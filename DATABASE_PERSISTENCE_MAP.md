# Database persistence map

MongoDB is authoritative. The browser holds only clearly labelled unsynced drafts: inspection drafts kept in `localStorage` while offline are labelled
"Pending sync (kept on this device)" / "Offline - pending sync" until the server confirms "Draft saved on the server". Every business action is a **command**. It runs through
`backend/src/domain/executor.js` in **one MongoDB transaction** (`readConcern: snapshot`, `writeConcern: majority`, primary). The
transaction performs these steps:

1. Re-check the idempotency key *inside* the transaction, so a write-conflict retry replays the committed result.
2. Validate the state.
3. Update entities with optimistic `VERSION` checks.
4. Append immutable `sim_events`.
5. Write one `sim_change_log` change set holding before/after values for every record touched.
6. Enqueue the dependent `RECALC` job.
7. Store the response under the idempotency key.

A success response is sent only after the commit. A commit whose outcome is unknown returns `503 COMMIT_OUTCOME_UNKNOWN`. The
client retries with the **same** key, and the stored result is replayed, so the action is never applied twice. A network or
transient error returns `503 DATABASE_UNAVAILABLE` ("your change was not saved").

## Audit metadata per action

| Required metadata | Where |
|---|---|
| Action / event ID | `sim_events.EVENT_ID` (sequenced `EVENT_SEQ` per session); `sim_change_log.CHANGE_SET_ID` |
| Actor / worker | `ACTOR_ID`, `ACTOR_LOGIN`, `ACTOR_TYPE` (HUMAN / AGENT / SYSTEM), `ON_BEHALF_OF` |
| Session / run / dataset | `SESSION_ID`, `RUN_ID`, `DATASET_ID` on events, change sets and every `sim_*` record |
| Entity | `sim_events.ENTITY_TYPE / ENTITY_ID`; `sim_change_log.CHANGES[].COLLECTION / ENTITY_KEY / RECORD_ID` |
| Event time and KNOWN_AT | `EVENT_TIME` (simulated), `KNOWN_AT`, `RECEIVED_AT` (wall) |
| Action type and reason | `COMMAND_TYPE`, `EVENT_TYPE`, `REASON` (from the payload's reason / reasonCode / note) |
| Before / after values | `sim_change_log.CHANGES[].BEFORE / AFTER` (changed fields only; inserts record the full document) |
| Correlation ID and idempotency key | `CORRELATION_ID`, `CAUSATION_ID`, `IDEMPOTENCY_KEY`; `idempotency_keys` stores the request hash and response |
| Record version | `VERSION` on every entity; `CHANGES[].VERSION_BEFORE / VERSION_AFTER` |
| Source | `SOURCE` (UI / AGENT / SCENARIO / SYSTEM) |

Secrets are never copied into audit payloads. Fields matching `PIN|PASSWORD|TOKEN|SECRET|HASH|CREDENTIAL` are recorded as
`[REDACTED]`. The integration test asserts that the change log holds no scrypt hash.

`sim_change_log` is deliberately **not** deleted by a session reset. The reset itself is audited in `audit_log` with the removed
counts and the new `RESET_GENERATION`.

## Administrative actions: one transaction with their audit record

The review found that worker administration wrote the worker first and the audit record afterwards, so a failure could leave
permissions, sign-in revocation or the audit trail incomplete. Every multi-record administrative action now commits its business
writes **and** its `audit_log` record in one transaction (`services/audit.adminTx`, `lib/db.withTransaction`).

| Action | Records in the same transaction |
|---|---|
| Create worker | worker-ID counter, `worker_master`, `app_users`, `worker_qualifications`, `app_shift_roster`, `accounts` (PIN hash), `sim_workers` in every live session, `audit_log` (after values, hash redacted), `admin_requests` |
| Update worker / role change | `worker_master`, `accounts` (roles, permissions), revocation of the person's open sign-ins (`auth_sessions`, role changes only), `worker_qualifications`, `audit_log` (before/after) |
| Deactivate / activate | `worker_master`, `accounts.status`, revocation of open sign-ins, `audit_log` (before/after, revoked count). History is never touched. |
| Reset PIN | `accounts.pin_hash`, `audit_log` (no PIN or hash in the record) |
| Approve / withdraw a rework standard | `rework_standards` (new version, previous one SUPERSEDED), `audit_log` |
| Confirm a points-policy version | `points_policy_versions`, `audit_log` |
| Save a rule version | `rule_settings`, `audit_log` (before/after rules) |
| Create / archive a session | `sim_sessions`, first job, `audit_log` |
| Reset a session | Three steps, each safe to repeat. (1) One transaction: `RESETTING` + `SESSION_RESET_STARTED` audit. (2) Delete only this session's records. (3) One transaction: re-initialise + job + `SESSION_RESET_TO_CHECKPOINT` audit with removed counts. An interrupted reset finishes when called again. |
| Change own PIN; retry a dead job | the change and its `audit_log` record |

`audit_log` rows carry `AUDIT_ID`, `AT`, `ACTOR`, `ACTION`, `TARGET`, `DETAILS`, `BEFORE`, `AFTER`, `IDEMPOTENCY_KEY` and
`REQUEST_ID`. Secrets are redacted by the same rule as above.

**Retries.** With an `Idempotency-Key` header (the admin app sends one per form submission), the stored result in
`admin_requests` (unique key) is returned for a retry of the same request. A different body with the same key is refused with 409
`IDEMPOTENCY_KEY_REUSED`. A concurrent duplicate loses on the unique index and receives the winner's result.

**Test.** `tests/integration/admin-atomic.test.js` forces the audit write to fail during create, update with a role change,
deactivate and PIN reset. It asserts that the worker, account (roles, permissions, status, PIN hash), qualifications, roster rows,
live-session rows, sign-ins and the worker-ID counter are all unchanged. It then tests the real actions, the idempotent HTTP
retry, the refused key reuse, and that history is kept after deactivation.

## Collections

### Source (seeded; never edited by the app)

The 146 collections from the three Final workbooks: master, plan, history events and `ref_*` analytics. Each carries `_origin: SEED`
and `_seed {workbook, sheet, row, key, content_sha256}`. Reseeding is insert-only, and drift is reported, not applied
(DATA_IMPORT_REPORT.md).

### Application master and configuration (validated input, global)

| Collection | Written by | Notes |
|---|---|---|
| `product_master`, `routing_operations`, `ctq_specifications`, `material_requirements` (`_origin: APP`) | `POST /api/admin/master/products` (`masterData.createProduct`) | One transaction, written only when routing, standards, inspection specs and materials are complete; `audit_log` entry |
| `worker_master`, `worker_qualifications`, `app_shift_roster` (`_origin: APP`) | `POST /api/admin/workers` (admin only) | onboarding fields; join-current-shift or future-shift roster |
| `accounts` | `setup_accounts.py`, admin worker creation | scrypt PIN/password hash; insert-only; never in Excel or logs |
| `auth_sessions` | sign-in | hashed session id, CSRF hash, idle/absolute expiry; login never clocks in |
| `rule_settings` | `PUT /api/admin/rules` | versioned, effective-dated; one transaction with its audit record |
| `rework_standards` | `POST /api/admin/master/rework-standards` (`/withdraw`) | approved rework labour standards: named approver, statement, version, effective date; earlier versions SUPERSEDED, never deleted |
| `points_policy_versions` | `POST /api/admin/points-policy` | confirmed points-policy versions (confirmer, statement, effective date, hash); shipped default = client formula |
| `admin_requests` | every admin write sent with an `Idempotency-Key` | request fingerprint (no PIN) and the committed result, for safe retries |
| `audit_log` | admin actions, session lifecycle | actor, action, target, details, before/after, idempotency key; written in the same transaction as the action |

### Session (interactive branch; every document has `SESSION_ID`, `RUN_ID`, `DATASET_ID`, `VERSION`, `CREATED_AT`, `CREATED_SIM_AT`)

| Collection | Business actions (commands) |
|---|---|
| `sim_sessions` | create / clock (PLAY, PAUSE, SPEED, SEEK) / reset / archive. Holds `EVENT_SEQ`, `COUNTERS`, `ENGINE` (lease, watermark, next boundary), `PROJECTION_VERSION`, `RESET_GENERATION`, `NOTIFY`. |
| `sim_workers`, `sim_attendance`, `sim_attendance_corrections`, `sim_participation` | CLOCK_IN/OUT, BREAK_START/END, ATTENDANCE_CORRECTION, ABSENCE_CONFIRM, TAKE/RELEASE_CONTROL; participation segments (category, reason, start/end) |
| `sim_tasks`, `sim_operations`, `sim_milestones`, `sim_progress` | TASK_ASSIGN/ACCEPT/START/PAUSE/RESUME/JOIN/HANDOVER/FINISH, OPERATION_START, MILESTONE_COMPLETE, PROCESS_COMPLETE |
| `sim_units`, `sim_plan_releases`, `sim_batch_membership`, `sim_batches` | BATCH_RELEASE, BATCH_SPLIT (one open membership per tank; unique `OPEN_KEY`), UNIT_RELEASE/ARRIVE, ORDER_CREATE (plan releases) |
| `production_orders`, `order_lines`, `production_batches`, `production_plan` rows **with `SESSION_ID`** | ORDER_CREATE (validated; visible to that session only) |
| `sim_inspections`, `sim_readings`, `sim_evidence` | INSPECTION_START / SAVE_DRAFT / SUBMIT; EVIDENCE_REQUEST_UPLOAD / MARK_VERIFIED. Cloudinary (or local) asset metadata: public id, bytes, dimensions, checksum, retake/supersedes. |
| `sim_holds`, `sim_dispositions`, `sim_defects`, `sim_investigations`, `sim_returns`, `sim_replacements` | DISPOSITION_DECIDE, RETURN_DISPATCH/ARRIVE, INCOMING_DEFECT_REPORT, INVESTIGATION_UPDATE (validated responsibility), REPLACEMENT_REQUEST/APPROVE |
| `sim_materials`, `sim_material_requests` | MATERIAL_REQUEST / DELIVERY / SHORTAGE / ISSUE / ISSUE_REVERSE / REQUEST_CANCEL |
| `sim_equipment` | EQUIPMENT_BREAKDOWN / REPAIRED |
| `sim_transfers`, `sim_overtime`, `sim_handovers`, `sim_support_requests` | WORKER_TRANSFER / TRANSFER_ARRIVE, OVERTIME_APPROVE, RELIEF_CALL_IN (also a session-scoped `app_shift_roster` row), TASK_HANDOVER, HELP_REQUEST / SUPPORT_RESOLVE |
| `sim_alerts`, `sim_alert_transitions` | engine lifecycle; ALERT_WORKFLOW (ACK / START / CLOSE) |
| `sim_actions`, `sim_forecasts` | ACTION_PROPOSE / APPROVE / REJECT / START / COMPLETE. The baseline, options, approvals, planned/actual times, handover, output and forecast error are stored. `sim_forecasts` rows are immutable (`IMMUTABLE: true`, insert-only by `FORECAST_ID`). |
| `sim_events` | immutable, sequenced event log of every command |
| `sim_change_log` | before/after audit (survives reset) |
| `idempotency_keys` | key = session + login + Idempotency-Key; request hash; committed response |

### Projections (engine; versioned and fenced)

| Collection | Content |
|---|---|
| `sim_projections` | `ORDER_FORECAST_SUMMARY`, `WORK_CENTER_SUMMARY`, `OPERATION_FORECAST`, `RULE_EVALUATION`, `WORKER_METRICS`, `ACTION_VERIFICATION`. Each carries `PROJECTION_VERSION`, `CALCULATION_ID`, `AS_OF`, `INPUT_WATERMARK`, `RULE_VERSION`, `ENGINE_VERSION`, `COMPUTED_AT`, `TRIGGER`. Readers use `PROJECTION_VERSION <= session.PROJECTION_VERSION`. |
| `sim_points_evaluations` | one document per points subject (status, reason, evidence and hash, desired allocation, booked net, calculation id, as-of) plus the `__STATE__` watermark |
| `sim_points_ledger` | append-only points rows (award, deduction, reversal with links); unique `(SESSION_ID, AWARD_KEY, WORKER_ID)` and `(SESSION_ID, POINTS_TRANSACTION_ID)` |
| `notifications` | durable outbox: `DEDUP_KEY` unique; PENDING → CLAIMED → SENT / CAPTURED / RETRY / FAILED / UNCERTAIN / SUPPRESSED |
| `jobs`, `engine_workers` | durable jobs with lease, fence, retries, dead letter; worker heartbeats |

## State survives restart and reload

| Restart or reload | What happens |
|---|---|
| API restart | The API is stateless apart from the cached connection and master-data cache. |
| Engine restart | Leases expire and another worker resumes from `ENGINE.SIM_AT` and the stored watermark. Overdue deadline boundaries are evaluated at once. Points re-evaluate every subject once. |
| Browser reload | Re-reads everything from the API. Unsynced inspection drafts are restored from the device and still labelled unsynced. |

Proof:

- `tests/integration/acceptance.test.js` AT2 (reload/sign-in never restarts work).
- `python_engine/tests_integration` (crash and restart of two workers).
- `tests/integration/reliability.test.js` (reset/archive scoped to one session; the change log survives).

## UI action → endpoint / command → collections / events → derived values → affected screens

Every command below is `POST /api/sessions/:sid/commands/<TYPE>` and requires an `Idempotency-Key`. Each one also writes
`sim_events`, `sim_change_log` and `idempotency_keys`, and enqueues a `RECALC` job.

### Operator app

| UI action | Command / endpoint | Main collections | Derived values recalculated | Affected screens |
|---|---|---|---|---|
| Sign in / sign out | `POST /api/auth/login`, `/logout` | `auth_sessions`, `audit_log` (login audit is separate from attendance) | none (no clock-in) | — |
| Clock in / out, break start/end | CLOCK_IN / CLOCK_OUT / BREAK_START / BREAK_END | `sim_workers`, `sim_attendance`, `sim_participation`, `sim_tasks` (paused) | labour categories, available labour (F2/M05), worker metrics | Work, Progress, Workforce, Overview |
| Accept / start / pause / resume / join / hand over / finish a task | TASK_ACCEPT … TASK_FINISH, TASK_JOIN, TASK_HANDOVER | `sim_tasks`, `sim_operations`, `sim_participation`, `sim_units`, `sim_handovers` | eligible minutes, TV1 points evaluation, F1/F4, forecast | Work, Queue, Task, Passport, Work centres |
| Complete a milestone | MILESTONE_COMPLETE | `sim_operations.MILESTONES_DONE`, `sim_milestones` | F1 progress evidence, progress fraction | Work, Passport |
| Self-check / gate inspection: draft, photo, submit | INSPECTION_START / SAVE_DRAFT / SUBMIT, EVIDENCE_REQUEST_UPLOAD / MARK_VERIFIED | `sim_inspections`, `sim_readings`, `sim_evidence` (Cloudinary metadata), `sim_holds`, `sim_defects`, `sim_investigations`, `sim_dispositions` | gate fail rate (M06), points pending/allocated, forecast | Inspection, Quality board, Passport |
| Report an incoming defect | INCOMING_DEFECT_REPORT | `sim_defects`, `sim_investigations`, `sim_holds`, `sim_tasks` (paused) | DD4 evaluation (PENDING), forecast (held tank) | Quality, Passport, Progress (pending investigations) |
| Ask for help | HELP_REQUEST | `sim_support_requests` | — | Work, admin support list |

### Supervisor/admin app

| UI action | Command / endpoint | Main collections | Derived values recalculated | Affected screens |
|---|---|---|---|---|
| Disposition, return dispatch/arrival, replacement | DISPOSITION_DECIDE, RETURN_DISPATCH / ARRIVE, REPLACEMENT_REQUEST / APPROVE | `sim_dispositions`, `sim_returns`, `sim_holds`, `sim_units`, `sim_replacements`, `sim_batch_membership` | batch good/scrap/replacement summary, NR3/OF2, forecast | Quality, Orders, Passport |
| Confirm / correct an investigation | INVESTIGATION_UPDATE | `sim_investigations` | DD4 / TV1 re-evaluation with linked reversals | Quality, Passport, Progress |
| Split a batch | BATCH_SPLIT | `sim_batches`, `sim_batch_membership`, `sim_units` | batch summaries | Orders, Passport |
| Enter a new order / plan | ORDER_CREATE, then BATCH_RELEASE | `production_orders` / `order_lines` / `production_batches` / `production_plan` (with `SESSION_ID`), `sim_plan_releases`, `sim_units` | forecast lines, bands, WO points | Orders, Recovery, Passport |
| Create a product | `POST /api/admin/master/products` | `product_master`, `routing_operations`, `ctq_specifications`, `material_requirements`, `audit_log` | catalogue (routing) | Administration, Orders |
| Create / edit / deactivate a worker, reset a PIN | `POST /api/admin/workers`, `PATCH /api/admin/workers/:id`, `/deactivate`, `/activate`, `/reset-pin` (one transaction each, `Idempotency-Key`) | `worker_master`, `worker_qualifications`, `app_users`, `app_shift_roster`, `accounts`, `auth_sessions` (revocations), `sim_workers`, `audit_log`, `admin_requests` | roster, available labour, permissions | Workforce, Administration |
| Approve a rework standard | `POST /api/admin/master/rework-standards` | `rework_standards`, `audit_log` | rework time points (pending → awarded), `sim_operations.REWORK_STANDARD` on new attempts | Administration → Rule settings, Progress, passport |
| Confirm a points policy | `POST /api/admin/points-policy` | `points_policy_versions`, `audit_log` | all points re-evaluated (linked reversals) | Administration → Rule settings, Progress |
| Transfer / call in relief / overtime | WORKER_TRANSFER → TRANSFER_ARRIVE, RELIEF_CALL_IN, OVERTIME_APPROVE | `sim_transfers`, `sim_overtime`, `app_shift_roster` (with `SESSION_ID`), `sim_workers` | F2, available labour, forecast | Workforce, Recovery, Verify |
| Materials | MATERIAL_REQUEST / DELIVERY / SHORTAGE / ISSUE / ISSUE_REVERSE | `sim_materials`, `sim_material_requests` | F3, F6, forecast material constraint | Materials, Alerts |
| Equipment | EQUIPMENT_BREAKDOWN / REPAIRED | `sim_equipment`, `sim_tasks` (paused, no-fault) | M11, forecast | Materials & equipment, Alerts |
| Acknowledge / start / close an alert | ALERT_WORKFLOW | `sim_alerts`, `sim_alert_transitions` | none (acknowledging never resolves) | Alerts |
| Recovery: generate, propose, approve, start, complete | `POST /recalculate {kind: RECOVERY}`, ACTION_PROPOSE / APPROVE / REJECT / START / COMPLETE | `jobs`, `sim_forecasts` (immutable), `sim_actions` | verification (before/after/actual, forecast error) | Recovery, Verify |
| Rule settings | `PUT /api/admin/rules` | `rule_settings` (new version, effective-dated), `audit_log` | all variance evaluations from the effective time | Administration, Alerts |
| Clock / reset / archive a simulation | `POST /sessions/:sid/clock`, `/reset`, `/archive` | `sim_sessions` (+ `sim_events` CLOCK_*), session collections deleted on reset, `audit_log` | boundaries, all projections | every screen (header clock) |
| Import / reconcile | `import_workflow.py` | `seed_runs`, `import_runs`, `reconciliation_reports`, `import_manifests` | — | Administration → Import |

## Fresh Factory (`GINI_ENVIRONMENT=FRESH_FACTORY`)

Separate, empty database (`gini_factory_teamtest` in the delivered `.env`). No workbook data. One permanent session
`S-FACTORY`; operator and admin apps use the **same** database through the same API. Details: `FRESH_FACTORY_SETUP.md`,
`backend/docs/DATA_MODEL.md` §6.

### Configuration (admin app → Factory setup; permission `factory_configuration`; each save = one transaction + `audit_log` row + RECALC job + `catalog_stamp` bump)

| UI action | Endpoint | Collections |
|---|---|---|
| 1 · Factory settings | `PUT /api/factory/settings` | `factory_settings`, `sim_sessions` (name, mode, timezone, serial prefix) |
| 2 · Work centres / stations | `PUT /api/factory/work-centers/:id`, `PUT /api/factory/stations/:id` | `work_center_master`, `workstation_master` |
| 3 · Skills | `PUT /api/factory/skills/:id` | `skill_master` |
| 4 · Equipment | `PUT /api/factory/equipment/:id` | `equipment_master`, `equipment_operation_map`, `sim_equipment` (S-FACTORY, UP) |
| 5 · Materials | `PUT /api/factory/materials/:id` | `material_master`, `sim_materials` (stock 0) |
| 5 · Receive stock | command `MATERIAL_RECEIPT` (lot, qty; duplicate lot refused) | `sim_materials`, `sim_events` |
| 6 · Shifts | `PUT /api/factory/shifts/:code`, `POST /api/factory/calendar/regenerate` | `shift_templates`, `shift_calendar`, `calendar_intervals`, `app_shift_roster` |
| 7 · Products, route, crew, labour standards, milestones, BOM | `POST /api/factory/products`, `POST /api/factory/products/:id/release` | `product_master`, `routing_operations` (+`routing_operations_history` on revision), `route_dependencies`, `crew_capacity_rules`, `operation_skill_requirements`, `milestone_definitions`, `operation_instructions`, `instruction_steps`, `material_requirements` |
| 8 · Checklists | `PUT /api/factory/checklists/:gate` | `ctq_check_master` (+`ctq_check_history`), `ctq_specifications` |
| 9 · Workers | `POST /api/admin/workers` | `worker_master`, `worker_qualifications`, `accounts` (scrypt hash only), `app_shift_roster`, `sim_workers` (HUMAN_ONLY, not clocked in) |
| Template import (optional) | `POST /api/factory/template/import` | configuration collections above, marked `ORIGIN: ILLUSTRATIVE_TEMPLATE` |

### Operations (session `S-FACTORY`)

| UI action | Command | Collections |
|---|---|---|
| Orders → New work order (wizard) | `ORDER_CREATE` | `production_orders`, `order_lines` (`QUANTITY_BASIS: ACCEPTED_GOOD`, `ROUTE_VERSION`), `production_batches`, `production_plan` |
| Orders → Add batch | `BATCH_CREATE` | `production_batches`, `production_plan` |
| Orders → Release batch | `BATCH_RELEASE` | `sim_units` (new `TANK_ID` + `TANK_SERIAL_NO`), `sim_plan_releases`, `sim_batches`, `sim_batch_membership`, `sim_operations`, `sim_events` |
| Dispatch → Assign | `OPERATION_START` / `TASK_ASSIGN` | `sim_operations`, `sim_tasks`, `sim_events` |
| Operator: clock in, start, milestones, finish | `CLOCK_IN`, `TASK_START`, `MILESTONE_COMPLETE`, `TASK_FINISH` | `sim_attendance`, `sim_workers`, `sim_tasks`, `sim_participation`, `sim_milestones`, `sim_events` |
| Operator / inspector: Scan, Confirm tank, Scan & inspect, Scan & join, record location | `SCAN_RECORD` | `sim_scans`, `sim_events` (`TANK_SCANNED`, `TANK_SCAN_MISMATCH`), `sim_units.LAST_SCANNED_*`; enforced by `TASK_START` / `INSPECTION_START` when `SCAN_REQUIRED` is on |
| Inspector: inspect, submit | `INSPECTION_START`, `INSPECTION_SUBMIT` | `sim_inspections` (`CHECKLIST_SNAPSHOT`), `sim_readings`, `sim_holds`, `sim_events` |
| Rework / scrap / replacement | `DISPOSITION_DECIDE` | `sim_dispositions`, `sim_returns`, `sim_replacements`, `sim_units` (replacement gets a new identity) |
| Engine (Python) | forecast, cutoffs, alerts, points, roster pointer | `sim_projections`, `sim_forecasts`, `sim_alerts`, `sim_points_ledger`, `sim_points_evaluations`, `notifications` (capture mode) |

### Guarded reset (optional; `ALLOW_FACTORY_RESET=true`, never in production, permission `factory_reset`)

`GET/POST /api/factory/reset`. Deletes the `S-FACTORY` documents of the session collections and of the session-tagged
order collections, the session's jobs / pending notifications / idempotency keys, ends operator sign-ins and recreates the
empty session. Kept: admin accounts, roles, `rule_settings`, `audit_log`, `factory_reset_log`, evidence files; workers and
configuration are kept unless `clearWorkers` / `clearConfiguration` is ticked. See `DATA_RESET_POLICY.md`.
