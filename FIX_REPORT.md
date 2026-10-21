# Fix report — GiNi Manufacturing (v3 repair)

Each original finding was checked against the code before anything was changed. For each one this report gives: whether it was
confirmed, the root cause, the changes, the tests, and the remaining limitation.

Test status words are those of TEST_RESULTS.md: PASS, FAIL, BLOCKED, NOT_EXECUTED and NOT_APPLICABLE.

Every test in this report ran against the **docdb-wire test substitute** database, through the **real** drivers (pymongo 4.10.1,
mongodb 6.12.0) and the real Express 4.21.2 and Nodemailer 6.9.16. A real MongoDB server was unavailable here, so the real-MongoDB
gate is **BLOCKED** (IMPLEMENTATION_STATUS.md §1).

## Audit summary (what was inspected)

**Inputs inspected:**

- the delivered project (git baseline `d44cbc2`);
- `GiNi_Synthetic_v3_Final.zip`: the three Final workbooks, `seed/manifest.json`, `generator/scenario_resolver.py`,
  `validation/REFERENCE_CHECKS.md` and the README/assumptions;
- the repair specification.

The earlier reference projects (SMD-ETC-Analysis, real-time-visibility, variance demo, cutoff/Roopa project, concept mockup, CTQ
guide) were inspected in the original build (`backend/docs/source-audit.md`). They were not re-supplied for this repair.

| Category | Findings |
|---|---|
| Implemented and kept | operator and admin screens, command bus with idempotency/transactions/events, engine (forecast DES, M01–M13 / F1–F6, alerts, outbox, recovery, verification), seed/reconcile/accounts tooling, sessions with leases and fenced publish |
| Incomplete | the Final Events/Analytics workbooks were not integrated; no before/after audit; passport field coverage; batch split; validated order/product input; relief-worker and no-action recovery options; live flag tests; browser latency; operator-side alerts |
| Incorrect | points A–G; the 5-minute-only evaluation; the deployment placeholder without a gate; Node version declarations; agents allowed to confirm a cause; break during transfer (found during testing) |
| Tested only with substitutes | every earlier test (stand-in DB **and** stand-in express/mongodb/nodemailer/pymongo libraries) |

## Findings

### 1. Only the Final Master workbook was delivered; v2-regenerated Events/Analytics were used as the test fixture — CONFIRMED

- **Root cause.** The v3 Events/Analytics workbooks were not available in the first build, so a regenerated fixture stood in.
- **Changes.**
  - All three Final workbooks are in `backend/data/final/`, unchanged, with `SHA256SUMS` and the package manifest.
  - New `backend/seed/import_workflow.py` (verify / seed / gate) runs all nine steps.
  - The 174 relationships are in `contracts/reference_checks.json`.
  - The dataset's own `scenario_resolver.py` handles DELTA runs.
  - A non-null and composite key validator was added.
  - Import runs are persisted (`import_runs`) and shown in Administration.
  - Compose and QUICKSTART now use the workflow.
  - The v2 fixture is no longer used anywhere.
- **Tests.**
  - `import_verify_*.json`: PASS. 508 checks, 3,474,855 references, 0 missing, 146/146 hashes equal.
  - `import_gate_*.json`: PASS. Seed, reconcile, idempotent reseed, preservation, drift.
  - Missing or changed workbook: fails with exit 2 (tested).
  - Seed tooling unit tests on the v3 bundle: 7/7 PASS.
- **Checkpoint reconciliation.** Done, with one named **reconciliation exception**: 96 stale "current task" rows in
  `REF_CHECKPOINT_WORKER_STATE`. Row-level evidence, recomputed from as-of-checkpoint records only, is in
  `backend/docs/test-results/import/checkpoint_task_exceptions.csv`: 0 rows disagree. All 96 operations had finished before
  the checkpoint; 67 of those tanks were also route-complete (an earlier statement of "all 96" was corrected; DATA_IMPORT_REPORT.md).
- **Limitation.** The gate on a real MongoDB replica set is BLOCKED (command in DATA_IMPORT_REPORT.md).

### 2. Tests ran on stand-ins (database and libraries) — CONFIRMED

