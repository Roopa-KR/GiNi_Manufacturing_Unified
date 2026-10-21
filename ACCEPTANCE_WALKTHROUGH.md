# Acceptance walkthrough

The walkthrough runs from an existing worker to verification. It uses the Final dataset and an interactive session from
checkpoint `CK-20261015-1055` (Thu 15 Oct 2026, 10:55 plant time). Every screen carries the yellow "Synthetic interactive demo"
banner: the data is synthetic and the app is not connected to any factory.

For every step below, the Expected column is what a reviewer must see. The automated test name tells you which test checks the same
thing (TEST_RESULTS.md). PINs come from `python setup_accounts.py --dataset-id GINI-SYN-TANKS --show-pin-for <ID>`, printed to that
terminal only.

**Preparation.** In the admin app, open Administration → Simulation and create (or reset) the default session from
`CK-20261015-1055`. Keep the clock **paused** for steps 1–10.

## Step 1. Existing productive worker signs in

**Who / where:** operator app, `W0001` (James Miller).

**Action:** sign in with the employee ID and PIN.

**Expected:**

- The running OP10 task is shown on tank `DEMO-TANK-000597`, along with:
  - work order / line / batch;
  - the crew of five;
  - milestones 3 of 4;
  - the instruction revision;
  - eligible time from history;
  - points as known now.
- Signing in does **not** clock anyone in or restart anything.

**Automated test:** acceptance AT2; e2e 1.

## Step 2. Pause and reload

**Who / where:** W0001.

**Action:** Pause → planned break, then reload the page.

**Expected:**

- The same task is still shown, paused, and the worker is on break.
- **End break** resumes the task. Nothing is duplicated.

**Automated test:** e2e 1; acceptance AT19/23.

## Step 3. Paused, off-shift and new workers

**Who / where:** admin app → Workforce, filters WORKING / ON BREAK / OFF SHIFT.

**Expected:**

- The full roster of 196 people, including off-shift people (shift-only filter clearly labelled).
- Missing telemetry is shown as "last known", never as idle.

**Automated test:** acceptance AT22; integration story 17.

## Step 4. Create a worker

**Who / where:** Administration → Workers → New worker. PIN `004211`; qualification SK-PA; shift A; **Join the current shift**.

**Expected:**

- A permanent ID is assigned (`W01xx`).
- The response names the first shift.
- In the operator app the new person has zero tasks, zero points and is **not clocked in**.
- `4211` is refused, because the PIN keeps its leading zeros.
- An operator account cannot create workers (403).

**Automated test:** e2e 3; story "permissions"; story 17.

## Step 5. Finish work, then the mandatory inspection

**Who / where:** W0001 records the remaining milestones, then **Finish work**.

**Expected:**

- The tank is `WORK_COMPLETED_AWAITING_INSPECTION`.
- No downstream work can start (409).
- Finishing is not a pass.

**Automated test:** story 15.

## Step 6. Incomplete, FAIL, hold, photo evidence

**Who / where:** inspector `W0162` → Inspect.

**Action:** submit once with a mandatory reading missing, then again with one reading out of limits and a photo
(camera or upload; Uploading → Verifying → Verified).

**Expected:**

- The first submission gives **INCOMPLETE**: a hold, not a failure and not a release.
- The second gives **FAIL** and a quality hold.
- The failed readings and photo stay on the passport.

**Automated test:** quality A; e2e 2.

## Step 7. Disposition and rework

**Who / where:** admin → Quality → hold → Decide.

**Action:** repairable → same station.

**Expected:**

- The tank is retained at its station (no fictitious transport).
- A new **rework attempt** is created on the same tank.
- An alternate station requires a reason.
- A downstream defect returns the tank to the **earlier** work centre (dispatch → transit → arrival). Rework anywhere else is refused.

**Automated test:** story 15; quality B.

## Step 8. Repeated failure

**Who / where:** reinspection FAIL again.

**Expected:**

- The disposition is **escalated** (2 failed inspections) and needs a quality supervisor or admin.
- There is never a forced pass.

**Automated test:** quality A.

## Step 9. Tank passport

**Who / where:**

- Click any tank ID (work centre, orders, quality, alerts, search).
- In the operator app, click the tank on the current-work card.

**Expected:**

- Six sections: identity, current state, progress, people and labour, quality, traceability.
- "Not recorded" where the data holds nothing.
- The operator view hides attribution and other people's minutes and points.
- The page survives a reload.

**Automated test:** repair "passport"; e2e "tank passport".

## Step 10. Batches and orders

**Who / where:** admin → Orders → a line.

**Action:** select two active tanks, then **Split**.

**Expected:**

- A child batch `<batch>-S1` is created, with one open membership per tank.
- The membership history appears on the passport.
- Batch summaries show good / scrapped / replacement.

**Automated test:** repair "batch split"; repair "batch replay" (PB-00002: 4 good, then 5 with the replacement).

