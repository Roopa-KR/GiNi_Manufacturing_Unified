# Test results - Fresh Factory

**Run date:** 2026-10-19 (final code of this delivery).

**Result words:** **PASS** = ran here and passed · **FAIL** = ran and failed · **BLOCKED** = cannot run in this
workspace (reason given) · **NOT_EXECUTED** = could run but was not run.

## Read this first: what database the tests used

| Item | Value |
|---|---|
| Database server used by every test below | **docdb-wire - a TEST SUBSTITUTE, not MongoDB** (`backend/devtools/docdb`). It speaks the MongoDB wire protocol and is reached by the **real** MongoDB drivers (Node `mongodb`, Python `pymongo`); it supports the transactions, unique / partial indexes and queries the app uses. |
| Real MongoDB (local Windows service or Atlas) | **BLOCKED** - not available in this build workspace (no MongoDB binaries, no network access to Atlas). Your connection string was **not** used and your databases were **not** contacted. |
| Your `.env` files | not read by the tests (the test copy excludes all `.env` files and uses a separate test configuration with throw-away secrets) |
| Disposable test databases | `gini_factory_final` (scenario, then the reset test and the mode test on the same database afterwards), `gini_factory_uiwalk` (UI walkthrough), `gini_factory_initcheck` / `gini_syn_probe` (bootstrap checks) |
| E-mail | `EMAIL_MODE=capture` (stored, never sent) |
| Evidence photos | local adapter (no Cloudinary call) |

So every PASS below means *passed against the test substitute*. Run the same tests once against your local MongoDB
replica set (commands at the end) before relying on them.

## 1. First complete scenario (spec §18, steps 1-22) - `backend/tests/fresh/scenario.test.js`

Runs over HTTP against the **real API** (cookies, CSRF, origin checks, idempotency keys) and the **real Python engine**,
on a database that was empty and initialised only with `npm run factory:init`. Nothing seeded, no workbook read.
Log: `backend/docs/test-results/fresh-factory/scenario.txt`.

**Result: PASS 24/24** (23 sub-tests + the enclosing test; 448 s, real-time clock, database `gini_factory_final`).

| Test | Spec step | Result |
|---|---|---|
| 00 the database starts empty (only the bootstrap admin and S-FACTORY) | 1 | **PASS** |
| 01-02 bootstrap admin logs into the admin app; environment banner data | 1-2 | **PASS** |
| 03 configure the test factory and timezone | 3 | **PASS** |
| 04 work centres and stations | 4 | **PASS** |
| 05 product, route, checklists and standards (draft until the checklists exist, then released) | 5 | **PASS** |
| 06 equipment and explicit material stock (no unlimited inventory) | 6 | **PASS** |
| 07-08 three workers with skills (incl. an inspector); their logins work and start from zero | 7-8 | **PASS** |
| 09 order for two good tanks (validation, duplicate refused) | 9 | **PASS** |
| 10-11 release two batches of one tank; two unique tanks generated exactly once | 10-11 | **PASS** |
| 12 assign work: readiness explains blockers; unqualified people refused | 12 + *missing qualifications* | **PASS** |
| 13-14 workers clock in, start, record milestones (minimum crew enforced) | 13-14 + *below-minimum crew* | **PASS** |
| 15-16 finish, inspect, release: tank 1 passes its whole route (incl. unattended cure) | 15-16 | **PASS** |
| 17-19 tank 2 fails, rework is authorised, reworked as a new attempt, reinspected and released | 17-19 | **PASS** |
| 20 the order completes only with two accepted route-complete tanks | 20 | **PASS** |
| 21 worker metrics and points agree with the stored events and ledger | 21 | **PASS** |
| 22 refresh and restart services: state remains (API and engine processes restarted) | 22 | **PASS** |

### Separate checks (spec §18 “also test separately”)

| Test | Covers | Result |
|---|---|---|
| X1 scrap and replacement without increasing demand; missing material blocks the start | scrap + replacement; *missing material* | **PASS** |
| X2 manual mode with browsers closed: no agent completes a person's work; a forged agent command (service token) for a person is refused 403 | *browsers closed* | **PASS** |
| X3 no historical baseline: baseline rules `INSUFFICIENT_DATA`, empty data is not abnormal; rules use the configured work centres only | *no historical baseline* | **PASS** |
| X4 cutoff crossing without new events (engine boundary evaluation) | *cutoff crossing* | **PASS** |
| X5 new worker login with zero history; future start; deactivation keeps history | *new worker* | **PASS** |
| X6 duplicate start / submit requests have one effect (plus duplicate order reference and duplicate release in step 09-11) | *duplicates* | **PASS** |
| X7 reset protection: disabled by default, refused without the flag | *reset protection* | **PASS** |

Observed values worth knowing (from the stored ledger, not hard-coded): time points of a two-person operation were split
by eligible minutes (120 vs 60 minutes → 2:1); the rework correction on the origin was split between the two people of
the original crew.

## 2. Guarded reset - `backend/tests/fresh/reset.test.js`

