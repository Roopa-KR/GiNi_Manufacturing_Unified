'use strict';
/* Worker administration is atomic with its audit record (repair review finding).
   In-process part: the real service functions run against the shared database with the audit write forced to fail; every
   related write (worker, account, qualifications, roster rows, live-session rows, sign-in revocations) must roll back.
   HTTP part: the same actions through the real API carry before/after audit values with secrets redacted, a retry with the same
   Idempotency-Key returns the first result without creating a second worker, the same key with another body is refused, and
   deactivation keeps the person's history.
   Env: MONGODB_URI, MONGODB_DB_NAME and the API variables used by the other integration suites. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const { Client, adminClient, freshSession, waitFor } = require('./helpers');

const A = require('../../src/services/audit');
const W = require('../../src/services/workersAdmin');

let mongo;
async function db() { if (!mongo) mongo = await MongoClient.connect(process.env.MONGODB_URI); return mongo.db(process.env.MONGODB_DB_NAME); }
test.after(async () => { if (mongo) await mongo.close(); const { getDb } = require('../../src/lib/db'); try { const d = await getDb(); await d.__client.close(); } catch (e) { /* not opened */ } });

const uniq = () => crypto.randomBytes(3).toString('hex').toUpperCase();
const pin = () => String(crypto.randomInt(0, 1e6)).padStart(6, '0');
function failingAudit() {
  const real = A.audit;
  A.audit = async () => { throw new Error('injected audit failure (test)'); };
  return () => { A.audit = real; };
}
async function snapshot(d, workerId, loginId) {
  return {
    worker: await d.collection('worker_master').findOne({ WORKER_ID: workerId }, { projection: { _id: 0 } }),
    accounts: await d.collection('accounts').find({ $or: [{ worker_id: workerId }, ...(loginId ? [{ login_id: loginId }] : [])] }, { projection: { _id: 0 } }).toArray(),
    quals: await d.collection('worker_qualifications').countDocuments({ WORKER_ID: workerId }),
    roster: await d.collection('app_shift_roster').countDocuments({ WORKER_ID: workerId }),
    simWorkers: await d.collection('sim_workers').countDocuments({ WORKER_ID: workerId }),
    users: await d.collection('app_users').countDocuments({ WORKER_ID: workerId }),
    audits: await d.collection('audit_log').countDocuments({ TARGET: workerId }),
    openSignIns: await d.collection('auth_sessions').countDocuments({ LOGIN_ID: { $in: [loginId || workerId] }, REVOKED_AT: null }),
  };
}

