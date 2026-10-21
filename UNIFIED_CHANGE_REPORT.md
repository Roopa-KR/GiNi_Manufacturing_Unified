# Unified application changes

The FreshFactory application is the shared manufacturing foundation. The disconnected FactoryOps ops_* vessel model is not used. This restores the original Python engine and operator/admin separation instead of running two different factories. Start with a NEW database; this delivery does not automatically migrate existing ops_* records.

## Changed implementation paths

| Path | Change |
|---|---|
| backend/src/domain/commands/quality.js | Explicit qualified independent inspector assignment; inspection assignment enforcement; photo evidence verification and required-photo checks |
| backend/src/domain/commands/evidence.js | Evidence must match inspection, tank and checklist question |
| backend/src/services/operatorViews.js | Assigned inspections visible to designated inspector across home work centers |
| backend/src/services/workersAdmin.js | Safe unused-worker deletion, history protection, active attendance protection, PIN session revocation, live worker update and timezone-correct qualifications |
| backend/src/routes/admin.js | Unused-worker deletion endpoint |
| backend/src/lib/db.js | Require replica-set/mongos transactions; no unsafe fallback |
| backend/src/services/factory.js | Dispatch inspector choices, target times, due dates, current-clock qualification checks and reset cleanup |
| backend/src/domain/catalog.js | Inactive workers cannot qualify |
| backend/src/services/plantViews.js | Normalize required-photo presentation |
| admin/src/pages/Dispatch.jsx | Assign inspector and display order/batch/deadline/step targets |
| admin/src/pages/Administration.jsx | Confirmed Delete unused action |
| admin/src/lib/api.js | Correct default admin application identity |
| frontend/src/pages/Inspection.jsx | Required photographs included in missing-answer count |
| backend/python_engine/gini_engine/baselines.py | Learn fresh-factory baselines from prior same-session evidence |
| backend/python_engine/gini_engine/calc.py | Refresh baselines and retain five-minute comparison samples |
| backend/python_engine/gini_engine/variance.py | Accurate insufficient-history explanation |
| backend/.env.example and backend/python_engine/.env.example | New team-test database default |
| render.yaml | Explicit fresh-factory worker configuration |
| backend/tests/fresh/unified.test.js | Physical identity, deletion, inspection assignment and photo regressions |
| backend/tests/fresh/browser-unified.cjs | Browser smoke script; execution blocked in this environment |
| backend/python_engine/tests/test_factory_baselines.py | Real-Mongo baseline learning tests |
| backend/package.json | Sequential test:unified command |

## Retained original capabilities

Orders, lines, batches and independently traceable manufactured tanks; attendance and individual labor; task dispatch/progress; independent inspection and photographs; hold, return/rework, reinspection, scrap and replacements; points and reversals; six variance flags and manufacturing alerts; cutoff scheduling, forecasts, recovery and verification; tank passports; separate device and supervisor applications. These capabilities share the existing collections and Python calculation path.

The three Final Excel workbooks and import tools are included unchanged for OPTIONAL synthetic replay in a separate database. Fresh factory setup does not seed these records. Runtime actions persist in MongoDB; workbook files are not rewritten by operator activity.

## Important boundaries

Unused employees can be physically deleted. Employees with operational history must be deactivated, or the whole disposable factory reset using the guarded reset workflow. No original customer/source database was changed during testing.

New factories need historical evidence before baseline-dependent flags can evaluate. Missing history is shown explicitly; it is not manufactured to force flags. Inspector assignment is recorded separately from starting inspection or clocking in.

Use the complete folder. Do not mix individual files into the disconnected FactoryOps version. Private .env backups, exported demo PINs, dependencies, stale COPY_THESE_FILES copies and runtime logs are excluded.

## Review additions (gap check against the original scope)

Items from the original build prompt / Fresh Factory specification that were still missing, added in this review:

