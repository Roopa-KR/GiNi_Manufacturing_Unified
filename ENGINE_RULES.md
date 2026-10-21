# Engine rules

**Ownership.** Python (`backend/python_engine/gini_engine/`) owns every derived calculation:

- labour metrics;
- forecasts and cutoff bands;
- variance rules and alerts;
- points;
- recovery options and verification.

Express (`backend/src/domain/`) owns the validated command transitions and permissions. The browser only displays results.

**Configuration.** Rule configuration lives in `backend/config/rules.json` (version **1.1.0**). Versions saved in Administration →
Rule settings are effective-dated: the newest version whose `EFFECTIVE_FROM` has passed applies, and a future-dated version waits.
The points policy is in `config/points_policy.json`. Every projection document carries the following trace fields:

- `CALCULATION_ID`
- `PROJECTION_VERSION`
- `RULE_VERSION`
- `ENGINE_VERSION`
- `AS_OF` (simulated time)
- `INPUT_WATERMARK` (event sequence)
- `COMPUTED_AT` (wall time)
- `TRIGGER` (`EVENTS`, `PERIODIC`, `BOUNDARY: <reason>` or `RECOVERED_OVERDUE_BOUNDARY`)

## 1. Calculation pass and scheduling

A pass runs in this order (`calc.py`):

1. input watermark;
2. labour metrics;
3. route forecast;
4. variance rules;
5. alert lifecycle and notification outbox;
6. points re-evaluation;
7. worker metrics;
8. action verification;
9. fenced publish.

A pass publishes only if no pass with a newer input watermark or a higher version published first. A superseded pass deletes only
its own documents, so a screen never mixes two versions. When a pass fails, the previous published projection stays and the UI
shows its age and `RECALCULATING` / `ENGINE_UNAVAILABLE`. A failure never shows as zero.

**Deadline-aware scheduling** (this replaces the old "every 5 minutes only" rule). A pass is triggered in four ways:

- **Events.** Every committed command enqueues a RECALC job.
- **Boundaries.** Each pass stores `ENGINE.NEXT_BOUNDARY_SIM_AT` and the next six boundaries with reasons (`calc.next_boundaries`).
  Boundaries are exact to the second:
  - each open order line's buffer deadline **+ 1 s** and cutoff **+ 1 s**. This is the first instant with a different result,
    because the bands are inclusive (14:30:00 is still AMBER; 14:30:01 is RED or cutoff-elapsed);
  - each open replenishment request's need-by + F6 threshold (F6 is inclusive: `late >= 10`, so exactly need-by + 10 min);
  - the current shift's end and the next shift's start.

  Agents act in whole simulated minutes, but a deadline does not wait for the next minute. `worker.plan_advance` stops stepping
  **before** the minute that would pass a boundary. The pass is then evaluated **as of the boundary itself** (e.g. 14:30:01),
  including a boundary inside the current part-minute. A boundary that falls exactly on a minute (shift end) is evaluated after
  that minute's step, so the shift change is applied first. Agent activity is applied up to the last whole minute before the
  boundary. Human commands are committed in the database as they happen, so nothing is missed. The pass is labelled
  `TRIGGER: "BOUNDARY: <reason>"` and `AS_OF = boundary`. At ×1, the engine tick (3 s) plus a pass of about 3 s gives an
  evaluation a few seconds after the crossing.

  The boundary is in simulated time, so pause and speed are respected: a paused clock crosses no boundary.

  An earlier version scheduled boundaries at deadline + 1 **minute**. That meant up to 60 s of delay at ×1. It was corrected after
  the review.
- **Restart recovery.** If the simulated time is past a stored boundary that was never evaluated (the engine was down while the
  clock ran), the engine evaluates at once (`RECOVERED_OVERDUE_BOUNDARY`). It then catches up minute by minute and stops before
  every boundary crossed on the way.
- **Periodic.** Every 5 simulated minutes, only for rolling-window rules (F3, M01 and similar).

Tests:

