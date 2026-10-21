# Demonstration guide: accounts and scripted walkthrough

Everything shown is a **synthetic demonstration** (yellow banner on every screen): fictional people, a fictional plant,
no connection to any factory, not Siemens-approved. The story runs on an **interactive branch** forked from checkpoint
`CK-20261015-1055` (Thu 15 Oct 2026, 10:55 plant time, America/Bogota).

## 1. Accounts

Sign-in is employee ID + demo PIN. PINs are text: `004211` is not `4211`.

| Person (worker ID) | Role → app | Use in the demo |
|---|---|---|
| `admin` | Administrator → admin app | sessions, clock, scenario console, workers, rules |
| W0173 James Nelson | Shift manager → admin (and operator) | supervision, recovery approval |
| W0175 Joshua Watson | Area supervisor → admin | dispatch, transfers, absences |
| W0179 Zachary Anderson | Quality supervisor → admin | dispositions, investigations |
| W0001 James Miller | Production operator → operator app | mid-shift worker on a WC1 crew (fit-up) |
| W0002 … W0013 | Production operators (WC1 crews) | concurrent tank tasks, crew sharing |
| W0162 Melissa Hayes (or another free inspector W0162–W0172) | Quality inspector → operator app | independent gate inspection with photos |
| W0021 Aaron Cox | Production operator, off shift at the checkpoint | off-shift state |
| W0181–W0184 | Maintenance | repairs |
| W0189–W0192 | Material handlers | deliveries |

Get demo PINs on the machine that ran the seed (never in production, printed to that terminal only):

```bash
cd backend/seed
python setup_accounts.py --dataset-id GINI-SYN-TANKS --show-pin-for W0001 --show-pin-for W0162 --show-pin-for W0179
```

`demo_accounts.csv` (written by the seed) lists every account with role and permissions — **no PINs**.

## 2. Preparation (5 minutes before)

1. Admin app → **Administration → Simulation**: reset the default session (type `RESET <id>`), or create a new
   interactive session from `CK-20261015-1055` and make it the default. Wait for the "initialising" banner to clear.
2. Leave the clock **paused** for the guided part; the header shows `Interactive`, the simulated clock (10:55) and
   "Analytics up to date".
3. Open the operator app on a tablet/phone or a second browser window.

## 3. Walkthrough (≈ 25 minutes)

**Act 1 — the shift as it is (observed state).**
Admin → **Overview**: 88 clocked in, 34 productively working, 28 active tanks; each work centre shows working/
waiting/on-break people, queue vs physical capacity, stations, equipment down (PB-02 at WC3, MS-06 at WC4) and a
FORECAST line (limiting constraint, load vs qualified labour, predicted run-out of work). Point out the labels:
OBSERVED vs FORECAST, and that the two pieces of equipment were already down at the fork (no notification was sent
for conditions already present). **Workforce** → filter WORKING / ON BREAK / OFF SHIFT; open W0001 for the timeline.

**Act 2 — an existing worker signs in mid-shift.**
Operator app, W0001: the running fit-up task on tank `DEMO-TANK-000597` with its order, batch, crew of five, eligible
time from history (signing in did not clock in, start or restart anything), milestones, instruction revision and
points. Pause → choose a reason; reload the page — still paused, same task. (A planned-break pause puts the worker on
break; **End break** resumes the task.)

**Act 3 — finish, mandatory inspection, photo evidence, failure, rework at the same station.**
W0001 records the remaining milestones and **Finish work** (finishing is not a pass or a release). Admin →
Quality shows the tank awaiting inspection; no downstream work can start. Inspector W0162 → **Inspect**, enters
readings (one outside the limit), adds a photo (camera or upload; badge goes Uploading → Verifying → Verified), submits:
**FAIL**, the tank goes on quality hold, failed readings and photos are kept. Quality supervisor (W0179 or admin) →
Quality → hold → **Decide**: repairable → return to the **same station** (no fictitious transport when inspection
happened there); an alternate station needs a named approver. The rework appears as a new attempt; after it, a
reinspection **PASS** releases the tank and the route resumes. Passport (Orders → line → tank) shows every attempt,
reading, photo, hold, disposition and release in order.

**Act 4 — scrap and replacement; two batches still reconcile.**
Administration → **Scenario console → Physical defect** on a queued tank, *non-repairable*, next gate. Play at ×10
until the inspection finds it (or perform the inspection). The disposition scraps it (permanent); Quality →
**Replacement** creates a new tank ID that satisfies the original demand. Orders → line shows good/active/scrapped/
replacement counts per batch that add up.

**Act 5 — downstream detection, investigation, equipment no-fault.**
Operator at a later station → **Report incoming defect** on a received tank: it is held and an investigation opens
against the earlier operation (involvement is not fault; no points change while pending). Quality → Investigations →
confirm the cause as **EQUIPMENT**: no deduction for anyone. (Confirming a WORKER cause would post −4 split by confirmed
responsibility, reversible by a later change.)

**Act 6 — evolving variance flags and notification capture.**
Scenario console → **Equipment interruption** on a WC1 fixture (60 min). Within seconds Alerts shows **M11 FIRING**
for that workstation with actual/threshold/evidence and exactly **one captured notification** (Alerts →
Notifications). **Ack** — still FIRING (acknowledging is not resolving). Materials → **Repaired**: the alert moves to
RECOVERING/RESOLVED in the same episode. Try **Material shortage** with a supplier delay (Materials shows "supplier can
deliver from …", the forecast names MATERIAL), **Absence**, or **Late evidence**; each injects a cause — no button sets a
flag directly.

**Act 7 — cutoff risk, recovery, verification.**
Play at ×30 for a minute, then Pause. **Recovery**: order lines with band, forecast ready time and range, good-by-due,
slack and limiting constraints. **Simulate** an AMBER/RED (or the tightest) line: options ranked with feasibility
checks — transfer (recipient qualified at arrival, donor minimum crew and queue cover), overtime, replacement,
resequence, expedite, combinations — with the effect on other lines (source-damaging options are rejected and say
why). **Propose** the best feasible option → **Verify**: approve, start (transfers and overtime are executed as real
commands), and later compare the immutable before/after forecast with the observed result (PROVISIONAL until due).
If anything happened in between, the approval is refused as stale — re-simulate.

**Act 8 — points reconcile.**
Operator → **Progress**: labour categories, tasks completed, crew shares, ledger lines (history known at the fork +
session); every total equals the ledger. Crew time is split, never duplicated.

**Act 9 — new data through the same engines.**
Administration → **Workers → New worker** (e.g. PIN `004211`, qualification SK-PA, shift A). Sign in to the operator
app with the new ID: zero tasks, zero points, *not clocked in* (creating a person fabricates no history). Clock in;
the person appears in the plant view and can accept eligible work from the queue. Create a second session to show that
branches are isolated.

## 4. If something goes wrong during the demo

| Symptom | Do this |
|---|---|
| "Engine offline" in the header | the observed screens keep working; restart the engine (Render → Manual Deploy → Restart); nothing is lost |
| A command is refused | the message says why (e.g. station occupied, not qualified, approval stale) — that is the validation working |
| You want a clean slate | Administration → Simulation → Reset (only the selected session) |
| Too fast to follow | Pause, or set ×1; notifications are suppressed at ×30 and above |
