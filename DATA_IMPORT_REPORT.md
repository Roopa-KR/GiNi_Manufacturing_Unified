# Data import report — GiNi v3 Final workbooks

Run on 2026-10-18 (UTC) in the build workspace. Reports (JSON): `backend/docs/test-results/import/`.

| Item | Value |
|---|---|
| Dataset | `GINI-SYN-TANKS`, version `GINI-SYN-2026-10-17-v3.0-FINAL` |
| Package seed manifest SHA-256 | `065e1f4527d0f375a98a50c61790c8f952c407d4e92efa8a5f6f911fd890da4b` |
| Collections / documents | 146 collections, 595,781 documents (1,402 package totals re-checked) |
| Import driver | real **pymongo 4.10.1** (built from the official GitHub tag) |
| Database used | **docdb-wire TEST SUBSTITUTE** (speaks the MongoDB wire protocol as replica set `rs0`; it is **not MongoDB**). A real MongoDB server could not be obtained here (Docker Hub, MongoDB downloads, apt and PyPI are blocked). |
| Real MongoDB replica-set run | **BLOCKED** — command below; must be run before acceptance |

## Source workbooks (unchanged; shipped in `backend/data/final/`)

| Workbook | Bytes | SHA-256 |
|---|---|---|
| Siemens_Manufacturing_Master_Final.xlsx | 482,214 | `c71e216ad85e3988dc164a1d551bace26fe9ccc26b021197ccfba4282d5c6684` |
| Siemens_Manufacturing_Events_Final.xlsx | 32,087,757 | `a38fc87f22dba288376cd64a954177310c6125a86a125a738717a329af1ce23e` |
| Siemens_Manufacturing_Analytics_Final.xlsx | 1,383,937 | `b1933a651d0449097e0fa5b3a3b7a42b6cad9024a4f4657bb2903c651ffe01b8` |

`backend/data/final/SHA256SUMS` holds these checksums, and `package_manifest.json` is the package's own seed manifest. The Master
workbook is byte-identical to the one supplied earlier. The earlier build used v2-regenerated Events/Analytics as a stand-in; that
fixture is no longer used anywhere.

## Workflow (`backend/seed/import_workflow.py`)

```
python import_workflow.py verify                      # steps 1-4, no database
python import_workflow.py seed                        # steps 1-7 against MONGODB_URI / MONGODB_DB_NAME
MONGODB_DB_NAME=gini_import_gate python import_workflow.py gate --drop-after   # steps 1-9 on a disposable database
```

The gate refuses to run unless the database name contains `gate`, `test`, `tmp` or `disposable`, so it can never run against a customer or production database.

| Step | What it does | Result (docdb-wire substitute) |
|---|---|---|
| 1–2 Locate and verify | Finds the three `*_Final.xlsx` files and checks them against `SHA256SUMS`. Fails with exit code 2 and a clear message when a file is missing or changed. | PASS. Missing-file and changed-file cases were tested and fail clearly (exit 2, `MISSING required workbook …` and `CHECKSUM MISMATCH …`). |
| 3 Validate | 41 required collections; business keys unique and non-null (118 PASS; 28 documentation sheets keyed by source row are NOT_APPLICABLE, with uniqueness still checked). All 174 relationships of `contracts/reference_checks.json` are re-checked independently for each run on the resolved view; DELTA runs go through the dataset's own `scenario_resolver.py`. Every collection's count and content hash is compared with the package manifest. | **PASS**: 508 checks, 0 failed. 3,474,855 references checked, 0 missing. 173/173 FK counts equal the package's. 1 FK is NOT_APPLICABLE (a GT_ ground-truth table, because the package excludes ground truth). 146/146 collection hashes equal. Totals equal. |
| 4 Bundle | NDJSON per collection plus `manifest.json` in `backend/data/seed_bundle/` (generated, not shipped). | PASS |
| 5 Seed | Insert-only by business key. | 595,781 inserted, 0 drift |
| 6 Reconcile | Counts, per-document hashes and calculated totals against the bundle. | PASS, 155 checks |
| 7 Reseed | Seeds a second time. | 0 inserted, 0 drift (idempotent) |
| 8 Preservation | An application-modified seeded document (`RUN-BASE\|TSK-B-0000001`) and an application-created document survive the reseed unchanged and show up in reconciliation and the activity export. | PASS |
| 9 Drift | A changed workbook row (`worker_master W0001` display name) is reported as drift and **not** applied. | PASS |

`gini_demo` was seeded the same way (`import_seed_20261018T140533Z.json`: PASS). Afterwards, `node scripts/ensure-indexes.js` created
84 indexes and `seed/setup_accounts.py` created 196 + 1 accounts.

