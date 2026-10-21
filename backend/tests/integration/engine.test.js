'use strict';
/* Engine-driven integration tests (API + database + running Python worker):
   scrap/replacement and order reconciliation, a cause-driven alert with exactly one captured notification and resolution,
   human control vs background agents, session isolation, stale recovery proposals. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client, demoPin, waitFor, adminClient, freshSession } = require('./helpers');

async function recalcAndWait(admin, sid) {
  // waits for a pass that has seen every event so far (published watermark >= current event sequence), not just any newer pass
  const s0 = (await admin.get(`/api/sessions/${sid}`)).data.session;
  await admin.post(`/api/sessions/${sid}/recalculate`, {});
  await waitFor(async () => { const s = (await admin.get(`/api/sessions/${sid}`)).data.session; return s.engine.projectionVersion > s0.engine.projectionVersion && s.engine.watermarkSeq >= s0.eventSeq; }, { timeoutMs: 90000, what: 'recalculation published' });
}

test('equipment breakdown -> M11 FIRING with one captured notification -> repair -> RESOLVED', { timeout: 240000 }, async () => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'alert test');
  const S = `/api/sessions/${sid}`;
  const mats = await admin.get(`${S}/materials`);
  const eq = mats.data.equipment.find(e => e.status === 'UP' && e.workCenterId === 'WC2');
  assert.ok(eq, 'an equipment item that is up');
  const b = await admin.cmd(sid, 'EQUIPMENT_BREAKDOWN', { equipmentId: eq.equipmentId, estimatedRecoveryMin: 90, reasonCode: 'RANDOM_FAILURE' });
  assert.equal(b.status, 201, JSON.stringify(b.data));
  await recalcAndWait(admin, sid);
  const al = await waitFor(async () => { const r = await admin.get(`${S}/alerts?open=1`); return (r.data.alerts || []).find(a => a.ruleId === 'M11' && a.entityId === eq.workstationId && a.evaluation === 'FIRING'); }, { what: 'M11 firing' });
  assert.equal(al.workflow, 'UNACKNOWLEDGED');
  const notes = (await admin.get(`${S}/alerts?alertId=${encodeURIComponent(al.alertId)}`)).data.notifications.filter(n => n.alertId === al.alertId && n.transition === 'FIRING');
  assert.equal(notes.length, 1, 'exactly one notification for the FIRING transition');
  await recalcAndWait(admin, sid);
  const notes2 = (await admin.get(`${S}/alerts?alertId=${encodeURIComponent(al.alertId)}`)).data.notifications.filter(n => n.alertId === al.alertId && n.transition === 'FIRING');
  assert.equal(notes2.length, 1, 'repeated evaluation does not duplicate the notification');
  const ack = await admin.cmd(sid, 'ALERT_WORKFLOW', { alertId: al.alertId, action: 'ACK' });
  assert.equal(ack.status, 201);
  const still = (await admin.get(`${S}/alerts?alertId=${encodeURIComponent(al.alertId)}`)).data.alerts.find(a => a.alertId === al.alertId);
  assert.equal(still.evaluation, 'FIRING', 'acknowledging is not resolving');
  const close = await admin.cmd(sid, 'ALERT_WORKFLOW', { alertId: al.alertId, action: 'CLOSE' });
  assert.equal(close.status, 409, 'closing an active condition without force is refused');
  await admin.cmd(sid, 'EQUIPMENT_REPAIRED', { equipmentId: eq.equipmentId });
  await recalcAndWait(admin, sid);
  const done = await waitFor(async () => { const r = await admin.get(`${S}/alerts?alertId=${encodeURIComponent(al.alertId)}`); const a = r.data.alerts.find(x => x.alertId === al.alertId); return a && a.evaluation === 'RESOLVED' ? a : null; }, { what: 'M11 resolved' });
  assert.equal(done.episodeId, al.episodeId);
  await admin.post(`${S}/archive`, {});
});

test('scrap is permanent; the replacement has a new ID and satisfies existing demand', { timeout: 240000 }, async () => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'scrap test');
  const S = `/api/sessions/${sid}`;
  const orders = await admin.get(`${S}/orders`);
  // a queued tank on a line with active WIP
  let target = null, lineBefore = null;
  for (const l of orders.data.lines.filter(x => x.buckets.QUEUED > 0)) {
    const d = await admin.get(`${S}/orders/${l.orderLineId}`);
    const t = d.data.batches.flatMap(b => b.tanks).find(x => x.state === 'QUEUED');
    if (t) { target = t; lineBefore = l; break; }
  }
  assert.ok(target, 'found a queued tank');
  // a non-repairable physical defect, detected by a human inspection after work: the shortest path is the incoming-defect/hold route;
  // here we exercise the disposition directly on a hold opened by a reported defect on the received tank
  const ops = await admin.get(`${S}/workforce?role=PRODUCTION_OPERATOR&pageSize=200`);
  const wcOps = ops.data.workers.filter(w => w.attendance === 'CLOCKED_IN');
  const pp = await admin.get(`${S}/units/${target.unitId}`);
  const prior = [...new Set(pp.data.attempts.filter(a => a.kind === 'LABOR' && a.finishedAt).map(a => a.operationId))];
  if (!prior.length) { await admin.post(`${S}/archive`, {}); return; }      // first-operation tank: nothing prior to report against
  const reporter = new Client('operator');
  let ok = false;
  for (const w of wcOps.slice(0, 40)) {
    await reporter.login(w.workerId, demoPin(w.workerId));
    const r = await reporter.cmd(sid, 'INCOMING_DEFECT_REPORT', { unitId: target.unitId, suspectedOriginOperationId: prior[prior.length - 1], defectCode: 'OUT_OF_TOLERANCE', description: 'integration test defect', severity: 'CRITICAL' });
    if (r.status === 201) { ok = true; break; }
  }
  assert.ok(ok, 'incoming defect reported');
  const hold = (await admin.get(`${S}/quality`)).data.holds.find(h => h.unitId === target.unitId);
  assert.ok(hold);
  const sc = await admin.cmd(sid, 'DISPOSITION_DECIDE', { holdId: hold.holdId, decision: 'SCRAP', reasonCode: 'NON_REPAIRABLE_SEVERITY' });
  assert.equal(sc.status, 201, JSON.stringify(sc.data));
  const back = await admin.cmd(sid, 'OPERATION_START', { unitId: target.unitId, workstationId: 'WS-WC1-01', crew: [] });
  assert.equal(back.status, 409, 'a scrapped tank never returns to work');
  const rq = await admin.cmd(sid, 'REPLACEMENT_REQUEST', { scrappedUnitId: target.unitId });
  assert.equal(rq.status, 201);
  const ap = await admin.cmd(sid, 'REPLACEMENT_APPROVE', { requestId: rq.data.result.replacement.REQUEST_ID });
  assert.equal(ap.status, 201, JSON.stringify(ap.data));
  if (ap.data.result.blocked) { await admin.post(`${S}/archive`, {}); return; }   // kit shortage blocks the replacement: correct behaviour
  const nu = ap.data.result.newUnit;
  assert.notEqual(nu.UNIT_ID, target.unitId);
  assert.equal(nu.REPLACEMENT_FOR_UNIT_ID, target.unitId);
  const after = (await admin.get(`${S}/orders`)).data.lines.find(l => l.orderLineId === lineBefore.orderLineId);
  assert.equal(after.requiredGoodQty, lineBefore.requiredGoodQty, 'replacement does not increase demand');
  assert.equal(after.scrapped, (lineBefore.scrapped || 0) + 1);
  assert.equal(after.goodCompleted, lineBefore.goodCompleted, 'scrap never counts as good');
  assert.equal(after.wip, lineBefore.wip, 'scrapped tank left WIP and the replacement entered it');
  await admin.post(`${S}/archive`, {});
});

test('sessions are isolated: activity in one branch is invisible in another', { timeout: 240000 }, async () => {
  const admin = await adminClient();
  const a = await freshSession(admin, 'iso A');
  const b = await freshSession(admin, 'iso B');
  const mats = await admin.get(`/api/sessions/${a}/materials`);
  const eq = mats.data.equipment.find(e => e.status === 'UP');
  await admin.cmd(a, 'EQUIPMENT_BREAKDOWN', { equipmentId: eq.equipmentId, estimatedRecoveryMin: 30, reasonCode: 'RANDOM_FAILURE' });
  const ea = (await admin.get(`/api/sessions/${a}/materials`)).data.equipment.find(e => e.equipmentId === eq.equipmentId);
  const eb = (await admin.get(`/api/sessions/${b}/materials`)).data.equipment.find(e => e.equipmentId === eq.equipmentId);
  assert.equal(ea.status, 'DOWN');
  assert.equal(eb.status, 'UP');
  const evB = await admin.get(`/api/sessions/${b}/events?since=0`);
  assert.ok(!evB.data.events.some(e => e.type === 'EQUIPMENT_DOWN' || (e.entityId === eq.equipmentId && e.type.startsWith('EQUIPMENT'))));
  await admin.post(`/api/sessions/${a}/archive`, {});
  await admin.post(`/api/sessions/${b}/archive`, {});
});

test('a human-controlled worker is never acted on by background agents while the clock runs', { timeout: 300000 }, async () => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'control test');
  const S = `/api/sessions/${sid}`;
  const wf = await admin.get(`${S}/workforce?state=WORKING&role=PRODUCTION_OPERATOR&pageSize=200`);
  const w = wf.data.workers[0];
  const op = new Client('operator');
  await op.login(w.workerId, demoPin(w.workerId));
  const tc = await op.cmd(sid, 'TAKE_CONTROL', { workerId: w.workerId });
  assert.equal(tc.status, 201, JSON.stringify(tc.data));
  const seq0 = (await admin.get(`/api/sessions/${sid}`)).data.session.eventSeq;
  await admin.post(`${S}/clock`, { action: 'SPEED', speed: 120 });
  await admin.post(`${S}/clock`, { action: 'PLAY' });
  // keep the lease alive while the plant runs ~30 simulated minutes
  for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 7000)); await op.cmd(sid, 'CONTROL_HEARTBEAT', { workerId: w.workerId }); }
  await admin.post(`${S}/clock`, { action: 'PAUSE' });
  const ev = await admin.get(`${S}/events?since=${seq0}&limit=500`);
  assert.ok(ev.data.events.length > 0, 'background agents advanced the plant');
  const byAgentForMe = ev.data.events.filter(e => e.actorType === 'AGENT' && (e.actor === w.workerId));
  assert.equal(byAgentForMe.length, 0, `no agent command acted as ${w.workerId}`);
  const me = await op.get(`${S}/me/home`);
  assert.equal(me.data.currentTask.task.status, 'WORKING', 'the human task was not completed by the simulator');
  await admin.post(`${S}/archive`, {});
});

test('recovery: options with donor checks, propose -> approve -> execute -> verify; stale proposals are refused', { timeout: 300000 }, async () => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'recovery test');
  const S = `/api/sessions/${sid}`;
  await recalcAndWait(admin, sid);
  const fc = await admin.get(`${S}/forecasts`);
  const line = fc.data.orders.find(o => o.BAND !== 'COMPLETE' && o.ACTIVE_UNITS > 0);
  assert.ok(line, 'an open order line with active tanks');
  const t0 = Date.now();
  await admin.post(`${S}/recalculate`, { kind: 'RECOVERY', orderLineId: line.ORDER_LINE_ID });
  const rec = await waitFor(async () => (await admin.get(`${S}/forecasts`)).data.recovery.find(r => r.orderLineId === line.ORDER_LINE_ID), { timeoutMs: 120000, what: 'recovery options' });
  const elapsed = Date.now() - t0;
  assert.ok(rec.baseline && rec.baseline.BAND, 'no-action baseline present');
  assert.ok(rec.options.length > 0, 'candidates generated');
  for (const o of rec.options) {
    assert.ok(Array.isArray(o.CHECKS));
    if (!o.FEASIBLE) assert.ok(o.REJECTION_REASON, 'infeasible options carry a reason');
  }
  const transfers = rec.options.filter(o => o.ACTION_TYPE === 'TRANSFER');
  for (const o of transfers) assert.ok(o.CHECKS.some(c => c.check === 'DONOR_MINIMUM_CREW') && o.CHECKS.some(c => c.check === 'RECIPIENT_QUALIFICATION_AT_ARRIVAL'), 'both donor and recipient checked');
  const feasible = rec.options.find(o => o.FEASIBLE && !o.ADVISORY && o.ACTION_TYPE.includes('TRANSFER'));
  if (!feasible) return;                       // nothing feasible to execute at this checkpoint: the rejection reasons were asserted above
  const pr = await admin.cmd(sid, 'ACTION_PROPOSE', { forecastId: rec.forecastId, optionId: feasible.OPTION_ID });
  assert.equal(pr.status, 201, JSON.stringify(pr.data));
  const act = pr.data.result.action;
  assert.deepEqual(act.BEFORE_FORECAST, rec.baseline, 'immutable before-forecast captured');
  // stale: change the transferred worker's state after the proposal, then approve
  const step = act.STEPS.find(s => s.type === 'TRANSFER');
  await admin.cmd(sid, 'WORKER_TRANSFER', { workerId: step.workerId, toWorkCenterId: step.toWorkCenterId === 'WC4' ? 'WC3' : 'WC4', reason: 'SUPERVISOR_DIRECTED_TRANSFER', allowSourceBelowMin: true });
  const stale = await admin.cmd(sid, 'ACTION_APPROVE', { actionId: act.ACTION_ID });
  assert.equal(stale.status, 201);
  assert.equal(stale.data.result.stale, true, 'approval revalidates current versions and refuses a stale proposal');
  const acts = await admin.get(`${S}/actions`);
  assert.equal(acts.data.actions.find(a => a.ACTION_ID === act.ACTION_ID).STATUS, 'STALE');
  // a current proposal executes through the same command services and is verified against its immutable forecasts
  const other = rec.options.find(o => o.FEASIBLE && !o.ADVISORY && o.OPTION_ID !== feasible.OPTION_ID && !(o.STEPS || []).some(s => s.workerId === step.workerId));
  if (other) {
    const p2 = await admin.cmd(sid, 'ACTION_PROPOSE', { forecastId: rec.forecastId, optionId: other.OPTION_ID });
    assert.equal(p2.status, 201, JSON.stringify(p2.data));
    const id2 = p2.data.result.action.ACTION_ID;
    const ap = await admin.cmd(sid, 'ACTION_APPROVE', { actionId: id2 });
    assert.equal(ap.status, 201);
    if (!ap.data.result.stale) {
      const ex = await admin.cmd(sid, 'ACTION_START', { actionId: id2 });
      assert.equal(ex.status, 201, `${other.ACTION_TYPE} ${JSON.stringify(other.STEPS)}: ${JSON.stringify(ex.data)}`);
      await recalcAndWait(admin, sid);
      const v = (await admin.get(`${S}/actions`)).data.actions.find(a => a.ACTION_ID === id2);
      assert.equal(v.STATUS, 'STARTED');
      assert.ok(v.verification && v.verification.before && v.verification.after, 'verification compares immutable before/after forecasts');
      assert.equal(v.verification.outcome, 'PROVISIONAL');
    }
  }
  console.log(`recovery simulation for ${line.ORDER_LINE_ID}: ${rec.options.length} options in ${elapsed} ms`);
  await admin.post(`${S}/archive`, {});
});
