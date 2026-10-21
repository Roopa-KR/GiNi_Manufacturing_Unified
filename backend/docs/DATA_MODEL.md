# Data model, indexes and migration notes

MongoDB (replica set; multi-document transactions are used for every command). All datetimes are BSON Dates in
**UTC**; plant-local display uses the session timezone (America/Bogota). Numbers are doubles/ints (no Decimal128).
Index definitions live in `contracts/indexes.json` (78 indexes on 62 collections) and are applied idempotently by
`node scripts/ensure-indexes.js` (API) and `python -m gini_engine indexes` (engine). State machines are in
`contracts/state_machines.json`, permissions in `contracts/permissions.json`.

## 1. Seeded collections (read-only for the application)

One collection per workbook sheet (`worker_master`, `routing_operations`, `task_assignments`, `inspection_header`,
`production_events`, …), every document tagged `dataset_id` and `_seed` (`workbook`, `sheet`, `row`, business `key`,
`content_sha256`, `dataset_version`). Reference analytics from the Analytics workbook are prefixed `ref_` and are never
used as live values (the application computes its own). Hidden `GT_*` ground truth is not seeded. Records carry
`EVENT_TIME` and `KNOWN_AT`: views at a time T show only records with both ≤ T (checkpoint and replay semantics).

The seed is **insert-only by business key**: running it again inserts nothing, never overwrites a document the
application changed (changes are recorded under `_app`), and reports a changed workbook row as drift instead of
applying it. `reconcile_mongo.py` compares document counts and the manifest's reference totals with the database (exit code 1 on FAIL).

## 2. Application collections

| Collection | Purpose | Key / unique index |
|---|---|---|
| `accounts` | login ID, scrypt PIN hash (`scrypt$16384$8$1$salt$digest`), roles, status, must-change flag | `dataset_id + login_id` unique |
| `auth_sessions` | server-side sessions: SHA-256 of the cookie value, CSRF hash, app kind, idle/absolute expiry | `SID_HASH` unique |
| `login_attempts` | throttle and audit of sign-ins | by login ID, IP, time |
| `idempotency_keys` | stored response per `session|actor|Idempotency-Key` + request hash | `KEY` unique |
| `jobs` | durable engine queue (lease, fence, attempts, backoff, dead letter) | `JOB_ID` unique; `DEDUP_KEY + DEDUP_OPEN` unique **partial** (one open job per key) |
| `notifications` | email outbox with delivery status, attempts, provider message ID | `DEDUP_KEY` unique (`session|alert|episode|transition`) |
| `audit_log` | administrative actions (worker changes, session create/reset/archive/purge, rule versions) | time |
| `rule_settings` | versioned, effective-dated rule configuration edits | `VERSION_NO` unique |
| `engine_workers` | engine heartbeats and status | `WORKER_ID` |
| `app_shift_roster` | roster rows for workers created in the application | `ROSTER_ID` unique |
| `continuation_shift_calendar`, `continuation_calendar_intervals`, `continuation_shift_roster` | synthetic calendar continuation after the last recorded day (ASM-APP-CAL-01) | `dataset_id + business key` unique |

Workers created in the admin app are added to `worker_master`/`worker_qualifications` with `_origin: APP` (never
`_seed`), so re-seeding cannot overwrite them.

## 3. Session collections (`sim_*`, one simulation branch each)

Every document carries `SESSION_ID`; uniqueness is per session (`SESSION_ID + business ID`), so branches never collide
and a record from another run cannot leak into a session view.

