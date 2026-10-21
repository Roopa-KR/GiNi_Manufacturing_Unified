# Assumption register and customer-confirmation checklist

Nothing in this demonstration has been approved by Siemens. Every value below is a **provisional, configurable demo
choice**. The dataset's own open questions and assumptions (Q-01…Q-24, ASM-001…) are seeded as `ref_client_decisions`
/ `ref_assumptions` and remain authoritative for the data; this register adds the choices the **application** makes.

## Application assumptions (ASM-APP-*)

| ID | Topic | Demo choice | Where configured | Impact if changed |
|---|---|---|---|---|
| ASM-APP-CAL-01 | Calendar after the last recorded day | The v3 calendar and roster end on 2026-10-15. Branch futures use a generated Mon–Fri continuation (same shift codes, break windows, rostered people, home work centres) in `continuation_*` collections marked `SYNTHETIC_CONTINUATION`; no absences or overtime invented | `gini_engine/continuation.py` | forecasts beyond Oct 15, who is present in a running branch |
| ASM-APP-MAT-01 | Replenishment | Material handler re-orders when available stock < 75 % of a day's average use known at the fork; orders 1.5 days of use; promised in 90 min; 20 % of deliveries arrive late (165 min); same policy in the forecast | `agents.py`, `forecast.py` | shortage duration, material-related waiting |
| ASM-APP-MAT-02 | Supply interruption | A scenario shortage may carry a supplier delay; no request (including expedites) is promised before it, open requests are re-promised | `MATERIAL_SHORTAGE.supplyDelayMin` | recovery options for material |
| ASM-APP-REW-01 | Rework standard | Rework attempt standard 60 labour-min, minimum crew 1, unless the disposition gives one | `config/simulation.json` | time points for rework, forecast |
| ASM-APP-INS-01 | Inspection outcomes in branch futures | Gate failures drawn per gate from first-attempt fail rates in RUN-BASE known at the fork (fallback 4 %) | `simulation.json`, `calc.ensure_baselines` | forecast range, rework load |
| ASM-APP-AGT-01 | Background plant agents | Agents act as the recorded crews would (accept, start, milestones, finish, inspect, dispose repairable/non-repairable per the matrix, replenish, repair) through the same validated commands as people; they never act for a human-controlled worker and never decide escalated or unclassified quality cases | `agents.py` | how a running branch evolves |
| ASM-APP-AGT-02 | Agent timing | Inspection starts 2 min after work completes; disposition decided after 12 min; clock-in spread 12 min | `simulation.json` | queue/hold durations |
| ASM-APP-OT-01 | Overtime option | Recovery may propose up to 120 min overtime per clocked-in operator at the constrained work centre; needs supervisor approval | `recovery.py` | recovery ranking |
| ASM-APP-TR-01 | Transfers | Travel and handover times from `TRANSFER_RULES`; recipient qualification checked at arrival time; donor keeps minimum crew and queue coverage | seeded `transfer_rules`, `recovery.py` | transfer feasibility |
| ASM-APP-ALR-01 | Escalation | HIGH-severity alert unacknowledged for 30 simulated minutes is escalated (one notification) | `alerts.py` | notification volume |
| ASM-APP-ALR-02 | Notification suppression | No notifications in replay, at clock speed ≥ ×30, inside the 900 s cooldown, or for conditions already present when a session forks | `config/rules.json` | notification volume |
| ASM-APP-BUF-01 | Deadline meaning | Cutoff = order line due time for **route complete** of the required good quantity (not shipment); safety buffer 10 min; logistics offset 0 | `config/rules.json` `cutoff` | every band and M09 |
| ASM-APP-PTS-01 | Points allocation | Work-order awards proportional to eligible contribution minutes; time points split by crew eligible minutes; confirmed-responsibility shares for deductions (equal by default); 2 decimals with largest-remainder residual | `config/points_policy.json` | individual scores (team totals unchanged) |
| ASM-APP-BRK-01 | Break end | Ending a break resumes the paused task in the same step (if nothing blocks it); otherwise the task stays paused with its reason | `BREAK_END` | operator workflow |
| ASM-APP-PIN-01 | Demo credentials | Demo PIN = HMAC-SHA256(`DEMO_PIN_SEED`, login ID) mod 10^6, six digits as text (leading zeros kept); hashes stored as `scrypt$16384$8$1$salt$digest`; administrator password set at seed time and changed at first sign-in | `seed/setup_accounts.py` | none for the pilot (replace with plant identity provider) |
| ASM-APP-SUP-01 | Synthetic supplements | Work instructions, CTQ limits where the guide gives none, milestone estimates and placeholder photos are synthetic and labelled with provenance on screen ("synthetic" badge / instruction revision) | seeded `operation_instructions`, `ctq_specifications`, `milestone_definitions` | operator instruction content |
| ASM-APP-EVD-01 | Evidence storage | Cloudinary signed direct upload in deployment; local disk only for development; a photo counts only after the server verified the upload | `EVIDENCE_STORAGE_MODE` | photo handling |
| ASM-APP-EML-01 | Email | Capture mode by default (outbox only). Live SMTP only to `ALERT_EMAIL_ALLOWLIST`; fabricated worker addresses are never emailed | `EMAIL_MODE` | — |
| ASM-APP-SEC-01 | Sign-in throttle | 10 failed attempts per login ID per 15 min; 50 per IP address (shared demo-room networks) | `LOGIN_RATE_*` | lockouts |

