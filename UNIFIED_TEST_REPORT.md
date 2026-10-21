# Verification for this delivery

This report supersedes older bundled test summaries for the changed code. It does not certify Siemens production readiness.

| Check | Result |
|---|---|
| Operator and admin production builds with real packages, Node 22 | PASS |
| Python unit/database tests, Python 3.12, real PyMongo | 77 passed, 0 skipped |
| Node unit tests, real dependencies | 20 passed, 0 skipped |
| Fresh-factory API/engine scenario on real MongoDB 7.0.16 replica set | TAP reports 24 passed including parent; restart subcase only emits a diagnostic, so not counted as a restart proof |
| Additional unified API/database regression | 4 subtests plus parent passed |
| Separate MongoDB/API/Python restart | Existing unit identities/states persisted; current engine recalculation succeeded |
| Browser smoke | BLOCKED: Chromium could not create its process singleton socket in this environment; no browser acceptance claimed |
| External Cloudinary, external SMTP, Vercel and Render deployments | NOT EXECUTED |
| Complete Final-workbook import/reconciliation | NOT rerun; original files/tools retained |
| Full six-flag input-to-browser-to-external-email lifecycle | NOT rerun; rule unit coverage and fresh operational/cutoff scenarios passed |
| Windows PowerShell launch scripts | Retained/reviewed, not executed on this Linux host |

## Operational evidence

The fresh scenario exercises employee setup, qualifications and clocking, route/stock setup, work orders and unique tanks, dispatch and work progression, inspection, rework, scrap/replacement, points reconciliation, background progression and cutoff without new operator events. It ran against a disposable real MongoDB replica set, not an in-process substitute.

Additional regressions verify a five-tank demand in two batches creates five immutable identities; unused-worker deletion and idempotent retry; protection of used workers; invalid home center rejection; assigned inspector visibility and access enforcement; missing and unknown evidence rejection; actual local PNG upload, verification and required-photo submission.

Node notification tests use real Nodemailer with a local test SMTP service, not an external mailbox. Fresh baseline tests use real MongoDB. The restart check independently verified persistence, then published a new projection from the current Python code.

Evidence files are in docs/unified-test-results. Historical tests elsewhere remain historical. Browser and hosted-provider testing are still required before claiming the deployed application is accepted.

## Repeat on your disposable local database

Start fresh setup and the API/Python engine; configure the test environment described by backend/tests/fresh/scenario.test.js and the existing fresh test guide. Run npm run test:unified from backend. This sequence creates test workers/orders and must not target a customer database. Run Python pytest with GINI_TEST_MONGODB_URI pointing to a disposable replica-set database for database-backed tests. Use the browser smoke script after the scenario with your local Chromium path and test credentials.

Recommended team acceptance: log in separately as operator, inspector and supervisor; complete the walkthrough in START_HERE_UNIFIED.md; verify required-photo pass/fail, same/earlier/alternate-station rework, independent batch output, each configured flag, notifications, cutoff and restart in your own deployed environment.

## Independent review run (2026-10-20)

Re-run of this delivery plus the review additions and tank-label scanning (see UNIFIED_CHANGE_REPORT.md). Database for every
row: **docdb-wire, a TEST SUBSTITUTE speaking the MongoDB wire protocol** (real drivers) - not MongoDB; a real MongoDB was not
available in the review workspace. Evidence: `docs/unified-test-results/review-2026-10-20/`, screenshots in
`docs/screenshots/review-2026-10-20/`.

| Check | Result |
|---|---|
| Delivery code as received: fresh scenario 24/24, unified regression 5/5, browser smoke (after fixing its passport text check) 18 rows / 0 JS errors | PASS |
| Final code, one clean empty database in sequence (`npm run test:unified`): scenario / unified / additions / scan | PASS 24/24 · 5/5 · 4/4 · 6/6 |
| `scan.test.js`: scans saved + evented + in both passports; scan required blocks Start work and Start inspection; wrong tank saved but unlocks nothing; someone cannot confirm another person's task; location scan never moves the route; switched off = optional | PASS 6/6 |
| Browser walkthrough on a new empty database (`ui-walk-review.cjs`): setup with "scan required" → workers → order → release + tank labels → dispatch → Start work locked → Confirm tank (unknown code, then the right serial) → location scan → station scan → start/finish → assign inspector → **Scan & inspect** → inspection → delete unused worker → passport **Label scans** (5 rows, last location) → order complete | PASS 18/18 steps, 0 page errors, 0 failed API calls |
| Python engine tests (incl. `test_factory_baselines.py`) | PASS 77/77 |
| Node unit tests | PASS 20/20 |
| Synthetic demo regression (seeded v3 test database): integration / flags / browser e2e | PASS 67/67 · 5/5 · 7/7 (two old integration tests updated for the "clock out before deactivation" rule; one e2e passport check timed out once under load and passed alone and in a full rerun) |
| Camera scanning (BarcodeDetector) | NOT_EXECUTED here (headless Chromium has no camera); typed / handheld-scanner path tested. Code 128 symbol table equals ReportLab's |
| Real MongoDB, Windows scripts, Cloudinary, SMTP, hosting | BLOCKED / NOT_EXECUTED in the review workspace |
