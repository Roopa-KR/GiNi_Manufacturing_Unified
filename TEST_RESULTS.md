# Test results

**Run date:** 2026-10-19, after the second review's fixes (FIX_REPORT.md §Second review, R1–R8). The build workspace clock reads
2026-10-18 UTC in the logs.

**Where the evidence is:**

| Evidence | Location |
|---|---|
| Raw logs | `backend/docs/test-results/logs/` (`summary.txt` is the run log, including the interruption below) |
| Flags | `backend/docs/test-results/flags/` |
| Deadline crossing | `backend/docs/test-results/deadline-crossing.json` |
| Latency | `backend/docs/test-results/latency*.json` |
| Import | `backend/docs/test-results/import/` (incl. `checkpoint_task_exceptions.csv`) |
| Screenshots | `docs/screenshots/` |

**Result words:**

| Word | Meaning |
|---|---|
| **PASS** | Ran here and passed |
| **FAIL** | Ran and failed |
| **BLOCKED** | Cannot run in this workspace (the reason is given) |
| **NOT_EXECUTED** | Could run in principle, but was not run or not automated |
| **NOT_APPLICABLE** | Does not apply |

## Environment (read this first)

| Item | Value |
|---|---|
| Machine | Linux, 2 vCPU Intel Xeon 2.1 GHz, 8 GB RAM. API, engine, database and both apps on one machine. |
| Runtimes | Node v22.22.0, Python 3.13.16, pytest 9.1.1, Playwright 1.56.1 with Chromium |
| Libraries | **Real** express 4.21.2, mongodb 6.12.0, bson 6.10.1, nodemailer 6.9.16, pymongo 4.10.1 and dnspython 2.7.0, built from their official GitHub release tags. Not from a registry install, so there are **no lockfiles** (BLOCKED here). |
| Database | **docdb-wire TEST SUBSTITUTE, not MongoDB.** It speaks the MongoDB wire protocol to the real drivers (replica set `rs0`). No MongoDB server, image or binary is reachable from this workspace: re-checked 2026-10-19, fastdl.mongodb.org 403 and the registries unresolvable. **No result below is a real-MongoDB PASS**, including the transaction-rollback tests. |
| Data | The **actual Final workbooks**, unchanged (`sha256sum -c backend/data/final/SHA256SUMS` gives OK × 3). Dataset `GINI-SYN-2026-10-17-v3.0-FINAL`: 146 collections, 595,781 documents. |
| Apps | Built with esbuild (`build:local`), because `vite build` cannot run here. An external review built both apps with Vite successfully elsewhere (DEPLOYMENT.md). |
| Email | `EMAIL_MODE=capture` through the Nodemailer `jsonTransport`. No external email was sent. |

## Summary: final run on the final code

| Suite | Command (working directory `backend/`) | Tests | Pass | Fail |
|---|---|---|---|---|
| Node unit (incl. Nodemailer SMTP, passport next-action coverage) | `npm test` | 20 (13 tests + subtests) | 20 | 0 |
| Node integration (real API + DB + engine over HTTP; cookies, CSRF) | `npm run test:integration` | 67 (35 tests + subtests) | 67 | 0 |
| Playwright end-to-end (Chromium, built apps) | `npm run test:e2e` | 7 | 7 | 0 |
| Python engine unit | `cd python_engine && python -m pytest -q tests` | 75 | 75 | 0 |
| Seed tooling (Final bundle) | `cd seed && python -m pytest -q tests` | 7 | 7 | 0 |
| Engine processes (2 engines, SIGKILL, restart) | `cd python_engine && GINI_INTEGRATION=1 python -m pytest -q tests_integration` | 2 | 2 (rerun, see below) | 0 |
| **Six flags, live, all six in ONE run** | `npm run test:flags` | 5 tests (F1 and F4 share one) | 5 | 0 |
| Latency: API ×1, API ×30, browser ×1 | `npm run measure:latency`, `measure:latency:browser` | 3 reports | 3 | 0 |
| Import gate / verify / seed | `python seed/import_workflow.py …` | 3 runs | 3 | 0 (earlier run, unchanged data) |
| **Total automated tests** | | **183** | **183** | **0** |

**Interruption during the final run (honest record).** The first attempt at the last three stages failed for an infrastructure
reason, not an application defect:

- The engine-process stage, the flags and the latency scripts ran after the other suites.
- During that first attempt, the substitute database process was **killed by the container's out-of-memory killer** (`dmesg`:
  `Memory cgroup out of memory: Killed process … (node)`, 4.3 GB). It holds all data in memory, and the disposable test database had
  grown with about 55 archived test sessions.
- Every later request in that attempt failed with `503 DATABASE_UNAVAILABLE`, so the engine-process test reported "2 errors" and
  the flags "0 of 6". Both are in `logs/summary.txt`.

