#!/usr/bin/env python3
"""Export activity entered after seeding (documents with _origin != SEED and seeded documents with _app.modified_at).

    python3 export_app_activity.py --dataset-id GINI-SYN-TANKS --out app_activity [--since 2026-10-17T00:00:00]
Writes one NDJSON per collection plus summary.json; the seed workbooks are never modified."""
import argparse, datetime as dt, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import seedlib as L, seedops as O

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--dataset-id", required=True); ap.add_argument("--out", required=True); ap.add_argument("--since")
a = ap.parse_args()
out = O.export_app_activity(L.open_store("mongodb"), a.dataset_id, dt.datetime.fromisoformat(a.since) if a.since else None)
os.makedirs(a.out, exist_ok=True)
for c, docs in out.items():
    with open(os.path.join(a.out, c + ".ndjson"), "w") as f:
        for d in docs:
            f.write(L.to_ejson({k: (str(v) if k == "_id" else v) for k, v in d.items()}) + "\n")
json.dump({c: len(v) for c, v in out.items()}, open(os.path.join(a.out, "summary.json"), "w"), indent=1)
print({c: len(v) for c, v in out.items()})
