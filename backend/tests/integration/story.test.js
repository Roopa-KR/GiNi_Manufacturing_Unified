'use strict';
/* End-to-end operational story against the REAL API + database (+ engine for session initialisation):
   existing mid-shift worker login -> finish work -> mandatory post-task inspection -> FAIL -> hold -> repairable disposition ->
   return to the SAME station -> new rework attempt -> reinspection PASS -> release; failed readings preserved; idempotency;
   permissions; admin-created worker. Runs on a fresh PAUSED session, so background agents never interfere. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client, demoPin, waitFor, adminClient, freshSession } = require('./helpers');

function answersFor(checklist, failFirstNumeric) {
  const out = {};
  let failed = false;
  for (const c of checklist) {
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

test('operational story: finish -> fail -> same-station rework -> reinspect -> release', { timeout: 300000 }, async (t) => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'story test');
  const S = `/api/sessions/${sid}`;

  // ---------------------------------------------------------------- an existing worker who is productively working at the checkpoint
  const wf = await admin.get(`${S}/workforce?state=WORKING&role=PRODUCTION_OPERATOR&pageSize=200`);
  assert.equal(wf.status, 200);
  assert.ok(wf.data.total >= 1, 'at least one operator is working at the checkpoint');
  let op = null, home = null;
  for (const w of wf.data.workers) {
    const c = new Client('operator');
    await c.login(w.workerId, demoPin(w.workerId));
    const h = await c.get(`${S}/me/home`);
    if (h.status === 200 && h.data.currentTask && h.data.currentTask.task.status === 'WORKING' && h.data.currentTask.operation.kind === 'LABOR') { op = c; home = h.data; break; }
  }
  assert.ok(op, 'found a working operator with a labour task');
  const ct = home.currentTask;
  await t.test('login shows the running task, attendance and prior progress without restarting anything', () => {
    assert.equal(home.shift.attendance, 'CLOCKED_IN');
    assert.equal(ct.task.status, 'WORKING');
    assert.ok(ct.time.eligibleElapsedMin >= 0);
    assert.ok(home.worker.firstClockInAt, 'first clock-in from history is shown');
  });
  const unitId = ct.unit.unitId;

  // ---------------------------------------------------------------- milestones then finish (finishing is not pass or release)
  for (const m of ct.milestones.milestones.filter(x => !x.done && x.attended && !x.final)) {
    const r = await op.cmd(sid, 'MILESTONE_COMPLETE', { operationInstanceId: ct.operation.operationInstanceId, milestoneId: m.milestoneId });
    assert.ok([200, 201].includes(r.status), `milestone ${m.milestoneId}: ${JSON.stringify(r.data)}`);
  }
  const fin = await op.cmd(sid, 'TASK_FINISH', { taskId: ct.task.taskId });
  assert.equal(fin.status, 201, JSON.stringify(fin.data));
  let pp = await admin.get(`${S}/units/${unitId}`);
  assert.equal(pp.data.unit.state, 'WORK_COMPLETED_AWAITING_INSPECTION');

  await t.test('no downstream work can start before inspection and release', async () => {
    const r = await admin.cmd(sid, 'OPERATION_START', { unitId, workstationId: 'WS-WC2-01', crew: [] });
    assert.equal(r.status, 409);
  });

  // ---------------------------------------------------------------- independent inspection FAIL
  const insp = await admin.get(`${S}/workforce?role=QUALITY_INSPECTOR&pageSize=200`);
  const crewIds = ct.crew.map(c => c.workerId);
  const candidates = insp.data.workers.filter(w => w.attendance === 'CLOCKED_IN' && !['INSPECTING', 'BREAK', 'TRANSFER'].includes(w.activity) && !crewIds.includes(w.workerId));
  assert.ok(candidates.length, 'a free clocked-in inspector exists');
  let inspector = null, started = null;
  for (const w of candidates) {
    const c = new Client('operator');
    await c.login(w.workerId, demoPin(w.workerId));
    const r = await c.cmd(sid, 'INSPECTION_START', { unitId, inspectorId: w.workerId });
    if (r.status === 201) { inspector = c; started = r.data.result.inspection; break; }
  }
  assert.ok(inspector, 'an inspector could start the gate inspection (qualified and independent)');
  const view = await inspector.get(`${S}/inspections/${started.INSPECTION_ID}`);
  assert.equal(view.status, 200);
  const failAns = answersFor(view.data.checklist, true);
  const sub = await inspector.cmd(sid, 'INSPECTION_SUBMIT', { inspectionId: started.INSPECTION_ID, answers: failAns, release: true });
  assert.equal(sub.status, 201, JSON.stringify(sub.data));
  assert.equal(sub.data.result.result, 'FAIL');
  pp = await admin.get(`${S}/units/${unitId}`);
  assert.equal(pp.data.unit.state, 'QUALITY_HOLD');

  // ---------------------------------------------------------------- disposition: repairable return to the origin station
  const q = await admin.get(`${S}/quality`);
  const hold = q.data.holds.find(h => h.unitId === unitId);
  assert.ok(hold, 'hold listed on the quality board');
  const dec = await admin.cmd(sid, 'DISPOSITION_DECIDE', { holdId: hold.holdId, decision: 'REWORK', reasonCode: 'PER_DISPOSITION_MATRIX' });
  assert.equal(dec.status, 201, JSON.stringify(dec.data));
  pp = await admin.get(`${S}/units/${unitId}`);
  let st = pp.data.unit.state;
  if (st === 'RETURN_REQUESTED') { await admin.cmd(sid, 'RETURN_DISPATCH', { unitId }); await admin.cmd(sid, 'RETURN_ARRIVE', { unitId }); }
  pp = await admin.get(`${S}/units/${unitId}`);
  st = pp.data.unit.state;
  assert.ok(['QUEUED_FOR_REWORK', 'RECEIVED_AT_REWORK_STATION'].includes(st), `unit queued for rework (got ${st})`);
  const ret = pp.data.returns.find(r => r.source === 'SESSION');
  assert.ok(ret, 'return movement recorded');
  assert.equal(ret.AUTHORIZED_DESTINATION_WORKSTATION_ID, ct.operation.workstationId, 'default destination is the station that performed the operation');

  await t.test('rework cannot start at another station without a named approver', async () => {
    const other = ['WS-WC1-01', 'WS-WC1-02', 'WS-WC2-01', 'WS-WC2-02', 'WS-WC3-01', 'WS-WC4-01'].find(x => x !== ct.operation.workstationId && x.startsWith(`WS-${ct.operation.workCenterId}`)) || 'WS-WC1-01';
    const r = await op.cmd(sid, 'OPERATION_START', { unitId, workstationId: other, crew: [op.user.workerId] });
    assert.ok([409, 400].includes(r.status), JSON.stringify(r.data));
  });

  // ---------------------------------------------------------------- rework attempt by the operator at the same station
  const rs = await op.cmd(sid, 'OPERATION_START', { unitId, workstationId: ct.operation.workstationId, crew: [op.user.workerId] });
  assert.equal(rs.status, 201, JSON.stringify(rs.data));
  const h2 = await op.get(`${S}/me/home`);
  const rt = h2.data.currentTask;
  assert.equal(rt.unit.unitId, unitId);
  assert.ok(String(rt.operation.instanceType).endsWith('REWORK'), 'new attempt is a rework attempt');
  assert.ok(rt.operation.attemptNo >= 2, 'attempt number incremented');
  const go = await op.cmd(sid, 'TASK_START', { taskId: rt.task.taskId });
  assert.equal(go.status, 201, JSON.stringify(go.data));
  const h3 = await op.get(`${S}/me/home`);
  for (const m of h3.data.currentTask.milestones.milestones.filter(x => !x.done && x.attended && !x.final)) {
    await op.cmd(sid, 'MILESTONE_COMPLETE', { operationInstanceId: rt.operation.operationInstanceId, milestoneId: m.milestoneId });
  }
  const f2 = await op.cmd(sid, 'TASK_FINISH', { taskId: rt.task.taskId });
  assert.equal(f2.status, 201, JSON.stringify(f2.data));
  pp = await admin.get(`${S}/units/${unitId}`);
  assert.equal(pp.data.unit.state, 'REWORK_COMPLETE_AWAITING_REINSPECTION');

  // ---------------------------------------------------------------- reinspection PASS + release
  const ri = await inspector.cmd(sid, 'INSPECTION_START', { unitId, inspectorId: inspector.user.workerId });
  assert.equal(ri.status, 201, JSON.stringify(ri.data));
  const rv = await inspector.get(`${S}/inspections/${ri.data.result.inspection.INSPECTION_ID}`);
  const pass = await inspector.cmd(sid, 'INSPECTION_SUBMIT', { inspectionId: ri.data.result.inspection.INSPECTION_ID, answers: answersFor(rv.data.checklist, false), release: true });
  assert.equal(pass.status, 201, JSON.stringify(pass.data));
  assert.equal(pass.data.result.result, 'PASS');
  pp = await admin.get(`${S}/units/${unitId}`);
  assert.ok(['RELEASED_TO_NEXT_OPERATION', 'IN_TRANSFER', 'QUEUED', 'CURING', 'ROUTE_COMPLETE'].includes(pp.data.unit.state), `released (got ${pp.data.unit.state})`);
  const sess = pp.data.inspections.filter(i => i.source === 'SESSION');
  assert.ok(sess.some(i => i.result === 'FAIL' && i.readings.some(r => r.result === 'FAIL')), 'failed readings are preserved on the passport');
  assert.ok(sess.some(i => i.result === 'PASS'), 'reinspection recorded');
  assert.ok(pp.data.attempts.filter(a => a.operationId === ct.operation.operationId).length >= 2, 'both attempts on the passport');
  assert.equal(pp.data.unit.unitId, unitId, 'tank identity unchanged through rework');
  await admin.post(`/api/sessions/${sid}/archive`, {});
});

test('idempotency, permissions and impersonation', { timeout: 180000 }, async (t) => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'permissions test');
  const S = `/api/sessions/${sid}`;
  const wf = await admin.get(`${S}/workforce?role=PRODUCTION_OPERATOR&pageSize=200`);
  const [a, b] = wf.data.workers.filter(w => w.attendance === 'CLOCKED_IN');
  const op = new Client('operator');
  await op.login(a.workerId, demoPin(a.workerId));

  await t.test('PIN is text: a wrong PIN or the PIN without leading zeros fails', async () => {
    const c = new Client('operator');
    const pin = demoPin(a.workerId);
    const r = await c.req('POST', '/api/auth/login', { loginId: a.workerId, pin: String(Number(pin)) === pin ? pin + '9' : String(Number(pin)) });
    assert.equal(r.status, 401);
    const r2 = await c.req('POST', '/api/auth/login', { loginId: a.workerId, pin: Number(pin) });
    assert.equal(r2.status, 400, 'a numeric PIN is rejected (must be a string)');
  });
  await t.test('operator cannot create workers', async () => {
    const r = await op.post('/api/admin/workers', { firstName: 'X', lastName: 'Y' });
    assert.equal(r.status, 403);
  });
  await t.test('operator cannot act for another worker', async () => {
    const r = await op.cmd(sid, 'CLOCK_OUT', { workerId: b.workerId });
    assert.equal(r.status, 403, JSON.stringify(r.data));
  });
  await t.test('writes require an idempotency key; a replay returns the same result; a reused key with another payload is refused', async () => {
    const noKey = await op.req('POST', `${S}/commands/BREAK_START`, { workerId: a.workerId });
    assert.equal(noKey.status, 400);
    const key = `idem-${Date.now()}`;
    const r1 = await op.cmd(sid, 'BREAK_START', { workerId: a.workerId, planned: false }, key);
    assert.equal(r1.status, 201, JSON.stringify(r1.data));
    const r2 = await op.cmd(sid, 'BREAK_START', { workerId: a.workerId, planned: false }, key);
    assert.equal(r2.status, 200);
    assert.equal(r2.data.replayed, true);
    assert.deepEqual(r2.data.events, r1.data.events);
    const r3 = await op.cmd(sid, 'BREAK_END', { workerId: a.workerId }, key);
    assert.equal(r3.status, 409);
  });
  await t.test('missing CSRF token is refused', async () => {
    const c = new Client('operator');
    await c.login(a.workerId, demoPin(a.workerId));
    c.csrf = null;
    const r = await c.cmd(sid, 'BREAK_END', { workerId: a.workerId });
    assert.equal(r.status, 403);
  });
  await t.test('foreign origin is refused for unsafe requests', async () => {
    const r = await fetch((process.env.API_URL || 'http://localhost:5000') + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ loginId: a.workerId, pin: demoPin(a.workerId) }) });
    assert.equal(r.status, 403);
  });
  await admin.post(`/api/sessions/${sid}/archive`, {});
});

test('admin creates a worker who starts with zero activity and can sign in', { timeout: 180000 }, async () => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'new worker test');
  const pin = '004211';
  const r = await admin.post('/api/admin/workers', { firstName: 'Jordan', lastName: `Tester${Date.now() % 100000}`, workerRole: 'PRODUCTION_OPERATOR', homeWorkCenterId: 'WC1', shiftCode: 'A', initialPin: pin, qualifications: [{ skillId: 'SK-PA', level: 'QUALIFIED' }] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const c = new Client('operator');
  await c.login(r.data.loginId, pin);
  const bad = await new Client('operator').req('POST', '/api/auth/login', { loginId: r.data.loginId, pin: '4211' });
  assert.equal(bad.status, 401, 'leading zeros are part of the PIN');
  const home = await waitFor(async () => { const h = await c.get(`/api/sessions/${sid}/me/home`); return h.status === 200 ? h : null; }, { what: 'new worker visible in the session' });
  assert.notEqual(home.data.shift.attendance, 'CLOCKED_IN', 'activation does not clock anyone in');
  assert.equal(home.data.currentTask, null);
  assert.equal(home.data.points.total.TOTAL, 0);
  const ci = await c.cmd(sid, 'CLOCK_IN', { workerId: r.data.workerId });
  assert.equal(ci.status, 201, JSON.stringify(ci.data));
  const q = await c.get(`/api/sessions/${sid}/me/queue`);
  assert.equal(q.status, 200);
  // the new person can take eligible work through the same validated commands: join a qualified WC1 crew, or start queued work
  const join = q.data.joinable.find(j => j.state === 'WORKING');
  const start = q.data.eligibleQueue.find(e => e.ready && e.minCrew <= 1);
  assert.ok(join || start, `eligible work offered to the new qualified worker: ${JSON.stringify({ joinable: q.data.joinable.length, queue: q.data.eligibleQueue.length })}`);
  const took = join
    ? await c.cmd(sid, 'TASK_JOIN', { workerId: r.data.workerId, operationInstanceId: join.operationInstanceId })
    : await c.cmd(sid, 'OPERATION_START', { unitId: start.unitId, workstationId: start.freeWorkstations[0], crew: [r.data.workerId] });
  assert.equal(took.status, 201, JSON.stringify(took.data));
  const home2 = await c.get(`/api/sessions/${sid}/me/home`);
  assert.ok(home2.data.currentTask, 'the new worker now has a current task');
  // still clocked in with a task: deactivation is refused until the person clocks out (unified rule); the task is paused for shift end
  const refused = await admin.post(`/api/admin/workers/${r.data.workerId}/deactivate`, {});
  assert.equal(refused.status, 409, JSON.stringify(refused.data)); assert.equal(refused.data.error.code, 'WORKER_ON_SHIFT');
  const co = await c.cmd(sid, 'CLOCK_OUT', { workerId: r.data.workerId, pauseActiveTasks: true });
  assert.equal(co.status, 201, JSON.stringify(co.data));
  const deact = await admin.post(`/api/admin/workers/${r.data.workerId}/deactivate`, {});
  assert.equal(deact.status, 200);
  const after = await c.get('/api/auth/me');
  assert.equal(after.status, 401, 'deactivation revokes access');
  await admin.post(`/api/sessions/${sid}/archive`, {});
});