## Separation of data

| Kind | Where | Notes |
|---|---|---|
| Source (workbooks) | Seeded collections with `_origin: SEED` and `_seed` provenance (workbook, sheet, row, content hash) | Never edited by the app. A reseed never overwrites app changes. |
| Session (interactive branch) | `sim_*` collections with `SESSION_ID` | New orders, batches and plans entered in a session carry `SESSION_ID` and are invisible to other sessions and to history reduction. |
| Projection | `sim_projections`, `sim_points_evaluations` | Versioned, with a watermark and calculation id. |
| Auth | `accounts`, `auth_sessions` (hashed session id) | Hashes exist only there. Never in Excel, the bundle or logs. |

There is no future leakage. History is read with `EVENT_TIME <= cut AND KNOWN_AT <= cut`; the passport test asserts this for history rows.
Alternative runs (`RUN-ALT-*`, DELTA) resolve through `scenario_resolver.py` and are never merged into `RUN-BASE`.

## People and accounts

The data has 196 people:

| Role | Count |
|---|---|
| Production operators | 160 (the requirement is at least 150) |
| Quality inspectors | 12 |
| Maintenance technicians | 8 |
| Material handlers | 8 |
| Area supervisors | 4 |
| Shift managers | 2 |
| Quality supervisors | 2 |

Names are consistent fictional American names, with no duplicates and no mismatches between `worker_master` and `app_users`. IDs
keep their leading zeros (`W0001`…).

Accounts are created by the explicit `setup_accounts.py` command. They are linked to `WORKER_ID`, PINs are scrypt-hashed, and the
command is insert-only, so a reseed or a re-run never resets a PIN.

## Checkpoint reconciliation (CK-20261015-1055, 10:55 local)

| Measure | Reference sheet | App after initialisation | Explanation |
|---|---|---|---|
| People in plant view | 196 | 196 | equal |
| People working | 36 (PLANT_STATE WORKING, includes 2 repairing) | 34 WORKING + 2 REPAIRING | equal |
| People with active task | 158 | 62 | **Source conflict, documented below.** The 62 genuinely active people equal the reference's own 34 IN_PROGRESS + 28 PAUSED. |
| Queued tanks | 10 | 10 | equal |

**Source conflict (named reconciliation exception, not "fixed" in the data).** `REF_CHECKPOINT_WORKER_STATE` names a
`CURRENT_TASK_ID` for 158 people. The application keeps 62 of those tasks active (34 working, 28 paused). That matches the
reference's own 34 IN_PROGRESS + 28 PAUSED rows. The application is **not** forced back to 158.

Row-level evidence is in `backend/docs/test-results/import/checkpoint_task_exceptions.csv`, one row per referenced task. It is
recomputed from the imported Final data using **only records known at the checkpoint**. The `TASK_STATUS` column is derived at the
end of the dataset, so it is shown for information only and not used. To regenerate it:

```bash
python backend/seed/tools/checkpoint_task_exceptions.py --out backend/docs/test-results/import/checkpoint_task_exceptions.csv
```

The latest run gave:

| Finding | Rows |
|---|---|
| The application keeps the task active (task open, operation not finished at 10:55) | 62 |
| Not active: an `OPERATION_FINISHED` event for the task's operation was known before the checkpoint | 96 |
| … of those, the tank was also route-complete before the checkpoint | 67 |
| Last known task event for the 96 | `PAUSED`, 11.9 to 312.9 hours before the checkpoint (shift end or break) |
| Rows where the application's result disagrees with the as-of-checkpoint evidence | **0** |

**Correction.** An earlier version of this report said all 96 tanks were route-complete. That was wrong: it is 67 of 96. What all
96 have in common is that the operation had already finished before the checkpoint. The sheet's
`WORK_PERFORMED_STATE = WORK_COMPLETED_AWAITING_INSPECTION` for these rows describes the operation, not an open task, so the
application does not resume them.

## Not executed / blocked

- **Real MongoDB replica-set gate: BLOCKED.** No MongoDB binary or image is reachable here. Run it before acceptance:
  ```powershell
  docker compose up -d mongo     # or an Atlas test cluster
  $env:MONGODB_URI="mongodb://localhost:27017/?replicaSet=rs0"; $env:MONGODB_DB_NAME="gini_import_gate"
  python backend/seed/import_workflow.py gate --drop-after
  ```
- Excel formula sheets (`POINTS_RECON`) are recomputed from `points_ledger` by `reconcile_mongo.py`, not imported as formulas
  (per the package's `skipped_sheets`).
