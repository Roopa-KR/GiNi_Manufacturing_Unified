"""Reproducible import workflow for the three GiNi v3 Final workbooks.

    python import_workflow.py verify  --data ../data/final                       # steps 1-3 only (no database)
    python import_workflow.py seed    --data ../data/final                       # steps 1-7 against MONGODB_URI / MONGODB_DB_NAME
    python import_workflow.py gate    --data ../data/final                       # steps 1-9 on a DISPOSABLE database (name must contain gate/test/tmp/disposable)

Steps
  1. locate the three *_Final.xlsx workbooks and verify them against data/final/SHA256SUMS (fails clearly when missing/changed)
  2. record checksums and the dataset id/version found inside the workbooks
  3. validate: required collections, non-null unique business keys, every foreign-key relationship of
     contracts/reference_checks.json re-checked independently per run on the resolved view (DELTA runs via scenario_resolver),
     and - when the package's seed manifest is supplied - per-collection counts and content hashes equal to it
  4. export the seed bundle (NDJSON per collection + manifest.json)
  5. seed (insert-only by business key)
  6. reconcile the database with the bundle (counts, per-document hashes, calculated totals)
  7. seed again: zero inserts, zero drift (idempotency)
  8. gate only: an application-modified seeded document and an application-created document survive a reseed unchanged and are
     reported by reconciliation and the activity export
  9. gate only: a changed workbook row is reported as drift and NOT applied

Writes <report-dir>/import_<mode>_<timestamp>.json (and .md). Exit code 0 = PASS, 1 = FAIL, 2 = inputs missing/invalid.
The workbooks are only read; nothing is written next to them except the bundle when --bundle-out points there.
"""
import argparse, collections, copy, datetime as dt, hashlib, json, os, re, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import seedlib as L, seedops as O  # noqa: E402
import scenario_resolver as SR  # noqa: E402

REQUIRED = ["worker_master", "worker_qualifications", "skill_master", "routing_operations", "work_center_master", "workstation_master", "equipment_master",
            "product_master", "ctq_check_master", "ctq_specifications", "shift_calendar", "shift_roster", "run_catalog", "checkpoints",
            "production_orders", "order_lines", "production_batches", "batch_unit_membership", "unit_master", "operation_instances", "task_assignments",
            "task_events", "labor_segments", "operation_crew", "attendance_events", "inspection_header", "inspection_readings", "defect_records",
            "quality_dispositions", "points_ledger", "material_events", "production_events",
            # v3-only supplements the application uses
            "worker_task_plan", "workstation_queue_entries", "operation_milestone_events", "return_movements", "hold_cases",
            "operation_instructions", "instruction_steps", "milestone_definitions", "disposition_matrix"]


def now():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0, tzinfo=None)


def log(*a):
    print("[import %s]" % now().strftime("%H:%M:%S"), *a, flush=True)


# ---------------------------------------------------------------------------- step 1-2
def locate(data):
    out = {"data_dir": os.path.abspath(data), "files": {}, "problems": []}
    sums = {}
    sp = os.path.join(data, "SHA256SUMS")
    if os.path.exists(sp):
        for line in open(sp):
            m = re.match(r"^([0-9a-f]{64})\s+\*?(?:\./)?(.+)$", line.strip())
            if m: sums[os.path.basename(m.group(2))] = m.group(1)
    else:
        out["problems"].append("SHA256SUMS not found in %s - checksums recorded but not verified against the package" % data)
    for n in L.WORKBOOKS:
        p = os.path.join(data, n)
        if not os.path.exists(p):
            out["problems"].append("MISSING required workbook %s" % p)
            continue
        h = L.sha_file(p)
        exp = sums.get(n)
        out["files"][n] = {"sha256": h, "bytes": os.path.getsize(p), "expected_sha256": exp, "verified": (h == exp) if exp else None}
        if exp and h != exp:
            out["problems"].append("CHECKSUM MISMATCH %s: %s != %s (the workbook was changed)" % (n, h, exp))
    out["result"] = "PASS" if not out["problems"] or all(p.startswith("SHA256SUMS not found") for p in out["problems"]) else "FAIL"
    return out