| Group | Collections |
|---|---|
| Session and log | `sim_sessions` (clock anchors, mode, status, counters, `EVENT_SEQ`, `ENGINE` lease/fence/watermark, `PROJECTION_VERSION`), `sim_events` (immutable envelope: `EVENT_SEQ` unique per session, type, entity, event/known/received time, actor, command, correlation/causation, idempotency key, payload) |
| Plant state | `sim_units`, `sim_operations`, `sim_tasks`, `sim_workers`, `sim_equipment`, `sim_materials`, `sim_material_requests`, `sim_plan_releases`, `sim_participation` (labour segments; one open segment per worker — unique **partial** index), `sim_milestones`, `sim_attendance`, `sim_attendance_corrections`, `sim_transfers`, `sim_overtime`, `sim_handovers`, `sim_support_requests` |
| Quality | `sim_inspections`, `sim_readings`, `sim_evidence`, `sim_holds`, `sim_dispositions`, `sim_returns`, `sim_defects`, `sim_investigations`, `sim_replacements` |
| Engine output | `sim_projections` (versioned: ORDER_FORECAST_SUMMARY, WORK_CENTER_SUMMARY, OPERATION_FORECAST, RULE_EVALUATION, WORKER_METRICS, ACTION_VERIFICATION), `sim_alerts`, `sim_alert_transitions`, `sim_points_ledger` (append-only; `AWARD_KEY + WORKER_ID` unique), `sim_forecasts` (immutable recovery simulations), `sim_actions` |

Creating a session writes only the `sim_sessions` document and an `INIT_SESSION` job; the engine reduces the source run
at the checkpoint (records with `EVENT_TIME` and `KNOWN_AT` ≤ fork) into these collections. Reset deletes only that
session's `sim_*` records and re-initialises. Archive stops the engine for the session; `scripts/purge-archived-sessions.js`
reclaims the storage (status `PURGED`, counts kept).

## 4. Footprint (local fixture; verify on Atlas)

* Seed: 123 collections, ~539k documents, ~520 MB as JSON (≈ 180 MB `ref_*`). Plan ≥ 1 GB of Atlas storage.
* An initialised session: ~1,200–2,500 documents; a session running for a simulated day adds events, segments,
  projections (only the 3 latest projection versions are kept) and alerts — typically tens of thousands of documents.
* Indexes: 78 secondary indexes; the largest are on the seeded event collections.

## 5. Migrations

There is one schema version (1.0). Changes are additive and applied by idempotent scripts:

| Script | Effect |
|---|---|
| `scripts/ensure-indexes.js` / `python -m gini_engine indexes` | create missing indexes from `contracts/indexes.json` (safe to re-run) |
| `seed/setup_accounts.py --migrate-roles` | rewrite only roles of setup-created accounts whose stored role is unknown to the permission contract (legacy `QUALITY` → `INSPECTOR`), recording each change |
| engine start | `continuation.ensure()` upserts the calendar continuation by business key |
| `scripts/purge-archived-sessions.js` | optional storage reclaim |

Requirements on the server: replica set (transactions), partial indexes (MongoDB ≥ 3.2; Atlas current versions),
`$setOnInsert`/`findOneAndUpdate` semantics of MongoDB ≥ 4.4. Verify these with the real-MongoDB gate before the demo
(IMPLEMENTATION_STATUS.md, "Real MongoDB gate").

## 6. Fresh Factory database (`GINI_ENVIRONMENT=FRESH_FACTORY`)

A fresh-factory database (e.g. `gini_factory_teamtest`) holds **no seeded workbook data**. The same collection names are
used, but every configuration document is created by an administrator in the app (`_origin: APP`, `dataset_id:
GINI-FRESH-FACTORY`, `CONFIG_VERSION`, `CREATED_BY/AT`, `UPDATED_BY/AT`), and every operational document belongs to the one
permanent session `S-FACTORY` (`FACTORY_SESSION: true`, `SOURCE_RUN_ID: NO-HISTORY`, no checkpoint, real-time clock).
Setup guide: `FRESH_FACTORY_SETUP.md`.

### New collections