- **Root cause.** No package registry and no MongoDB server were reachable.
- **Changes.**
  - The library shims were deleted (`backend/devtools/shims/`, `scripts/dev/local-env.sh`).
  - The real **express 4.21.2, mongodb 6.12.0 (+ bson 6.10.1), nodemailer 6.9.16, pymongo 4.10.1, dnspython 2.7.0** were built
    from their official GitHub release tags (outside the package). The only non-original piece is a `whatwg-url` adapter that
    exports Node's built-in URL classes.
  - A wire-protocol server (`backend/devtools/docdb/wire.js`) lets the real drivers talk to the isolated test database. It reports
    itself as `7.0.0-docdb-wire-test-substitute`.
  - `/api/ready` and Administration → Integrations name the server kind. The substitute is shown as **"TEST SUBSTITUTE (docdb-wire)
    - not MongoDB"** and is never presented as MongoDB.
- **Tests.** All suites in TEST_RESULTS.md ran through the real libraries.
- **Limitation.** A real MongoDB server is still BLOCKED. `npm install` / `pip install` from the registries and lockfiles are
  BLOCKED (DEPLOYMENT.md §Lockfiles).

### 3. Points A — `tv1_split` rounded to whole points — CONFIRMED

- **Root cause.** `allocate(..., precision=0)`.
- **Changes.**
  - Two-decimal Decimal allocation with largest-remainder residual (RULE_VERSION 2.0).
  - History rows keep their source values.
  - The operator UI shows time points to two decimals.
- **Tests.** `test_points.py` (40/39.5 → +0.50, 40/40.5 → −0.50, crew 90/84 → +6.00 total with W1 2.14 / W2 2.14 / W3 1.72,
  three equal shares 0.33/0.33/0.34) and `test_points_ledger.py`: PASS.

### 4. Points B — a WO was skipped forever once an award or evaluation existed; reversals only for DD4 — CONFIRMED

- **Root cause.**
  - `wo_awards` skipped any order that had a `WO_AWARD_EVALUATION` projection or a ledger row.
  - `TV1_DONE` was a permanent flag.
  - DD4 reversals used prefix keys.
- **Changes.** `points.py` was rewritten around subject reconciliation:
  - `sim_points_evaluations` stores the status, reason, evidence and hash, the desired allocation and the booked net.
  - Re-evaluation happens when a subject is new, pending, or touched by an event, and after a restart.
  - The desired allocation is compared with history-plus-session booked rows.
  - Only the per-worker difference posts: REVERSAL rows (`REVERSAL_OF_ID`, `REVERSES_TRANSACTION_IDS`) plus revision rows.
  - Unchanged evidence posts nothing.
  - This applies to TV1, NR3/OF2 and DD4.
  - A session downstream defect reverses a pre-fork history award.
- **Tests.** `test_points_ledger.py` (late workmanship evidence, corrected shares, history reversal) and `repair.test.js`
  (API-level DD4 lifecycle): PASS.

### 5. Points C — pending allocation — CONFIRMED

- **Root cause.** No pending state existed. No denominator meant "skip", and evaluations were finalised.
- **Changes.**
  - PENDING (with a reason) when the gate has not passed, when there are no eligible minutes, or when there is no contribution
    denominator.
  - Pending subjects are re-evaluated every pass and awarded once when the evidence arrives.
  - The operator Progress page lists "Pending points (not booked yet)".
- **Tests.** `test_pending_until_gate_then_allocated`: PASS.

### 6. Points D — responsibility validation — CONFIRMED

- **Root cause.**
  - `INVESTIGATION_UPDATE` checked only that shares were positive and summed to 1.
  - Agents were allowed to confirm a cause.
- **Changes.** The roster is checked, inactive people stay valid, and the command now rejects:
  - unknown workers;
  - duplicates;
  - non-finite shares, shares ≤ 0 and shares > 1, plus the total ≠ 1;
  - a non-human or unnamed reviewer;
  - a missing evidence note;
  - a reviewer naming themselves;
  - naming the detector without an explicit `detectorAlsoResponsible`;
  - workers named for EQUIPMENT/MATERIAL/SUPPLIER/PROCESS causes.

  Suspected parties are stored separately and never deduct.
- **Tests.** `repair.test.js`, eight rejection cases through the API: PASS.

### 7. Points E — prefix matching (D-1 collected D-10) — CONFIRMED

