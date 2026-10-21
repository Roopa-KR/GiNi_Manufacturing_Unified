# Implementation status — requirement → code → test → status

**Status date:** 2026-10-19, after the second review (FIX_REPORT.md §Second review, R1–R6).

**Status words:**

| Status | Meaning |
|---|---|
| **DONE / TESTED** | Implemented, and an automated test passed (TEST_RESULTS.md) |
| **DONE / PARTLY TESTED** | A named part is not automated |
| **BLOCKED** | Cannot run here; the reason and the command are given |
| **NOT_EXECUTED** | Not run |

**Context for every "TESTED".** Real Express 4.21.2, MongoDB driver 6.12.0, Nodemailer 6.9.16, PyMongo 4.10.1 and Chromium. The
database was the **docdb-wire TEST SUBSTITUTE**, not MongoDB. The data was the **actual Final workbooks**.

## 1. Gates

| Gate | Status | Next step |
|---|---|---|
| Final workbooks imported, validated, seeded twice, preservation, drift | **DONE / TESTED** on the substitute | DATA_IMPORT_REPORT.md |
| Same import gate on a disposable **real MongoDB replica set** | **BLOCKED**: no MongoDB server or image reachable (Docker Hub, fastdl.mongodb.org, apt blocked) | `docker compose up -d mongo`, then `MONGODB_DB_NAME=gini_import_gate python backend/seed/import_workflow.py gate --drop-after`, then every suite in QUICKSTART §8 |
| Real libraries | **DONE**: built from the official GitHub release tags, outside the package | — |
| npm/PyPI registry install and lockfiles | **BLOCKED here**: registries unreachable (the external review installed the published dependencies elsewhere) | DEPLOYMENT.md §Lockfiles: generate and commit `package-lock.json` × 3 (`npm ci` needs them) |
| `vite build` | **BLOCKED here** (rollup's native binary is not installable offline; esbuild `build:local` used). The external review (2026-10-19) built both apps with Vite on Node 24 | `npm ci && npm run build` in `frontend/` and `admin/` on Node 22 |
| Vercel × 3 / Render / Atlas deploy and smoke tests | **NOT_EXECUTED**: no credentials, and public deployment was not authorised | DEPLOYMENT.md §6 |
| Live Cloudinary upload | **NOT_EXECUTED**: no credentials; the local evidence mode runs the same sign → upload → verify flow (e2e 2) | DEPLOYMENT.md §5 |
| Live SMTP | **NOT_EXECUTED** (not authorised). Real Nodemailer against a **local fake SMTP server** passed: SENT / RETRY / FAILED / down / allowlist / capture. | DEPLOYMENT.md §6 12c |

## 2. Requirements by section

| § | Requirement | Code | Test | Status |
|---|---|---|---|---|
| 1 | Audit (implemented, incomplete, incorrect, substitutes, references) | — | — | DONE: FIX_REPORT.md |
| 2 | Every business action is durable (one transaction, events, outbox/jobs) | `domain/executor.js`, `commands/*` | integration suites (DB assertions in repair, reliability, acceptance) | DONE / TESTED |
| 2 | Audit metadata incl. before/after, correlation, idempotency key, version, source; secrets redacted | `executor.js` (`sim_change_log`), DATABASE_PERSISTENCE_MAP.md | repair "change log" | DONE / TESTED |
| 2 | A success response means committed; unknown commit → 503 retry with the same key | `executor.js`, `middleware/errorHandler.js` | acceptance AT20 (duplicates/race) | DONE / PARTLY TESTED (the unknown-commit path is code review only) |
| 2 | Administrative actions (worker create/edit/role/deactivate/PIN, rework standards, points policy, rule versions, session create/archive/reset) atomic with their audit record; safe retry | `services/audit.adminTx`, `workersAdmin.js`, `sessions.js`, `rules.js` | admin-atomic (injected audit failure → full rollback; idempotent retry; key reuse refused) | DONE / TESTED (R3) |
| 2 | Browser drafts labelled unsynced | `frontend/src/pages/Inspection.jsx` | — (manual) | DONE / PARTLY TESTED |
| 2 | Photos in Cloudinary, metadata in Mongo | `services/evidence.js`, `routes/evidence*.js` | e2e 2 (local evidence mode) | DONE / PARTLY TESTED (live Cloudinary NOT_EXECUTED) |
| 3 | Calculation id/version, rule version, as-of, watermark, computed-at, trigger, assumptions, freshness | `calc.py`, `points.py`, `recovery.py` | repair "boundaries"; test_publish | DONE / TESTED |
| 3 | Pre-action forecasts never overwritten | `sim_forecasts` insert-only, `sim_actions.BEFORE/AFTER_FORECAST` | engine "recovery" | DONE / TESTED |
| 3 | Failure → stale/unknown/error, never zero | `viewsCommon.freshness`, `ErrorState`, classify UNKNOWN | test_cutoff (UNKNOWN); UI runs | DONE / PARTLY TESTED |
| 4 | Three Final workbooks; steps 1–9; fail clearly when missing | `seed/import_workflow.py`, `contracts/reference_checks.json` | import reports; missing/changed-file runs | DONE / TESTED (real MongoDB BLOCKED) |
| 4 | Source / session / projection / auth separation; no future leakage; alternative runs isolated | `reduce.py` (`SESSION_ID: None`), view scoping, resolver | AT17; repair passport (no future rows); repair new order (other branch) | DONE / TESTED |
| 4 | Checkpoint reconciliation; named exception with row-level evidence (96 stale reference tasks) | `seed/tools/checkpoint_task_exceptions.py` | CSV: 158 references, 62 active, 96 not, 0 inconsistent | DONE / TESTED |
| 4 | ≥ 150 operators, consistent names | data (160 operators) | DATA_IMPORT_REPORT.md | DONE / TESTED |
| 5 | Accounts linked to WORKER_ID; hashed; leading zeros; insert-only; never in logs or Excel | `seed/setup_accounts.py`, `lib/pin` | unit pin tests; story permissions | DONE / TESTED |
| 5 | Checkpoint worker view (station, task, attendance, milestones, shift progress, points, next work, blockers); login ≠ clock-in | `operatorViews.home` | AT2; e2e 1 | DONE / TESTED |
| 5 | Admin-only onboarding, full fields, join-current vs next shift | `workersAdmin.js`, admin Workers form | story "admin creates a worker"; e2e 3; permissions (403); admin-atomic "onboarding" (NEXT_SHIFT) | DONE / TESTED |
| 6A | Fractional TV1, exact crew residual | `points.tv1_split` | test_points, test_points_ledger | DONE / TESTED |
| 6B | WO re-evaluation, append-only reversals, unchanged evidence posts nothing, all rules | `points.py` reconcile | test_points_ledger (5 cases); repair DD4 | DONE / TESTED |
| 6C | Pending allocation | `points.py`, operator Progress | test_pending_until_gate_then_allocated | DONE / TESTED |
| 6D | Responsibility validation | `commands/quality.js` INVESTIGATION_UPDATE | repair (8 rejection cases) | DONE / TESTED |
| 6E | Exact D-1 ≠ D-10 | `SUBJECT_KEY` exact | test_points_ledger; repair | DONE / TESTED |
| 6F | Eligible-time exclusions; no full allowance per member; no inspection timing | `points.eligible_minutes` | test_points_ledger (break excluded) | DONE / TESTED |
| 6F | Rework scored only against an APPROVED rework standard (approver, version, effective date); planning value ≠ approval | `domain/reworkStandards.js`, `OPERATION_START` provenance, `points.rework_standard` | test_points_ledger (3); standards-policy; quality (provenance) | DONE / TESTED (R4) |
| 6 | Scoring exceptions beyond the formula are versioned policy switches, OFF until confirmed | `services/pointsPolicy.js`, `points.load_policy` | test_points_ledger (default, confirmed, equipment); standards-policy | DONE / TESTED (R6; business decision pending) |
| 6G | Ledger reconciliation, links, retries, concurrency | `points.py`, `viewsCommon.pointsFor` | 4 concurrent engines; ledger = evaluations; AT9 | DONE / TESTED |
| 7 | Passport sections, "Not recorded", role protection, clickable IDs in both apps, search | `services/passport.js`, `PassportSections.jsx`, `TankLink` | repair passport; e2e tank passport | DONE / TESTED |
| 7 | Next action explained for every unit state in the contract | `passport.nextAction` | unit passport-next-action; repair passport (live tanks) | DONE / TESTED (R5) |
| 8 | Versioned CTQ checklists; drafts, evidence, camera/upload, retake, retry, server validation, conflicts, offline drafts | `Inspection.jsx`, `inspectionRules.js`, evidence | unit inspection rules; e2e 2; AT20 (conflicting submission) | DONE / PARTLY TESTED (camera hardware and offline reconnect are manual) |
| 8 | 11-step failure loop; alternate station needs approval; unknown stays held; escalation; legacy scrap only when selected | `commands/quality.js`, disposition matrix | story "operational story"; quality (2 tests) | DONE / TESTED (legacy-policy session is code review only) |
| 9 | WO → line → batch → tank → attempt; partial transfers (per-tank release); mixed states; split / membership history; no overlap | `BATCH_SPLIT`, `sim_batch_membership`, `plantViews.orderLine` | repair batch split | DONE / TESTED |
| 9 | 5 units, 1 scrap → 4 good; replacement satisfies the fifth | `orderLine` batch summary | repair batch replay (PB-00002) | DONE / TESTED |
| 9 | Validated product/order/plan input; product needs routing, standards, inspection config | `domain/masterData.js`, `commands/orders.js` | repair product/order | DONE / TESTED |
| 10 | Drill-down plant → work centre → worker/tank → history; worker fields incl. login separate from attendance | `plantViews.*` (`appSession`), admin pages | AT22; UI runs | DONE / PARTLY TESTED |
| 10 | Missing telemetry ≠ idle; nobody productive at two stations; full roster; transfer departure → travel → arrival; nobody on a break sent on a transfer | `plantState`, M13, `transferWorker`, recovery donor check | reliability invariant and exclusive; F2 flag test (arrival); engine "recovery" | DONE / TESTED |
| 10 | Shared clock; labels "Synthetic live replay" / "Synthetic interactive demo" | `sessions.js`, `ui.jsx` | AT3 | DONE / TESTED |
| 11 | Six flags: docs, config, live end-to-end with captured notification, ack ≠ resolve | `variance.py`, `rules.json` 1.1.0, `tests/flags` | `npm run test:flags`: all six in ONE run after the last change | DONE / TESTED |
| 11 | Durable Nodemailer outbox (dedup, retry, states); tests use capture only | `services/notifications.js` | unit SMTP test; M11 test | DONE / TESTED |
| 12 | Bands with exact boundaries; deadline-aware scheduling evaluated at the boundary to the second; pause/speed; overdue recovery | `forecast.classify`, `calc.next_boundaries` (+1 s), `worker.plan_advance` | test_cutoff; test_boundaries (7); repair boundaries (scheduling only); **e2e deadline crossing at ×1** | DONE / TESTED (R1/R2); overdue recovery after an engine restart is code review only |
| 12 | Browser-measured latency vs 5 s / 15 s | `scripts/measure-browser-latency.js` | Chromium ×1: pause 0.39 s p50 / 3.66 s max; alert 4.9 / 5.4 s; analytics 4.1 / 11.1 s; cutoff crossing 4.6–5.0 s | DONE / TESTED (local; deployed stack NOT_EXECUTED) |
| 13 | Options incl. relief worker and no action; donor/recipient checks; stale approvals refused; persisted baseline, approvals, times, error | `recovery.py`, `RELIEF_CALL_IN`, `decisions.js`, `verify.py` | engine "recovery"; repair "recovery" | DONE / TESTED |
| 14 | Duplicates, exclusive assignment, two engines, stale projections, restart, expired jobs, human-owned tasks, reset/archive scope, no double inspection submit, GETs never mutate | `executor`, `jobs.py`, `calc.publish`, sessions | AT20, AT2, engine "human-controlled worker", test_publish, tests_integration (2), reliability (4), e2e "browser closed" | DONE / TESTED |
| 15 | Real libraries; stand-ins removed or isolated; runtime versions; deploy configs; placeholder gate; `.env.example` files; no VITE secrets; no payments config | `devtools/README.md`, `engines`, `check-deploy.mjs` | check-deploy runs | DONE (lockfiles and deploy BLOCKED) |
| 16 | One current task; drill-downs; real backend calls; loading / empty / stale / permission-denied / retry states | `ui.jsx` (`ErrorState` 403/401, `Freshness`, `Empty`, `Loading`) | e2e | DONE / PARTLY TESTED |
| 16 | Operator sees alerts for their own area | `operatorViews.home.alerts`, `Work.jsx` | — | DONE / NOT_EXECUTED (no automated test) |
| 17 | Test groups A–J | — | TEST_RESULTS.md (per item) | Mostly PASS on the substitute DB; real MongoDB, Vite, deploy and live providers BLOCKED; camera-denied, upload failure, offline reconnect and DB interruption NOT_EXECUTED |