# ---------------------------------------------------------------------------- step 3
def validate(colls, manifest, package_manifest=None):
    checks = []
    have = set(colls)
    for c in REQUIRED:
        checks.append(dict(check="REQUIRED_COLLECTION", collection=c, result="PASS" if c in have and colls[c]["docs"] else "FAIL", count=len(colls.get(c, {}).get("docs", []))))
    for c, info in colls.items():
        keys = [d["_seed"]["key"] for d in info["docs"]]
        dup = [k for k, n in collections.Counter(keys).items() if n > 1]
        kf = [f for f in info["key_fields"] if f != "RUN_ID"]
        if kf == ["_SOURCE_ROW"]:
            checks.append(dict(check="BUSINESS_KEY", collection=c, key_fields=info["key_fields"], duplicates=len(dup), result="NOT_APPLICABLE" if not dup else "FAIL",
                               note="reference/documentation sheet without a natural key: keyed by source row (uniqueness still checked)"))
            continue
        # single identifier: must be present on every row; composite keys may have empty components (e.g. period-level rows) but never all of them
        nulls = sum(1 for d in info["docs"] if kf and (all(d.get(f) in (None, "") for f in kf) if len(kf) > 1 else d.get(kf[0]) in (None, "")))
        if "RUN_ID" in info["key_fields"]:
            nulls += sum(1 for d in info["docs"] if d.get("RUN_ID") in (None, ""))
        checks.append(dict(check="BUSINESS_KEY", collection=c, key_fields=info["key_fields"], duplicates=len(dup), null_keys=nulls, result="PASS" if not dup and not nulls else "FAIL", examples=dup[:3]))
    # foreign keys on the resolved view per run
    rel = json.load(open(os.path.join(HERE, "..", "contracts", "reference_checks.json")))["relationships"]
    cat = {}
    for d in colls.get("run_catalog", {}).get("docs", []):
        cat[d["RUN_ID"]] = {"BASELINE_RUN_ID": d.get("BASELINE_RUN_ID"), "BRANCH_AT": d.get("BRANCH_AT"), "STORAGE_MODE": d.get("STORAGE_MODE")}
    runs = sorted(cat)
    resolved_cache = {}

    def rows(table):
        c = table.lower()
        return colls.get(c, {}).get("docs", []) if c in colls else colls.get("ref_" + c, {}).get("docs", [])

    def resolved(table, run):
        k = (table, run)
        if k not in resolved_cache:
            r = rows(table)
            if r and "RUN_ID" in r[0]:
                resolved_cache[k] = SR.resolve(r, table, run, cat) if table in SR.PK else [x for x in r if x.get("RUN_ID") == run]
            else:
                resolved_cache[k] = r          # global (master/config) table
        return resolved_cache[k]
    for r in rel:
        parents_tables = r["parent"].split("|")
        child_rows_all = rows(r["child"])
        if r["child"].startswith("GT_") and not manifest.get("ground_truth_included"):
            checks.append(dict(check="FOREIGN_KEY", relationship="%s.%s -> %s.%s" % (r["child"], r["child_column"], r["parent"], r["parent_column"]), result="NOT_APPLICABLE",
                               note="hidden ground-truth table, excluded from the seed by design (export_seed_bundle.py --include-ground-truth for tests)"))
            continue
        if not child_rows_all:
            checks.append(dict(check="FOREIGN_KEY", relationship="%s.%s -> %s.%s" % (r["child"], r["child_column"], r["parent"], r["parent_column"]), result="FAIL", note="child table not in bundle"))
            continue
        scoped = "RUN_ID" in child_rows_all[0]
        checked = missing = 0
        examples = []
        for run in (runs if scoped else [None]):
            crow = resolved(r["child"], run) if scoped else child_rows_all
            pkeys = set()
            for pt in parents_tables:
                prow = resolved(pt, run) if scoped else rows(pt)
                pkeys |= {p.get(r["parent_column"]) for p in prow}
            for x in crow:
                v = x.get(r["child_column"])
                if v in (None, ""):
                    continue
                checked += 1
                if v not in pkeys:
                    missing += 1
                    if len(examples) < 3: examples.append("%s:%s" % (run, v))
        res = "PASS" if missing == 0 else "FAIL"
        checks.append(dict(check="FOREIGN_KEY", relationship="%s.%s -> %s.%s" % (r["child"], r["child_column"], r["parent"], r["parent_column"]), references_checked=checked,
                           expected_references_per_package=r["expected_references"], references_match_package=(checked == r["expected_references"]), missing=missing, result=res, examples=examples))
    if package_manifest:
        pc = package_manifest["collections"]
        for c, m in manifest["collections"].items():
            p = pc.get(c)
            ok = p is not None and p["count"] == m["count"] and p["content_sha256"] == m["content_sha256"]
            checks.append(dict(check="PACKAGE_MANIFEST", collection=c, count=m["count"], package_count=(p or {}).get("count"), content_hash_equal=bool(p and p["content_sha256"] == m["content_sha256"]), result="PASS" if ok else "FAIL"))
        for c in set(pc) - set(manifest["collections"]):
            checks.append(dict(check="PACKAGE_MANIFEST", collection=c, result="FAIL", note="in the package manifest but not exported"))
        checks.append(dict(check="PACKAGE_TOTALS", result="PASS" if json.dumps(package_manifest.get("totals"), sort_keys=True, default=str) == json.dumps(manifest.get("totals"), sort_keys=True, default=str) else "FAIL"))
    fk = [c for c in checks if c["check"] == "FOREIGN_KEY" and c["result"] != "NOT_APPLICABLE"]
    summary = dict(checks=len(checks), failed=sum(1 for c in checks if c["result"] == "FAIL"), not_applicable=sum(1 for c in checks if c["result"] == "NOT_APPLICABLE"), foreign_keys=len(fk), references_checked=sum(c.get("references_checked", 0) for c in fk),
                   references_missing=sum(c.get("missing", 0) for c in fk), fk_counts_equal_package=sum(1 for c in fk if c.get("references_match_package")))
    return dict(result="PASS" if summary["failed"] == 0 else "FAIL", summary=summary, checks=checks)