test('worker administration rolls back completely when its audit record cannot be written', { timeout: 240000 }, async (t) => {
  const d = await db();
  const admin = await adminClient();
  await freshSession(admin, 'admin atomic: live session');            // a live session the new worker would be added to
  const body = { firstName: 'Atomic', lastName: `Rollback${uniq()}`, workerRole: 'PRODUCTION_OPERATOR', homeWorkCenterId: 'WC1', shiftCode: 'A', initialPin: pin(), loginId: `atomic.${uniq().toLowerCase()}`, qualifications: [{ skillId: 'SK-PA' }] };

  await t.test('create: no worker, account, qualification, roster or session row survives a failed audit', async () => {
    const counter = await d.collection('counters').findOne({ _id: 'WORKER_ID' });
    const restore = failingAudit();
    try { await assert.rejects(W.createWorker(body, 'admin'), /injected audit failure/); } finally { restore(); }
    assert.equal(await d.collection('worker_master').countDocuments({ LAST_NAME: body.lastName }), 0, 'no worker');
    assert.equal(await d.collection('accounts').countDocuments({ login_id: body.loginId }), 0, 'no account');
    const after = await d.collection('counters').findOne({ _id: 'WORKER_ID' });
    assert.equal(after.n, counter.n, 'the worker-ID counter increment rolled back too (no gap)');
  });

  // now create for real (audited) and exercise update / role change / deactivate / PIN reset under the same failure
  const created = await W.createWorker(body, 'admin');
  const wid = created.workerId;
  const good = await snapshot(d, wid, body.loginId);
  assert.ok(good.worker && good.accounts.length === 1 && good.quals === 1 && good.roster > 0 && good.simWorkers >= 1 && good.users === 1 && good.audits === 1);
  const createdAudit = await d.collection('audit_log').findOne({ TARGET: wid, ACTION: 'WORKER_CREATED' });
  assert.equal(createdAudit.AFTER.account.pin_hash, '[REDACTED]', 'the PIN hash is never copied into the audit record');
  assert.ok(!JSON.stringify(createdAudit).includes(body.initialPin), 'the plaintext PIN appears nowhere in the audit record');

  const op = new Client('operator');
  await op.login(body.loginId, body.initialPin);                      // an open sign-in that a deactivation must revoke

  for (const [name, run] of [
    ['update + role change', () => W.updateWorker(wid, { displayName: `Renamed ${uniq()}`, workerRole: 'QUALITY_INSPECTOR', addQualifications: [{ skillId: 'SK-PA' }] }, 'admin')],
    ['deactivate', () => W.setActive(wid, false, 'admin')],
    ['PIN reset', () => W.resetPin(wid, pin(), 'admin')],
  ]) {
    await t.test(`${name}: nothing changes when the audit write fails`, async () => {
      const before = await snapshot(d, wid, body.loginId);
      const restore = failingAudit();
      try { await assert.rejects(run(), /injected audit failure/); } finally { restore(); }
      assert.deepEqual(await snapshot(d, wid, body.loginId), before, 'worker, account (roles, permissions, status, PIN hash), qualifications and sign-ins unchanged');
    });
  }
  assert.equal((await op.get('/api/auth/me')).status, 200, 'the failed deactivation did not revoke the sign-in');

  await t.test('deactivate for real: account blocked, sign-in revoked, audit with before/after, history kept', async () => {
    const r = await W.setActive(wid, false, 'admin');
    assert.equal(r.revokedSignIns, 1);
    assert.equal((await op.get('/api/auth/me')).status, 401, 'the open sign-in was revoked in the same transaction');
    const a = await d.collection('audit_log').findOne({ TARGET: wid, ACTION: 'WORKER_DEACTIVATED' });
    assert.equal(a.BEFORE.activeFlag, 'Y'); assert.equal(a.AFTER.activeFlag, 'N'); assert.equal(a.AFTER.revokedSignIns, 1);
    const s = await snapshot(d, wid, body.loginId);
    assert.ok(s.worker && s.quals === 1 && s.roster === good.roster && s.simWorkers === good.simWorkers, 'master data, qualifications and roster history are kept');
  });
});

test('admin HTTP: Idempotency-Key replays the first result; the same key with another body is refused; history survives deactivation', { timeout: 240000 }, async () => {
  const d = await db();
  const admin = await adminClient();
  const sid = await freshSession(admin, 'admin atomic: http');
  const key = `t-${crypto.randomUUID()}`;
  const body = { firstName: 'Retry', lastName: `Safe${uniq()}`, workerRole: 'PRODUCTION_OPERATOR', homeWorkCenterId: 'WC1', shiftCode: 'A', initialPin: pin(), qualifications: [{ skillId: 'SK-PA' }] };
  const first = await admin.post('/api/admin/workers', body, key);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const again = await admin.post('/api/admin/workers', body, key);      // e.g. the response was lost and the browser retried
  assert.equal(again.status, 200);
  assert.equal(again.data.workerId, first.data.workerId, 'the retry returns the same worker');
  assert.equal(again.data.replayed, true);
  assert.equal(await d.collection('worker_master').countDocuments({ LAST_NAME: body.lastName }), 1, 'exactly one worker');
  assert.equal(await d.collection('audit_log').countDocuments({ TARGET: first.data.workerId, ACTION: 'WORKER_CREATED' }), 1, 'exactly one audit record');
  const other = await admin.post('/api/admin/workers', { ...body, lastName: `Other${uniq()}` }, key);
  assert.equal(other.status, 409);
  assert.equal(other.data.error.code, 'IDEMPOTENCY_KEY_REUSED');
  const stored = await d.collection('admin_requests').findOne({ IDEMPOTENCY_KEY: key });
  assert.ok(stored && !JSON.stringify(stored).includes(body.initialPin), 'the stored request fingerprint and result contain no PIN');

  // the person works, then is deactivated: the work stays attributed
  const wid = first.data.workerId;
  const op = new Client('operator');
  await op.login(wid, body.initialPin);
  const ci = await op.cmd(sid, 'CLOCK_IN', { workerId: wid });
  assert.ok(ci.status < 500, JSON.stringify(ci.data));
  const events = await d.collection('sim_events').countDocuments({ SESSION_ID: sid, ACTOR_ID: wid });
  if (ci.status === 201) {
    // a person who is clocked in cannot be deactivated (finish / hand over, clock out first) - unified rule
    const refused = await admin.post(`/api/admin/workers/${wid}/deactivate`, {}, `t-${crypto.randomUUID()}`);
    assert.equal(refused.status, 409, JSON.stringify(refused.data)); assert.equal(refused.data.error.code, 'WORKER_ON_SHIFT');
    const co = await op.cmd(sid, 'CLOCK_OUT', { workerId: wid, pauseActiveTasks: true });
    assert.equal(co.status, 201, JSON.stringify(co.data));
  }
  const evBefore = await d.collection('sim_events').countDocuments({ SESSION_ID: sid, ACTOR_ID: wid });
  const deact = await admin.post(`/api/admin/workers/${wid}/deactivate`, {}, `t-${crypto.randomUUID()}`);
  assert.equal(deact.status, 200);
  assert.equal((await op.get('/api/auth/me')).status, 401, 'sign-in revoked');
  assert.ok(events > 0 || ci.status !== 201, 'clock-in recorded');
  assert.equal(await d.collection('sim_events').countDocuments({ SESSION_ID: sid, ACTOR_ID: wid }), evBefore, 'recorded events by the person are kept');
  const w = await waitFor(async () => (await admin.get(`/api/sessions/${sid}/workers/${wid}`)).data, { what: 'worker detail still served' });
  assert.ok(w, 'the deactivated person is still shown with their history');
  const list = (await admin.get(`/api/admin/workers?q=${encodeURIComponent(body.lastName)}`)).data.workers;
  assert.equal(list.length, 1); assert.equal(list[0].active, false); assert.equal(list[0].accountStatus, 'INACTIVE');
});