On a **separate disposable** test database with `ALLOW_FACTORY_RESET=true` (never your database): preview, typed
confirmations, quiesce, operational data of `S-FACTORY` cleared (units, tasks, events, inspections, points ledger,
attendance, alerts, projections, change log), admin kept, workers and configuration kept by default, operator sign-ins
revoked, `factory_reset_log` + `audit_log` record kept, app usable afterwards.
**PASS (1/1)** - run with the final code on `gini_factory_final` right after the scenario (API restarted with the flag
only for this test, then restarted again without it). Log: `backend/docs/test-results/fresh-factory/reset.txt`.
The flag-off refusal is part of X7 above.

## 2b. Operating modes - `backend/tests/fresh/modes.test.js`

On the same disposable database after the reset. **PASS 4/4**: in Manual team test the clock cannot be played, sped up
or paused and equals real time; an agent command for a real person is refused (403); after switching to Simulated test the
clock can be played and sped up, but a real person is still never driven by an agent (403, stays `HUMAN_ONLY`);
returning to Manual team test is refused while the simulated clock is ahead of real time (`SIMULATED_CLOCK_AHEAD`).
Log: `backend/docs/test-results/fresh-factory/modes.txt`.

## 3. UI walkthrough in a real browser (Chromium, Playwright) - empty database

Driven only through the admin and operator screens (no API shortcuts), on the offline builds of both apps.
Steps = sections A-F of `TEAM_TEST_WALKTHROUGH.md`. Screenshots: `docs/screenshots/fresh-factory/`.

**Result: PASS - 16/16 steps, 0 page errors, 0 failed API calls** (database `gini_factory_uiwalk`). Script and log: `backend/docs/test-results/fresh-factory/ui-walk.cjs`, `ui-walkthrough.txt`.

| Step | What was clicked | Result |
|---|---|---|
| admin login | bootstrap admin signs in; Overview shows the empty-factory guidance | PASS |
| 1 factory | Factory setup → 1 · Factory → name, site, timezone, serial prefix → Save | PASS |
| 2 work centres + stations | work centre FAB, station FAB-01 | PASS |
| 5 skills | SK-WELD (production), SK-QC (inspection) | PASS |
| 6 shift | shift D with workdays | PASS |
| 7 material + stock | material MAT-KIT, receipt of 3 | PASS |
| 3 product (draft) | New product with 2-step route + BOM → saved as DRAFT | PASS |
| 4 checklist + release | Create QG10 → question → Save version; product → Release | PASS |
| 8 workers | Olga (operator, SK-WELD) and Ivan (inspector, SK-QC) with logins; onboarding screen | PASS |
| 9 order wizard | New work order PO-UI-1, 1 good tank, 1 batch | PASS |
| 10 release | Release batch → serial `UW-26-00001` shown | PASS |
| 12 dispatch | Dispatch & assign → Assign crew → Olga | PASS |
| 13-15 operator | Olga signs in, Clock in, Start work, Finish work | PASS |
| 16 inspector | Ivan signs in, Clock in, Inspect, Yes, Submit inspection | PASS |
| order state | Orders & Batches: PO-UI-1 “Order line complete”, accepted good 1/1, “Standard-based estimate (no history yet)” | PASS |

A real bug found by this walkthrough was fixed: the station / equipment / stock-receipt selects showed the first option
while their state was empty, so saving failed with “required”; they now start with a “choose…” placeholder.

## 4. Regression: synthetic demonstration still works (same code, synthetic database)

The synthetic demo stack (seeded v3 data in its own test database, `GINI_ENVIRONMENT=SYNTHETIC_DEMO`) with the final code:

| Suite | Result |
|---|---|
| Node integration (`backend/tests/integration`) | **PASS 67/67** |
| Feature flags (`backend/tests/flags`) | **PASS 5/5** |
| Browser end-to-end (`backend/tests/e2e`) | **PASS 7/7** |
| Node unit (`backend/tests/unit`, with the test database URI set) | **PASS 20/20** |
| Python engine (`backend/python_engine/tests`) | **PASS 75/75** |
| Seed tools (`backend/seed/tests`, with the fixture bundle) | **PASS 7/7** |

Logs: `backend/docs/test-results/fresh-factory/synthetic-regression.txt`.

## 5. Safety checks

| Check | Result |
|---|---|
| Starting API / engine on the fresh database performs no delete and no reset | PASS (no delete path at start-up; step 22 restart keeps state) |
| `factory:init` run twice: nothing duplicated, existing admin password unchanged (second run with a different `ADMIN_PASSWORD`: hash identical, 1 admin, 1 session) | PASS |
| `factory:init` refuses a database holding the synthetic demo, and refuses when `GINI_ENVIRONMENT` is not `FRESH_FACTORY` | PASS |
| Workbook seed tool refuses a fresh-factory database (`refuse_fresh_factory`) | PASS (checked against `gini_factory_final`: “Refused … nothing was imported”) |
| No plaintext PIN / password / token in audit payloads, events or logs of the scenario | PASS (scenario asserts no PIN in audit/events) |
| Frontend `.env.example` files contain only `VITE_*` / non-secret values | PASS (reviewed) |
| No synthetic worker, tank, order or history appears in the fresh database | PASS (step 00 and every later count start from 0) |

