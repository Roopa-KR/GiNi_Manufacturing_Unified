"""Seed, reconcile, export and account-setup operations (called by the CLI scripts and by the tests)."""
import datetime as dt, gzip, hashlib, hmac, json, os, collections, secrets
import seedlib as L

ORDER = ["CONFIG", "MASTER", "OPERATIONAL", "OPERATIONAL_DERIVED", "ANALYTICS_REFERENCE", "GROUND_TRUTH_TEST_ONLY"]


def _now():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0, tzinfo=None)


def dataset_identity(W):
    ver = {r["KEY"]: r["VALUE"] for _, r in W.get("DATASET_VERSION", {}).get("rows", [])}
    return ver.get("DATASET_ID") or "GINI-SYN-TANKS", ver.get("DATASET_VERSION_ID") or "UNKNOWN"


def build_bundle(folder, include_gt=False):
    W = L.read_workbooks(folder, include_gt)
    ds, ver = dataset_identity(W)
    colls = L.build_documents(W, ds, ver)
    manifest = dict(dataset_id=ds, dataset_version=ver, source_workbooks={n: L.sha_file(os.path.join(folder, n)) for n in L.WORKBOOKS},
                    skipped_sheets=L.SKIP_SHEETS, ground_truth_included=include_gt, collections={})
    for c, info in colls.items():
        hs = sorted(d["_seed"]["key"] + ":" + d["_seed"]["content_sha256"] for d in info["docs"])
        manifest["collections"][c] = dict(sheet=info["sheet"], kind=info["kind"], key_fields=info["key_fields"], key_basis=info["key_basis"], count=len(info["docs"]),
                                          content_sha256=hashlib.sha256("\n".join(hs).encode()).hexdigest())
    manifest["totals"] = L.totals({c: info["docs"] for c, info in colls.items()})
    manifest["manifest_sha256"] = hashlib.sha256(json.dumps({k: v for k, v in manifest.items() if k != "manifest_sha256"}, sort_keys=True, default=str).encode()).hexdigest()
    return colls, manifest


def write_bundle(colls, manifest, out, gz=True):
    os.makedirs(out, exist_ok=True)
    for c, info in colls.items():
        p = os.path.join(out, c + (".ndjson.gz" if gz else ".ndjson"))
        op = gzip.open if gz else open
        with op(p, "wt", encoding="utf-8") as f:
            for d in info["docs"]:
                f.write(L.to_ejson(d) + "\n")
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1, default=str, sort_keys=True)


def read_bundle(folder):
    manifest = json.load(open(os.path.join(folder, "manifest.json")))
    colls = {}
    for c, m in manifest["collections"].items():
        p = os.path.join(folder, c + ".ndjson.gz")
        op = gzip.open if os.path.exists(p) else open
        p = p if os.path.exists(p) else os.path.join(folder, c + ".ndjson")
        with op(p, "rt", encoding="utf-8") as f:
            colls[c] = dict(sheet=m["sheet"], kind=m["kind"], key_fields=m["key_fields"], docs=[L.from_ejson(x) for x in f if x.strip()])
    return colls, manifest