- **Root cause.** Regex `^DD4|<defect>` with no terminator.
- **Changes.** An exact `SUBJECT_KEY` field on every ledger row and an exact-match query (indexed).
- **Tests.** `test_exact_defect_association_and_corrected_responsibility` and its API-level variant: PASS.

### 8. Points F — eligible time and crew allowance — PARTLY CONFIRMED

- **What was already right.** Crew shares already split one allowance. Breaks and blocked segments were already excluded.
- **What was missing.** The exclusion evidence was not shown, and the provisional rework standard was not labelled.
- **Changes.**
  - Each evaluation lists `excludedMinByReason`.
  - The rework allowance carries `PROVISIONAL_STANDARD` plus a note when no approved standard exists.
  - Inspections are never time-scored (documented).
- **Tests.** `test_fractional_tv1_posted_once…` (a 15-minute planned break is excluded and listed): PASS.

### 9. Points G — ledger reconciliation and links; transaction ID race — CONFIRMED

- **Root cause.** `POINTS_TRANSACTION_ID` came from a document count, so concurrent passes collided and silently dropped rows.
- **Changes.**
  - Deterministic IDs (a hash of the award key and the worker).
  - One transaction per revision.
  - Links to WO, line, batch, tank, attempt, defect, investigation, rule version, calculation id, evidence and reversal.
  - The operator total equals history plus session ledger.
- **Tests.** Four concurrent engines produce no duplicate (`test_concurrent_engines_never_double_post`). Ledger equals
  evaluations. Acceptance AT9 (displayed totals equal the ledger). All PASS.

### 10. Five-minute-only time-driven evaluation — CONFIRMED

- **Root cause.** The engine evaluated only after events or every 5 simulated minutes.
- **Changes.**
  - `calc.next_boundaries` computes buffer deadline, cutoff, need-by + F6 threshold, and shift end/start. (First version: deadline + 1 min; corrected to + 1 s in the second review, R1.)
  - The engine stops its minute loop at the boundary and evaluates there.
  - It recovers overdue boundaries after a restart (`RECOVERED_OVERDUE_BOUNDARY`).
  - Every projection carries `TRIGGER` and `CALCULATION_ID`.
  - The periodic pass is kept only for rolling windows.
- **Tests.** `test_boundaries.py` and `repair.test.js` (boundaries recorded live): PASS. A real crossing at ×1 is tested since the second review (R1/R2).
  `test_cutoff.py`: band boundaries to the second.

### 11. `YOUR-GINI-API` placeholder without validation — CONFIRMED

- **Changes.**
  - `scripts/check-deploy.mjs` runs as `prebuild` in both apps.
  - On Vercel (`VERCEL=1`) it fails the build while the placeholder or a non-https origin remains, or while a `VITE_*` variable
    looks like a secret.
  - `npm run check:deploy` runs the same check locally.
  - `configure:vercel` writes the origin.
- **Tests.** Placeholder → exit 1. After configure → OK. PASS.

### 12. Node version mismatch — CONFIRMED

- **Root cause.**
  - `engines ">=20.11 <23"` included Node 20, which Vercel deprecated on 2026-10-01.
  - Compose used `node:20.18`, the docs said "20.x", and the tests ran on 22.
  - The engine Dockerfile used Python 3.12 while the tests used 3.13.
- **Changes.**
  - `engines.node = "22.x"` in all four `package.json` files, plus `.nvmrc`.
  - Compose `node:22.22.0` and `python:3.13.9`.
  - Dockerfile `python:3.13-slim`, plus `.python-version`.
  - The decision and its official sources are in DEPLOYMENT.md §0.
- **Limitation.** Not built on Vercel or Render here (BLOCKED).

### 13. "env folder" instead of `.env.example` files — NOT REPRODUCED

- **Finding.** `.env.example` files already exist in `backend/`, `backend/python_engine/`, `frontend/` and `admin/`, with
  placeholders only. They were updated (seed variables, capture mode).

### 14. Unrelated payments/bookings configuration — NOT REPRODUCED

- **Finding.** A grep finds none in any `.env.example`, `vercel.json` or `render.yaml`.

### 15. No before/after values in the audit — CONFIRMED

