# Tank passport field map

**Endpoint:** `GET /api/sessions/:sid/units/:unitId`. The server code is in `backend/src/services/passport.js` (sections) and
`plantViews.passport` (attempts, inspections, events).

**Rendered by:**

- `admin/src/components/PassportSections.jsx`, at the supervisor route `/units/:unitId`.
- The same component in `frontend/src/components/PassportSections.jsx`, at the operator route `/tanks/:unitId` (role-limited).

**How records are read:**

- *History* means records of the source run (`RUN-BASE`) that satisfy **EVENT_TIME/anchor ≤ cut AND KNOWN_AT ≤ cut**. The cut is
  the fork for interactive sessions and the replay clock for replays.
- *Session* means `sim_*` records of this session as of simulated now.
- A field with no record is `null` and the UI shows **"Not recorded"**. Nothing is estimated or invented.

**Role filtering:**

- Values marked 🔒 are returned as `"RESTRICTED"` unless the viewer has `view_all_workers`, `operational_supervision` or
  `quality_approval`.
- An operator sees crew names and intervals, plus their **own** minutes and points.

## Identity

| Field | Source |
|---|---|
| Unit ID, serial | `sim_units.UNIT_ID / TANK_SERIAL_NO`, else `unit_master` |
| Product / model | `UNIT.PRODUCT_ID` + `product_master.PRODUCT_NAME` |
| Component type, drawing, revision, route + version | `unit_master.COMPONENT_TYPE / DRAWING_REF / DRAWING_REVISION / ROUTE_ID / ROUTE_VERSION` |
| Work order, line, production batch | `sim_units.ORDER_ID / ORDER_LINE_ID / BATCH_ID` (current batch), else `unit_master.INITIAL_BATCH_ID` |
| Parent/child batch history | `batch_unit_membership` (history) + `sim_batch_membership` (session splits, with `PARENT_BATCH_ID`) |
| Replacement-for / replaced-by | `REPLACEMENT_FOR_UNIT_ID`, `REPLACED_BY_UNIT_ID`, `replacement_requests` / `sim_replacements`. Both are clickable links. |
| Created | `unit_master.CREATED_AT` |

## Current state

| Field | Source |
|---|---|
| State, since | `sim_units.STATE / STATE_SINCE` (or `NOT_IN_ACTIVE_WINDOW` for a tank only in history) |
| Physical location (work centre, workstation) | `CURRENT_WORK_CENTER_ID / CURRENT_WORKSTATION_ID` |
| In transit from → to, arrival | `ARRIVE_AT`, `TRANSFER_TO_WORK_CENTER_ID` / `REWORK_PENDING.DEST_WORK_CENTER_ID` |
| **Proposed rework destination** (kept separate from the physical location) | `REWORK_PENDING.DEST_WORK_CENTER_ID / DEST_WORKSTATION_ID / RETURN_ID` |
| Current operation attempt | `CURRENT_OPERATION_INSTANCE_ID` → attempt no., type, state |
| Hold | open `sim_holds` row (type, since, location) |
| Blocker | attempt state `BLOCKED*` / `WAIT*` / `BELOW_MIN_CREW`, or `BLOCKED_ARRIVAL` |
| Assigned crew / productive now | `sim_tasks` for the current attempt (ASSIGNED / ACCEPTED / PAUSED / WORKING) / WORKING only |
| Last recorded event, data freshness | latest history/session event; `freshness` (operational as-of, analytics watermark, engine status) |

## Progress

| Field | Source |
|---|---|
| Route steps completed / current / pending (and gates PASSED) | `routing_operations` for the product + attempts + `PASSED_GATES` |
| Operation attempts and rework loops | `operation_instances` (history) + `sim_operations`; `return_movements` + `sim_returns` |
| Milestone progress | `MILESTONES_DONE` vs `milestone_definitions`; history `operation_milestone_events` |
| Expected next action | Derived from the tank's state (`passport.nextAction`) for **every** unit state in `contracts/state_machines.json` (25 states, plus older names found in history). It names who acts and what releases the tank, using the current operation, the next gate, the hold type, the rework destination, the expected arrival, the cure end and the next route step. Examples: WORKING → "Crew records the remaining milestones of OP10, then Finish work - finishing is not a pass; inspection QG20 follows"; QUALITY_HOLD → "An authorised approver decides the disposition …". A tank outside the active window gives "history only". An unknown state is reported as "No guidance for state X", never left empty. Tested by `tests/unit/passport-next-action.test.js` (coverage of every contract state) and repair "passport" (live tanks). An earlier version returned `null` for WORKING, PAUSED, WORK_COMPLETED_AWAITING_INSPECTION, QUALITY_HOLD, REWORK_IN_PROGRESS and CURING; this was corrected after the review. |
| Work completed / inspection passed / final release | latest labour `finishedAt` / latest PASS inspection `completedAt` / `ROUTE_COMPLETED_AT`. These are three separate fields. |
| Forecast next movement, line completion, band | `OPERATION_FORECAST` and `ORDER_FORECAST_SUMMARY` projections. Labelled ◇ Forecast, with computation time. |

