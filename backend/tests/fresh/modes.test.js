'use strict';
/*
 * FRESH FACTORY - operating-mode guards (Manual Team Test vs Simulated Test).
 * Runs on a DISPOSABLE fresh-factory database that already has factory settings and at least one real (non-simulated)
 * worker - for example the database left by scenario.test.js or by the UI walkthrough. It switches the mode to
 * SIMULATED_TEST and leaves it there with the clock ahead of real time, so never run it on a team database.
 * Runs only with FRESH_MODES_TEST=1:   FRESH_MODES_TEST=1 node --test tests/fresh/modes.test.js
 * Env: API_URL, FRONTEND_URL, ADMIN_URL, ADMIN_LOGIN, ADMIN_PASSWORD, MONGODB_URI, MONGODB_DB_NAME, INTERNAL_SERVICE_TOKEN.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const { Client, API } = require('../integration/helpers');

const SID = 'S-FACTORY';
const key = () => `modes-${crypto.randomUUID()}`;

test('operating modes: manual clock is real time, simulated mode only drives designated simulated workers', { timeout: 5 * 60 * 1000, skip: process.env.FRESH_MODES_TEST !== '1' && 'set FRESH_MODES_TEST=1 on a disposable, configured fresh-factory database' }, async (t) => {
  const mc = new MongoClient(process.env.MONGODB_URI);
  await mc.connect();
  t.after(() => mc.close());
  const db = mc.db(process.env.MONGODB_DB_NAME);
  const st = await db.collection('factory_settings').findOne({});
  assert.ok(st, 'factory settings exist (run on a configured disposable fresh-factory database)');
  const human = await db.collection('sim_workers').findOne({ SESSION_ID: SID, SIMULATED_WORKER: { $ne: true } });
  assert.ok(human, 'a real (non-simulated) worker exists');
  assert.equal(human.CONTROL.MODE, 'HUMAN_ONLY');

  const admin = new Client('admin');
  await admin.login(process.env.ADMIN_LOGIN || 'admin', process.env.ADMIN_PASSWORD);
  const settings = (mode) => admin.req('PUT', '/api/factory/settings', { factoryName: st.FACTORY_NAME, siteId: st.SITE_ID, timezone: st.TIMEZONE, serialPrefix: st.SERIAL_PREFIX, workingDays: st.WORKING_DAYS, operatingMode: mode }, { 'idempotency-key': key() });
  const forged = async () => {
    const r = await fetch(API + '/api/internal/commands', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}` },
      body: JSON.stringify({ sessionId: SID, commands: [{ type: 'CLOCK_IN', payload: {}, actorWorkerId: human.WORKER_ID, idempotencyKey: key() }] }) });
    return (await r.json()).results[0];
  };

  await t.test('manual team test: the clock cannot be played, sped up or rewound', async () => {
    if (st.OPERATING_MODE !== 'MANUAL_TEAM_TEST') assert.equal((await settings('MANUAL_TEAM_TEST')).status, 200);
    for (const body of [{ action: 'PLAY' }, { action: 'SPEED', speed: 10 }, { action: 'PAUSE' }]) {
      const r = await admin.post(`/api/sessions/${SID}/clock`, body);
      assert.ok(r.status >= 400 && r.status < 500, `${body.action} refused in manual mode (got ${r.status})`);
    }
    const s = await admin.get(`/api/sessions/${SID}`);
    assert.equal(s.status, 200);
    const now = Date.now(), sim = new Date(s.data.session ? s.data.session.simNow : s.data.simNow).getTime();
    assert.ok(Math.abs(sim - now) < 120000, 'session time = real time');
  });

  await t.test('manual team test: an agent command for a real person is refused', async () => {
    const r = await forged();
    assert.equal(r.ok, false); assert.equal(r.status, 403);
  });

  await t.test('simulated test: clock control allowed, real people still never driven by agents', async () => {
    assert.equal((await settings('SIMULATED_TEST')).status, 200);
    const sess = await db.collection('sim_sessions').findOne({ SESSION_ID: SID });
    assert.equal(sess.OPERATING_MODE, 'SIMULATED_TEST');
    const r1 = await admin.post(`/api/sessions/${SID}/clock`, { action: 'PLAY' });
    assert.ok(r1.status < 300, `PLAY allowed in simulated mode (got ${r1.status} ${JSON.stringify(r1.data).slice(0, 200)})`);
    const r2 = await admin.post(`/api/sessions/${SID}/clock`, { action: 'SPEED', speed: 60 });
    assert.ok(r2.status < 300, `SPEED allowed (got ${r2.status})`);
    const r = await forged();
    assert.equal(r.ok, false, 'agent command for a real person refused in simulated mode too'); assert.equal(r.status, 403);
    assert.equal((await db.collection('sim_workers').findOne({ SESSION_ID: SID, WORKER_ID: human.WORKER_ID })).CONTROL.MODE, 'HUMAN_ONLY');
  });

  await t.test('simulated test: returning to manual is refused while the simulated clock is ahead of real time', async () => {
    await new Promise(r => setTimeout(r, 5000));      // speed 60: ~5 simulated minutes ahead
    const r = await settings('MANUAL_TEAM_TEST');
    assert.equal(r.status, 409, `refused (got ${r.status} ${JSON.stringify(r.data).slice(0, 200)})`);
    assert.equal(r.data.error.code, 'SIMULATED_CLOCK_AHEAD');
  });
});