Recovery:

1. The database was restarted from its snapshot.
2. The archived test sessions' data was removed (76,705 test documents; the Final dataset and the default session untouched).
3. Those three stages were re-run unchanged: engine processes 2/2, flags 5/5, latency all within target.

The unit, integration, e2e, engine-unit and seed results above come from the same final run, before the database was killed.

**Earlier failures in this cycle, found and fixed:**

| Failure | Cause | Fixed in |
|---|---|---|
| Recovery `ACTION_START` failed with 409 DUPLICATE | Relief call-in roster rows had no `ROSTER_ID` | FIX_REPORT R7 |
| Recovery `ACTION_START` failed with `ON_BREAK` (intermittent) | Options offered people on a break | FIX_REPORT R8 |
| `repair.test.js` did not load | Duplicate variable in a new assertion | — |
| Repair relief assertion failed | It assumed the executed option was a relief option | — |

All of these pass in the final run.

## Second-review checks (R1–R8)

| Finding | Test | Result and evidence |
|---|---|---|
| R1/R2: deadline crossing, evaluated at cutoff + 1 s without an event, visible at ×1 | e2e "deadline crossing at x1" | **PASS** in 3 runs: UI latency **4.6 s, 4.6 s and 5.0 s** after the crossing (target 15 s). Projection `AS_OF` = 15:56:16.000 = cutoff + 1 s exactly; `TRIGGER "BOUNDARY: cutoff passed for <line>"`; computed 2.8 s after the crossing; the line RED and `CUTOFF_ELAPSED` (`deadline-crossing.json`). |
| R1: sub-minute planning | `test_boundaries.py` (7) | **PASS**. 14:20:01 / 14:30:01 / 14:10:00; band change at the instant; `plan_advance` cases. |
| R2: scheduled boundaries exact to the second | repair "deadline-aware scheduling" | **PASS**. Scheduling only; the test name now says so. |
| R3: admin atomicity | admin-atomic "rolls back completely…" (5 subtests) | **PASS**. A forced audit failure leaves worker, account (roles, permissions, status, PIN hash), qualifications, roster, live-session rows, sign-ins and the worker-ID counter unchanged. The audit record contains no PIN or hash. **The transaction behaviour was tested on the substitute DB, not on MongoDB.** |
| R3: idempotent admin retry, key reuse refused, history kept after deactivation | admin-atomic "admin HTTP…" | **PASS** |
| R3: next-shift onboarding | admin-atomic "onboarding" | **PASS** (was NOT_EXECUTED) |
| R4: planning value is not approval; approved standard releases points; snapshot used | `test_points_ledger.py` (3); quality (provenance on a real rework attempt); standards-policy | **PASS** |
| R5: next action for every state | unit passport-next-action (3); repair passport (live tanks) | **PASS** (25 contract states + aliases) |
| R6: exceptions OFF by default; confirmed policy version re-evaluates with linked reversals | `test_points_ledger.py` (3); standards-policy | **PASS** |
| R7: relief call-in roster IDs | repair recovery (two call-ins); engine recovery | **PASS** |
| R8: recovery donors on a break | engine recovery: 3 consecutive passes after the fix, plus the final run | **PASS** |
| Browser closed (not just reloaded) | e2e "browser closed" | **PASS**. Every browser context is closed while the clock runs at ×30 for about 12 simulated minutes. The server advances, processes events and publishes. A new browser with no carried-over state shows the same task, with its start time unchanged and never two running tasks. |
| Checkpoint exception evidence | `seed/tools/checkpoint_task_exceptions.py` | **PASS**. 158 references: 62 active, 96 not active, **0 inconsistent** rows; `checkpoint_task_exceptions.csv`. |

## Flags (§11): all six in one run

Each flag follows this lifecycle, and the test asserts every step:

1. Healthy at the start.
2. The condition is created through ordinary commands.
3. The alert row appears in the supervisor UI (Chromium, screenshot taken).
4. **Exactly one** FIRING notification is captured for the episode.
5. ACK leaves the alert FIRING with workflow ACKNOWLEDGED.
6. The cause is corrected through commands.
7. The alert RESOLVES.