def seed(store, colls, manifest, actor="seed_mongo.py"):
    """insert-only, idempotent; returns a seed-run report (never modifies an existing document)"""
    run_id = "SEED-" + _now().strftime("%Y%m%dT%H%M%SZ") + "-" + secrets.token_hex(3)
    rep = dict(seed_run_id=run_id, dataset_id=manifest["dataset_id"], dataset_version=manifest["dataset_version"], manifest_sha256=manifest["manifest_sha256"],
               started_at=_now(), store=store.kind, actor=actor, collections={}, drift=[])
    store.ensure_unique_index("import_manifests", ["dataset_id", "dataset_version"])
    ex = store.find("import_manifests", {"dataset_id": manifest["dataset_id"], "dataset_version": manifest["dataset_version"]})
    if ex and ex[0].get("manifest_sha256") != manifest["manifest_sha256"]:
        rep["drift"].append(dict(collection="import_manifests", key=manifest["dataset_version"], note="Same dataset version seeded earlier from different workbook content"))
    if not ex:
        store.insert_one("import_manifests", dict(dataset_id=manifest["dataset_id"], dataset_version=manifest["dataset_version"], manifest_sha256=manifest["manifest_sha256"],
                                                  source_workbooks=manifest["source_workbooks"], first_seeded_at=_now(), counts={c: m["count"] for c, m in manifest["collections"].items()}))
    for c in sorted(colls, key=lambda c: (ORDER.index(colls[c]["kind"]), c)):
        docs = colls[c]["docs"]
        store.ensure_unique_index(c, ["dataset_id", "_seed.key"], partial_exists="_seed.key")
        ins, mat, existing = store.insert_only(c, docs)
        drift = [d["_seed"]["key"] for d in docs if d["_seed"]["key"] in existing and existing[d["_seed"]["key"]] != d["_seed"]["content_sha256"]]
        rep["collections"][c] = dict(source_rows=len(docs), inserted=ins, already_present=mat, drift=len(drift))
        rep["drift"] += [dict(collection=c, key=k, note="Workbook row differs from the seeded document; left unchanged (no silent overwrite)") for k in drift[:50]]
    rep["finished_at"] = _now()
    rep["inserted_total"] = sum(x["inserted"] for x in rep["collections"].values())
    rep["already_present_total"] = sum(x["already_present"] for x in rep["collections"].values())
    store.insert_one("seed_runs", {k: v for k, v in rep.items() if k != "drift"} | dict(drift_count=len(rep["drift"])))
    return rep


TOTAL_INPUTS = {"points_by_worker": ("points_ledger",), "points_total": ("points_ledger",), "good_tanks_by_run_order_line": ("production_events",),
                "attended_min_by_run": ("ref_worker_shift_summary",), "task_status_counts": ("task_assignments",), "rework_loops_by_run": ("return_movements",),
                "plan_rows_by_source": ("worker_task_plan",), "operator_metrics_points_mismatch": ("ref_operator_metrics", "points_ledger"),
                "order_line_good_qty_mismatch": ("order_lines", "production_events")}


NEEDED_FOR_TOTALS = sorted({c for v in TOTAL_INPUTS.values() for c in v})


def read_bundle_collection(folder, c, manifest):
    """one collection of a bundle (memory-bounded reconciliation)"""
    p = os.path.join(folder, c + ".ndjson.gz")
    op = gzip.open if os.path.exists(p) else open
    p = p if os.path.exists(p) else os.path.join(folder, c + ".ndjson")
    with op(p, "rt", encoding="utf-8") as f:
        return [L.from_ejson(x) for x in f if x.strip()]