## Step 11. New order through the same engines

**Who / where:**

- Administration → products (API `POST /api/admin/master/products`).
- Order entry (`ORDER_CREATE`), then **Release**.

**Expected:**

- An incomplete product is refused with every problem listed.
- A complete product, then an order, then a release creates new tank IDs. The forecast includes them and other sessions never see them.

**Automated test:** repair "validated product and order input"; reliability "idempotency".

## Step 12. Downstream defect and investigation

**Who / where:** an operator at a later station → Report incoming defect. Then admin → Quality → Investigations.

**Expected:**

- The tank is held and the investigation is OPEN_UNKNOWN. No points change.
- The confirmation is refused for an unknown or duplicate worker, bad shares, no evidence, or naming the detector.
- Confirming a WORKER cause gives **−4** to the named worker.
- Correcting the shares posts a linked reversal and new rows.
- An EQUIPMENT cause gives a reversal to zero.

**Automated test:** repair "responsibility".

## Step 13. Points reconcile

**Who / where:** operator → Progress.

**Expected:**

- Time points to 2 decimals.
- Pending points listed separately.
- Every total equals the ledger rows (history plus session).
- Reversals name what they reverse.

**Automated test:** test_points*; acceptance AT9.

## Step 14. Six flags, live

**Who / where:** play the clock at ×60 and use the commands named in ENGINE_RULES.md §3.

**Expected:**

- Each of F1–F6 goes healthy → FIRING (UI row) → **one** captured notification → ACK, still FIRING → corrected → RESOLVED.

**Automated test:** `npm run test:flags`.

## Step 15. Cutoff passage with no event

**Who / where:** admin → order entry: an order line due about 2 simulated minutes ahead. Then the Recovery page at **×1**.

**Expected:**

- The engine evaluates **at** the boundary: cutoff + 1 s, not the next whole minute. The projection says
  `TRIGGER: BOUNDARY: cutoff passed for <line>`, with `AS_OF` = cutoff + 1 s.
- The line shows "cutoff elapsed" and RED within 15 s of the clock crossing the cutoff.
- The bands are GREEN ≤ 14:20:00 < AMBER ≤ 14:30:00 < RED for a 14:30 cutoff.

**Automated test:** e2e "deadline crossing at x1" (measured: see TEST_RESULTS.md); test_boundaries; test_cutoff.

## Step 16. Recovery

**Who / where:** admin → Recovery → Simulate an at-risk line.

**Expected:**

- The options include:
  - transfer (donor and recipient checks);
  - **relief worker** (off-shift call-in);
  - overtime;
  - replacement;
  - resequence;
  - expedite;
  - **no action** (= the baseline).
- Infeasible options show their reasons.
- A source-damaging option is rejected.

**Automated test:** engine 14; repair "recovery".

## Step 17. Verification

**Who / where:** Propose → Approve → Start → Verify.

**Expected:**

- An approval goes stale if anything changed, and is then refused.
- A started action is verified against **immutable** before/after forecasts. The result is PROVISIONAL until the due time, with the forecast error recorded.
- No old forecast is overwritten.

**Automated test:** engine 14; repair "recovery".

## Step 18. Restart and reload

**Action:** stop and restart the API and the engine; close and reopen the browsers.

**Expected:**

- Every accepted action is still there.
- Points are not duplicated.
- Overdue boundaries are evaluated.
- The inspection draft is restored (labelled pending sync while unsent).

**Automated test:** python tests_integration; acceptance AT2; Inspection offline draft.

## Step 19. Rework standard and points policy

**Who / where:** admin → Administration → Rule settings.

**Action and expected:**

- Rework a tank (step 7) while no rework standard is approved. The rework attempt shows "PROVISIONAL - synthetic planning
  value", and its time points are **pending**, not awarded.
- Approve a rework standard for that operation (approver = you, a statement, an effective date before the attempt). On the next
  pass the attempt's points are awarded, naming the standard ID and version. The audit shows the approval.
- Points policy shows "shipped default (client formula)", with both attempt adjustments **off**. Turning one on needs a
  confirmation statement and creates a new, audited version. Every session then re-evaluates its points under it, with linked
  reversals.

**Automated test:** test_points_ledger (standards and policy); standards-policy; quality (provenance).

## Step 20. Administration is atomic

**Who / where:** Administration → Workers.

**Action and expected:**

- Create, edit (incl. a role change), deactivate and reset a PIN. Each appears once in Audit with before/after values and no
  PIN or hash.
- Submitting the same form twice after a lost response creates one worker, not two.
- Deactivation ends the person's open sign-ins; their tasks, points and history stay.

**Automated test:** admin-atomic (including a forced audit failure that rolls everything back).

## Acceptance gate (not executable here)

Repeat steps 1–18 on a **real MongoDB replica set** and on the deployed Vercel/Render stack, then run the smoke tests in
DEPLOYMENT.md §6.