| Flag | Created by | Corrected by | Session / alert | Notifications for the episode | Wall time | Result |
|---|---|---|---|---|---|---|
| F6 replenishment delay | `MATERIAL_REQUEST` (need-by +2 min), clock ×60 | `MATERIAL_DELIVERY` | S-8CAC8F / AL-F6-MR-8CAC8F-00001 | FIRING captured, RESOLVED captured | 20 s | **PASS** |
| F5 congestion | `BATCH_RELEASE` until WC1 ≥ 85 % | `OPERATION_START` on free stations | S-A29172 / AL-F5-WC1 | FIRING captured, RESOLVED captured | 9 s | **PASS** |
| F2 regional imbalance | `BATCH_RELEASE` (FAB 1.59 / FIN 0.42) | `WORKER_TRANSFER` of 11 qualified FIN people to WC1/WC2, then arrival | S-84418E / AL-F2-AREAS | FIRING captured, RESOLVED captured | 39 s | **PASS** |
| F3 material velocity | Abnormal `MATERIAL_ISSUE`s | `MATERIAL_ISSUE_REVERSE` | S-A08318 / AL-F3-PLANT | FIRING captured (RESOLVED still in the outbox when the report was written) | 15 s | **PASS** |
| F1 stalled assignment | No progress evidence | Milestone progress | S-604FF4 / AL-F1-OPI-B-0005375 | FIRING captured, RESOLVED captured | 85 s | **PASS** |
| F4 location velocity | Long dwell at WS-WC2-06 | Completion | S-604FF4 / AL-F4-WS-WC2-06 | FIRING captured, RESOLVED captured | 8 s | **PASS** |

**F2 refusals during the correction.** The F2 log records that the server refused unqualified moves: 33 × WC1 and 26 × WC2 with
403. After 11 arrivals the result was FAB 1.33 / FIN 0.53, with 0 people transferable, which is OK.

**Evidence:**

- `flags/flags-final-one-pass.txt` and `flags-report-final-one-pass.json`.
- Screenshots: `docs/screenshots/F1…F6-firing.png`.
- The earlier runs (F2 failing on a test defect, then passing alone) are kept in the same folder for history.

## Latency (§12)

**Browser measurement.** `measure-browser-latency.js`: Chromium on the built apps, ×1, agents active, 5 iterations, session
S-B853AB. The times include the apps' polling.

| Measure | Target | p50 | p95 / max | Result |
|---|---|---|---|---|
| Operator clicks Pause, and the paused state is visible | ≤ 5 s | 0.39 s | 3.66 s | **PASS** |
| Operator clicks End break, and "Pause" is visible again | ≤ 5 s | 0.16 s | 0.19 s | **PASS** |
| Breakdown, and the M11 row is visible on the Alerts page | ≤ 15 s | 4.9 s | 5.4 s | **PASS** |
| Command, and the header shows analytics up to date including it | ≤ 15 s | 4.1 s | 11.1 s | **PASS** |
| Cutoff crossing with no event, and "cutoff elapsed" visible (e2e, 3 runs) | ≤ 15 s | 4.6 s | 5.0 s | **PASS** |

**API measurement.** `measure-latency.js`, 10 iterations, agents active, job backlog 0–1 pending and 0 dead:

| Workload | Command → visible state (≤ 5 s) | Event → alert (≤ 15 s) | Event → forecast published (≤ 15 s) |
|---|---|---|---|
| ×1 | p50 41 ms, max 55 ms | p50 1.7 s, max 2.9 s | p50 3.1 s, max 3.6 s |
| ×30 | p50 62 ms, max 74 ms | p50 2.2 s, max 2.7 s | p50 3.0 s, max 3.5 s |

These numbers come from one machine running the substitute database. They are **not** a prediction for Vercel + Render + Atlas.
Re-measure there.

## Test groups A–J (§17)

### A. Data

| Item | Evidence | Result |
|---|---|---|
| All three Final workbooks imported; checksums and version recorded | `import_seed_*.json` | **PASS** (substitute DB) |
| Reference validation | 508 checks, 0 failed, 3,474,855 references, 0 missing | **PASS** |
| Seed twice, no duplicates, app changes preserved, drift | Reseed inserted 0; seed tests | **PASS** |
| Reconciliation reports | 155 checks; checkpoint exceptions CSV with 0 inconsistent rows | **PASS** |
| Missing inputs fail clearly | Exit 2, names the file | **PASS** |
| Same gate on a real MongoDB replica set | — | **BLOCKED** |

### B. Accounts and workers

| Item | Evidence | Result |
|---|---|---|
| Existing productive worker; paused or waiting worker | AT2; story; e2e 1 | **PASS** |
| Off-shift worker | AT22; relief call-in | **PASS** |
| New worker; join current vs next shift | admin-atomic "onboarding"; story; e2e 3 | **PASS** |
| Leading-zero PIN | Unit; story; e2e 3 | **PASS** |
| Unauthorized creation rejected | Story "permissions" (403) | **PASS** |
| Deactivation preserves history | admin-atomic: recorded events, master data, roster and the worker detail are kept; sign-in revoked | **PASS** |

### C. Persistence