- **Changes.**
  - Every command writes one `sim_change_log` change set in the same transaction: changed fields before and after, versions,
    actor, source, reason, correlation, idempotency key and event IDs.
  - Secrets are redacted.
  - The change log survives a session reset (with `RESET_GENERATION`).
  - DATABASE_PERSISTENCE_MAP.md documents it.
- **Tests.** `repair.test.js` (before/after, no scrypt hash) and `reliability.test.js` (audit kept after a reset).

### 16. Tank passport incomplete; tank IDs not clickable everywhere; no operator passport — CONFIRMED

- **Changes.**
  - `services/passport.js` builds the six sections (TANK_PASSPORT_FIELD_MAP.md) with "Not recorded" and role filtering.
  - A shared `PassportSections` component.
  - Operator route `/tanks/:id` and supervisor route `/units/:id`.
  - `TankLink` on every screen that shows a tank.
  - A top-bar tank search (`/search`).
- **Tests.** `repair.test.js` (sections, role limits, no future records, 404) and the e2e test (links in both apps, reload,
  search).

### 17. Batch split / membership history / scrap and replacement counting — CONFIRMED (split missing)

- **Changes.**
  - `BATCH_SPLIT` command; `sim_batch_membership` with one open membership per tank (unique `OPEN_KEY`); `sim_batches` children.
  - Batch summaries: demand, good, good from replacements, scrapped, active, mixed states.
  - Admin split UI and membership history.
- **Tests.** Replay of the Final data, batch PB-00002: at 03:00Z **4 good, 1 scrapped, 1 still needed**; at 03:45Z **5 good, 1
  from the replacement**. The split / overlap / passport test passes.

### 18. No validated path for new products/orders/plans — CONFIRMED

- **Changes.**
  - `POST /api/admin/master/products` (with dry run) validates routing, standards, CTQ specifications per gate and materials, then
    writes everything in one transaction or nothing.
  - The `ORDER_CREATE` command validates the lines and the plan, and writes session-scoped orders, lines, batches, plan and
    releases.
  - Reads are scoped by `SESSION_ID` (views, forecast, points, reducer).
- **Tests.**
  - An incomplete product → 422 with every problem, and nothing is written.
  - A new product, then an order, then a release creates new tanks that the forecast includes and the passport shows.
  - The other branch never sees the order.
  - Idempotent retry.

### 19. Recovery lacked relief-worker and explicit no-action options — CONFIRMED

- **Changes.**
  - A `RELIEF_WORKER` option (an off-shift qualified person called in, with checks and a forecast override `reliefs`).
  - The `RELIEF_CALL_IN` command writes a session-scoped roster row.
  - An `OPT-NA` no-action option equal to the baseline, which can be proposed, approved, started and verified.
- **Tests.** `repair.test.js` recovery test.

### 20. Six flags without live end-to-end tests; F3/F4 did not notify; capture bypassed Nodemailer — CONFIRMED

- **Changes.**
  - `tests/flags/flags.test.js` runs the full lifecycle per flag through commands, the UI and capture.
  - Rules 1.1.0: F3/F4 notify, and F3 counts net issues.
  - New `MATERIAL_ISSUE` and `MATERIAL_ISSUE_REVERSE` commands.
  - Capture mode uses Nodemailer `jsonTransport`.
  - A per-session notification policy (`notify.suppressSpeed`, `cooldownSeconds`).
  - A shipped rule version is applied automatically only while nobody has edited the rules.
  - Notifications are filterable by alert and episode.
- **Tests.** TEST_RESULTS.md §Flags, plus the SMTP unit test against a local fake SMTP server (SENT / RETRY 451 / FAILED 550 /
  server down / allowlist / capture).

### 21. Latency measured by API polling only — CONFIRMED

- **Changes.** `scripts/measure-browser-latency.js` uses Playwright to time:
  - the operator's Pause click until Resume is visible;
  - a breakdown until the alert row is visible;
  - a command until "Analytics up to date" is visible.
- **Tests.** TEST_RESULTS.md §Latency.

### 22. Mode label — CONFIRMED

- **Changes.** "Interactive synthetic simulation" became **"Synthetic interactive demo"** ("Synthetic live replay" was unchanged).

### 23. Found during testing: a planned break during a transfer lost the arrival — FIXED

- **Root cause.**
  - `BREAK_START` overwrote `TRANSFER`, so the arrival was never recorded.
  - A transfer could be ordered for someone on a break.
