'use strict';
/* Quality loops on the Final dataset against the REAL API + database (+ engine for initialisation), paused sessions:
   A. incomplete inspection -> INCOMPLETE hold (not a fail, no release) -> reinspection FAIL -> same-station repair -> reinspection
      FAIL again -> the disposition is ESCALATED (configurable ESCALATE_AFTER_FAILED_REINSPECTIONS, default 2) and needs a quality
      supervisor/admin; failed readings stay on the passport.
   B. downstream incoming defect -> unknown case stays held until a named approver states a reason -> return to the EARLIER origin
      work centre at an approved ALTERNATE station (reason required) -> dispatch, transit, arrival -> rework only at the authorised
      station; the investigation stays open (disposition is not blame). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client, demoPin, adminClient, freshSession } = require('./helpers');

function answersFor(checklist, failFirstNumeric, skipMandatory = false) {
  const out = {};
  let failed = false, skipped = false;
  for (const c of checklist) {
    if (skipMandatory && !skipped && c.mandatory) { skipped = true; continue; }       // leave one mandatory check unanswered
    if (c.answerType === 'YES_NO') { out[c.checkId] = { answer: c.failureAnswer === 'No' ? 'Yes' : 'No' }; continue; }
    const values = {};
    for (const s of c.specs) {
      const lo = s.lower, hi = s.upper;
      const nom = s.nominal ?? (lo !== null && hi !== null ? (lo + hi) / 2 : 0);
      values[s.position] = Array.from({ length: s.readings || 1 }, () => nom);
      if (failFirstNumeric && !failed && hi !== null && hi !== undefined) { values[s.position][0] = hi + Math.max(1, Math.abs(hi - (lo ?? hi)) * 0.5); failed = true; }
    }
    out[c.checkId] = { values };
  }
  return out;
}
async function workingOperator(admin, sid) {
  const wf = await admin.get(`/api/sessions/${sid}/workforce?state=WORKING&role=PRODUCTION_OPERATOR&pageSize=200`);
  for (const w of wf.data.workers) {
    const c = new Client('operator'); await c.login(w.workerId, demoPin(w.workerId));
    const h = await c.get(`/api/sessions/${sid}/me/home`);
    if (h.data.currentTask && h.data.currentTask.task.status === 'WORKING' && h.data.currentTask.operation.kind === 'LABOR') return { c, home: h.data };
  }
  return null;
}
async function inspectorFor(admin, sid, unitId, exclude) {
  const insp = await admin.get(`/api/sessions/${sid}/workforce?role=QUALITY_INSPECTOR&pageSize=200`);
  for (const w of insp.data.workers.filter(x => x.attendance === 'CLOCKED_IN' && !exclude.includes(x.workerId))) {
    const c = new Client('operator'); await c.login(w.workerId, demoPin(w.workerId));
    const r = await c.cmd(sid, 'INSPECTION_START', { unitId, inspectorId: w.workerId });
    if (r.status === 201) return { c, ins: r.data.result.inspection };
  }
  return null;
}
async function finishWork(op, sid, task) {
  const S = `/api/sessions/${sid}`;
  const h = await op.get(`${S}/me/home`);
  for (const m of h.data.currentTask.milestones.milestones.filter(x => !x.done && x.attended && !x.final)) {
    await op.cmd(sid, 'MILESTONE_COMPLETE', { operationInstanceId: h.data.currentTask.operation.operationInstanceId, milestoneId: m.milestoneId });
  }
  return op.cmd(sid, 'TASK_FINISH', { taskId: task });
}

test('incomplete inspection, repeated reinspection failure escalates, failed readings retained', { timeout: 400000 }, async (t) => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'quality: escalation');
  const S = `/api/sessions/${sid}`;
  const found = await workingOperator(admin, sid);
  assert.ok(found, 'a working operator');
  const { c: op, home } = found;
  const unitId = home.currentTask.unit.unitId;
  const crew = home.currentTask.crew.map(x => x.workerId);
  assert.equal((await finishWork(op, sid, home.currentTask.task.taskId)).status, 201);

  const first = await inspectorFor(admin, sid, unitId, crew);
  assert.ok(first, 'an independent inspector started the gate inspection');
  const v1 = await first.c.get(`${S}/inspections/${first.ins.INSPECTION_ID}`);
  await t.test('missing mandatory answers -> INCOMPLETE hold: not a fail, not a release', async () => {
    const r = await first.c.cmd(sid, 'INSPECTION_SUBMIT', { inspectionId: first.ins.INSPECTION_ID, answers: answersFor(v1.data.checklist, false, true), release: true });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.result.result, 'INCOMPLETE');
    const u = (await admin.get(`${S}/units/${unitId}`)).data.unit;
    assert.equal(u.state, 'INCOMPLETE_INSPECTION_HOLD');
  });
  // reinspection after incomplete evidence -> FAIL -> repairable, retained at the same station
  const second = await inspectorFor(admin, sid, unitId, crew);
  const v2 = await second.c.get(`${S}/inspections/${second.ins.INSPECTION_ID}`);
  assert.equal(v2.data.inspection.trigger, 'REINSPECTION_AFTER_INCOMPLETE_EVIDENCE');
  const f1 = await second.c.cmd(sid, 'INSPECTION_SUBMIT', { inspectionId: second.ins.INSPECTION_ID, answers: answersFor(v2.data.checklist, true), release: true });
  assert.equal(f1.data.result.result, 'FAIL');
  let hold = (await admin.get(`${S}/quality`)).data.holds.find(h => h.unitId === unitId);
  const d1 = await admin.cmd(sid, 'DISPOSITION_DECIDE', { holdId: hold.holdId, decision: 'REWORK', reasonCode: 'PER_DISPOSITION_MATRIX' });
  assert.equal(d1.status, 201, JSON.stringify(d1.data));
  let pp = (await admin.get(`${S}/units/${unitId}`)).data;
  if (pp.unit.state === 'RETURN_REQUESTED') { await admin.cmd(sid, 'RETURN_DISPATCH', { unitId }); await admin.cmd(sid, 'RETURN_ARRIVE', { unitId }); }
  const ws = home.currentTask.operation.workstationId;
  const rs = await op.cmd(sid, 'OPERATION_START', { unitId, workstationId: ws, crew: [op.user.workerId] });
  assert.equal(rs.status, 201, JSON.stringify(rs.data));
  const h2 = (await op.get(`${S}/me/home`)).data.currentTask;
  assert.ok(String(h2.operation.instanceType).endsWith('REWORK'), 'a separate rework attempt on the same tank');
  { // the rework attempt records where its labour standard came from: no approved standard here, so the planning value is PROVISIONAL
    const { MongoClient } = require('mongodb');
    const m = await MongoClient.connect(process.env.MONGODB_URI);
    try {
      const o = await m.db(process.env.MONGODB_DB_NAME).collection('sim_operations').findOne({ SESSION_ID: sid, OPERATION_INSTANCE_ID: h2.operation.operationInstanceId });
      assert.ok(o.REWORK_STANDARD, 'rework standard provenance recorded on the attempt');
      if (o.REWORK_STANDARD.STATUS === 'PROVISIONAL') assert.equal(o.REWORK_STANDARD.SOURCE, 'SYNTHETIC_DEFAULT_PLANNING_VALUE');
      else assert.ok(o.REWORK_STANDARD.STANDARD_ID && o.REWORK_STANDARD.APPROVED_BY && o.REWORK_STANDARD.VERSION, 'an approved standard names its ID, version and approver');
    } finally { await m.close(); }
  }
  await op.cmd(sid, 'TASK_START', { taskId: h2.task.taskId });
  assert.equal((await finishWork(op, sid, h2.task.taskId)).status, 201);
  // reinspection fails again -> escalated case
  const third = await inspectorFor(admin, sid, unitId, crew);
  const v3 = await third.c.get(`${S}/inspections/${third.ins.INSPECTION_ID}`);
  const f2 = await third.c.cmd(sid, 'INSPECTION_SUBMIT', { inspectionId: third.ins.INSPECTION_ID, answers: answersFor(v3.data.checklist, true), release: true });
  assert.equal(f2.data.result.result, 'FAIL');
  hold = (await admin.get(`${S}/quality`)).data.holds.find(h => h.unitId === unitId);
  await t.test('second failed inspection: the disposition is escalated and recorded as such', async () => {
    const d2 = await admin.cmd(sid, 'DISPOSITION_DECIDE', { holdId: hold.holdId, decision: 'PENDING_REVIEW', note: 'Repeated failure - engineering review' });
    assert.equal(d2.status, 201, JSON.stringify(d2.data));
    pp = (await admin.get(`${S}/units/${unitId}`)).data;
    const disp = pp.dispositions.filter(x => x.source === 'SESSION').pop();
    assert.equal(disp.ESCALATED, true);
    assert.ok(disp.FAILED_INSPECTIONS >= 2);
    assert.equal(pp.unit.state, 'PENDING_REVIEW', 'never a forced pass');
  });
  await t.test('failed readings and every attempt are retained', async () => {
    const sess = pp.inspections.filter(i => i.source === 'SESSION');
    assert.equal(sess.filter(i => i.result === 'FAIL').length, 2);
    assert.ok(sess.some(i => i.result === 'INCOMPLETE'));
    assert.ok(sess.filter(i => i.result === 'FAIL').every(i => i.readings.some(r => r.result === 'FAIL')));
  });
});

test('downstream defect: unknown case held until a named reason; earlier-station return to an approved alternate station', { timeout: 300000 }, async (t) => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'quality: earlier station');
  const S = `/api/sessions/${sid}`;
  let unit = null;
  for (const wc of ['WC2', 'WC3', 'WC4']) {
    unit = ((await admin.get(`${S}/work-centers/${wc}`)).data.queue || []).find(u => u.state === 'QUEUED');
    if (unit) break;
  }
  assert.ok(unit, 'a queued tank downstream of OP10');
  const steps = (await admin.get(`${S}/units/${unit.unitId}`)).data.sections.progress.routeSteps;
  const cur = steps.findIndex(s => s.status === 'CURRENT');
  const origin = steps.slice(0, cur).reverse().find(s => s.kind === 'LABOR');
  const wf = (await admin.get(`${S}/workforce?role=PRODUCTION_OPERATOR&pageSize=200`)).data.workers.filter(w => w.attendance === 'CLOCKED_IN');
  const rep = new Client('operator'); await rep.login(wf[0].workerId, demoPin(wf[0].workerId));
  const r = await rep.cmd(sid, 'INCOMING_DEFECT_REPORT', { unitId: unit.unitId, suspectedOriginOperationId: origin.operationId, defectCode: 'UNCLASSIFIED', description: 'Dent on flange noticed at receiving (test)' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const hold = (await admin.get(`${S}/quality`)).data.holds.find(h => h.unitId === unit.unitId);
  assert.ok(hold, 'tank held');
  await t.test('a case without a matrix entry stays held until a named approver states a reason', async () => {
    if (hold.matrix.disposition !== 'NO_MATRIX_ENTRY' && hold.matrix.disposition !== 'PENDING_REVIEW') return;   // matrix covers it: nothing to prove here
    const noReason = await admin.cmd(sid, 'DISPOSITION_DECIDE', { holdId: hold.holdId, decision: 'REWORK' });
    assert.equal(noReason.status, 400, JSON.stringify(noReason.data));
    assert.equal(noReason.data.error.code, 'REASON_REQUIRED');
  });
  const pass = (await admin.get(`${S}/units/${unit.unitId}`)).data;
  const originAttempt = pass.attempts.filter(a => a.operationId === origin.operationId).pop();
  const originWs = originAttempt.workstationId;
  const originWc = originWs.split('-')[1];
  const wcView = (await admin.get(`${S}/work-centers/${originWc}`)).data;
  const alt = wcView.stations.map(s => s.workstationId).find(x => x !== originWs);
  await t.test('an alternate station needs an explicit reason', async () => {
    const r1 = await admin.cmd(sid, 'DISPOSITION_DECIDE', { holdId: hold.holdId, decision: 'REWORK', reasonCode: 'APPROVER_DECISION', alternateWorkstationId: alt });
    assert.equal(r1.status, 400);
    assert.equal(r1.data.error.code, 'ALTERNATE_REASON_REQUIRED');
  });
  const d = await admin.cmd(sid, 'DISPOSITION_DECIDE', { holdId: hold.holdId, decision: 'REWORK', reasonCode: 'APPROVER_DECISION', alternateWorkstationId: alt, alternateReason: 'ORIGIN_STATION_OCCUPIED' });
  assert.equal(d.status, 201, JSON.stringify(d.data));
  let pp = (await admin.get(`${S}/units/${unit.unitId}`)).data;
  const ret = pp.returns.find(x => x.source === 'SESSION');
  await t.test('return authorised to the earlier origin work centre at the approved alternate station', async () => {
    assert.equal(ret.AUTHORIZED_DESTINATION_WORKSTATION_ID, alt);
    assert.equal(ret.DESTINATION_BASIS, 'ALTERNATE_STATION_SAME_WORK_CENTER');
    assert.equal(ret.ALTERNATE_STATION_REASON, 'ORIGIN_STATION_OCCUPIED');
    assert.ok(ret.ALTERNATE_APPROVED_BY);
    assert.equal(ret.ORIGIN_WORK_CENTER_ID, originWc);
    assert.equal(pp.unit.state, 'RETURN_REQUESTED', 'a downstream tank must physically move back (no fictitious retention)');
    assert.equal(pp.sections.current.proposedReworkDestination.workstationId, alt, 'proposed destination is separate from the physical location');
  });
  await t.test('dispatch -> transit -> arrival, then rework only at the authorised station', async () => {
    const dis = await admin.cmd(sid, 'RETURN_DISPATCH', { unitId: unit.unitId });
    assert.equal(dis.status, 201, JSON.stringify(dis.data));
    pp = (await admin.get(`${S}/units/${unit.unitId}`)).data;
    assert.equal(pp.unit.state, 'IN_RETURN_TRANSFER');
    assert.ok(pp.sections.current.inTransit, 'in transit shown with destination');
    const arr = await admin.cmd(sid, 'RETURN_ARRIVE', { unitId: unit.unitId });
    assert.equal(arr.status, 201, JSON.stringify(arr.data));
    pp = (await admin.get(`${S}/units/${unit.unitId}`)).data;
    assert.equal(pp.unit.state, 'QUEUED_FOR_REWORK');
    assert.equal(pp.unit.workCenterId, originWc);
    const wrong = await admin.cmd(sid, 'OPERATION_START', { unitId: unit.unitId, workstationId: originWs, crew: [] });
    assert.equal(wrong.status, 409, 'rework at a station other than the authorised one is refused');
    assert.equal(wrong.data.error.code, 'REWORK_STATION_MISMATCH');
  });
  await t.test('the disposition is not a finding of blame: the investigation stays open', async () => {
    const inv = pp.sections.quality.investigations.find(i => i.source === 'SESSION');
    assert.equal(inv.status, 'OPEN_UNKNOWN');
  });
});