## People and labour

| Field | Source |
|---|---|
| Who worked on each attempt | `operation_crew` (history), `sim_tasks` (session) |
| Join/leave and contribution intervals | `labor_segments` (history), clipped at the cut; `sim_participation` (session) |
| Minutes by category (direct, rework, waiting, break, transfer) 🔒 for others | segment phase → category (`NORMAL`→DIRECT, `CORRECTION/REWORK`→REWORK, `BELOW_MIN_OR_BLOCKED`→WAITING) |
| Labour minutes vs elapsed 🔒 | Σ DIRECT+REWORK minutes vs attempt start→finish |
| Inspector, reviewer, disposition approver, action owner | `inspection_header.INSPECTOR_ID` / `sim_inspections`; investigations `REVIEWED_BY` / `ACTION_OWNER`; dispositions `DECIDED_BY`; `sim_actions.OWNER_ID` |

## Quality

| Field | Source |
|---|---|
| Inspection history, checklist / spec version | `inspection_header` + `sim_inspections` (`CHECKLIST_VERSION`, gate, attempt, trigger, reinspection-of, entry lag) |
| Readings, units, limits, results | `inspection_readings` + `sim_readings` |
| Failed and passed attempts | inspection `RESULT` |
| Photograph evidence | `sim_evidence` (status, captured-at, retake/supersedes). History rows carry `PHOTO_EVIDENCE_REF` when present. |
| Detected-at/by vs suspected/confirmed origin | `defect_records` / `sim_defects` (`DETECTED_BY`, detection stage/work centre) vs `SUSPECTED_ORIGIN_*` and the confirmed origin |
| Investigation status and attribution 🔒 | `defect_investigations` (history) + `sim_investigations` (responsible parties, shares, evidence) |
| Return authorisation and reinspection outcome | `sim_returns` / `return_movements` (authorised by, destination, basis, alternate approval, loop status) |

## Traceability

| Field | Source |
|---|---|
| Material lot, material events | `unit_master.MATERIAL_LOT_ID`, `material_events` for the unit |
| Equipment used | attempts' `EQUIPMENT_ID` |
| Timestamped history | history `production_events` + session `sim_events` |
| EVENT_TIME vs KNOWN_AT (late records) | events whose KNOWN_AT is more than 1 min after EVENT_TIME, with the lateness |
| Points evidence (own only for operators) 🔒 | `points_ledger` (history) + `sim_points_ledger` (session), including reversal links. Points evaluations 🔒. |
| Related alerts and recovery actions | `sim_alerts` (entity or evidence = unit) and `sim_actions` (unit or its order line) |

## Clickable tank IDs (both apps)

| App | Where |
|---|---|
| Operator (`/tanks/:id`) | Current work card, task view, queue (my tasks, queue, planned next), progress (crew shares, ledger, pending points, investigations), inspection header |
| Supervisor (`/units/:id`) | Orders and batches (incl. extra/replacement tanks and membership history), work centres (stations, queue, awaiting inspection), quality board (holds, returns, investigations, inspections, scrapped tanks), alerts (UNIT scope), verification steps, materials movements, worker timeline and tasks, the top-bar **tank search** (`GET /sessions/:sid/search?q=`) |

Tests (`tests/integration/repair.test.js`):

- Correct tank from supported links. Note that the `/units/TNK-DOES-NOT-EXIST` → 404 case runs in the passport test.
- All six sections are present.
- No history record is known after the fork.
- Operators get the role-limited view: `RESTRICTED` points evaluations, only their own points, and others' minutes restricted.
- Batch membership history appears after a split.
- A new-product tank's passport shows its product and route.

The browser click-through and refresh steps are part of `tests/e2e/browser.test.js`.
