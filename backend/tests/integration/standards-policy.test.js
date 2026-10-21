'use strict';
/* Rework-standard approval and points-policy confirmation through the real API (repair review findings: a populated number is not
   an approval; scoring exceptions must be explicit, versioned and confirmed). Both write versioned records with a named
   approver/confirmer and an audit row in one transaction. To leave the shared database's scoring unchanged for the other suites,
   the records created here take effect in 2099 (SCHEDULED); the engine-side effect of approved standards and confirmed policies
   is tested in python_engine/tests/test_points_ledger.py. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const { Client, demoPin, adminClient } = require('./helpers');

let mongo;
async function db() { if (!mongo) mongo = await MongoClient.connect(process.env.MONGODB_URI); return mongo.db(process.env.MONGODB_DB_NAME); }
test.after(async () => { if (mongo) await mongo.close(); });
const FUTURE = '2099-01-01T00:00:00Z';
const key = () => `t-${crypto.randomUUID()}`;

test('rework standards: validated, versioned, approved by a named person, audited, idempotent', { timeout: 120000 }, async () => {
  const d = await db();
  const admin = await adminClient();
  const bad = await admin.post('/api/admin/master/rework-standards', { operationId: 'OP-NOPE', laborMin: -5, approvalStatement: 'x' }, key());
  assert.equal(bad.status, 400, JSON.stringify(bad.data));
  for (const frag of ['is not a labour operation', 'laborMin must be a positive number', 'approvalStatement is required']) assert.ok(bad.data.error.message.includes(frag), `${frag} in ${bad.data.error.message}`);
  const prod = (await admin.get('/api/admin/master/products')).data.products.find(p => p.status === 'RELEASED' && p.routingOperations > 0);
  const body = { operationId: 'OP10', productId: prod.productId, reworkType: 'GATE_REWORK', laborMin: 25, approvalStatement: 'Time study TS-OP10-RW by IE lead, 12 observations', effectiveFrom: FUTURE };
  const k = key();
  const a1 = await admin.post('/api/admin/master/rework-standards', body, k);
  assert.equal(a1.status, 201, JSON.stringify(a1.data));
  const s1 = a1.data.standard;
  assert.equal(s1.STATUS, 'APPROVED'); assert.equal(s1.APPROVED_BY, process.env.ADMIN_LOGIN || 'admin'); assert.ok(s1.VERSION >= 1);
  const replay = await admin.post('/api/admin/master/rework-standards', body, k);
  assert.equal(replay.status, 200); assert.equal(replay.data.standard.STANDARD_ID, s1.STANDARD_ID, 'a retry returns the same approval');
  const a2 = await admin.post('/api/admin/master/rework-standards', { ...body, laborMin: 28 }, key());
  assert.equal(a2.status, 201);
  assert.equal(a2.data.standard.VERSION, s1.VERSION + 1);
  assert.equal(a2.data.standard.SUPERSEDES, s1.STANDARD_ID);
  const old = await d.collection('rework_standards').findOne({ STANDARD_ID: s1.STANDARD_ID });
  assert.equal(old.STATUS, 'SUPERSEDED', 'the previous version is kept, marked superseded');
  const aud = await d.collection('audit_log').findOne({ TARGET: a2.data.standard.STANDARD_ID, ACTION: 'REWORK_STANDARD_APPROVED' });
  assert.ok(aud && aud.BEFORE.standardId === s1.STANDARD_ID && aud.AFTER.LABOR_MIN === 28, 'audited with before/after');
  const wd = await admin.post(`/api/admin/master/rework-standards/${a2.data.standard.STANDARD_ID}/withdraw`, { reason: 'Superseded by a new study (test)' }, key());
  assert.equal(wd.status, 200);
  // operators cannot approve standards
  const sessions = (await admin.get('/api/sessions')).data.sessions || [];
  const live = sessions.find(x => ['READY', 'RUNNING', 'PAUSED'].includes(x.status) && x.mode === 'INTERACTIVE');
  const wf = live ? await admin.get(`/api/sessions/${live.sessionId}/workforce?role=PRODUCTION_OPERATOR&pageSize=5`) : null;
  const someone = wf && wf.data && wf.data.workers ? wf.data.workers[0] : null;
  assert.ok(someone, 'an operator to try with');
  if (someone) {
    const op = new Client('operator');
    await op.login(someone.workerId, demoPin(someone.workerId));
    const r = await op.post('/api/admin/master/rework-standards', body, key());
    assert.ok([401, 403].includes(r.status), `operator refused (${r.status})`);
  }
});

test('points policy: the shipped default is the client formula; a change is a confirmed, versioned, audited decision', { timeout: 120000 }, async () => {
  const d = await db();
  const admin = await adminClient();
  const cur = (await admin.get('/api/admin/points-policy')).data;
  assert.deepEqual(cur.adjustments, ['withdraw_positive_time_on_confirmed_workmanship_defect', 'waive_negative_time_on_confirmed_equipment_cause']);
  if (cur.effective.source === 'SHIPPED_DEFAULT') {
    for (const k of cur.adjustments) assert.equal(cur.effective.policy.attempt_adjustments[k], false, `${k} is OFF by default`);
  }
  const noStatement = await admin.post('/api/admin/points-policy', { attemptAdjustments: { withdraw_positive_time_on_confirmed_workmanship_defect: true } }, key());
  assert.equal(noStatement.status, 400);
  assert.match(noStatement.data.error.message, /confirmationStatement is required/);
  const unknown = await admin.post('/api/admin/points-policy', { attemptAdjustments: { pay_double: true }, confirmationStatement: 'Agreed in the steering committee minutes SC-14' }, key());
  assert.equal(unknown.status, 400);
  const ok = await admin.post('/api/admin/points-policy', { attemptAdjustments: { withdraw_positive_time_on_confirmed_workmanship_defect: true }, confirmationStatement: 'Agreed by the plant manager, steering committee minutes SC-14 (test record)', effectiveFrom: FUTURE }, key());
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const v = await d.collection('points_policy_versions').findOne({ VERSION_NO: ok.data.version });
  assert.equal(v.CONFIRMED_BY, process.env.ADMIN_LOGIN || 'admin');
  assert.ok(v.CONFIRMATION_STATEMENT.includes('SC-14') && v.POLICY_HASH);
  const after = (await admin.get('/api/admin/points-policy')).data;
  assert.equal(after.versions.find(x => x.version === ok.data.version).status, 'SCHEDULED', 'a future-dated version waits; the policy in force is unchanged');
  assert.equal(after.effective.key, cur.effective.key);
  assert.ok(await d.collection('audit_log').findOne({ ACTION: 'POINTS_POLICY_CONFIRMED', TARGET: `P${ok.data.version}` }), 'audited');
});
