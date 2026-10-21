#!/usr/bin/env python3
"""Final workbooks -> reproducible seed bundle (one NDJSON per collection, MongoDB extended JSON dates) + manifest.json
with counts, per-collection content hashes and reconciliation totals.

    python3 export_seed_bundle.py --workbooks <folder with the three *_Final.xlsx> --out seed_bundle [--no-gzip] [--include-ground-truth]
Same workbooks -> same manifest hashes (generation timestamps are not part of any hash)."""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import seedops as O

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--workbooks", required=True); ap.add_argument("--out", required=True)
ap.add_argument("--no-gzip", action="store_true"); ap.add_argument("--include-ground-truth", action="store_true", help="GT_* hidden ground truth (test use only; never read by the application)")
a = ap.parse_args()
colls, man = O.build_bundle(a.workbooks, a.include_ground_truth)
O.write_bundle(colls, man, a.out, gz=not a.no_gzip)
print(json.dumps(dict(dataset_id=man["dataset_id"], dataset_version=man["dataset_version"], collections=len(man["collections"]),
                      documents=sum(m["count"] for m in man["collections"].values()), manifest_sha256=man["manifest_sha256"]), indent=1))