- **Changes.**
  - Breaks are refused while someone is in transit, and agents defer the break until after arrival.
  - Transfers are refused while someone is on a break.

### 24. Found during testing: points counted inherited (history) quality records as session evidence — FIXED

- **Changes.** Session evidence now means records with `KNOWN_AT > fork` (or session scrap). A WO completed before the fork with
  no session evidence is `HISTORY_FINAL`.

### 25. Onboarding: no explicit join-current-shift vs next-shift choice — PARTLY CONFIRMED

- **Changes.**
  - `startOption` (`JOIN_CURRENT_SHIFT` / `NEXT_SHIFT`) in the API and admin form.
  - The response names the first shift and whether it is the current one.
  - Admin-only creation, zero history and the HUMAN_ONLY control were already in place (story test 17, e2e 3).

### 26. Operators saw no alerts — CONFIRMED

- **Changes.** `me/home` returns alerts whose entity is the person's operation, tank, station, work centre or the person
  themselves. The operator app shows them with the note "waiting is not a performance finding".

## Second review (2026-10-19): findings and fixes

An external review of the previous delivery reported six code issues and three qualifications about the reports. Each was checked
against the code before it was fixed. All were confirmed.

### R1. Cutoff scheduling used deadline + 1 minute — CONFIRMED, FIXED

- **Defect.** `calc.BOUNDARY_STEP` was 1 min and the engine only stepped in whole minutes. A 14:30 cutoff was re-evaluated at
  14:31, up to 60 s late at ×1.
- **Fix.**
  - Boundaries are exact to the second (cutoff + 1 s, buffer deadline + 1 s, F6 need-by + 10 min).
  - `worker.plan_advance` stops before the minute that would pass a boundary.
  - The pass is evaluated as of the boundary itself (`TRIGGER "BOUNDARY: …"`, `AS_OF = boundary`), including a boundary inside
    the current part-minute.
- **Tests.**
  - `test_boundaries.py`: 7 tests.
  - e2e "deadline crossing at x1": real crossing at ×1 with no event for the line. `AS_OF` = cutoff + 1 s, the line RED and
    cutoff-elapsed, and visible in the supervisor UI within 15 s (see TEST_RESULTS.md).

### R2. The boundary integration test did not cross a deadline — CONFIRMED, FIXED

- **Defect.** The repair test only checked that a boundary was scheduled, and accepted EVENTS or PERIODIC as the last trigger.
  TEST_RESULTS.md overstated what it proved.
- **Fix.**
  - The repair test is renamed to what it proves: boundaries are scheduled, exact to the second.
  - The crossing itself is proved by the new e2e test (R1).
  - TEST_RESULTS.md was corrected.

### R3. Worker edits, deactivation and their audit writes were not atomic — CONFIRMED, FIXED

- **Defect.** `updateWorker`, `setActive` and `resetPin` wrote outside any transaction. `createWorker` added the person to live
  sessions and wrote the audit record after its transaction.
- **Fix.**
  - `services/audit.adminTx` runs every multi-record admin action (worker create/update/role change/deactivate/activate/PIN
    reset, rework standards, points policy, rule versions, session create/archive, own PIN change, job retry) in one transaction
    with its audit record. The audit record holds before/after values with secrets redacted.
  - A role change now also ends the person's open sign-ins.
  - Session reset is a three-step, repeatable procedure.
  - An `Idempotency-Key` makes a retry return the first result (`admin_requests`); the admin app sends one per form submission.
- **Test.** `tests/integration/admin-atomic.test.js` injects an audit failure into each action and asserts that nothing changed.
  It also covers real actions, idempotent HTTP retries, refused key reuse, kept history, and join-current vs next-shift onboarding.

### R4. A synthetic default rework standard could be treated as approved — CONFIRMED, FIXED

- **Defect.** `OPERATION_START` wrote the 60-min default into `REWORK_STANDARD_LABOR_MIN`, and `points.py` treated any value as
  approved.
- **Fix.**
  - New `rework_standards` records: named approver, statement, version, effective date. Admin UI and API, audited.
  - Every rework attempt records `REWORK_STANDARD` provenance: APPROVED with ID, version and approver, or PROVISIONAL from a
    synthetic planning value.
  - Points are awarded only against an approved standard; otherwise the attempt is PENDING, and anything booked earlier is reversed.