# ---------------------------------------------------------------------------- database steps
def server_identity():
    from pymongo import MongoClient
    import pymongo
    cli = MongoClient(os.environ["MONGODB_URI"], serverSelectionTimeoutMS=10000)
    bi = cli.admin.command("buildInfo")
    hello = cli.admin.command("hello")
    v = bi.get("version", "")
    return {"driver": "pymongo %s" % pymongo.version, "server_version": v, "replica_set": hello.get("setName"),
            "server_kind": "TEST SUBSTITUTE (docdb-wire) - not MongoDB" if "docdb" in v else "MongoDB server", "database": os.environ.get("MONGODB_DB_NAME")}


def proof_preservation(store, colls, manifest):
    """step 8 - application modification + creation survive a reseed"""
    ds = manifest["dataset_id"]
    target_c = "task_assignments"
    d = store.find(target_c, {"dataset_id": ds, "_origin": "SEED"})[0]
    key = d["_seed"]["key"]
    store.db[target_c].update_one({"_id": d["_id"]}, {"$set": {"TASK_STATUS": "IMPORT_GATE_APP_CHANGE", "_app": {"modified_at": now(), "modified_by": "import_workflow.gate", "reason": "preservation proof"}}})
    app_doc = {"dataset_id": ds, "RUN_ID": "IMPORT-GATE-APP", "EVENT_ID": "PEV-APP-GATE-%d" % int(time.time()), "EVENT_TYPE": "OPERATION_STARTED", "_origin": "APP", "created_at": now()}
    store.db["production_events"].insert_one(dict(app_doc))
    rep = O.seed(store, colls, manifest, actor="import_workflow.gate.reseed")
    after = store.db[target_c].find_one({"_id": d["_id"]})
    created = store.db["production_events"].count_documents({"EVENT_ID": app_doc["EVENT_ID"]})
    loose = O.reconcile(store, manifest)
    act = O.export_app_activity(store, ds)
    ok = (rep["inserted_total"] == 0 and after["TASK_STATUS"] == "IMPORT_GATE_APP_CHANGE" and created == 1
          and any(x["result"] == "DIFFERS_DUE_TO_APPLICATION_CHANGES" for x in loose["checks"]) and len(act.get(target_c, [])) >= 1 and len(act.get("production_events", [])) >= 1)
    return dict(result="PASS" if ok else "FAIL", modified_key=key, modified_value_after_reseed=after["TASK_STATUS"], app_created_present=created, reseed_inserted=rep["inserted_total"],
                loose_reconcile=loose["result"], app_activity_collections={k: len(v) for k, v in act.items()})