def reconcile(store, manifest, bundle_colls=None, bundle_loader=None):
    """compare the database with the seed manifest: counts, per-document content hashes, calculated totals.
    Seeded documents the application changed afterwards are reported; when the bundle is supplied their as-seeded values
    are taken from it, so the totals comparison stays exact (strict). Without the bundle such differences are reported as
    explained by application activity."""
    ds = manifest["dataset_id"]
    strict = bundle_colls is not None or bundle_loader is not None
    out = dict(dataset_id=ds, dataset_version=manifest["dataset_version"], checked_at=_now(), store=store.kind, strict_totals=strict, checks=[])
    db, modified_by_coll = {}, {}
    # memory-bounded: documents are kept only for the collections the calculated totals need
    for c, m in manifest["collections"].items():
        seeded = store.find(c, {"dataset_id": ds, "_origin": "SEED", "_seed.dataset_version": manifest["dataset_version"]})
        keys = collections.Counter(d["_seed"]["key"] for d in seeded)
        dup = [k for k, n in keys.items() if n > 1]
        modified = [d for d in seeded if d.get("_app")]
        clean = [d for d in seeded if not d.get("_app")]
        bad_hash = [d["_seed"]["key"] for d in clean if L.content_hash(L.seeded_fields(d)) != d["_seed"]["content_sha256"]]
        hs = sorted(d["_seed"]["key"] + ":" + d["_seed"]["content_sha256"] for d in seeded)
        same_set = hashlib.sha256("\n".join(hs).encode()).hexdigest() == m["content_sha256"]
        res = "PASS" if (len(seeded) == m["count"] and not dup and not bad_hash and same_set) else "FAIL"
        out["checks"].append(dict(check="COLLECTION", collection=c, expected=m["count"], found=len(seeded), duplicates=len(dup), content_mismatch_unmodified=len(bad_hash),
                                  modified_by_application=len(modified), seed_hash_set_equal=same_set, app_created_documents=len(store.find(c, {"dataset_id": ds, "_origin": "APP"})), result=res))
        modified_by_coll[c] = len(modified)
        if c in NEEDED_FOR_TOTALS:
            orig = {}
            if modified and strict:
                docs = bundle_colls[c]["docs"] if bundle_colls is not None else bundle_loader(c)
                want = {d["_seed"]["key"] for d in modified}
                orig = {d["_seed"]["key"]: d for d in docs if d["_seed"]["key"] in want}
            db[c] = [L.seeded_fields(orig[d["_seed"]["key"]]) if (d.get("_app") and d["_seed"]["key"] in orig) else L.seeded_fields(d) for d in seeded]
        del seeded, clean, modified
    t = L.totals(db)
    for k, v in manifest["totals"].items():
        if k in ("collection_counts", "run_counts"):
            continue
        got = json.loads(json.dumps(t.get(k), default=str))
        mods = sum(modified_by_coll.get(c, 0) for c in TOTAL_INPUTS.get(k, ()))
        if got == v:
            r = "PASS"
        elif mods and not strict:
            r = "DIFFERS_DUE_TO_APPLICATION_CHANGES"
        else:
            r = "FAIL"
        out["checks"].append(dict(check="TOTAL", name=k, result=r, application_modified_inputs=mods, expected_summary=str(v)[:200], found_summary=str(got)[:200]))
    out["result"] = "FAIL" if any(c["result"] == "FAIL" for c in out["checks"]) else "PASS"
    out["note"] = ("Totals compare the as-seeded state; documents the application changed are counted with their seeded values from the bundle" if strict else
                   "Documents changed by the application are reported, not failed; supply --bundle for an exact as-seeded totals comparison")
    return out


def export_app_activity(store, dataset_id, since=None):
    """documents created by the application (_origin != SEED) and seeded documents the application changed (_app.modified_at)"""
    out = {}
    for c in store.collections():
        if c in ("seed_runs", "import_manifests", "accounts", "auth_sessions"):
            continue
        docs = store.find(c, {"dataset_id": dataset_id, "$or": [{"_origin": {"$ne": "SEED"}}, {"_app.modified_at": {"$exists": True}}]})
        if since:
            docs = [d for d in docs if (d.get("_app", {}) or {}).get("modified_at", d.get("created_at") or dt.datetime.max) >= since or (d.get("created_at") or dt.datetime.min) >= since]
        if docs:
            out[c] = docs
    return out


# ------------------------------------------------------------------------------------------------ accounts (never in Excel)
def _contracts():
    """role -> permission matrix and the explicit WORKER_ROLE -> application role map shared with the Express API"""
    here = os.path.dirname(os.path.abspath(__file__))
    for cand in (os.path.join(here, "..", "contracts", "permissions.json"), os.path.join(here, "contracts", "permissions.json")):
        if os.path.exists(cand):
            with open(cand, encoding="utf-8") as f:
                return json.load(f)
    raise SystemExit("contracts/permissions.json not found next to seed/")


_C = None


def contracts():
    global _C
    if _C is None:
        _C = _contracts()
    return _C


def role_of(worker_role):
    """explicit table lookup on WORKER_MASTER.WORKER_ROLE - never substring matching; unknown roles get no account"""
    return contracts()["worker_role_map"].get((worker_role or "").strip().upper())


def perms_of(role):
    return list(contracts()["roles"].get(role, []))


