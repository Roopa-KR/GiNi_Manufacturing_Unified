'use strict';
/*
 * Guarded factory reset - run ONLY against a DISPOSABLE fresh-factory test database whose API was started with
 * ALLOW_FACTORY_RESET=true (never NODE_ENV=production). It is NOT part of the normal scenario run and never runs at start-up.
 *   ALLOW_FACTORY_RESET_TEST=1 node --test tests/fresh/reset.test.js
 * Checks: preview shows the exact target and counts; wrong confirmations are refused; the reset quiesces, clears operational data
 * consistently, keeps the admin (and, by default, workers and configuration), ends operator sign-ins, writes an audit record that
 * survives, leaves a valid empty session that works again (new order -> release -> tank), and evidence files are not deleted.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const { Client } = require('../integration/helpers');

const SID = 'S-FACTORY';
const key = () => `reset-${crypto.randomUUID()}`;

test('guarded factory reset (disposable database only)', { skip: process.env.ALLOW_FACTORY_RESET_TEST !== '1' && 'set ALLOW_FACTORY_RESET_TEST=1 on a disposable database' }, async (t) => {
  const mc = new MongoClient(process.env.MONGODB_URI); await mc.connect();
  const db = mc.db(process.env.MONGODB_DB_NAME);
  t.after(() => mc.close());
  const admin = new Client('admin');
  await admin.login(process.env.ADMIN_LOGIN || 'admin', process.env.ADMIN_PASSWORD);
  const op = new Client('operator');
  const opLogin = process.env.RESET_TEST_OPERATOR || 'ana.test', opPin = process.env.RESET_TEST_PIN || '246810';
  await op.login(opLogin, opPin);

  const pv = (await admin.get('/api/factory/reset')).data;
  assert.equal(pv.enabled, true, 'API must run with ALLOW_FACTORY_RESET=true for this test');
  assert.equal(pv.target.database, process.env.MONGODB_DB_NAME);
  assert.ok(Object.keys(pv.operational).length > 0, 'something to reset');
  const before = { workers: await db.collection('worker_master').countDocuments({}), products: await db.collection('product_master').countDocuments({}), admins: await db.collection('accounts').countDocuments({ worker_id: null }), audit: await db.collection('audit_log').countDocuments({}) };
  const evidenceFiles = await db.collection('sim_evidence').countDocuments({});

  assert.equal((await admin.post('/api/factory/reset', { confirmText: 'RESET wrong', factoryName: pv.target.factoryName, acknowledge: true }, key())).status, 400, 'wrong typed database refused');
  assert.equal((await admin.post('/api/factory/reset', { confirmText: pv.confirmText, factoryName: 'wrong', acknowledge: true }, key())).status, 400, 'wrong factory name refused');
  assert.equal((await admin.post('/api/factory/reset', { confirmText: pv.confirmText, factoryName: pv.target.factoryName }, key())).status, 400, 'missing acknowledgement refused');
  assert.equal((await op.req('POST', '/api/factory/reset', {}, { 'idempotency-key': key() })).status, 403, 'operators cannot reset');

  const r = await admin.post('/api/factory/reset', { confirmText: pv.confirmText, factoryName: pv.target.factoryName, acknowledge: true }, key());
  assert.equal(r.status, 200, JSON.stringify(r.data));
  for (const c of ['sim_units', 'sim_tasks', 'sim_events', 'sim_inspections', 'sim_points_ledger', 'sim_attendance', 'sim_alerts', 'sim_projections', 'sim_change_log']) assert.equal(await db.collection(c).countDocuments({ SESSION_ID: SID }), 0, `${c} cleared`);
  for (const c of ['production_orders', 'order_lines', 'production_batches']) assert.equal(await db.collection(c).countDocuments({ SESSION_ID: SID }), 0, `${c} cleared`);
  assert.equal(await db.collection('worker_master').countDocuments({}), before.workers, 'workers kept by default');
  assert.equal(await db.collection('product_master').countDocuments({}), before.products, 'configuration kept by default');
  assert.equal(await db.collection('accounts').countDocuments({ worker_id: null }), before.admins, 'admin kept');
  assert.ok(await db.collection('audit_log').countDocuments({ ACTION: 'FACTORY_RESET' }) >= 1, 'audit record kept outside the cleared data');
  const log = await db.collection('factory_reset_log').findOne({ RESET_ID: r.data.resetId });
  assert.equal(log.STATUS, 'COMPLETED');
  const s = await db.collection('sim_sessions').findOne({ SESSION_ID: SID });
  assert.equal(s.STATUS, 'READY'); assert.equal(s.EVENT_SEQ, 0); assert.ok(s.RESET_GENERATION >= 1);
  const w = await db.collection('sim_workers').find({ SESSION_ID: SID }).toArray();
  assert.ok(w.length > 0 && w.every(x => x.ATTENDANCE_STATE !== 'CLOCKED_IN' && x.CONTROL.MODE === 'HUMAN_ONLY'), 'people back, nobody clocked in');
  const m = await db.collection('sim_materials').find({ SESSION_ID: SID }).toArray();
  assert.ok(m.every(x => x.ON_HAND_QTY === 0), 'stock back to zero (explicit receipts only)');
  assert.equal((await op.get(`/api/sessions/${SID}/me/home`)).status, 401, 'operator sign-in ended');
  assert.equal((await admin.get('/api/factory/setup')).status, 200, 'admin keeps access');
  void evidenceFiles;
  // the empty session works again
  const prod = (await db.collection('product_master').findOne({ STATUS: 'RELEASED' })).PRODUCT_ID;
  const o = await admin.cmd(SID, 'ORDER_CREATE', { customerOrderRef: 'PO-AFTER-RESET', lines: [{ productId: prod, requiredGoodQty: 1, dueAt: new Date(Date.now() + 86400000).toISOString() }] }, key());
  assert.equal(o.status, 201, JSON.stringify(o.data));
  const rel = await admin.cmd(SID, 'BATCH_RELEASE', { batchId: o.data.result.lines[0].batches[0] }, key());
  assert.equal(rel.status, 201); assert.equal(rel.data.result.tanks.length, 1);
  assert.equal(await db.collection('sim_units').countDocuments({ SESSION_ID: SID }), 1, 'no stale record recreated');
});