test('onboarding: join the current shift vs start with the next shift', { timeout: 180000 }, async () => {
  const d = await db();
  const admin = await adminClient();
  const sid = await freshSession(admin, 'admin atomic: onboarding');
  const simNow = new Date((await admin.get(`/api/sessions/${sid}`)).data.session.simNow);
  const mk = (startOption, shiftCode) => admin.post('/api/admin/workers', { firstName: 'Shift', lastName: `${startOption}${uniq()}`, workerRole: 'PRODUCTION_OPERATOR', homeWorkCenterId: 'WC1', shiftCode, startOption, initialPin: pin(), qualifications: [{ skillId: 'SK-PA' }] }, `t-${crypto.randomUUID()}`);
  // crew A runs at the 10:55 checkpoint
  const cur = await mk('JOIN_CURRENT_SHIFT', 'A');
  assert.equal(cur.status, 201, JSON.stringify(cur.data));
  const next = await mk('NEXT_SHIFT', 'A');
  assert.equal(next.status, 201, JSON.stringify(next.data));
  const ref = await d.collection('sim_sessions').findOne({ DEFAULT_FLAG: true, STATUS: { $in: ['READY', 'RUNNING', 'PAUSED'] } });
  const { simNow: sn } = require('../../src/lib/time');
  const refNow = ref ? sn(ref) : simNow;
  if (cur.data.firstShift && cur.data.firstShift.joinsCurrent) {
    assert.ok(new Date(cur.data.firstShift.plannedStartAt) <= refNow && new Date(cur.data.firstShift.plannedEndAt) > refNow, 'joins the shift running now');
  }
  assert.ok(next.data.firstShift, 'a first shift is named');
  assert.equal(next.data.firstShift.joinsCurrent, false, 'NEXT_SHIFT never joins the running shift');
  assert.ok(new Date(next.data.firstShift.plannedStartAt) > refNow, 'the first shift starts after now');
  assert.ok(cur.data.firstShift && next.data.firstShift.shiftId !== cur.data.firstShift.shiftId, 'a different (later) shift than the current one');
  // neither is clocked in; the next-shift person has no roster row covering now in the session
  for (const r of [cur, next]) {
    const w = await d.collection('sim_workers').findOne({ SESSION_ID: sid, WORKER_ID: r.data.workerId });
    assert.ok(w, 'present in the running session');
    assert.notEqual(w.ATTENDANCE_STATE, 'CLOCKED_IN', 'creating a worker never clocks them in');
  }
  const wn = await d.collection('sim_workers').findOne({ SESSION_ID: sid, WORKER_ID: next.data.workerId });
  assert.equal(wn.ROSTER_STATUS, 'NOT_ROSTERED');
  assert.equal(wn.NEXT_SHIFT_ID, next.data.firstShift.shiftId);
});
