'use strict';
/* Reliability proofs (Section 14) against the REAL API + database + engine on the Final dataset:
   exclusive assignment, idempotent retries of a new command, GET requests that never mutate (new endpoints included),
   reset and archive scoped to exactly one session (audit kept), and the plant-wide invariant that nobody is productive at two
   stations at once. Duplicate inspection submissions, two engines, stale projections, restart and expired jobs are covered by
   acceptance.test.js, python_engine/tests/test_publish.py and python_engine/tests_integration. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { MongoClient } = require('mongodb');
const { Client, demoPin, waitFor, adminClient, freshSession } = require('./helpers');

let mongo;
async function db() { if (!mongo) mongo = await MongoClient.connect(process.env.MONGODB_URI); return mongo.db(process.env.MONGODB_DB_NAME); }
test.after(async () => { if (mongo) await mongo.close(); });

test('a worker productive on one operation cannot join a second one at the same time', { timeout: 200000 }, async () => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'reliability: exclusive');
  const S = `/api/sessions/${sid}`;
  const wf = (await admin.get(`${S}/workforce?state=WORKING&role=PRODUCTION_OPERATOR&pageSize=200`)).data.workers;
  const a = wf[0];
  const other = wf.find(w => w.currentOperationInstanceId && w.currentOperationInstanceId !== a.currentOperationInstanceId);
  assert.ok(a && other, 'two different working operations exist');
  const c = new Client('operator');
  await c.login(a.workerId, demoPin(a.workerId));
  const r = await c.cmd(sid, 'TASK_JOIN', { operationInstanceId: other.currentOperationInstanceId, start: true });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  const working = await (await db()).collection('sim_tasks').countDocuments({ SESSION_ID: sid, WORKER_ID: a.workerId, STATUS: 'WORKING' });
  assert.equal(working, 1);
});

test('retrying ORDER_CREATE with the same Idempotency-Key creates one order; GETs never mutate', { timeout: 200000 }, async () => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'reliability: idempotency');
  const S = `/api/sessions/${sid}`;
  const simNow = new Date((await admin.get(S)).data.session.simNow);
  const body = { lines: [{ productId: 'TT-S', requiredGoodQty: 1, dueAt: new Date(simNow.getTime() + 2 * 86400000).toISOString() }] };
  const [r1, r2] = await Promise.all([admin.cmd(sid, 'ORDER_CREATE', body, 'same-key-1'), admin.cmd(sid, 'ORDER_CREATE', body, 'same-key-1')]);
  assert.ok([r1.status, r2.status].every(s => [200, 201].includes(s)), `${r1.status} ${r2.status} ${JSON.stringify(r2.data)}`);
  assert.equal(r1.data.result.orderId, r2.data.result.orderId);
  assert.equal(await (await db()).collection('production_orders').countDocuments({ SESSION_ID: sid }), 1);
  const reuse = await admin.cmd(sid, 'ORDER_CREATE', { ...body, priority: 'HIGH' }, 'same-key-1');
  assert.equal(reuse.status, 409, 'a reused key with a different body is refused');
  const d = await db();
  const before = await d.collection('sim_sessions').findOne({ SESSION_ID: sid });
  const evBefore = await d.collection('sim_events').countDocuments({ SESSION_ID: sid });
  const unit = (await admin.get(`${S}/work-centers/WC1`)).data.queue[0];
  for (const p of ['', '/overview', '/workforce', '/orders', `/orders/${r1.data.result.lines[0].orderLineId}`, `/units/${unit.unitId}`, '/quality', '/alerts', '/forecasts', '/freshness', '/search?q=TNK-00059', '/materials']) {
    const r = await admin.get(`${S}${p}`);
    assert.ok(r.status < 500, `${p} -> ${r.status}`);
  }
  await admin.get('/api/admin/master/products');
  const after = await d.collection('sim_sessions').findOne({ SESSION_ID: sid });
  assert.equal(after.EVENT_SEQ, before.EVENT_SEQ, 'no event sequenced by reads');
  assert.equal(after.VERSION, before.VERSION, 'session document unchanged by reads');
  assert.equal(await d.collection('sim_events').countDocuments({ SESSION_ID: sid }), evBefore);
});

test('reset and archive touch exactly one session; the change log survives a reset', { timeout: 400000 }, async () => {
  const admin = await adminClient();
  const a = await freshSession(admin, 'reliability: reset A');
  const b = await freshSession(admin, 'reliability: reset B');
  for (const sid of [a, b]) {
    const r = await admin.cmd(sid, 'MATERIAL_REQUEST', { materialId: 'MAT-KIT-S', qty: 2, needByMin: 120 });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  const d = await db();
  const logA = await d.collection('sim_change_log').countDocuments({ SESSION_ID: a });
  assert.ok(logA >= 1);
  const bad = await admin.post(`/api/sessions/${a}/reset`, { confirm: 'RESET wrong' });
  assert.equal(bad.status, 400, 'reset needs the exact confirmation text');
  const ok = await admin.post(`/api/sessions/${a}/reset`, { confirm: `RESET ${a}` });
  assert.ok([200, 201].includes(ok.status), JSON.stringify(ok.data));
  await waitFor(async () => ((await admin.get(`/api/sessions/${a}`)).data.session || {}).status === 'READY', { timeoutMs: 180000, what: 'A re-initialised' });
  assert.equal(await d.collection('sim_material_requests').countDocuments({ SESSION_ID: a, REQUEST_ID: { $regex: '^MR-' } }), 0, 'A activity removed');
  assert.equal(await d.collection('sim_material_requests').countDocuments({ SESSION_ID: b, REQUEST_ID: { $regex: '^MR-' } }), 1, 'B untouched');
  assert.equal(await d.collection('sim_change_log').countDocuments({ SESSION_ID: a }), logA, 'audit of A kept after the reset');
  const sa = await d.collection('sim_sessions').findOne({ SESSION_ID: a });
  assert.equal(sa.RESET_GENERATION, 1);
  const arc = await admin.post(`/api/sessions/${a}/archive`, {});
  assert.ok([200, 201].includes(arc.status), JSON.stringify(arc.data));
  const sb = (await admin.get(`/api/sessions/${b}`)).data.session;
  assert.ok(['READY', 'PAUSED', 'RUNNING'].includes(sb.status), `B still active (${sb.status})`);
  const cmdA = await admin.cmd(a, 'MATERIAL_REQUEST', { materialId: 'MAT-KIT-S', qty: 1, needByMin: 60 });
  assert.equal(cmdA.status, 409, 'an archived session accepts no commands');
});

test('plant-wide invariant: nobody is productive at two stations at once (all sessions in the database)', async () => {
  const d = await db();
  const rows = await d.collection('sim_tasks').aggregate([{ $match: { STATUS: 'WORKING' } }, { $group: { _id: { s: '$SESSION_ID', w: '$WORKER_ID' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray();
  assert.deepEqual(rows, []);
});
