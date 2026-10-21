"""Seed tooling tests on the full Final bundle with the in-process MemoryStore.

    SEED_BUNDLE=<bundle folder> python3 -m unittest -v tests/test_seed.py
These tests exercise the seed logic (insert-only upserts, drift handling, reconciliation, activity export, account setup).
They do NOT prove behaviour of a live MongoDB server: run seed_mongo.py / reconcile_mongo.py against Atlas or a local
replica set for that (see README_SEED.md)."""
import copy, datetime as dt, hashlib, os, sys, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import seedlib as L, seedops as O

BUNDLE = os.environ.get("SEED_BUNDLE", os.path.join(os.path.dirname(HERE), "..", "seed_bundle"))


class SeedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.colls, cls.man = O.read_bundle(BUNDLE)
        cls.total = sum(len(c["docs"]) for c in cls.colls.values())

    SUBSET = ("worker_master", "app_users", "task_assignments", "production_events", "points_ledger", "order_lines", "ref_worker_shift_summary", "return_movements",
              "worker_task_plan", "ref_operator_metrics")

    def sub(self):
        subset = [c for c in self.SUBSET if c in self.colls]          # a reduced local fixture may lack v3-only collections
        colls = {c: copy.deepcopy(self.colls[c]) for c in subset}
        man = dict(self.man, collections={c: self.man["collections"][c] for c in subset})
        return colls, man

    def fresh(self):
        """seed the collections every behavioural test needs (the full bundle is seeded in test_02)"""
        st = L.MemoryStore()
        colls, man = self.sub()
        rep = O.seed(st, colls, man)
        return st, rep

    def test_01_bundle_matches_manifest(self):
        for c, m in self.man["collections"].items():
            docs = self.colls[c]["docs"]
            self.assertEqual(len(docs), m["count"], c)
            hs = sorted(d["_seed"]["key"] + ":" + d["_seed"]["content_sha256"] for d in docs)
            self.assertEqual(hashlib.sha256("\n".join(hs).encode()).hexdigest(), m["content_sha256"], c)
            self.assertTrue(all(L.content_hash(L.seeded_fields(d)) == d["_seed"]["content_sha256"] for d in docs), c)
            self.assertEqual(len({d["_seed"]["key"] for d in docs}), len(docs), f"{c} duplicate seed keys")

    def test_02_seed_twice_no_duplicates(self):
        st = L.MemoryStore()
        r1 = O.seed(st, self.colls, self.man)
        self.assertEqual(r1["inserted_total"], self.total)
        r2 = O.seed(st, self.colls, self.man)
        self.assertEqual(r2["inserted_total"], 0)
        self.assertEqual(r2["already_present_total"], self.total)
        self.assertEqual(r2["drift"], [])
        for c in self.colls:
            self.assertEqual(len(st.find(c, {"dataset_id": self.man["dataset_id"]})), len(self.colls[c]["docs"]), c)
        rec = O.reconcile(st, self.man)
        self.assertEqual(rec["result"], "PASS", [x for x in rec["checks"] if x["result"] != "PASS"][:3])
        type(self).full_reconcile = rec

    def test_03_reseed_keeps_application_activity(self):
        st, _ = self.fresh()
        ds = self.man["dataset_id"]
        rows = st.find("task_assignments", {"dataset_id": ds, "RUN_ID": "RUN-BASE"})
        t = next((r for r in rows if r.get("TASK_STATUS") == "PAUSED"), None) or next(r for r in rows if r.get("TASK_STATUS") not in ("IN_PROGRESS",))
        st.update_one("task_assignments", {"_id": t["_id"]}, {"TASK_STATUS": "IN_PROGRESS", "_app.modified_at": dt.datetime(2026, 10, 17, 9, 0), "_app.modified_by": "W0001"})
        st.insert_one("production_events", dict(dataset_id=ds, RUN_ID="SESSION-TEST-1", EVENT_ID="PEV-APP-000001", EVENT_TYPE="OPERATION_STARTED", UNIT_ID="TNK-000001",
                                                EVENT_TIME=dt.datetime(2026, 10, 17, 9, 1), KNOWN_AT=dt.datetime(2026, 10, 17, 9, 1), _origin="APP", created_at=dt.datetime(2026, 10, 17, 9, 1)))
        colls, man = self.sub()
        rep = O.seed(st, colls, man)
        self.assertEqual(rep["inserted_total"], 0)
        again = st.find("task_assignments", {"_id": t["_id"]})[0]
        self.assertEqual(again["TASK_STATUS"], "IN_PROGRESS", "seed overwrote an application change")
        self.assertEqual(len(st.find("production_events", {"EVENT_ID": "PEV-APP-000001"})), 1)
        rec = O.reconcile(st, man, colls)          # strict: as-seeded values of changed documents come from the bundle
        self.assertEqual(rec["result"], "PASS", [x for x in rec["checks"] if x["result"] != "PASS"][:3])
        self.assertTrue(all(x["result"] == "PASS" for x in rec["checks"]))
        loose = O.reconcile(st, man)               # without the bundle: the change is reported as application activity, not as a seed failure
        self.assertEqual(loose["result"], "PASS")
        self.assertTrue(any(x["result"] == "DIFFERS_DUE_TO_APPLICATION_CHANGES" for x in loose["checks"]))
        row = next(x for x in rec["checks"] if x.get("collection") == "task_assignments")
        self.assertEqual(row["modified_by_application"], 1)
        act = O.export_app_activity(st, ds)
        self.assertEqual(len(act.get("task_assignments", [])), 1)
        self.assertEqual(len(act.get("production_events", [])), 1)

    def test_04_changed_workbook_row_is_reported_not_applied(self):
        st, _ = self.fresh()
        colls, man = self.sub()
        d = colls["worker_master"]["docs"][0]
        d["DISPLAY_NAME"] = "Changed Name"
        d["_seed"]["content_sha256"] = L.content_hash(L.seeded_fields(d))
        rep = O.seed(st, colls, man)
        self.assertEqual(len([x for x in rep["drift"] if x["collection"] == "worker_master"]), 1)
        self.assertNotEqual(st.find("worker_master", {"_seed.key": d["_seed"]["key"]})[0]["DISPLAY_NAME"], "Changed Name")

    def test_05_accounts_are_created_outside_excel_and_never_reset(self):
        st, _ = self.fresh()
        ds = self.man["dataset_id"]
        made, guide, unmapped, _ = O.setup_accounts(st, ds, "local-demo-seed-123456", "admin", "a-long-local-passphrase")
        workers = st.find("worker_master", {"dataset_id": ds})
        self.assertEqual(made, len(workers) - len(unmapped) + 1)
        self.assertEqual(unmapped, [], "every seeded WORKER_ROLE must be in the explicit role map")
        h1 = {a["login_id"]: a["pin_hash"] for a in st.find("accounts", {"dataset_id": ds})}
        made2, _, _, _ = O.setup_accounts(st, ds, "local-demo-seed-123456", "admin", "a-long-local-passphrase")
        self.assertEqual(made2, 0)
        self.assertEqual(h1, {a["login_id"]: a["pin_hash"] for a in st.find("accounts", {"dataset_id": ds})})
        w = guide[0]["login_id"]
        self.assertTrue(O.verify_pin(O.demo_pin("local-demo-seed-123456", w), h1[w]))
        self.assertFalse(O.verify_pin("000000" if O.demo_pin("local-demo-seed-123456", w) != "000000" else "111111", h1[w]))
        self.assertTrue(all("pin_hash" not in d and "PIN" not in " ".join(d.keys()) for c in self.colls for d in self.colls[c]["docs"][:50]))
        self.assertTrue(all(not any(ch.isdigit() for ch in g["pin"]) for g in guide), "guide must not contain PINs")
        roles = {a["login_id"]: a["roles"] for a in st.find("accounts", {"dataset_id": ds})}
        self.assertIn("ADMIN", roles["admin"])
        self.assertTrue(all("manage_workers" not in O.perms_of(r[0]) for k, r in roles.items() if k != "admin"), "only admins manage workers")
        # explicit role map: maintenance and material handlers never become OPERATOR; quality approval only for quality supervisors
        wr = {x["WORKER_ID"]: x.get("WORKER_ROLE") for x in workers}
        for login, r in roles.items():
            if login == "admin":
                continue
            self.assertEqual(r, [O.contracts()["worker_role_map"][wr[login]]])
            if wr[login] in ("MAINTENANCE_TECHNICIAN", "MATERIAL_HANDLER"):
                self.assertNotIn("OPERATOR", r)
            if "quality_approval" in O.perms_of(r[0]):
                self.assertIn(wr[login], ("QUALITY_SUPERVISOR",))

    def test_05b_pins_are_text_and_keep_leading_zeros(self):
        seeds = ["local-demo-seed-%06d" % i for i in range(400)]
        z = next((s, "W0001") for s in seeds if O.demo_pin(s, "W0001").startswith("0"))
        pin = O.demo_pin(*z)
        self.assertEqual(len(pin), 6)
        h = O.hash_pin(pin)
        self.assertTrue(O.verify_pin(pin, h))
        self.assertFalse(O.verify_pin(pin.lstrip("0"), h), "a PIN without its leading zeros is a different PIN")
        self.assertTrue(h.startswith("scrypt$16384$8$1$") and len(h.split("$")[4]) == 32 and len(h.split("$")[5]) == 64)

    def test_06_reference_totals_reconcile_inside_the_workbooks(self):
        t = self.man["totals"]
        self.assertEqual(t["order_line_good_qty_mismatch"], [])
        self.assertEqual(t["operator_metrics_points_mismatch"], [])
        self.assertGreaterEqual(len(self.colls["worker_master"]["docs"]), 196)
        self.assertGreaterEqual(sum(1 for d in self.colls["worker_master"]["docs"] if d.get("WORKER_ROLE") == "PRODUCTION_OPERATOR"), 150)


if __name__ == "__main__":
    unittest.main(verbosity=2)
