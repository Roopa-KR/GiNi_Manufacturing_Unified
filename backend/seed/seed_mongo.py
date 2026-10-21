#!/usr/bin/env python3
"""Explicit, idempotent MongoDB seed from the Final workbooks (or from a bundle made by export_seed_bundle.py).

    MONGODB_URI=... MONGODB_DB_NAME=gini_demo_dev python3 seed_mongo.py --workbooks <folder>     # or --bundle seed_bundle
Insert-only ($setOnInsert on {dataset_id, _seed.key}): running it again inserts nothing, never duplicates and never
overwrites a document the application changed. Rows whose workbook content changed since the first seed are reported as
drift and left untouched. Never run automatically at build or start-up. Requires: pip install pymongo openpyxl"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import seedlib as L, seedops as O

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
src = ap.add_mutually_exclusive_group(required=True)
src.add_argument("--workbooks"); src.add_argument("--bundle")
ap.add_argument("--report", default="seed_report.json")
a = ap.parse_args()
colls, man = O.read_bundle(a.bundle) if a.bundle else O.build_bundle(a.workbooks)
store = L.open_store("mongodb")
rep = O.seed(store, colls, man)
json.dump(rep, open(a.report, "w"), indent=1, default=str)
print(json.dumps({k: rep[k] for k in ("seed_run_id", "dataset_version", "inserted_total", "already_present_total")}, default=str), "drift:", len(rep["drift"]))
