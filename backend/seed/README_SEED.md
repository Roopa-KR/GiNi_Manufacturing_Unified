# MongoDB seed tooling - GiNi synthetic dataset (Final)

The three `*_Final.xlsx` workbooks are the only seed source. These scripts turn them into a reproducible bundle, import it into MongoDB
without duplicates, reconcile the database against the workbooks, create demo accounts outside Excel, and export activity entered later.
All data is synthetic ("Synthetic live replay"); nothing is Siemens data.

## Commands

```bash
pip install pymongo openpyxl                      # Python 3.10+
export MONGODB_URI="mongodb+srv://..."             # from the hosting dashboard / secret store - never from Excel or git
export MONGODB_DB_NAME=gini_demo_dev

# 1. workbooks -> bundle (NDJSON per collection + manifest.json with counts, content hashes and totals)
python3 export_seed_bundle.py --workbooks <folder with the three *_Final.xlsx> --out seed_bundle

# 2. explicit seed (never run automatically on application start)
python3 seed_mongo.py --bundle seed_bundle --report seed_report.json

# 3. reconcile the database against the bundle (exit code 1 on FAIL)
python3 reconcile_mongo.py --manifest seed_bundle/manifest.json --bundle seed_bundle --report reconcile_report.json

# 4. demo accounts (once; insert-only)
DEMO_PIN_SEED="<>= 12 chars, from the secret store>" ADMIN_LOGIN=admin ADMIN_PASSWORD="<>= 15 chars>" \
  python3 setup_accounts.py --dataset-id GINI-SYN-TANKS --guide demo_accounts.csv

# 5. activity entered in the application after seeding
python3 export_app_activity.py --dataset-id GINI-SYN-TANKS --out app_activity.json [--since 2026-10-17T00:00:00]
```

`seed_mongo.py --workbooks <folder>` builds the bundle in memory and seeds it in one step.

## What a seeded document looks like

One collection per sheet (`worker_master`, `task_assignments`, `return_movements`, ...). Analytics sheets are seeded as reference outputs
with the prefix `ref_` (e.g. `ref_worker_shift_summary`); the application computes its own live values and may compare them with these.
`GT_*` hidden ground truth is excluded unless `export_seed_bundle.py --include-ground-truth` is used for tests. `README` and the formula
sheet `POINTS_RECON` are not seeded.

```json
{ "...all workbook columns...": "...",
  "dataset_id": "GINI-SYN-TANKS",
  "_origin": "SEED",
  "_seed": { "key": "RUN-BASE|TSK-000123", "sheet": "TASK_ASSIGNMENTS", "workbook": "Siemens_Manufacturing_Events_Final.xlsx",
             "row": 125, "dataset_version": "GINI-SYN-2026-10-17-v3.0-FINAL", "content_sha256": "..." } }
```

`_seed.key` is the business key (RUN_ID + primary key for scenario tables, a documented composite key where no single key exists, or the
source row number for documentation-only sheets). `manifest.json` lists the key fields used for every collection.

## Idempotency and application activity

- A unique partial index on `(dataset_id, _seed.key)` is created for every seeded collection.
- Writes are `updateOne(filter={dataset_id, _seed.key}, {$setOnInsert: doc}, upsert=true)`: a document that already exists is never modified.
  Running the seed again inserts 0 documents.
- If a workbook row changed after the first seed, the difference is reported in the seed report as `drift`; it is **not applied**
  (application activity may already depend on the seeded value). Apply such a change deliberately through a migration.
- The application must write new documents with `_origin: "APP"` and `created_at`, and changes to seeded documents with
  `_app.modified_at` / `_app.modified_by`. `export_app_activity.py` exports exactly those documents.
- `seed_runs` and `import_manifests` record every seed run (manifest hash, inserted / already present counts, drift).

## Reconciliation

`reconcile_mongo.py` checks, per collection: document count, duplicate seed keys, the content hash of every unmodified seeded document,
and the set of seed hashes against the manifest. It then recomputes the totals in `manifest.json` from the database (counts per run,
points per worker and category, good tanks per order line, attended minutes per run, task-status counts, rework loops, plan rows) and
compares them. With `--bundle`, the as-seeded values of documents the application changed are taken from the bundle, so the totals
comparison stays exact; without it, totals that differ only because of application changes are reported as
`DIFFERS_DUE_TO_APPLICATION_CHANGES`, not as a failure. The same totals are embedded in Analytics `SEED_RECONCILIATION_TOTALS`.

## Credentials

PIN/password hashes, authentication sessions and deployment secrets are never in the workbooks (validation check SEC-01 scans every
column name and value). `setup_accounts.py` creates `accounts` documents with scrypt hashes; demo PINs are derived from `DEMO_PIN_SEED`
with HMAC and are neither stored nor printed (`--show-local-pins` prints them for local use only and is refused when `NODE_ENV` /
`APP_ENV` contains `production`). Re-running the command never resets a PIN, role or status. Only `ADMIN` has `manage_workers`.
Authentication sessions (`auth_sessions`) are created by the application at login.

`APP_SESSIONS` in the Events workbook is something else: synthetic historical device-login intervals (login / logout event IDs, device,
status) used for attendance analysis and replay. It contains no tokens or secrets.

## Tests

```bash
python3 export_seed_bundle.py --workbooks <Final folder> --out seed_bundle
SEED_BUNDLE=seed_bundle python3 -m unittest -v tests/test_seed.py
```

The tests use `seedlib.MemoryStore`, an in-process store implementing the operations the scripts use (unique index, `$setOnInsert`
upsert, `$set`, `$or` / `$exists` / `$ne` / `$in` filters). They cover: bundle = manifest; seeding the full bundle twice gives no
duplicates; re-seeding keeps application changes and application-created documents; a changed workbook row is reported, not applied;
accounts are created outside Excel and never reset; the reference totals reconcile inside the workbooks.

**Not yet verified against a MongoDB server.** The build environment had no access to package registries or MongoDB downloads, so
`MongoStore` (pymongo) has not been executed. Before relying on it, run steps 2-3 twice against a disposable Atlas database or a local
replica set and confirm: second seed inserts 0, `reconcile_mongo.py` returns PASS.