- `python_engine/tests/test_boundaries.py`:
  - need-by 14:00 gives 14:10:00; buffer deadline 14:20 gives 14:20:01; cutoff 14:30 gives 14:30:01;
  - the band changes exactly at the scheduled instant;
  - `plan_advance` stops before the minute that would pass a sub-minute boundary, evaluates a boundary inside the current
    part-minute, applies an on-minute boundary after that minute, and respects the per-tick limit;
  - passed boundaries are not rescheduled.
- `tests/integration/repair.test.js`: the live engine records cutoff boundaries at :01 s. This test does **not** cross a
  deadline.
- `tests/e2e/browser.test.js`, test "deadline crossing at x1". It creates an order line whose cutoff is 75 simulated seconds
  ahead and plays the clock at **×1**. It then asserts:
  - a projection exists with `TRIGGER "BOUNDARY: cutoff passed for <line>"` and `AS_OF` = cutoff + 1 s exactly;
  - the line is `CUTOFF_ELAPSED` and RED;
  - the supervisor Recovery page shows "cutoff elapsed" within 15 s of the moment the shared clock crossed the boundary
    (measured in Chromium, including the page's 5 s polling).

  Evidence is in `tests/e2e/.artifacts/deadline-crossing.json`, copied to `backend/docs/test-results/`.

## 2. Cutoff bands (`forecast.classify`)

The deadline basis is the ROUTE_COMPLETE time of the required good quantity. The buffer is `SAFETY_BUFFER_MINUTES` = 10.

| Band | Condition | Spec example (cutoff 14:30, buffer 10) |
|---|---|---|
| GREEN | forecast ready ≤ cutoff − buffer | 14:20:00 → GREEN |
| AMBER | cutoff − buffer < ready ≤ cutoff | 14:20:01 → AMBER; 14:30:00 → AMBER |
| RED | ready > cutoff, **or** a known quantity shortfall, **or** the cutoff elapsed without the output | 14:30:01 → RED |
| UNKNOWN | no due time, or readiness cannot be estimated (also: held tanks without disposition). Never shown as on time. | — |
| COMPLETE | finished output keeps its actual result | — |

Tests: `python_engine/tests/test_cutoff.py`. It covers every boundary to the second, plus shortfall, an elapsed cutoff, completed
output, an overnight shift with timezone, and no cutoff.

## 3. Variance flags F1–F6 (`variance.py`)

Common behaviour:

- A breach becomes FIRING after `persistence` consecutive evaluations, and RESOLVED after `recovery` clear evaluations.
- A closed entity (finished operation, delivered request) clears like an OK evaluation.
- `NO_DATA` / `INSUFFICIENT_DATA` never breach and never resolve.
- Notifications: one outbox item per `<session>|<alert>|<episode>|<transition>` (unique key) for FIRING / ESCALATED / RESOLVED.
  They are suppressed in replay, on a session's first pass, at speed ≥ the session's `NOTIFY.SUPPRESS_SPEED` (default ×30), and
  inside the cooldown.
- Every flag has a LIVE end-to-end test in `tests/flags/flags.test.js`: healthy → condition created by commands → UI row →
  exactly one captured notification → ACK keeps FIRING → cause corrected → RESOLVED.

| Flag | Operational meaning | Formula (exact inputs) | Config (`rules.json`) | Minimum sample / baseline | Zero / missing | Boundary | Persist / recover; notify |
|---|---|---|---|---|---|---|---|
| **F6 Replenishment Delay** | A material request is late and still short | For each `sim_material_requests` row not DELIVERED/CANCELLED that has `NEED_BY_AT`: outstanding = `QTY − DELIVERED_QTY`; late = now − `NEED_BY_AT`. HIGH if an operation is blocked on that material (`sim_operations.BLOCKED_MATERIAL_ID`). | `threshold.min_minutes` = 10 | none (no baseline: the need-by is the contract) | no need-by → not evaluated; partial delivery reduces outstanding | breach when outstanding > 0 **and** late **≥** 10 min | 1 / 1; yes |
| **F5 Congestion** | A finite queue is nearly full | queued = tanks at the work centre with STATE QUEUED or QUEUED_FOR_REWORK; occupancy = queued / `WORK_CENTER_MASTER.QUEUE_CAPACITY_UNITS` × 100; plus blocked arrivals (`BLOCKED_ARRIVAL`) | `threshold.occupancy_pct` = 85 | capacity must be configured (WC1 8, WC2 6, WC3 5, WC4 6) | no capacity → no congestion claimed | breach at occupancy **≥** 85 % or any blocked arrival; HIGH at 100 % with blocked arrivals | 3 / 2; yes |
| **F2 Regional Workload Imbalance** | One area is overloaded while another has idle qualified people | Per area (FAB = WC1+WC2, FIN = WC3+WC4): ratio = remaining standard labour (`metrics.remaining_std_work`) ÷ unique qualified clocked-in operators × minutes to their shift end (`metrics.available_labor`). Breach when one area > 1.3, another < 0.7, and the light area has ≥ 2 people qualified for the heavy area's skills. | `threshold.high_ratio` 1.3, `low_ratio` 0.7; `min_samples.qualified_people` 2 | capacity counts each person once; a person in transfer counts only after arrival | an area without qualified capacity → NO_DATA | strict `>` 1.3 and `<` 0.7 | 2 / 2; yes |
| **F3 Material Velocity Anomaly** | Material is issued much faster or slower than the work being done | net issues = `MATERIAL_CONSUMED` events in the session part of the last 120 min, minus issues reversed as recorded-in-error (`MATERIAL_ISSUE_REVERSED`); rate = net issues ÷ productive DIRECT/REWORK labour hours in the same window; baseline = issues per productive hour over the history known at the fork (`baselines.MATERIAL_ISSUES_PER_PRODUCTIVE_HOUR`) | `threshold.rel_pct` 50, `min_abs` 2; `min_samples.productive_hours` 1 | ≥ 1 productive hour in the window; a baseline must exist | under 1 productive hour → INSUFFICIENT_DATA (zero demand is not a fault); no baseline → INSUFFICIENT_DATA | breach when \|issues − expected\| **≥** 2 **and** relative deviation **≥** 50 % | 2 / 2; yes (enabled in 1.1.0) |
| **F4 Location Velocity Anomaly** | A tank sits at an occupied station much longer than usual (slow processing, not missing supply) | Tank in WORKING/PAUSED/READY/REWORK_IN_PROGRESS at a workstation: dwell = now − operation `STARTED_AT` (else `STATE_SINCE`); baseline = median station dwell per work centre over history known at the fork (`DWELL_MEDIAN_MIN`) | `threshold.rel_pct` 50, `min_abs_min` 30; `min_samples.baseline_visits` 5 | median over ≥ 5 visits | no baseline → not evaluated; empty station → not this rule (M10 starvation) | breach when dwell **≥** baseline × 1.5 **and** dwell − baseline **≥** 30 min | 2 / 2; yes (enabled in 1.1.0) |
| **F1 Stalled Active Assignment** | A genuinely working crew shows no progress evidence for much longer than the next milestone needs | For WORKING labour operations only (cure, breaks, authorised pauses and external holds are other states): expected = (next milestone's progress threshold − last reached threshold) × elapsed standard for the crew size (`CREW_CAPACITY_RULES`); since = now − last milestone (inherited operations: since the fork) | `threshold.factor` 1.5, `min_excess_min` 20 | milestone definitions for the operation | no milestones / no standard → not evaluated | breach when since **≥** expected × 1.5 **and** since − expected **≥** 20 min; HIGH at ≥ 2× | 2 / 2; yes |

Commands used by the live tests and by real operations: `MATERIAL_REQUEST`, `MATERIAL_DELIVERY`, `BATCH_RELEASE`, `OPERATION_START`,
`WORKER_TRANSFER` / `TRANSFER_ARRIVE`, `MATERIAL_ISSUE` / `MATERIAL_ISSUE_REVERSE` (new: a manual issue and the reversal of an
issue recorded by mistake), `MILESTONE_COMPLETE`, `TASK_FINISH` and `ALERT_WORKFLOW`.

The other rules (M01–M13: efficiency, earned-work gap, backlog, staffing gap, rework/scrap rate, deadline risk, starvation/blocking,
equipment/material interruption, minimum crew, stale telemetry) are unchanged. Their definitions are in `backend/docs/formulas.md` §4.

## 4. Points (`points.py`, RULE_VERSION 2.0)

| Rule | Points | Basis |
|---|---|---|
| PTS-TV1 | standard allowance − actual eligible minutes, **2 decimals** | One allowance per gate-released labour attempt, split across the crew by eligible-minute shares with exact residual allocation. It is never granted to each member. 40 std / 39.5 actual → **+0.50**; 40 / 40.5 → **−0.50**; crew 90 / 84 → **+6.00** total (W1 2.14, W2 2.14, W3 1.72). |
| PTS-NR3 | +3 per completed work order | no rework, scrap, FAIL hold or downstream defect on any tank of the WO |
| PTS-OF2 | +2 per completed work order | a defect caught and corrected at its origin station, with no downstream defect and no scrap; mutually exclusive with NR3 |
| PTS-DD4 | −4 per distinct downstream defect (exact `DEFECT_ID`) | only after a named human reviewer confirmed a **WORKER** cause, split by the confirmed shares |

**Eligible time.** Only DIRECT/REWORK participation without an external reason counts. The following are excluded and listed on the
evaluation as `excludedMinByReason`:

- breaks;
- external blocking;
- material or equipment waits;
- transfer and handover;
- cure;
- below-minimum-crew time.

Inspection attempts are never time-scored, so there is no incentive to rush an inspection.

**Rework attempts and approved standards.** A populated number is not an approval.

- A rework attempt earns time points only against an **APPROVED** rework standard in `rework_standards`. Each standard has a
  named approver, an approval statement, a version and an effective date. It is approved in Administration → Rule settings →
  Rework labour standards (`POST /api/admin/master/rework-standards`), in one transaction with its audit record.
- `OPERATION_START` records the provenance on the attempt (`sim_operations.REWORK_STANDARD`):
  - `STATUS APPROVED` with `STANDARD_ID`, `VERSION`, `APPROVED_BY`; or
  - `STATUS PROVISIONAL`, `SOURCE SYNTHETIC_DEFAULT_PLANNING_VALUE`.
- The 60-min planning value from `config/simulation.json` is used **only for forecasting**.
- Without an approved standard, the attempt's evaluation is `PENDING` ("waiting for an approved rework standard") and no time
  points are posted. Anything booked earlier against an unapproved value is reversed.
- A standard approved later but effective before the attempt started releases the points on the next pass. Lookup order is
  product + rework type, then product, then rework type, then any.
- Awarded rows carry `REWORK_STANDARD_ID` and `REWORK_STANDARD_VERSION`.

**Points policy versions.** The shipped `config/points_policy.json` (1.1.0) is the client's formula. Two attempt adjustments go
beyond the original formula and are therefore **OFF** by default:

| Policy switch | Effect when ON |
|---|---|
| `withdraw_positive_time_on_confirmed_workmanship_defect` | Positive speed points on an attempt are withdrawn when a reviewer confirms a workmanship defect on it |
| `waive_negative_time_on_confirmed_equipment_cause` | An attempt's overrun is not charged when a reviewer confirms an equipment cause |

A switch is turned on only by saving a **confirmed policy version** (Administration → Rule settings → Points policy,
`POST /api/admin/points-policy`). The version records the confirmer, a confirmation statement of at least 20 characters, an effective
date and a hash, and it is audited. Recording provenance:

- every evaluation records `POLICY_KEY`;
- every ledger row records `ALLOCATION_POLICY` and `ALLOCATION_POLICY_STATUS` (`CONFIRMED` / `SHIPPED_DEFAULT_NOT_CONFIRMED`);
- a change of the policy in force re-evaluates every subject, posting linked reversals and new rows.

**Re-evaluation with an append-only ledger.** The subject is one of `TV1|<attempt>`, `WO|<order>` or `DD4|<defect>`.

- **Which subjects are evaluated.** Each pass re-evaluates subjects that are new, PENDING, or whose tank was touched by an event since
  the last pass. After an engine restart or a rule-version change, it re-evaluates every subject.
- **Where evaluations are stored.** Every evaluation goes to `sim_points_evaluations` with:
  - status `PENDING` / `AWARDED` / `NOT_ELIGIBLE` / `DEDUCTED` / `NO_DEDUCTION` / `HISTORY_FINAL`;
  - reason, evidence and evidence hash;
  - the desired allocation and the booked net;
  - calculation id, as-of time and rule version.
- **What is booked.** The desired allocation is compared with what is currently booked for that exact subject: the history ledger
  known at the fork plus the session ledger.
  - Unchanged evidence posts nothing.
  - A change posts, per affected worker, a **reversal** row (`REVERSAL_OF_ID` and `REVERSES_TRANSACTION_IDS` name the reversed
    rows, including history rows such as `PTX-B-000777`) and a new revision row.
- **Atomic and idempotent.** A revision is one transaction with deterministic IDs: `AWARD_KEY = SUBJECT|R<n>` / `SUBJECT|X<n>`, and
  `POINTS_TRANSACTION_ID = PTS-<session>-<sha1(award key, worker)>`. The unique index (`SESSION_ID`, `AWARD_KEY`, `WORKER_ID`) means a
  retry, a restart or a concurrent second engine aborts a duplicate revision as a whole.
- **Late evidence.**
  - A confirmed WORKER cause books DD4 against the confirmed responsible people.
  - Withdrawing speed points for a workmanship defect, and waiving overruns for an equipment cause, happen **only** under a
    confirmed policy version (see above).
  - A session downstream defect on a WO awarded before the fork reverses the history award.

**Responsibility validation** (`INVESTIGATION_UPDATE`):

- Confirmation needs a named, signed-in human reviewer and an evidence note.
- Every named worker must exist in the session roster (inactive or departed people stay valid).
- No duplicates.
- Shares must be finite, positive, at most 1, and total 1.
- A reviewer cannot name themselves.
- Naming the person who *detected* the defect requires the explicit `detectorAlsoResponsible`. Detection is not fault.
- EQUIPMENT / MATERIAL / SUPPLIER / PROCESS causes cannot name workers and produce no deductions.
- UNKNOWN / SUSPECTED stay pending: suspected parties are stored separately and never deduct.

Tests:

- `python_engine/tests/test_points.py` and `test_points_ledger.py` (real pymongo) cover:
  - fractional values, crew total, and pending → allocated;
  - the default policy keeping the formula, and a confirmed policy withdrawing points with linked reversals (with no event needed);
  - the equipment waiver only under a confirmed policy;
  - a planning value that is not an approval, and an approved standard (most specific key, effective date) releasing points;
  - D-1 vs D-10, corrected shares, equipment no-fault, history reversal and NR3/OF2 exclusivity;
  - four concurrent engines, and ledger = evaluations.
- `tests/integration/standards-policy.test.js`: approval and confirmation through the API, covering validation, versions,
  supersession, audit, idempotent retry, operators refused, and a future-dated version that waits.
- `tests/integration/repair.test.js`: every invalid-responsibility case through the API, the DD4 lifecycle and the change log.

## 5. Recovery and verification

Options are generated from the forecast's limiting constraints and simulated through the same DES:

- qualified transfer;
- relief worker;
- overtime;
- replacement;
- resequence;
- material or maintenance expedite;
- combinations;
- an explicit **no-action** baseline.

Each option has donor/recipient checks and the source-damage rule (an option that turns another line RED is rejected). A proposal
records its baseline forecast, the options, its approvals, planned and actual times, handover, output, and the forecast error. An
approval goes stale when any event happens after its forecast, and then it is refused. Old forecasts are immutable copies and are
never overwritten. Details are in `backend/docs/formulas.md` §6–7. The tests are `tests/integration/engine.test.js` 14.