- **Tests.**
  - `test_points_ledger.py`: 3 new tests.
  - `standards-policy.test.js`.
  - The quality test asserts the provenance on a real rework attempt.

### R5. The passport "next action" was null for common states — CONFIRMED, FIXED

- **Defect.** `nextAction` used state names that do not exist in the state contract.
- **Fix.** Guidance now covers all 25 contract states plus older history names, naming who acts and what releases the tank.
- **Tests.** `tests/unit/passport-next-action.test.js` (every contract state) and the repair passport test (live tanks).

### R6. Time-score exceptions beyond the formula — BUSINESS DECISION, made explicit

- **Defect.** "Withdraw positive speed points on a confirmed workmanship defect" and "waive the overrun on a confirmed equipment
  cause" were applied silently.
- **Fix.**
  - They are now switches in a versioned points policy and are **OFF** by default, which is the client's formula.
  - A named person turns one on by confirming a policy version with a statement and an effective date. This is audited.
  - Evaluations and ledger rows record the policy version, and a policy change re-evaluates every subject.
- **Tests.** `test_points_ledger.py` and `standards-policy.test.js`.

### R7. Found while re-running the suite: a second relief call-in failed with 409 DUPLICATE — FIXED

- **Defect.** `RELIEF_CALL_IN` inserted its session roster row without a `ROSTER_ID`, while `app_shift_roster` has a unique index
  on `ROSTER_ID`. The first call-in anywhere in the database succeeded. Every later one collided on the missing (null) key, and
  recovery `ACTION_START` for a relief option failed. The earlier full run passed only because it was the first call-in in that
  database.
- **Fix.**
  - Call-in rows get `ROSTER_ID = ROS-<session>-<call-in id>`.
  - The one existing row was given an ID.
- **Test.** The repair recovery test asserts distinct `ROSTER_ID`s for two call-ins in one session. The engine recovery test,
  which failed, passes again.

### R8. Found while re-running the suite: recovery offered transfers of people on a break — FIXED

- **Defect.** Since breaks can no longer start during a transfer (and a transfer refuses a person on a break), a recovery option
  could propose transferring someone who was on a break. Approval succeeded, but `ACTION_START` was refused with `ON_BREAK`. The
  engine recovery test failed in 1 of 3 runs, depending on who was on a break at the fork.
- **Fix.** The donor check adds `AVAILABLE_TO_LEAVE_NOW`. A person on a break or already in transfer makes the option infeasible,
  and the reason is shown.
- **Test.** The engine recovery test passed 3 of 3 consecutive runs after the fix (previously 2 of 3), and passed in the final
  full run.

### Report qualifications

| Qualification | What was done |
|---|---|
| The six flags had not passed together after the last test change | The full suite was rerun in one pass (TEST_RESULTS.md §Flags) |
| Some PASS descriptions were broader than their assertions (page reload ≠ browser closed; a scheduled boundary ≠ a processed one) | New e2e "browser closed": every browser context closed while the clock runs on the server, then a new browser with no carried-over state. Plus the deadline-crossing test (R1). The wording in TEST_RESULTS.md was corrected. |
| A real driver against a substitute server is still substitute testing | Unchanged and stated: MongoDB is still unreachable from this workspace (re-checked 2026-10-19). The real-replica-set run remains the first acceptance step. |
| Checkpoint: 96 stale task references, evidence not independently recomputed | `seed/tools/checkpoint_task_exceptions.py` recomputes every row from as-of-checkpoint records. It produced `checkpoint_task_exceptions.csv` with 0 inconsistent rows. It also corrected an overstatement in the earlier report: 67 of the 96 tanks, not all 96, were route-complete. |

## Remaining limitations (summary)

The following are BLOCKED or NOT_EXECUTED:

- real MongoDB replica-set runs;
- registry installs and lockfiles;
- `vite build` here (rollup's native binary cannot be installed in this workspace; the external review built both apps with Vite
  successfully elsewhere);
- Vercel/Render deployment;
- live Cloudinary and live SMTP;
- camera hardware.

See IMPLEMENTATION_STATUS.md and TEST_RESULTS.md for the exact commands.