| Item | Evidence | Result |
|---|---|---|
| Task, attendance, inspection, rework, investigation, worker creation, alert, recovery and rule-change commands verified in the DB | Integration suites (DB reads); admin-atomic (audit with before/after) | **PASS** |
| Admin actions atomic with their audit record | admin-atomic | **PASS** (substitute DB) |
| Engine crash and restart: accepted state remains | `tests_integration` | **PASS** |
| Every browser closed, then a new browser | e2e "browser closed" | **PASS** |
| API process restart during an automated scenario | — | **NOT_EXECUTED** (the stack was restarted between suites, but no test asserts across an API restart) |

### D. Tank passport

| Item | Evidence | Result |
|---|---|---|
| Correct tank from every link; location and status; crew and labour; role protection; no future information | repair passport; e2e 5 | **PASS** |
| Next action for every state | unit passport-next-action; repair passport | **PASS** |
| Return/rework attempts (with rework-standard provenance); scrap and replacement links | repair batch tests; quality | **PASS** |
| Inspection photographs shown in the passport | Photo verified in e2e 2; the passport rendering of the photo is not asserted | **PASS / partly** |

### E. Points

| Item | Evidence | Result |
|---|---|---|
| Fractional minutes, exact crew totals, +3/+2 exclusivity, pending then allocated | `test_points*` | **PASS** |
| Late-evidence reversals; corrected responsibility; unknown or duplicate worker rejected; D-1 ≠ D-10; equipment no-fault | `test_points_ledger`; repair "responsibility" | **PASS** |
| Rework standard approval; policy versions | `test_points_ledger`; standards-policy | **PASS** |
| Retry and concurrency deduplication; displayed = ledger | 4 concurrent engines; AT9 | **PASS** |

### F. Quality

| Item | Evidence | Result |
|---|---|---|
| Pass, fail, incomplete; same-station repair; earlier-station return; approved alternate; repeated failure escalates; unknown held; failed evidence retained; scrap and replacement | Unit inspection rules; quality (2); story; engine scrap | **PASS** |
| Legacy scrap policy session | Code review only | **NOT_EXECUTED** |

### G. Batches and orders

| Item | Evidence | Result |
|---|---|---|
| Partial movement, split membership, mixed states, replacement reconciliation (4 good, then 5), new valid product and order | repair (4 tests); reliability "ORDER_CREATE idempotency" | **PASS** |

### H. Engines

| Item | Evidence | Result |
|---|---|---|
| Six flags end to end | One-pass run | **PASS** |
| Cutoff passage with no event | e2e deadline crossing at ×1 | **PASS** |
| Exact buffer and cutoff boundaries; overnight and time zone | `test_cutoff`; `test_boundaries` | **PASS** |
| Material and equipment interruption | AT13; engine M11 | **PASS** |
| Transfer donor impact; stale approval; immutable baseline; relief and no-action | engine recovery; repair recovery | **PASS** |
| Overdue-boundary recovery after an engine restart while the clock runs | Code review only | **NOT_EXECUTED** |

### I. Resilience

| Item | Evidence | Result |
|---|---|---|
| Browser closed; Python restart; two engines; duplicate request; concurrent conflicting command; SMTP failure | e2e 6; `tests_integration`; AT20; reliability; unit SMTP | **PASS** |
| Camera denied; upload failure; offline reconnect | UI code paths exist; not automated | **NOT_EXECUTED** |
| Database interruption | Not automated. **Observed unplanned during this run:** the substitute DB was killed. The API answered `503 DATABASE_UNAVAILABLE` ("your change was not saved; retry") instead of failing silently. After the restart, state was as of the last snapshot, because the substitute keeps data in memory; MongoDB does not have this limitation. | **NOT_EXECUTED** (as a test) |

### J. Deployment and build

| Item | Evidence | Result |
|---|---|---|
| Actual Vite builds | Not possible in this workspace. The external review built both apps with Vite (Node 24). | **BLOCKED here** |
| Supported runtimes | Node 22.22 and Python 3.13 used for every run here | **PASS** (local) |
| SPA deep links; cookies, CSRF, origins | e2e 1 and 5; story "CSRF", "foreign origin" | **PASS** (local proxy) |
| API rewrites on Vercel; live providers | — | **NOT_EXECUTED / BLOCKED** (no credentials, not authorised) |

## Visual note

Wide tables scroll horizontally inside their own container (`overflow-x: auto`); the page itself does not scroll sideways. This
affects two screenshots:

- On the Alerts page at 1280 px, the action column is cut off.
- In `15-admin-cutoff-elapsed-at-boundary.png` (1200 px), the Band column with "cutoff elapsed" is off-screen to the right.

The test located that text in the row through the DOM. The screenshot shows the line at 10:56 with its −27 h slack. This is
cosmetic, but a narrower column layout would make it visible without scrolling.
