'use strict';
/*
 * Fresh factory - tank-label scanning. The label is the tank serial (created at batch release). Checks: every scan is saved
 * (sim_scans + events) and shown in the passport; "scan required" blocks starting work / an inspection until the right tank
 * is scanned; a wrong tank is recorded and does not unlock anything; a location scan records the station without moving
 * the tank on its route. Run AFTER scenario.test.js, unified.test.js and additions.test.js on the same DISPOSABLE database.
 * The scan-required switches are turned off again at the end.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const { Client } = require('../integration/helpers');

const SID = 'S-FACTORY';
const key = () => `scan-${crypto.randomUUID()}`;
const RUN = Date.now().toString(36).toUpperCase();
const ok = (r, s = 201) => { assert.equal(r.status, s, JSON.stringify(r.data).slice(0, 600)); return r.data; };

test('fresh factory: tank-label scanning is saved, shown and (when switched on) required', { timeout: 10 * 60 * 1000 }, async (t) => {
  const mc = new MongoClient(process.env.MONGODB_URI); await mc.connect(); t.after(() => mc.close());
  const db = mc.db(process.env.MONGODB_DB_NAME);
  const admin = new Client('admin'); await admin.login(process.env.ADMIN_LOGIN || 'admin', process.env.ADMIN_PASSWORD);
  const cmd = (c, type, p) => c.cmd(SID, type, p, key());
  const st = await db.collection('factory_settings').findOne({});
  const settings = (on) => admin.req('PUT', '/api/factory/settings', { factoryName: st.FACTORY_NAME, siteId: st.SITE_ID, timezone: st.TIMEZONE, serialPrefix: st.SERIAL_PREFIX, workingDays: st.WORKING_DAYS,
    operatingMode: st.OPERATING_MODE, scanRequiredStartWork: on, scanRequiredInspection: on }, { 'idempotency-key': key() });
  t.after(async () => { await settings(false); });

  // two free stations, a tank, a crew of two new welders, an inspector
  const S1 = `FS1-${RUN}`.slice(0, 20), S2 = `FS2-${RUN}`.slice(0, 20);
  for (const id of [S1, S2]) { const r = await admin.req('PUT', `/api/factory/stations/${id}`, { name: `Scan test ${id}`, workCenterId: 'FAB', type: 'WORKSTATION', capacity: 1 }, { 'idempotency-key': key() }); assert.ok([200, 201].includes(r.status), JSON.stringify(r.data)); }
  ok(await cmd(admin, 'MATERIAL_RECEIPT', { materialId: 'MAT-SHELL', qty: 2, lotId: `LOT-SCAN-${RUN}` }));
  const o = ok(await cmd(admin, 'ORDER_CREATE', { customerOrderRef: `SCAN-${RUN}`, lines: [{ productId: 'TANK-A', requiredGoodQty: 2, dueAt: new Date(Date.now() + 3 * 86400000).toISOString(), batches: [{ qty: 1 }, { qty: 1 }] }] })).result;
  const tank = ok(await cmd(admin, 'BATCH_RELEASE', { batchId: o.lines[0].batches[0] })).result.tanks[0];
  const other = ok(await cmd(admin, 'BATCH_RELEASE', { batchId: o.lines[0].batches[1] })).result.tanks[0];
  const crew = [];
  for (const [first, pin] of [['Sam', '615243'], ['Sue', '625143']]) {
    const login = `${first.toLowerCase()}.${RUN.toLowerCase()}`;
    const w = ok(await admin.post('/api/admin/workers', { firstName: first, lastName: `Scanner ${RUN}`, workerRole: 'PRODUCTION_OPERATOR', homeWorkCenterId: 'FAB', shiftCode: 'D', initialPin: pin, loginId: login, qualifications: [{ skillId: 'SK-WELD' }] }, key()));
    const c = new Client('operator'); await c.login(login, pin); ok(await cmd(c, 'CLOCK_IN', {}));
    crew.push({ id: w.workerId, c });
  }
  const insp = ok(await admin.post('/api/admin/workers', { firstName: 'Ina', lastName: `Scanner ${RUN}`, workerRole: 'QUALITY_INSPECTOR', homeWorkCenterId: 'FAB', shiftCode: 'D', initialPin: '635241', loginId: `ina.${RUN.toLowerCase()}`, qualifications: [{ skillId: 'SK-QC' }] }, key()));
  const ina = new Client('operator'); await ina.login(`ina.${RUN.toLowerCase()}`, '635241'); ok(await cmd(ina, 'CLOCK_IN', {}));

  ok(await settings(true), 200);
  const sess = ok(await admin.get(`/api/sessions/${SID}`), 200);
  const pub = sess.session || sess;
  assert.deepEqual(pub.scanRequired, { startWork: true, inspection: true }, 'session shows the scan requirement');

  const op = ok(await cmd(admin, 'OPERATION_START', { unitId: tank.unitId, workstationId: S1, crew: crew.map(x => x.id) })).result;
  const [ta, tb] = op.tasks;

  await t.test('start is blocked until the right tank is scanned; a wrong tank is saved but unlocks nothing', async () => {
    const home = ok(await crew[0].c.get(`/api/sessions/${SID}/me/home`), 200);
    assert.deepEqual({ required: home.currentTask.scan.required, confirmed: home.currentTask.scan.confirmed }, { required: true, confirmed: false });
    const blocked = await cmd(crew[0].c, 'TASK_START', { taskId: ta });
    assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'SCAN_REQUIRED');
    const wrong = ok(await cmd(crew[0].c, 'SCAN_RECORD', { code: other.serial, purpose: 'CONFIRM_TASK', taskId: ta, method: 'SCANNER_OR_TYPED' })).result;
    assert.equal(wrong.scan.result, 'WRONG_TANK');
    assert.equal((await cmd(crew[0].c, 'TASK_START', { taskId: ta })).status, 409, 'wrong tank does not unlock');
    const unknown = ok(await cmd(crew[0].c, 'SCAN_RECORD', { code: 'NOPE-404', purpose: 'CONFIRM_TASK', taskId: ta })).result;
    assert.equal(unknown.scan.result, 'UNKNOWN');
    const right = ok(await cmd(crew[0].c, 'SCAN_RECORD', { code: tank.serial.toLowerCase(), purpose: 'CONFIRM_TASK', taskId: ta, method: 'CAMERA' })).result;
    assert.equal(right.scan.result, 'MATCH');
    const home2 = ok(await crew[0].c.get(`/api/sessions/${SID}/me/home`), 200);
    assert.equal(home2.currentTask.scan.confirmed, true);
    ok(await cmd(crew[0].c, 'TASK_START', { taskId: ta }));
    // the second person confirms the tank (e.g. before joining) - a tank scan in the last hour counts
    assert.equal((await cmd(crew[1].c, 'TASK_START', { taskId: tb })).status, 409);
    ok(await cmd(crew[1].c, 'SCAN_RECORD', { code: tank.serial, purpose: 'CONFIRM_UNIT', unitId: tank.unitId }));
    ok(await cmd(crew[1].c, 'TASK_START', { taskId: tb }));
    // someone cannot confirm another person's task
    assert.equal((await cmd(crew[1].c, 'SCAN_RECORD', { code: tank.serial, purpose: 'CONFIRM_TASK', taskId: ta })).status, 403);
  });

  await t.test('inspection start needs the inspector\'s scan of that tank', async () => {
    for (const m of ['MS-OP10-01', 'MS-OP10-02']) ok(await cmd(crew[0].c, 'MILESTONE_COMPLETE', { operationInstanceId: op.operation.OPERATION_INSTANCE_ID, milestoneId: m }));
    ok(await cmd(crew[0].c, 'TASK_FINISH', { taskId: ta }));
    const blocked = await cmd(ina, 'INSPECTION_START', { unitId: tank.unitId });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.data)); assert.equal(blocked.data.error.code, 'SCAN_REQUIRED');
    assert.equal(ok(await cmd(ina, 'SCAN_RECORD', { code: tank.serial, purpose: 'CONFIRM_INSPECTION', unitId: tank.unitId })).result.scan.result, 'MATCH');
    const ins = ok(await cmd(ina, 'INSPECTION_START', { unitId: tank.unitId })).result.inspection;
    assert.equal(ins.INSPECTOR_ID, insp.workerId);
  });

  await t.test('a location scan records the station without moving the tank on its route', async () => {
    const before = await db.collection('sim_units').findOne({ SESSION_ID: SID, UNIT_ID: other.unitId });
    const r = ok(await cmd(crew[1].c, 'SCAN_RECORD', { code: other.serial, stationCode: 'fab-01', purpose: 'LOCATE' })).result;
    assert.equal(r.scan.stationId, 'FAB-01');
    const after = await db.collection('sim_units').findOne({ SESSION_ID: SID, UNIT_ID: other.unitId });
    assert.equal(after.LAST_SCANNED_STATION_ID, 'FAB-01');
    assert.equal(after.ROUTE_STEP, before.ROUTE_STEP); assert.equal(after.STATE, before.STATE); assert.equal(after.CURRENT_WORKSTATION_ID, before.CURRENT_WORKSTATION_ID);
    assert.equal((await cmd(crew[1].c, 'SCAN_RECORD', { code: other.serial, stationCode: 'NO-SUCH', purpose: 'LOCATE' })).status, 400);
  });

  await t.test('scans are stored, evented and shown in the tank passport (admin and operator)', async () => {
    const rows = await db.collection('sim_scans').find({ SESSION_ID: SID, $or: [{ UNIT_ID: tank.unitId }, { EXPECTED_UNIT_ID: tank.unitId }] }).toArray();
    assert.ok(rows.length >= 5, `scans saved: ${rows.length}`);
    assert.ok(rows.every(r => r.SCAN_ID && r.SCANNED_AT && r.PURPOSE && r.RESULT && r.CODE));
    assert.ok(rows.some(r => r.RESULT === 'WRONG_TANK') && rows.some(r => r.METHOD === 'CAMERA'));
    const ev = await db.collection('sim_events').find({ SESSION_ID: SID, ENTITY_ID: tank.unitId, EVENT_TYPE: { $in: ['TANK_SCANNED', 'TANK_SCAN_MISMATCH'] } }).toArray();
    assert.ok(ev.some(e => e.EVENT_TYPE === 'TANK_SCANNED') && ev.some(e => e.EVENT_TYPE === 'TANK_SCAN_MISMATCH'));
    const pa = ok(await admin.get(`/api/sessions/${SID}/units/${tank.unitId}`), 200);
    assert.ok(pa.scans.rows.length >= 5 && pa.scans.rows.some(r => r.result === 'WRONG_TANK'));
    const po = ok(await crew[0].c.get(`/api/sessions/${SID}/units/${other.unitId}`), 200);
    assert.equal(po.scans.lastLocation.stationId, 'FAB-01');
  });

  await t.test('switched off: work starts without a scan (scanning stays optional)', async () => {
    ok(await settings(false), 200);
    const op2 = ok(await cmd(admin, 'OPERATION_START', { unitId: other.unitId, workstationId: S2, crew: crew.map(x => x.id) }), 201).result;
    // the first operation is finished (its crew tasks are completed) - the new task starts without any scan
    ok(await cmd(crew[1].c, 'TASK_START', { taskId: op2.tasks[1] }));
  });
});
