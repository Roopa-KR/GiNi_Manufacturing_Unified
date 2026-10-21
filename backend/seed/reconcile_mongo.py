#!/usr/bin/env python3
"""Reconcile MongoDB with the seed manifest: per-collection counts, per-document content hashes, no duplicates,
and calculated totals (points per worker, good tanks per order line, attended minutes, task statuses, rework loops, plans).

    python3 reconcile_mongo.py --manifest seed_bundle/manifest.json [--report reconcile_report.json]
Exit code 0 = PASS, 1 = FAIL. Application changes are reported (modified_by_application), not failed."""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import seedlib as L, seedops as O

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--manifest", required=True); ap.add_argument("--report", default="reconcile_report.json")
ap.add_argument("--bundle", help="seed bundle folder: exact as-seeded totals even after application changes")
a = ap.parse_args()
man = json.load(open(a.manifest))
loader = (lambda c: O.read_bundle_collection(a.bundle, c, man)) if a.bundle else None
rep = O.reconcile(L.open_store("mongodb"), man, bundle_loader=loader)
json.dump(rep, open(a.report, "w"), indent=1, default=str)
print(rep["result"], sum(1 for c in rep["checks"] if c["result"] == "PASS"), "/", len(rep["checks"]))
sys.exit(0 if rep["result"] == "PASS" else 1)