def proof_drift(store, colls, manifest):
    """step 9 - a changed workbook row is reported as drift, not applied"""
    c = "worker_master"
    changed = copy.deepcopy(colls[c])
    d = changed["docs"][0]
    d["DISPLAY_NAME"] = d["DISPLAY_NAME"] + " (changed in workbook)"
    d["_seed"]["content_sha256"] = L.content_hash(L.seeded_fields(d))
    rep = O.seed(store, {c: changed}, dict(manifest, collections={c: manifest["collections"][c]}), actor="import_workflow.gate.drift")
    stored = store.db[c].find_one({"dataset_id": manifest["dataset_id"], "_seed.key": d["_seed"]["key"]})
    ok = rep["collections"][c]["drift"] == 1 and stored["DISPLAY_NAME"] != d["DISPLAY_NAME"]
    return dict(result="PASS" if ok else "FAIL", drift_reported=rep["collections"][c]["drift"], stored_value_unchanged=stored["DISPLAY_NAME"] != d["DISPLAY_NAME"], key=d["_seed"]["key"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["verify", "seed", "gate"])
    ap.add_argument("--data", default=os.path.join(HERE, "..", "data", "final"))
    ap.add_argument("--package-manifest", default=None, help="the dataset package's seed/manifest.json (default: <data>/package_manifest.json when present)")
    ap.add_argument("--bundle-out", default=os.path.join(HERE, "..", "data", "seed_bundle"))
    ap.add_argument("--drop-after", action="store_true", help="gate only: drop the disposable database after the proofs")
    ap.add_argument("--report-dir", default=os.path.join(HERE, "..", "docs", "test-results", "import"))
    a = ap.parse_args()
    t0 = time.time()
    report = dict(mode=a.mode, started_at=now(), steps={})
    os.makedirs(a.report_dir, exist_ok=True)

    def finish(code):
        report["finished_at"] = now(); report["seconds"] = round(time.time() - t0, 1)
        report["result"] = {0: "PASS", 1: "FAIL", 2: "INPUT_ERROR"}[code]
        stamp = now().strftime("%Y%m%dT%H%M%SZ")
        p = os.path.join(a.report_dir, "import_%s_%s.json" % (a.mode, stamp))
        json.dump(report, open(p, "w"), indent=1, default=str)
        log("report:", p, "->", report["result"])
        sys.exit(code)

    log("step 1-2: locate and verify inputs in", a.data)
    loc = locate(a.data)
    report["steps"]["1_2_inputs"] = loc
    if loc["result"] != "PASS":
        for p in loc["problems"]: log("ERROR", p)
        finish(2)
    log("step 3: read workbooks and build documents (this takes a few minutes)")
    colls, manifest = O.build_bundle(a.data)
    report["dataset"] = dict(dataset_id=manifest["dataset_id"], dataset_version=manifest["dataset_version"], collections=len(manifest["collections"]),
                             documents=sum(m["count"] for m in manifest["collections"].values()), manifest_sha256=manifest["manifest_sha256"], source_workbooks=manifest["source_workbooks"])
    log("dataset", manifest["dataset_id"], manifest["dataset_version"], report["dataset"]["collections"], "collections", report["dataset"]["documents"], "documents")
    pm_path = a.package_manifest or os.path.join(a.data, "package_manifest.json")
    pm = json.load(open(pm_path)) if os.path.exists(pm_path) else None
    val = validate(colls, manifest, pm)
    report["steps"]["3_validation"] = val
    log("validation", val["result"], json.dumps(val["summary"]))
    log("step 4: write bundle to", a.bundle_out)
    O.write_bundle(colls, manifest, a.bundle_out)
    report["steps"]["4_bundle"] = dict(path=os.path.abspath(a.bundle_out), manifest_sha256=manifest["manifest_sha256"])
    if a.mode == "verify":
        finish(0 if val["result"] == "PASS" else 1)
    dbn = os.environ.get("MONGODB_DB_NAME", "")
    if a.mode == "gate" and not re.search(r"(gate|test|tmp|disposable)", dbn):
        log("ERROR refusing to run destructive gate proofs on database %r (name must contain gate/test/tmp/disposable)" % dbn)
        finish(2)
    report["server"] = server_identity()
    log("server:", json.dumps(report["server"]))
    store = L.open_store("mongodb")
    log("step 5: seed")
    r1 = O.seed(store, colls, manifest, actor="import_workflow.%s.seed1" % a.mode)
    report["steps"]["5_seed"] = {k: v for k, v in r1.items() if k != "collections"} | dict(collections_total=len(r1["collections"]), drift_examples=r1["drift"][:5])
    log("seed inserted", r1["inserted_total"], "already present", r1["already_present_total"], "drift", len(r1["drift"]))
    log("step 6: reconcile (strict, with bundle)")
    rec = O.reconcile(store, manifest, bundle_colls=colls)
    report["steps"]["6_reconcile"] = dict(result=rec["result"], checks=len(rec["checks"]), failed=[c for c in rec["checks"] if c["result"] == "FAIL"][:20])
    log("reconcile", rec["result"], len(rec["checks"]), "checks")
    log("step 7: seed again (idempotency)")
    r2 = O.seed(store, colls, manifest, actor="import_workflow.%s.seed2" % a.mode)
    idem = r2["inserted_total"] == 0 and not r2["drift"]
    report["steps"]["7_reseed"] = dict(result="PASS" if idem else "FAIL", inserted=r2["inserted_total"], already_present=r2["already_present_total"], drift=len(r2["drift"]))
    log("reseed inserted", r2["inserted_total"], "drift", len(r2["drift"]))
    ok = val["result"] == "PASS" and rec["result"] == "PASS" and idem
    if a.mode == "gate":
        log("step 8: preservation proof")
        report["steps"]["8_preservation"] = proof_preservation(store, colls, manifest)
        log("step 9: drift proof")
        report["steps"]["9_drift"] = proof_drift(store, colls, manifest)
        ok = ok and report["steps"]["8_preservation"]["result"] == "PASS" and report["steps"]["9_drift"]["result"] == "PASS"
        if a.drop_after:
            store.cli.drop_database(dbn)
            report["steps"]["dropped_disposable_database"] = dbn
    if not (a.mode == "gate" and a.drop_after):
        # the import run itself is a durable business record (Administration -> Import & reconciliation)
        store.insert_one("import_runs", dict(dataset_id=manifest["dataset_id"], mode=a.mode, started_at=report["started_at"], finished_at=now(), result="PASS" if ok else "FAIL",
                                             dataset_version=manifest["dataset_version"], manifest_sha256=manifest["manifest_sha256"], source_workbooks=manifest["source_workbooks"],
                                             validation=val["summary"], reconcile=dict(result=rec["result"], checks=len(rec["checks"])), reseed=report["steps"]["7_reseed"],
                                             server=report["server"], _origin="APP"))
    finish(0 if ok else 1)


if __name__ == "__main__":
    main()