## 6. Status of each part

### Implemented and tested (against the test substitute)

Empty bootstrap; admin-only setup with 10-step checklist; factory settings and timezone; work centres, stations, skills,
equipment, materials with explicit stock and lots; shift templates → calendar and rosters; products with routes, crew
min/std/max, labour standards, milestones, BOM, DRAFT → RELEASED, route versions; versioned checklists pinned at
inspection start; worker creation with logins, qualifications, future start, deactivation; work-order wizard (required
quantity = accepted good tanks), batches, release with unique tank identities exactly once; readiness and blockers;
assignment with qualification / crew / duplicate checks; clock-in, start, milestones, finish; inspection, hold,
rework as a new attempt, re-inspection, release; scrap and replacement without increasing demand; order completion
from accepted route-complete tanks; points and metrics from stored events; standard-based forecasts with no history;
cutoff boundaries without events; alerts with insufficient-data handling; manual-mode agent protection; persistence
across restart; guarded reset; illustrative template import (API level); environment banner; both apps' fresh screens.

### Implemented but not fully integration-tested

* **SIMULATED_TEST mode**: the guards are tested (2b). A full run with agents driving *designated simulated workers*
  through a whole order was not run end to end.
* **Template import through the screen**: tested through the API and visible in the Template tab; the full click path
  (preview → typed confirmation) was not automated.
* **Reset through the screen**: the API reset is tested; the Reset tab was only checked for its disabled state.
* **Overnight shifts and breaks**: validation and calendar generation tested; a team test across midnight was not run.
* **Windows PowerShell scripts** (`gini-fresh-setup.ps1`, edits to `gini-2-setup.ps1` / `gini-3-start.ps1`): reviewed,
  **not executed** (no Windows in this workspace).

### Blocked by infrastructure

* Real MongoDB / Atlas transactions and indexes - **BLOCKED** (test substitute used; see top).
* Real SMTP delivery - **BLOCKED** (capture mode only; no e-mail was sent).
* Cloudinary upload - **BLOCKED** (local evidence adapter only).
* Public deployment (Vercel / Render) - **NOT_EXECUTED** (not authorised).

### Business policies still needing confirmation

1. **Points**: time points of a crew split by eligible minutes; the rework correction charged to the original crew
   by the same shares. Confirm the split and whether rework labour earns points.
2. **Disposition** with no configured matrix: every failed inspection is decided by a person (no automatic
   rework/scrap). Confirm who may approve (currently quality supervisor / admin).
3. **Replacement** after scrap: explicit request + approval, blocked while material is missing. Confirm whether it should be automatic.
4. **Forecast with no history**: standard-based, fail rate 0 until real inspections exist. Confirm when history-based
   fail rates should take over (minimum sample).
5. **Baseline rules** stay `INSUFFICIENT_DATA` until enough history exists; confirm the minimum history per rule.
6. **Assignment before clock-in** is allowed (assigning is not starting); starting requires clock-in. Confirm.
7. **Tank serial format** `<PREFIX>-<YY>-#####`: the number does not restart each year. Confirm.
8. **Shift calendar horizon** 60 days ahead, regenerated on shift changes. Confirm.
9. **Credentials**: admin password ≥ 15 characters; worker PIN 6-8 digits; PIN change on first sign-in by default. Confirm with IT.
10. **Engine catch-up** after an outage in manual mode: only timed process steps (cure, transfer) are caught up, up to 12 hours. Confirm.
11. **Illustrative template values** (standards, crews, limits) are synthetic and must be replaced by confirmed values before any real use.

## Commands to repeat the tests on your own MongoDB (replica set required)

Use a **disposable** database name - never `gini_factory_teamtest` (your team database) and never your demo database.
In PowerShell, from the `backend` folder, with the API and the engine started on that database:

```powershell
$env:MONGODB_DB_NAME = "gini_factory_selftest"          # also in python_engine/.env while testing
npm run factory:init                                     # empty bootstrap of the disposable database
# start the API (npm start) and the engine (cd python_engine; py -3.13 -m gini_engine) with the same settings, then:
$env:API_URL = "http://localhost:5000"
npm run test:fresh                                       # the 22-step scenario + X1-X7 (about 8 minutes, real time)
$env:FRESH_MODES_TEST = "1"; node --test tests/fresh/modes.test.js        # optional; leaves the database in Simulated test
# optional reset test: restart the API with ALLOW_FACTORY_RESET=true for this database only, then
$env:ALLOW_FACTORY_RESET_TEST = "1"; node --test tests/fresh/reset.test.js
```

The tests read `ADMIN_LOGIN`, `ADMIN_PASSWORD`, `MONGODB_URI`, `INTERNAL_SERVICE_TOKEN`, `FRONTEND_URL`, `ADMIN_URL` from
the environment (the same values as in `backend/.env`). Set `ALLOW_FACTORY_RESET=false` again afterwards.