## Legacy behaviour kept only as named policies

| Legacy rule | Treatment |
|---|---|
| "All first-stage failures are scrap" (old deck) | Not the default. The default policy `DEFAULT_REPAIRABLE_RETURN_V1` returns repairable defects to the station that did the work; non-repairable severity is scrapped; unknown stays on hold. |
| SHORT / CUT / PASSED-LINE (warehouse) | Not mapped to scrap or rework. Manufacturing uses gate fail and scrap rates with explicit denominators (M06). See `source-audit.md`. |

## Customer-confirmation checklist

Each item is required before a pilot; the demo implements the choice shown.

| # | Topic | Question for Siemens | Demo choice | Dataset ref |
|---|---|---|---|---|
| 1 | Routing | Confirm the tank route WC1 Pre-Assembly → WC2 Assembly → WC3 Painting (+cure) → WC4 Markings and the gate positions QG10–QG40 | as stated | Q-01, ASM-003 |
| 2 | CTQ limits | Actual drawing tolerances, coating thickness and required reading counts per product; which CTQ answers are pass/fail polarity | CTQ guide wording (16 tank + 5 cover + 3 accessory checks) with synthetic numeric limits | Q-13 |
| 3 | Inspection authority | Who may perform independent gate inspections and release; may an operator self-check ever release | independent inspector (never in the inspected crew) or quality supervisor releases; self-check never releases | Q-12 |
| 4 | Crew standards | Standard times by product, operation and crew size; setup separate or not; minimum/maximum crew | `CREW_CAPACITY_RULES` synthetic (efficiency 1.00 to 3 people, 0.95 for 4, 0.88 for 5) | Q-03, ASM-007 |
| 5 | Disposition | Matrix by product/operation/defect/severity; who authorises rework at an alternate station; when is scrap mandatory | versioned matrix, named quality approver, unknown → hold | Q-02 |
| 6 | Score allocation | Division of WO-level +3/+2 among workers; time points per operation or per WO; caps; whether scrap or incomplete-inspection holds disqualify +3 | ASM-APP-PTS-01; scrap and FAIL holds disqualify; incomplete-inspection holds do not | Q-10, Q-11, Q-21, Q-22 |
| 7 | Deadline meaning | Is the due time customer ship, route complete or another milestone; buffer size; logistics offset | route complete, 10 min buffer, 0 offset | Q-08 |
| 8 | Cover/accessory joining | Where and how covers and accessories join the tank; their CTQ gates and genealogy | kept as reference only (no joining stage) | Q-09, ASM-002 |
| 9 | Skills | Which operations need certified welders; can trainees count toward a crew | OP20 needs ≥ 2 certified welders; trainees only as extra crew | Q-04, ASM-008 |
| 10 | Queues and buffers | Physical buffer capacity per work centre (drives congestion F5) | `QUEUE_CAPACITY_UNITS` synthetic | Q-06 |
| 11 | Materials | Kit and coating replenishment rules and lead times; replacement tank lead time | ASM-APP-MAT-01 | Q-07 |
| 12 | Calendar | Shift pattern, breaks, holidays, timezone | America/Bogota, shifts A 06:00–14:30 and B 14:30–23:00 | Q-15 |
| 13 | Attendance | Grace periods, source of truth, correction approval | corrections appended with reason, originals kept | Q-17, Q-18 |
| 14 | Data access | Which systems hold attendance, login, production and inspection data for a shadow pilot | none (synthetic) | Q-14, Q-16 |
| 15 | Notifications | Recipients per rule, working-hours rules, escalation timing | supervisors/manager roles, 30 min escalation | — |