| Collection | Purpose | Key / unique index |
|---|---|---|
| `factory_settings` | factory name, site ID, plant timezone, operating mode (`MANUAL_TEAM_TEST` / `SIMULATED_TEST`), tank serial prefix, setup timestamps | `dataset_id` unique (one document) |
| `shift_templates` | shift code, start/end (overnight allowed), breaks, workdays, version; generates `shift_calendar` / `calendar_intervals` 60 days ahead and `app_shift_roster` rows | `dataset_id + SHIFT_CODE` unique |
| `ctq_check_history` | previous versions of inspection checklists (archived when a new version is saved; open inspections keep their pinned `CHECKLIST_SNAPSHOT`) | by gate + version |
| `routing_operations_history` | previous route revisions of a product (archived on revision; refused while tanks of that product are active) | by product + `ROUTE_VERSION` |
| `factory_reset_log` | every guarded reset: who, when, database, preview counts, options, removed counts, status | `RESET_ID` unique |
| `sim_scans` | every tank / station label scan: `SCAN_ID`, `SCANNED_AT`, `WORKER_ID`, `CODE`, `PURPOSE` (CONFIRM_TASK / CONFIRM_UNIT / CONFIRM_INSPECTION / LOCATE / LOOKUP), `RESULT` (MATCH / WRONG_TANK / UNKNOWN / FOUND / STATION…), `METHOD`, `UNIT_ID`, `EXPECTED_UNIT_ID`, `STATION_ID`, `TASK_ID`; events `TANK_SCANNED` / `TANK_SCAN_MISMATCH`. The label is the tank serial - no separate barcode ID | `SESSION_ID + SCAN_ID` |
| `catalog_stamp` | one counter bumped on every configuration change so the API and the engine reload configuration immediately | `_id` |

### Fields added to existing collections (fresh factory only)

* `product_master`: `STATUS` (`DRAFT` / `RELEASED` / `INACTIVE`), `ROUTE_VERSION`, `CONFIG_VERSION`.
* `ctq_check_master`: `DEFAULT_SPECS` (lower/upper/target/unit used when no product-specific specification exists), `ACTIVE`, `CHECKLIST_VERSION`, `SEQUENCE_NO`.
* `production_orders` / `order_lines`: `CUSTOMER_ORDER_REF` (optional, unique per session), `QUANTITY_BASIS: ACCEPTED_GOOD` (required quantity = accepted good tanks, not attempts), `ROUTE_VERSION` pinned at order creation.
* `sim_units`: `TANK_ID` `TNK-FACTORY-#####` and `TANK_SERIAL_NO` `<PREFIX>-<YY>-#####` (unique per session), `ROUTE_VERSION`, `IDENTITY_ORIGIN`.
* `sim_units` (scanning): `LAST_SCANNED_AT/BY`, `LAST_SCANNED_STATION_ID/AT` (location by label scan; never changes the route step).
* `factory_settings` / `sim_sessions`: `SCAN_REQUIRED { START_WORK, INSPECTION }`.
* `sim_inspections`: `CHECKLIST_SNAPSHOT` (checks and limits as they were when the inspection started).
* `sim_workers`: `CONTROL.MODE` `HUMAN_ONLY` (real people) or `AGENT` (only workers flagged `SIMULATED_WORKER`, only in `SIMULATED_TEST`).
* `worker_master`: `SIMULATED_WORKER`, `EMPLOYEE_NO` (duplicate check), `START_DATE` (`FUTURE_START` roster status).

### Fresh-factory indexes (`contracts/factory_indexes.json`, created by `npm run factory:init` only)

`sim_units SESSION_ID+TANK_SERIAL_NO` (unique, partial) · `production_orders SESSION_ID+CUSTOMER_ORDER_REF` and
`SESSION_ID+ORDER_ID` (unique, partial) · `factory_settings dataset_id` · `dataset_id + <ID>` unique on
`work_center_master`, `workstation_master`, `skill_master`, `equipment_master`, `material_master`, `product_master`,
`shift_templates`, `shift_calendar`, `ctq_check_master` · `factory_reset_log RESET_ID`.

### Migration

None for existing databases: everything above is additive and is only written in a database whose environment is
`FRESH_FACTORY`. `factory:init` refuses a database that holds the synthetic demonstration, and the seed tools refuse a
fresh-factory database, so the two kinds of database never mix.