def demo_pin(seed_secret, login_id):
    """local demo PIN derived from DEMO_PIN_SEED (never stored, never written to Excel or a file)"""
    return "%06d" % (int(hmac.new(seed_secret.encode(), login_id.encode(), hashlib.sha256).hexdigest(), 16) % 1_000_000)


def hash_pin(pin, salt=None):
    salt = salt or os.urandom(16)
    h = hashlib.scrypt(pin.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return "scrypt$16384$8$1$" + salt.hex() + "$" + h.hex()


def verify_pin(pin, stored):
    _, n, r, p, salt, h = stored.split("$")
    return hmac.compare_digest(hashlib.scrypt(pin.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p), dklen=32).hex(), h)


def setup_accounts(store, dataset_id, pin_seed, admin_login=None, admin_password=None, migrate_roles=False):
    """insert-only: re-running never resets a PIN, status or a role the application changed.
    Every person in WORKER_MASTER gets an account keyed by WORKER_ID (login_id = WORKER_ID) when WORKER_ROLE is in the explicit
    role map; others are reported, never defaulted to OPERATOR. migrate_roles=True only rewrites roles of accounts this script
    created whose stored role is not a known application role (legacy v3 'QUALITY' etc.), and records the change."""
    if not pin_seed or len(pin_seed) < 12:
        raise SystemExit("DEMO_PIN_SEED must be set (>= 12 characters) for the explicit account setup command")
    store.ensure_unique_index("accounts", ["dataset_id", "login_id"])
    workers = sorted(store.find("worker_master", {"dataset_id": dataset_id}), key=lambda w: w["WORKER_ID"])
    users = {u["WORKER_ID"]: u for u in store.find("app_users", {"dataset_id": dataset_id})}
    existing = {d["login_id"]: d for d in store.find("accounts", {"dataset_id": dataset_id})}
    known_roles = set(contracts()["roles"])
    made, guide, unmapped, migrated = 0, [], [], 0
    for w in workers:
        login = w["WORKER_ID"]
        role = role_of(w.get("WORKER_ROLE"))
        if role is None:
            unmapped.append((login, w.get("WORKER_ROLE")))
            continue
        u = users.get(login, {})
        active = (w.get("ACTIVE_FLAG") or u.get("ACTIVE_FLAG") or "Y") == "Y"
        guide.append(dict(login_id=login, worker_id=login, display_name=w.get("DISPLAY_NAME"), worker_role=w.get("WORKER_ROLE"), app_role=role, permissions="|".join(perms_of(role)),
                          active="Y" if active else "N", pin="derived locally from DEMO_PIN_SEED - not stored; use --show-pin-for <WORKER_ID>"))
        cur = existing.get(login)
        if cur is not None:
            if migrate_roles and cur.get("_origin") == "SETUP" and not set(cur.get("roles") or []) & known_roles:
                store.update_one("accounts", {"dataset_id": dataset_id, "login_id": login}, {"roles": [role], "permissions": perms_of(role), "role_migrated_at": _now(), "role_migrated_from": cur.get("roles")})
                migrated += 1
            continue
        store.insert_one("accounts", dict(dataset_id=dataset_id, login_id=login, worker_id=login, roles=[role], permissions=perms_of(role),
                                          status="ACTIVE" if active else "INACTIVE", pin_hash=hash_pin(demo_pin(pin_seed, login)), pin_must_change=False,
                                          created_at=_now(), created_by="setup_accounts.py", _origin="SETUP"))
        made += 1
    if admin_login and admin_login not in existing:
        if not admin_password or len(admin_password) < 15:
            raise SystemExit("ADMIN_PASSWORD must be >= 15 characters")
        store.insert_one("accounts", dict(dataset_id=dataset_id, login_id=admin_login, worker_id=None, roles=["ADMIN"], permissions=perms_of("ADMIN"), status="ACTIVE",
                                          pin_hash=hash_pin(admin_password), pin_must_change=True, created_at=_now(), created_by="setup_accounts.py", _origin="SETUP"))
        made += 1
    return made, guide, unmapped, migrated