| Path | Change |
|---|---|
| frontend/src/components/Scan.jsx (new) | Scan tank or station label: camera (browser BarcodeDetector where supported), handheld scanner or manual entry; "Confirm tank" check against the current task (original scope §6 "scan tank/station barcode or QR with manual entry fallback") |
| frontend/src/App.jsx, frontend/src/pages/Work.jsx | Scan button in the operator header; Confirm tank button on the task card |
| backend/src/routes/views.js | `/search` also resolves station IDs (with the tanks currently at the station) for the scanner |
| admin/src/components/Barcode.jsx (new) | Code 128 barcode (no external library; symbol table checked against ReportLab's) and printable labels |
| admin/src/pages/Orders.jsx | Print tank labels after a batch release; optional planned release date/time per order line (Fresh Factory spec §9 "Planned release") |
| admin/src/pages/Passport.jsx, admin/src/pages/Setup.jsx | Print label on the tank passport and for each station |
| admin/src/pages/Setup.jsx, backend/src/services/factory.js | Checklist option "photo required when the answer fails" (`EVIDENCE_REQUIRED=ON_FAILURE_ANSWER`, as in the CTQ guide) |
| backend/src/domain/commands/quality.js | Fresh factory: a failed answer of such a question cannot be submitted without a verified photo of it |
| backend/src/services/plantViews.js, frontend/src/pages/Inspection.jsx | "photo if it fails" badge; the missing-answer count includes the missing failure photo |
| backend/tests/fresh/additions.test.js (new) | Scanner lookup, planned release in plant time, photo-on-failure rule |
| backend/tests/fresh/browser-unified.cjs | Fixed the passport check (exact text match never matched the title); now passes |
| backend/package.json | `test:unified` also runs additions.test.js |
| backend/tests/fresh/ui-walk-review.cjs (new) | Browser walkthrough on an empty database incl. labels, Confirm tank, Scan, Assign inspector, Delete unused |
| backend/tests/integration/admin-atomic.test.js, story.test.js | Updated for the new rule "clock out before deactivation" (assert the 409, clock out, then deactivate) |
| UNIFIED_TEST_REPORT.md, docs/unified-test-results/review-2026-10-20/, docs/screenshots/review-2026-10-20/ | Review test evidence |
| START_HERE_UNIFIED.md, TEAM_TEST_WALKTHROUGH.md | Labels, Confirm tank, Assign inspector, planned release, photo on failure |

## Tank-label scanning as part of tracking (2026-10-20, second step)

The tank label is the permanent tank serial (`TANK_SERIAL_NO`, created when a batch is released); a station label is the
station ID. Nothing new has to be registered for a barcode.

| Path | Change |
|---|---|
| backend/src/domain/commands/scan.js (new) | `SCAN_RECORD` command: saves every scan in `sim_scans` (who, when, code, purpose, result MATCH / WRONG_TANK / UNKNOWN / STATION…, method camera or scanner/typed, station, expected tank, task) and events `TANK_SCANNED`, `STATION_SCANNED`, `TANK_SCAN_MISMATCH`; a location scan sets `LAST_SCANNED_STATION_ID/AT` on the tank (route step, state and workstation are never changed by a scan). Not available to simulated agents |
| backend/src/domain/commands/tasks.js, quality.js | "Scan required" (fresh factory, switched on in Factory setup): a person starting their own work needs a matching scan of that task's tank (or of that tank in the last 60 min); an inspector needs a matching scan of the tank in the last 60 min before an inspection starts. Off by default; work started by a supervisor for someone and agent actions are not blocked |
| backend/src/services/factory.js, sessions.js, admin/src/pages/Setup.jsx | Factory setup → 1 · Factory: two switches "Require a scan … before people start work / before an inspection starts" (`factory_settings.SCAN_REQUIRED`, mirrored on the session, shown as `session.scanRequired`); `sim_scans` is cleared by the guarded reset |
| backend/src/domain/executor.js, backend/src/services/sessions.js | `sim_scans` is a session collection (scoped and cleared like the other `sim_*`) |
| backend/src/services/operatorViews.js | Current task carries `scan { required, confirmed, confirmedAt }`; joinable crews carry the tank serial |
| backend/src/services/passport.js | Passport returns `scans { rows, lastLocation }` |
| frontend/src/components/Scan.jsx | Every scan goes through `SCAN_RECORD`; look-up scan of a tank offers "record where this tank is" (scan the station label) |
| frontend/src/pages/Work.jsx | Confirm tank saves the confirmation; "Tank confirmed hh:mm"; Start work / Resume locked until the scan when required; inspector's "Scan & inspect" when inspection scans are required |
| frontend/src/pages/Queue.jsx | "Scan & join" when scans are required |
| frontend/src/pages/Inspection.jsx | Confirm tank on an open inspection (saved in the history) |
| admin/src/components/PassportSections.jsx, frontend/src/components/PassportSections.jsx, admin/src/pages/Passport.jsx, frontend/src/pages/TankPassport.jsx | "Label scans" card: every scan of the tank with who / when / purpose / result / station / method, and the last scanned location |
| backend/scripts/print-openapi.js, backend/docs/openapi.json | `SCAN_RECORD` listed |
| backend/tests/fresh/scan.test.js (new) | Saved / evented / shown; required → blocked → wrong tank still blocked → right tank unlocks; inspection gate; location scan does not move the route; switched off → optional |
