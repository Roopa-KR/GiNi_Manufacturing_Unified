'use strict';
/*
 * FRESH FACTORY - first complete test scenario (FRESH_FACTORY_SETUP.md, TEST_RESULTS_FRESH_FACTORY.md).
 *
 * Runs against the REAL API over HTTP (cookies, CSRF, origin, idempotency keys) and the REAL Python engine, on a database that was
 * EMPTY and initialised only with `npm run factory:init`. Nothing is seeded. Env:
 *   API_URL, FRONTEND_URL, ADMIN_URL          (as in tests/integration/helpers.js)
 *   ADMIN_LOGIN, ADMIN_PASSWORD               (the bootstrap admin)
 *   MONGODB_URI, MONGODB_DB_NAME              (read-only verification of stored events / ledger; the test never writes directly)
 *   FRESH_RESTART_CMD                         (optional: shell command that restarts the API and the engine, for step 22)
 *   INTERNAL_SERVICE_TOKEN                    (agent-protection check: an agent command for a real person must be refused)
 * The database must be empty apart from factory:init - run it on a disposable database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { MongoClient } = require('mongodb');
const { Client, waitFor, API } = require('../integration/helpers');

const SID = 'S-FACTORY';
const key = () => `fresh-${crypto.randomUUID()}`;
const PINS = { ana: '246810', ben: '135791', cara: '864202', dan: '975319', eve: '112358' };
const S = {};               // shared state between the steps

function expect(r, status, what) {
  const ok = Array.isArray(status) ? status.includes(r.status) : r.status === status;
  assert.ok(ok, `${what}: expected ${status}, got ${r.status} ${JSON.stringify(r.data).slice(0, 600)}`);
  return r.data;
}
async function put(c, path, body) { return c.req('PUT', path, body, { 'idempotency-key': key() }); }
async function cmd(c, type, payload, k) { return c.cmd(SID, type, payload, k || key()); }
async function unit(c, unitId) { return expect(await c.get(`/api/sessions/${SID}/units/${unitId}`), 200, 'passport'); }
async function stateOf(db, unitId) { return (await db.collection('sim_units').findOne({ SESSION_ID: SID, UNIT_ID: unitId })).STATE; }

test('fresh factory - first complete scenario and separate checks', { timeout: 30 * 60 * 1000 }, async (t) => {
  const mc = new MongoClient(process.env.MONGODB_URI);
  await mc.connect();
  const db = mc.db(process.env.MONGODB_DB_NAME);
  t.after(() => mc.close());
  const admin = new Client('admin');

  await t.test('00 the database starts empty (only the bootstrap admin and S-FACTORY)', async () => {
    for (const c of ['worker_master', 'production_orders', 'sim_units', 'sim_tasks', 'sim_attendance', 'sim_points_ledger', 'run_catalog', 'unit_master']) assert.equal(await db.collection(c).countDocuments({}), 0, `${c} not empty`);
    assert.equal(await db.collection('accounts').countDocuments({ worker_id: null, roles: 'ADMIN' }), 1);
    const s = await db.collection('sim_sessions').findOne({ SESSION_ID: SID });
    assert.ok(s && s.FACTORY_SESSION && s.CLOCK.REAL_TIME, 'permanent real-time factory session exists');
    assert.equal(await db.collection('sim_sessions').countDocuments({}), 1, 'no demo sessions');
  });

  await t.test('01-02 bootstrap admin logs into the admin app; environment banner data', async () => {
    await admin.login(process.env.ADMIN_LOGIN || 'admin', process.env.ADMIN_PASSWORD);
    const env = expect(await admin.get('/api/environment'), 200, 'environment');
    assert.equal(env.environment, 'FRESH_FACTORY');
    assert.equal(env.database, process.env.MONGODB_DB_NAME);
    assert.equal(env.bootstrap, 'DONE');
    const setup = expect(await admin.get('/api/factory/setup'), 200, 'setup');
    assert.equal(setup.steps.length, 10);
    assert.ok(setup.steps.every(s => s.status === 'NOT_CONFIGURED'), 'every setup step starts NOT_CONFIGURED');
    assert.equal(setup.readyToRelease, false);
    // public registration does not exist; an operator account cannot use the admin app (checked later)
    expect(await admin.req('POST', '/api/auth/register', { loginId: 'x' }), [401, 403, 404], 'no public registration');
  });

  await t.test('03 configure the test factory and timezone', async () => {
    const bad = await put(admin, '/api/factory/settings', { factoryName: 'Test Plant', siteId: 'TP-01', timezone: 'Mars/Olympus' });
    expect(bad, 400, 'invalid timezone refused');
    const r = await put(admin, '/api/factory/settings', { factoryName: 'Team Test Plant', siteId: 'TTP-01', timezone: 'Europe/Berlin', operatingMode: 'MANUAL_TEAM_TEST', workingDays: [1, 2, 3, 4, 5, 6, 7], serialPrefix: 'TT' });
    expect(r, 200, 'settings');
    const env = expect(await admin.get('/api/environment'), 200, 'environment');
    assert.equal(env.factory.timezone, 'Europe/Berlin');
    assert.match(env.operationalTimeLocal, /^\d{4}-\d{2}-\d{2}T/);
    // shifts: an all-day shift D (so the test can run at any hour) and an overnight shift N (overnight support)
    expect(await put(admin, '/api/factory/shifts/D', { name: 'Day (test)', startLocal: '00:00', endLocal: '23:59', daysOfWeek: [1, 2, 3, 4, 5, 6, 7], breaks: [] }), [200, 201], 'shift D');
    const n = expect(await put(admin, '/api/factory/shifts/N', { name: 'Night', startLocal: '22:00', endLocal: '06:00', daysOfWeek: [1, 2, 3, 4, 5], breaks: [{ startLocal: '02:00', endLocal: '02:30' }] }), [200, 201], 'shift N');
    assert.equal(n.record.OVERNIGHT, true);
    const night = await db.collection('shift_calendar').findOne({ SHIFT_CODE: 'N' });
    assert.ok(night && night.START_AT_LOCAL === '22:00' && night.END_AT_LOCAL === '06:00');
    expect(await put(admin, '/api/factory/shifts/X', { name: 'bad', startLocal: '08:00', endLocal: '16:00', daysOfWeek: [1], breaks: [{ startLocal: '17:00', endLocal: '17:30' }] }), 400, 'break outside the shift refused');
  });

  await t.test('04 work centres and stations', async () => {
    expect(await put(admin, '/api/factory/work-centers/FAB', { name: 'Fabrication', type: 'FABRICATION', areaId: 'AREA-A', queueCapacity: 6, capacity: 2, sequence: 1 }), [200, 201], 'FAB');
    expect(await put(admin, '/api/factory/work-centers/FIN', { name: 'Finishing', type: 'FINISHING', areaId: 'AREA-B', queueCapacity: 6, capacity: 1, sequence: 2 }), [200, 201], 'FIN');
    expect(await put(admin, '/api/factory/stations/FAB-01', { name: 'Fit-up bay 1', workCenterId: 'FAB', type: 'WORKSTATION' }), [200, 201], 'FAB-01');
    expect(await put(admin, '/api/factory/stations/FAB-02', { name: 'Fit-up bay 2', workCenterId: 'FAB', type: 'WORKSTATION' }), [200, 201], 'FAB-02');
    expect(await put(admin, '/api/factory/stations/FIN-01', { name: 'Paint booth', workCenterId: 'FIN', type: 'WORKSTATION' }), [200, 201], 'FIN-01');
    expect(await put(admin, '/api/factory/stations/FIN-CURE', { name: 'Cure zone', workCenterId: 'FIN', type: 'CURE_ZONE', capacity: 4 }), [200, 201], 'FIN-CURE');
    expect(await put(admin, '/api/factory/stations/BAD-01', { name: 'x', workCenterId: 'NOPE' }), 400, 'station of an unknown work centre refused');
    for (const [id, name, cat] of [['SK-WELD', 'Welding / fit-up', 'PRODUCTION'], ['SK-PAINT', 'Painting', 'PRODUCTION'], ['SK-QC', 'Gate inspection', 'INSPECTION']]) expect(await put(admin, `/api/factory/skills/${id}`, { name, category: cat }), [200, 201], id);
  });

  await t.test('05 product, route, checklists and standards (draft until the checklists exist, then released)', async () => {
    const product = { productId: 'TANK-A', productName: 'Test tank A', modelVariant: 'A', componentType: 'TRANSFORMER_TANK', drawingRef: 'DWG-TEST-A', drawingRevision: 'A',
      operations: [
        { operationId: 'OP10', operationName: 'Shell fit-up and weld', kind: 'LABOR', workCenterId: 'FAB', sequenceNo: 10, standardLaborMin: 60, standardElapsedMin: 30, minCrew: 2, stdCrew: 2, maxCrew: 3, requiredSkillId: 'SK-WELD', gateOperationId: 'QG10', qualityGateRequired: 'Y', milestones: ['Shell fitted', 'Seams welded', 'Work complete'] },
        { operationId: 'QG10', operationName: 'Fabrication gate', kind: 'INSPECTION', workCenterId: 'FAB', sequenceNo: 20, standardElapsedMin: 10, standardLaborMin: 10, minCrew: 1, stdCrew: 1, maxCrew: 1, requiredSkillId: 'SK-QC' },
        { operationId: 'OP20', operationName: 'Paint', kind: 'LABOR', workCenterId: 'FIN', sequenceNo: 30, standardLaborMin: 30, standardElapsedMin: 30, minCrew: 1, stdCrew: 1, maxCrew: 2, requiredSkillId: 'SK-PAINT', gateOperationId: 'QG20', qualityGateRequired: 'Y', milestones: ['Painted'] },
        { operationId: 'OP25', operationName: 'Paint cure (unattended)', kind: 'PROCESS', workCenterId: 'FIN', sequenceNo: 40, standardElapsedMin: 1, standardLaborMin: 0, minCrew: 0, stdCrew: 0, maxCrew: 0 },
        { operationId: 'QG20', operationName: 'Final gate', kind: 'INSPECTION', workCenterId: 'FIN', sequenceNo: 50, standardElapsedMin: 10, standardLaborMin: 10, minCrew: 1, stdCrew: 1, maxCrew: 1, requiredSkillId: 'SK-QC' },
      ],
      materials: [{ materialId: 'MAT-SHELL', consumedAtOperationId: 'OP10', qtyPerUnit: 1, uom: 'KIT' }] };
    // the BOM material does not exist yet -> saved, but as a DRAFT with the missing items listed
    expect(await put(admin, '/api/factory/materials/MAT-SHELL', { name: 'Shell kit', uom: 'KIT', lotTracked: true }), [200, 201], 'material');
    const p = expect(await admin.post('/api/factory/products', product, key()), 201, 'product');
    assert.equal(p.status, 'DRAFT');
    assert.ok(p.missing.some(m => /QG10/.test(m)) && p.missing.some(m => /QG20/.test(m)), 'gates without checklists are listed');
    expect(await admin.post('/api/factory/products/TANK-A/release', {}, key()), 422, 'draft product cannot be released yet');
    expect(await put(admin, '/api/factory/checklists/QG10', { version: '1.0', checks: [
      { checkId: 'QG10-LEN', question: 'Shell length', requirement: 'Measured on the long side', inputType: 'NUMERIC', mandatory: true, unit: 'mm', lower: 998, upper: 1002, nominal: 1000, instrument: 'Tape measure' },
      { checkId: 'QG10-CRK', question: 'Welds free of cracks?', inputType: 'YES_NO', failureAnswer: 'No', mandatory: true, photoRequired: false }] }), 200, 'QG10 checklist');
    expect(await put(admin, '/api/factory/checklists/QG20', { version: '1.0', checks: [{ checkId: 'QG20-PNT', question: 'Paint coverage uniform?', inputType: 'YES_NO', failureAnswer: 'No', mandatory: true }] }), 200, 'QG20 checklist');
    expect(await put(admin, '/api/factory/checklists/QG30', { version: '1.0', checks: [{ checkId: 'QG30-X', question: 'Numeric without limits', inputType: 'NUMERIC', unit: 'mm' }] }), 400, 'numeric question without limits refused (no invented tolerances)');
    const rel = expect(await admin.post('/api/factory/products/TANK-A/release', {}, key()), 200, 'release product');
    assert.equal(rel.status, 'RELEASED');
    const m = expect(await admin.get('/api/factory/master'), 200, 'master');
    const ms = m.products.find(x => x.PRODUCT_ID === 'TANK-A').route.find(r => r.OPERATION_ID === 'OP10').milestones;
    assert.deepEqual(ms, ['Shell fitted', 'Seams welded', 'Work complete']);
  });

  await t.test('06 equipment and explicit material stock (no unlimited inventory)', async () => {
    expect(await put(admin, '/api/factory/equipment/WLD-01', { name: 'Welder 1', type: 'WELDER', workstationId: 'FAB-01', availability: 'AVAILABLE', requiredSkills: ['SK-WELD'] }), [200, 201], 'equipment');
    const before = await db.collection('sim_materials').findOne({ SESSION_ID: SID, MATERIAL_ID: 'MAT-SHELL' });
    assert.equal(before.ON_HAND_QTY, 0, 'stock starts at zero');
    expect(await cmd(admin, 'MATERIAL_RECEIPT', { materialId: 'MAT-SHELL', qty: 2 }), 400, 'lot-tracked material needs a lot');
    const r = expect(await cmd(admin, 'MATERIAL_RECEIPT', { materialId: 'MAT-SHELL', qty: 2, lotId: 'LOT-001', initialStock: true }), 201, 'receipt');
    assert.equal(r.result.material.ON_HAND_QTY, 2);
    expect(await cmd(admin, 'MATERIAL_RECEIPT', { materialId: 'MAT-SHELL', qty: 1, lotId: 'LOT-001' }), 409, 'same lot twice refused');
  });

  await t.test('07-08 three workers with skills (incl. an inspector); their logins work and start from zero', async () => {
    const mk = async (b) => expect(await admin.post('/api/admin/workers', b, key()), 201, `worker ${b.firstName}`);
    S.ana = await mk({ firstName: 'Ana', lastName: 'Test', workerRole: 'PRODUCTION_OPERATOR', homeWorkCenterId: 'FAB', shiftCode: 'D', initialPin: PINS.ana, loginId: 'ana.test', qualifications: [{ skillId: 'SK-WELD' }, { skillId: 'SK-PAINT' }] });
    S.ben = await mk({ firstName: 'Ben', lastName: 'Test', workerRole: 'PRODUCTION_OPERATOR', homeWorkCenterId: 'FAB', shiftCode: 'D', initialPin: PINS.ben, loginId: 'ben.test', qualifications: [{ skillId: 'SK-WELD' }] });
    S.cara = await mk({ firstName: 'Cara', lastName: 'Test', workerRole: 'QUALITY_INSPECTOR', homeWorkCenterId: 'FAB', shiftCode: 'D', initialPin: PINS.cara, loginId: 'cara.test', qualifications: [{ skillId: 'SK-QC' }] });
    S.dan = await mk({ firstName: 'Dan', lastName: 'Test', workerRole: 'PRODUCTION_OPERATOR', homeWorkCenterId: 'FIN', shiftCode: 'D', initialPin: PINS.dan, loginId: 'dan.test', qualifications: [] });
    assert.match(S.ana.workerId, /^W\d{4}$/);
    assert.equal(S.ana.firstShift.joinsCurrent, true, 'JOIN_CURRENT_SHIFT joins the running shift');
    expect(await admin.post('/api/admin/workers', { firstName: 'X', lastName: 'Y', workerRole: 'PRODUCTION_OPERATOR', homeWorkCenterId: 'FAB', shiftCode: 'Q', initialPin: '123456' }, key()), 400, 'unknown shift refused');
    for (const n of ['ana', 'ben', 'cara', 'dan']) {
      S[n + 'C'] = new Client('operator');
      const l = await S[n + 'C'].login(`${n}.test`, PINS[n]);
      assert.equal(l.user.workerId, S[n].workerId);
      const home = expect(await S[n + 'C'].get(`/api/sessions/${SID}/me/home`), 200, `${n} home`);
      assert.equal(home.worker.attendance === 'CLOCKED_IN', false, 'creating an account never clocks in');
      assert.equal(home.currentTask, null);
      assert.equal(home.points.total.TOTAL, 0);
    }
    const w = await db.collection('sim_workers').findOne({ SESSION_ID: SID, WORKER_ID: S.ana.workerId });
    assert.equal(w.CONTROL.MODE, 'HUMAN_ONLY');
    // an operator account cannot use the admin application
    const op = new Client('admin');
    const r = await op.req('POST', '/api/auth/login', { loginId: 'ana.test', pin: PINS.ana });
    assert.equal(r.status, 403);
    // stored credentials are hashes only
    const acct = await db.collection('accounts').findOne({ login_id: 'ana.test' });
    assert.match(acct.pin_hash, /^scrypt\$/);
    assert.ok(!JSON.stringify(await db.collection('audit_log').find({ ACTION: 'WORKER_CREATED' }).toArray()).includes(PINS.ana), 'no PIN in the audit log');
  });

  await t.test('09 order for two good tanks (validation, duplicate refused)', async () => {
    const reference = expect(await admin.get('/api/admin/reference'), 200, 'reference');
    assert.ok(reference.products.some(p => p.id === 'TANK-A' && p.status === 'RELEASED'));
    const now = new Date();
    const due = new Date(now.getTime() + 3 * 86400000);
    const bad = await cmd(admin, 'ORDER_CREATE', { customerOrderRef: 'PO-T-1', lines: [{ productId: 'TANK-A', requiredGoodQty: 2, dueAt: due.toISOString(), batches: [{ qty: 1 }, { qty: 2 }] }] });
    expect(bad, 422, 'batches that do not reconcile with the quantity are refused');
    expect(await cmd(admin, 'ORDER_CREATE', { lines: [{ productId: 'TANK-A', requiredGoodQty: 0, dueAt: due.toISOString() }] }), 422, 'zero quantity refused');
    expect(await cmd(admin, 'ORDER_CREATE', { lines: [{ productId: 'NOPE', requiredGoodQty: 1, dueAt: due.toISOString() }] }), 422, 'unknown product refused');
    const k = key();
    const body = { customerOrderRef: 'PO-T-1', customerName: 'Test customer', priority: 'NORMAL', lines: [{ productId: 'TANK-A', requiredGoodQty: 2, dueAt: due.toISOString(), batches: [{ qty: 1 }, { qty: 1 }] }] };
    const o = expect(await cmd(admin, 'ORDER_CREATE', body, k), 201, 'order');
    S.order = o.result;
    assert.equal(S.order.lines[0].batches.length, 2);
    const again = expect(await cmd(admin, 'ORDER_CREATE', body, k), 200, 'same request replayed');
    assert.equal(again.replayed, true);
    expect(await cmd(admin, 'ORDER_CREATE', body), 409, 'second order with the same reference refused');
    assert.equal(await db.collection('production_orders').countDocuments({ SESSION_ID: SID }), 1, 'exactly one order stored');
    assert.equal(await db.collection('sim_units').countDocuments({ SESSION_ID: SID }), 0, 'a planned batch is not a physical tank');
  });

  await t.test('10-11 release two batches of one tank; two unique tanks generated exactly once', async () => {
    const [b1, b2] = S.order.lines[0].batches;
    const k = key();
    const r1 = expect(await cmd(admin, 'BATCH_RELEASE', { batchId: b1 }, k), 201, 'release 1');
    assert.equal(r1.result.tanks.length, 1);
    const rep = expect(await cmd(admin, 'BATCH_RELEASE', { batchId: b1 }, k), 200, 'release 1 replayed');
    assert.equal(rep.replayed, true);
    const again = expect(await cmd(admin, 'BATCH_RELEASE', { batchId: b1 }), 201, 'release 1 again (new key)');
    assert.equal(again.result.alreadyReleased, true);
    // concurrent releases of the second batch: still exactly one tank
    const rs = await Promise.all([cmd(admin, 'BATCH_RELEASE', { batchId: b2 }), cmd(admin, 'BATCH_RELEASE', { batchId: b2 }), cmd(admin, 'BATCH_RELEASE', { batchId: b2 })]);
    assert.ok(rs.every(r => [200, 201, 409].includes(r.status)), JSON.stringify(rs.map(r => r.status)));
    const units = await db.collection('sim_units').find({ SESSION_ID: SID }).toArray();
    assert.equal(units.length, 2, 'two tanks exactly');
    assert.equal(new Set(units.map(u => u.UNIT_ID)).size, 2);
    assert.equal(new Set(units.map(u => u.TANK_SERIAL_NO)).size, 2);
    for (const u of units) {
      assert.match(u.TANK_SERIAL_NO, /^TT-\d{2}-\d{5}$/);
      assert.equal(u.ROUTE_VERSION, '1.0'); assert.equal(u.ORDER_ID, S.order.orderId); assert.ok(u.BATCH_ID); assert.equal(u.STATE, 'QUEUED'); assert.equal(u.ROUTE_STEP, 'OP10');
    }
    S.t1 = units.find(u => u.BATCH_ID === b1).UNIT_ID; S.t2 = units.find(u => u.BATCH_ID === b2).UNIT_ID;
    const ev = await db.collection('sim_events').countDocuments({ SESSION_ID: SID, EVENT_TYPE: 'BATCH_RELEASED' });
    assert.equal(ev, 2, 'one release event per batch');
  });

  await t.test('12 assign work: readiness explains blockers; unqualified people refused', async () => {
    const rd = expect(await admin.get(`/api/factory/readiness?unitId=${S.t1}`), 200, 'readiness').tanks[0];
    assert.equal(rd.minCrew, 2); assert.equal(rd.stdCrew, 2); assert.equal(rd.requiredSkill, 'SK-WELD');
    expect(await cmd(admin, 'OPERATION_START', { unitId: S.t1, workstationId: 'FAB-01', crew: [S.dan.workerId] }), 403, 'unqualified worker refused');
    expect(await cmd(admin, 'OPERATION_START', { unitId: S.t1, workstationId: 'FIN-01', crew: [S.ana.workerId] }), 400, 'wrong work centre refused');
    const a = expect(await cmd(admin, 'OPERATION_START', { unitId: S.t1, workstationId: 'FAB-01', crew: [S.ana.workerId, S.ben.workerId] }), 201, 'assign T1');
    S.op1 = a.result.operation.OPERATION_INSTANCE_ID;
    expect(await cmd(admin, 'OPERATION_START', { unitId: S.t1, workstationId: 'FAB-02', crew: [S.ana.workerId] }), 409, 'duplicate operation for the same tank refused');
    const rd2 = expect(await admin.get(`/api/factory/readiness?unitId=${S.t1}`), 200, 'readiness').tanks[0];
    assert.ok(rd2.blockers.some(b => b.code === 'CREW_NOT_CLOCKED_IN'), 'not clocked in is a visible blocker');
  });

  await t.test('13-14 workers clock in, start, record milestones (minimum crew enforced)', async () => {
    const q = expect(await S.anaC.get(`/api/sessions/${SID}/me/queue`), 200, 'queue');
    const mine = (q.assigned || q.items || []).find(x => x.unitId === S.t1) || (q.assigned || []).find(x => x.unitId === S.t1);
    assert.ok(mine, 'assigned work is visible to the worker');
    S.taskAna = mine.taskId;
    expect(await cmd(S.anaC, 'TASK_START', { taskId: S.taskAna }), 409, 'cannot start before clocking in');
    expect(await cmd(S.anaC, 'CLOCK_IN', {}), 201, 'Ana clock in');
    const st = expect(await cmd(S.anaC, 'TASK_START', { taskId: S.taskAna }), 201, 'Ana start');
    assert.equal(st.result.operation.STATE, 'BELOW_MIN_CREW', 'one of a minimum crew of two: below minimum');
    expect(await cmd(S.anaC, 'TASK_FINISH', { taskId: S.taskAna }), 409, 'cannot finish below the minimum crew');
    expect(await cmd(S.benC, 'CLOCK_IN', {}), 201, 'Ben clock in');
    const benTask = (await db.collection('sim_tasks').findOne({ SESSION_ID: SID, WORKER_ID: S.ben.workerId, UNIT_ID: S.t1 })).TASK_ID;
    const st2 = expect(await cmd(S.benC, 'TASK_START', { taskId: benTask }), 201, 'Ben start');
    assert.equal(st2.result.operation.STATE, 'WORKING');
    const mat = await db.collection('sim_materials').findOne({ SESSION_ID: SID, MATERIAL_ID: 'MAT-SHELL' });
    assert.equal(mat.ON_HAND_QTY, 1, 'one kit consumed at the first start');
    expect(await cmd(S.anaC, 'MILESTONE_COMPLETE', { operationInstanceId: S.op1, milestoneId: 'MS-OP10-02' }), 409, 'milestones in order');
    expect(await cmd(S.anaC, 'MILESTONE_COMPLETE', { operationInstanceId: S.op1, milestoneId: 'MS-OP10-01' }), 201, 'milestone 1');
    expect(await cmd(S.benC, 'MILESTONE_COMPLETE', { operationInstanceId: S.op1, milestoneId: 'MS-OP10-02' }), 201, 'milestone 2');
    const home = expect(await S.anaC.get(`/api/sessions/${SID}/me/home`), 200, 'home');
    assert.equal(home.currentTask.milestones.completed, 2);
    const w = await db.collection('sim_workers').findOne({ SESSION_ID: SID, WORKER_ID: S.ana.workerId });
    assert.equal(w.CONTROL.MODE, 'HUMAN_ONLY', 'acting does not turn a real person into a lease that could expire to an agent');
  });

  await t.test('15-16 finish, inspect, release: tank 1 passes its whole route (incl. unattended cure)', async () => {
    expect(await cmd(S.anaC, 'TASK_FINISH', { taskId: S.taskAna }), 201, 'finish OP10');
    assert.equal(await stateOf(db, S.t1), 'WORK_COMPLETED_AWAITING_INSPECTION');
    expect(await cmd(S.anaC, 'INSPECTION_START', { unitId: S.t1 }), 403, 'an operator cannot do the independent inspection');
    expect(await cmd(S.caraC, 'CLOCK_IN', {}), 201, 'Cara clock in');
    const ins = expect(await cmd(S.caraC, 'INSPECTION_START', { unitId: S.t1 }), 201, 'inspection start').result.inspection;
    assert.equal(ins.CHECKLIST_VERSION, '1.0');
    assert.equal(ins.CHECKLIST_SNAPSHOT.length, 2, 'checklist pinned to the inspection');
    S.ins1 = ins.INSPECTION_ID;
    const k = key();
    const sub = expect(await cmd(S.caraC, 'INSPECTION_SUBMIT', { inspectionId: ins.INSPECTION_ID, answers: { 'QG10-LEN': { values: { VALUE: [1000.4] } }, 'QG10-CRK': { answer: 'Yes' } }, release: true }, k), 201, 'pass + release');
    assert.equal(sub.result.result, 'PASS');
    expect(await cmd(S.caraC, 'INSPECTION_SUBMIT', { inspectionId: ins.INSPECTION_ID, answers: {} }), 409, 'a submitted inspection cannot be submitted again');
    assert.equal(await stateOf(db, S.t1), 'QUEUED');
    const a = expect(await cmd(admin, 'OPERATION_START', { unitId: S.t1, workstationId: 'FIN-01', crew: [S.ana.workerId] }), 201, 'assign OP20');
    const tk = a.result.tasks[0];
    expect(await cmd(S.anaC, 'TASK_START', { taskId: tk }), 201, 'start OP20');
    expect(await cmd(S.anaC, 'TASK_FINISH', { taskId: tk }), 201, 'finish OP20 (single milestone = finish)');
    assert.equal(await stateOf(db, S.t1), 'CURING');
    // the unattended cure completes by its configured time only (engine rule), never by a person's task being completed by an agent
    await waitFor(async () => (await stateOf(db, S.t1)) === 'WORK_COMPLETED_AWAITING_INSPECTION', { timeoutMs: 240000, everyMs: 3000, what: 'cure completion by the engine (OP25, 1 min)' });
    const ins2 = expect(await cmd(S.caraC, 'INSPECTION_START', { unitId: S.t1 }), 201, 'final inspection').result.inspection;
    expect(await cmd(S.caraC, 'INSPECTION_SUBMIT', { inspectionId: ins2.INSPECTION_ID, answers: { 'QG20-PNT': { answer: 'Yes' } }, release: true }), 201, 'final pass');
    assert.equal(await stateOf(db, S.t1), 'ROUTE_COMPLETE');
    const ol = expect(await admin.get(`/api/sessions/${SID}/orders`), 200, 'orders').lines[0];
    assert.equal(ol.goodCompleted, 1); assert.equal(ol.complete, false, 'one good tank does not complete an order for two');
  });

  await t.test('17-19 tank 2 fails, rework is authorised, reworked as a new attempt, reinspected and released', async () => {
    const a = expect(await cmd(admin, 'OPERATION_START', { unitId: S.t2, workstationId: 'FAB-02', crew: [S.ana.workerId, S.ben.workerId] }), 201, 'assign T2');
    const op = a.result.operation.OPERATION_INSTANCE_ID;
    const [ta, tb] = a.result.tasks;
    expect(await cmd(S.anaC, 'TASK_START', { taskId: ta }), 201, 'Ana start T2');
    expect(await cmd(S.benC, 'TASK_START', { taskId: tb }), 201, 'Ben start T2');
    for (const m of ['MS-OP10-01', 'MS-OP10-02']) expect(await cmd(S.anaC, 'MILESTONE_COMPLETE', { operationInstanceId: op, milestoneId: m }), 201, m);
    expect(await cmd(S.benC, 'TASK_FINISH', { taskId: tb }), 201, 'finish');
    const ins = expect(await cmd(S.caraC, 'INSPECTION_START', { unitId: S.t2 }), 201, 'inspect T2').result.inspection;
    const f = expect(await cmd(S.caraC, 'INSPECTION_SUBMIT', { inspectionId: ins.INSPECTION_ID, answers: { 'QG10-LEN': { values: { VALUE: [1010] } }, 'QG10-CRK': { answer: 'Yes' } } }), 201, 'fail');
    assert.equal(f.result.result, 'FAIL');
    assert.equal(await stateOf(db, S.t2), 'QUALITY_HOLD');
    const hold = await db.collection('sim_holds').findOne({ SESSION_ID: SID, UNIT_ID: S.t2, RESOLUTION: 'OPEN' });
    expect(await cmd(S.anaC, 'DISPOSITION_DECIDE', { holdId: hold.HOLD_ID, decision: 'REWORK', reasonCode: 'X' }), 403, 'an operator cannot authorise rework');
    expect(await cmd(admin, 'DISPOSITION_DECIDE', { holdId: hold.HOLD_ID, decision: 'REWORK' }), 400, 'no matrix entry: the approver must give a reason');
    const d = expect(await cmd(admin, 'DISPOSITION_DECIDE', { holdId: hold.HOLD_ID, decision: 'REWORK', reasonCode: 'REPAIRABLE_DIMENSION', note: 'Trim and re-weld' }), 201, 'authorise rework');
    assert.equal(d.result.retainedAtStation, true, 'inspected at the station that did the work: no fictitious transport');
    assert.equal(await stateOf(db, S.t2), 'QUEUED_FOR_REWORK');
    const r = expect(await cmd(admin, 'OPERATION_START', { unitId: S.t2, workstationId: 'FAB-02', crew: [S.ben.workerId] }), 201, 'rework attempt');
    assert.equal(r.result.operation.ATTEMPT_NO, 2, 'rework is a new attempt on the same tank');
    assert.equal(r.result.operation.UNIT_ID, S.t2, 'same tank identity');
    const rt = r.result.tasks[0];
    expect(await cmd(S.benC, 'TASK_START', { taskId: rt }), 201, 'rework start');
    for (const m of ['MS-OP10-01', 'MS-OP10-02']) expect(await cmd(S.benC, 'MILESTONE_COMPLETE', { operationInstanceId: r.result.operation.OPERATION_INSTANCE_ID, milestoneId: m }), 201, `rework ${m}`);
    expect(await cmd(S.benC, 'TASK_FINISH', { taskId: rt }), 201, 'rework finish');
    assert.equal(await stateOf(db, S.t2), 'REWORK_COMPLETE_AWAITING_REINSPECTION');
    const ri = expect(await cmd(S.caraC, 'INSPECTION_START', { unitId: S.t2 }), 201, 'reinspection').result.inspection;
    assert.equal(ri.ATTEMPT_NO, 2);
    expect(await cmd(S.caraC, 'INSPECTION_SUBMIT', { inspectionId: ri.INSPECTION_ID, answers: { 'QG10-LEN': { values: { VALUE: [1000.1] } }, 'QG10-CRK': { answer: 'Yes' } }, release: true }), 201, 'reinspection pass + release');
    assert.equal(await stateOf(db, S.t2), 'QUEUED');
    const a2 = expect(await cmd(admin, 'OPERATION_START', { unitId: S.t2, workstationId: 'FIN-01', crew: [S.ana.workerId] }), 201, 'OP20 T2');
    expect(await cmd(S.anaC, 'TASK_START', { taskId: a2.result.tasks[0] }), 201, 'start');
    expect(await cmd(S.anaC, 'TASK_FINISH', { taskId: a2.result.tasks[0] }), 201, 'finish');
    await waitFor(async () => (await stateOf(db, S.t2)) === 'WORK_COMPLETED_AWAITING_INSPECTION', { timeoutMs: 240000, everyMs: 3000, what: 'cure T2' });
    const fi = expect(await cmd(S.caraC, 'INSPECTION_START', { unitId: S.t2 }), 201, 'final').result.inspection;
    expect(await cmd(S.caraC, 'INSPECTION_SUBMIT', { inspectionId: fi.INSPECTION_ID, answers: { 'QG20-PNT': { answer: 'Yes' } }, release: true }), 201, 'final pass');
    assert.equal(await stateOf(db, S.t2), 'ROUTE_COMPLETE');
  });

  await t.test('20 the order completes only with two accepted route-complete tanks', async () => {
    const ol = expect(await admin.get(`/api/sessions/${SID}/orders`), 200, 'orders').lines.find(l => l.orderId === S.order.orderId);
    assert.equal(ol.goodCompleted, 2); assert.equal(ol.scrapped, 0); assert.equal(ol.complete, true);
    const line = expect(await admin.get(`/api/sessions/${SID}/orders/${ol.orderLineId}`), 200, 'order line');
    assert.equal(line.goodTotal, 2);
    assert.equal(line.batches.length, 2);
    const pass = await unit(admin, S.t2);
    assert.ok(JSON.stringify(pass).includes('ATTEMPT') || pass, 'passport available');
  });

  await t.test('21 worker metrics and points agree with the stored events and ledger', async () => {
    // wait until the engine has processed every event (watermark) so projections and the ledger are current
    await waitFor(async () => { const s = await db.collection('sim_sessions').findOne({ SESSION_ID: SID }); return (s.ENGINE || {}).WATERMARK_SEQ >= s.EVENT_SEQ - 0 && (s.ENGINE || {}).WATERMARK_SEQ > 0; }, { timeoutMs: 180000, everyMs: 3000, what: 'engine watermark' });
    for (const n of ['ana', 'ben', 'cara']) {
      const p = expect(await S[n + 'C'].get(`/api/sessions/${SID}/me/progress`), 200, `${n} progress`);
      const ledger = await db.collection('sim_points_ledger').find({ SESSION_ID: SID, WORKER_ID: S[n].workerId }).toArray();
      const sum = Math.round(ledger.reduce((a, r) => a + Number(r.POINTS_DELTA || 0), 0) * 100) / 100;
      const shown = (p.points && (p.points.total || {}).TOTAL) ?? (p.pointsTotal ?? null);
      assert.equal(Number(shown), sum, `${n}: points shown ${shown} = ledger sum ${sum}`);
      const segs = await db.collection('sim_participation').find({ SESSION_ID: SID, WORKER_ID: S[n].workerId }).toArray();
      assert.ok(segs.length > 0, `${n} has participation segments`);
    }
    const fc = expect(await admin.get(`/api/sessions/${SID}/forecasts`), 200, 'forecasts');
    assert.ok(/STANDARD-BASED/.test(fc.orders.map(o => o.BASIS).join(' ')) || fc.orders.length === 0 || fc.orders.every(o => o.BAND === 'COMPLETE'), 'forecast labelled standard-based');
  });

  await t.test('22 refresh and restart services: state remains', async () => {
    const before = { units: await db.collection('sim_units').find({ SESSION_ID: SID }, { projection: { _id: 0, UNIT_ID: 1, STATE: 1 } }).sort({ UNIT_ID: 1 }).toArray(), events: await db.collection('sim_events').countDocuments({ SESSION_ID: SID }) };
    if (!process.env.FRESH_RESTART_CMD) { t.diagnostic('FRESH_RESTART_CMD not set - restart not exercised'); return; }
    execSync(process.env.FRESH_RESTART_CMD, { stdio: 'inherit' });
    await waitFor(async () => { try { return (await fetch(API + '/api/health')).ok; } catch (e) { return false; } }, { timeoutMs: 60000, what: 'API back' });
    const again = new Client('admin');
    await again.login(process.env.ADMIN_LOGIN || 'admin', process.env.ADMIN_PASSWORD);
    const after = { units: await db.collection('sim_units').find({ SESSION_ID: SID }, { projection: { _id: 0, UNIT_ID: 1, STATE: 1 } }).sort({ UNIT_ID: 1 }).toArray() };
    assert.deepEqual(after.units, before.units);
    assert.ok((await db.collection('sim_events').countDocuments({ SESSION_ID: SID })) >= before.events);
    const ol = expect(await again.get(`/api/sessions/${SID}/orders`), 200, 'orders after restart').lines.find(l => l.orderId === S.order.orderId);
    assert.equal(ol.goodCompleted, 2);
    // the old cookie session of an operator still works after an API restart (sessions are stored in MongoDB)
    expect(await S.anaC.get(`/api/sessions/${SID}/me/home`), 200, 'operator session survives the restart');
  });

  // ------------------------------------------------------------------------------------------- separate checks
  await t.test('X1 scrap and replacement without increasing demand; missing material blocks the start', async () => {
    const due = new Date(Date.now() + 2 * 86400000).toISOString();
    const o = expect(await cmd(admin, 'ORDER_CREATE', { customerOrderRef: 'PO-T-2', lines: [{ productId: 'TANK-A', requiredGoodQty: 1, dueAt: due }] }), 201, 'order 2').result;
    const rel = expect(await cmd(admin, 'BATCH_RELEASE', { batchId: o.lines[0].batches[0] }), 201, 'release').result;
    S.t3 = rel.tanks[0].unitId;
    // stock is now 0 (two kits consumed): the start is blocked by material - not a performance issue
    const a = expect(await cmd(admin, 'OPERATION_START', { unitId: S.t3, workstationId: 'FAB-01', crew: [S.ana.workerId, S.ben.workerId] }), 201, 'assign T3');
    const [ta, tb] = a.result.tasks;
    const blocked = await cmd(S.anaC, 'TASK_START', { taskId: ta });
    assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'MATERIAL_SHORTAGE');
    const rd = expect(await admin.get(`/api/factory/readiness?unitId=${S.t3}`), 200, 'readiness').tanks[0];
    assert.ok(rd.blockers.some(b => b.code === 'MATERIAL_SHORTAGE'));
    expect(await cmd(admin, 'MATERIAL_RECEIPT', { materialId: 'MAT-SHELL', qty: 1, lotId: 'LOT-002' }), 201, 'receive 1');
    expect(await cmd(S.anaC, 'TASK_START', { taskId: ta }), 201, 'start after receipt');
    expect(await cmd(S.benC, 'TASK_START', { taskId: tb }), 201, 'Ben start');
    for (const m of ['MS-OP10-01', 'MS-OP10-02']) expect(await cmd(S.anaC, 'MILESTONE_COMPLETE', { operationInstanceId: a.result.operation.OPERATION_INSTANCE_ID, milestoneId: m }), 201, m);
    expect(await cmd(S.anaC, 'TASK_FINISH', { taskId: ta }), 201, 'finish');
    const ins = expect(await cmd(S.caraC, 'INSPECTION_START', { unitId: S.t3 }), 201, 'inspect').result.inspection;
    expect(await cmd(S.caraC, 'INSPECTION_SUBMIT', { inspectionId: ins.INSPECTION_ID, answers: { 'QG10-LEN': { values: { VALUE: [990] } }, 'QG10-CRK': { answer: 'No' } } }), 201, 'fail');
    const hold = await db.collection('sim_holds').findOne({ SESSION_ID: SID, UNIT_ID: S.t3, RESOLUTION: 'OPEN' });
    expect(await cmd(admin, 'DISPOSITION_DECIDE', { holdId: hold.HOLD_ID, decision: 'SCRAP', reasonCode: 'NON_REPAIRABLE_SEVERITY' }), 201, 'scrap');
    assert.equal(await stateOf(db, S.t3), 'SCRAPPED');
    const rq = expect(await cmd(admin, 'REPLACEMENT_REQUEST', { scrappedUnitId: S.t3 }), 201, 'replacement request').result.replacement;
    const blockedR = expect(await cmd(admin, 'REPLACEMENT_APPROVE', { requestId: rq.REQUEST_ID }), 201, 'approve without material');
    assert.equal(blockedR.result.blocked, true, 'replacement blocked without material');
    expect(await cmd(admin, 'MATERIAL_RECEIPT', { materialId: 'MAT-SHELL', qty: 1, lotId: 'LOT-003' }), 201, 'receive');
    const rq2 = expect(await cmd(admin, 'REPLACEMENT_REQUEST', { scrappedUnitId: S.t3 }), 201, 'request again').result.replacement;
    const ok = expect(await cmd(admin, 'REPLACEMENT_APPROVE', { requestId: rq2.REQUEST_ID }), 201, 'approve');
    const nu = ok.result.newUnit;
    assert.notEqual(nu.UNIT_ID, S.t3); assert.equal(nu.REPLACEMENT_FOR_UNIT_ID, S.t3); assert.match(nu.TANK_SERIAL_NO, /^TT-/);
    const line = await db.collection('order_lines').findOne({ SESSION_ID: SID, ORDER_ID: o.orderId });
    assert.equal(line.REQUIRED_GOOD_QTY, 1, 'demand unchanged by the replacement');
    const scrapped = await db.collection('sim_units').findOne({ SESSION_ID: SID, UNIT_ID: S.t3 });
    assert.equal(scrapped.STATE, 'SCRAPPED', 'original scrap record retained');
    const ol = expect(await admin.get(`/api/sessions/${SID}/orders`), 200, 'orders').lines.find(l => l.orderId === o.orderId);
    assert.equal(ol.requiredGoodQty, 1); assert.equal(ol.scrapped, 1); assert.equal(ol.goodCompleted, 0);
    S.t4 = nu.UNIT_ID;
  });

  await t.test('X2 manual mode with browsers closed: no agent completes a person\'s task; agent commands for people are refused', async () => {
    const a = expect(await cmd(admin, 'OPERATION_START', { unitId: S.t4, workstationId: 'FAB-01', crew: [S.ana.workerId, S.ben.workerId] }), 201, 'assign T4');
    const [ta, tb] = a.result.tasks;
    expect(await cmd(S.anaC, 'TASK_START', { taskId: ta }), 201, 'start'); expect(await cmd(S.benC, 'TASK_START', { taskId: tb }), 201, 'start');
    // "close the browsers": no further requests from Ana/Ben. The engine keeps running; nothing finishes their work.
    const s0 = await db.collection('sim_sessions').findOne({ SESSION_ID: SID });
    await waitFor(async () => { const s = await db.collection('sim_sessions').findOne({ SESSION_ID: SID }); return s.ENGINE.SIM_AT > new Date(s0.ENGINE.SIM_AT.getTime() + 90000); }, { timeoutMs: 240000, everyMs: 5000, what: 'engine advanced 90 s of real time' });
    const t1 = await db.collection('sim_tasks').findOne({ SESSION_ID: SID, TASK_ID: ta });
    assert.equal(t1.STATUS, 'WORKING', 'still working - not completed by an agent');
    const agentEvents = await db.collection('sim_events').countDocuments({ SESSION_ID: SID, ACTOR_TYPE: 'AGENT' });
    assert.equal(agentEvents, 0, 'no AGENT-actor events in Manual Team Test');
    const sys = await db.collection('sim_events').distinct('COMMAND_TYPE', { SESSION_ID: SID, ACTOR_TYPE: 'SYSTEM' });
    assert.ok(sys.every(x => ['PROCESS_COMPLETE', 'UNIT_ARRIVE', 'RETURN_ARRIVE'].includes(x)), `system actions limited to timed steps: ${sys}`);
    // a forged agent command (internal endpoint, service token) to finish Ana's task is refused
    const r = await fetch(API + '/api/internal/commands', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}` },
      body: JSON.stringify({ sessionId: SID, commands: [{ type: 'TASK_FINISH', payload: { taskId: ta }, actorWorkerId: S.ana.workerId, idempotencyKey: key() }, { type: 'BATCH_RELEASE', payload: { batchId: 'x' }, system: true, idempotencyKey: key() }] }) });
    const out = await r.json();
    assert.equal(out.results[0].ok, false); assert.equal(out.results[0].status, 403);
    assert.equal(out.results[1].ok, false); assert.equal(out.results[1].status, 403);
    // clean up: finish T4 normally (by the people)
    for (const m of ['MS-OP10-01', 'MS-OP10-02']) expect(await cmd(S.anaC, 'MILESTONE_COMPLETE', { operationInstanceId: a.result.operation.OPERATION_INSTANCE_ID, milestoneId: m }), 201, m);
    expect(await cmd(S.anaC, 'TASK_FINISH', { taskId: ta }), 201, 'finish');
  });

  await t.test('X3 no historical baseline: baseline rules INSUFFICIENT_DATA, empty data is not abnormal', async () => {
    const al = expect(await admin.get(`/api/sessions/${SID}/alerts`), 200, 'alerts');
    const rules = (al.ruleEvaluation || {}).rules || [];
    assert.ok(rules.length > 0, 'rules evaluated');
    const m04 = rules.filter(r => r.rule_id === 'M04');
    assert.ok(m04.length && m04.every(r => ['INSUFFICIENT_DATA', 'BREACH'].includes(r.status)) && m04.some(r => r.status === 'INSUFFICIENT_DATA'), 'M04 backlog baseline: insufficient data');
    const m08 = rules.find(r => r.rule_id === 'M08');
    if (m08) assert.equal(m08.status, 'INSUFFICIENT_DATA');
    const f2 = rules.find(r => r.rule_id === 'F2');
    if (f2) assert.notEqual(f2.status, 'BREACH');
    const wcs = [...new Set(rules.filter(r => r.entity_type === 'WORK_CENTER').map(r => r.entity_id))].sort();
    assert.deepEqual(wcs, ['FAB', 'FIN'], 'rules evaluate the configured work centres (no WC1-WC4)');
    const ov = expect(await admin.get(`/api/sessions/${SID}/overview`), 200, 'overview');
    assert.deepEqual(ov.workCenters.map(w => w.workCenterId).sort(), ['FAB', 'FIN']);
  });

  await t.test('X4 cutoff crossing without new events (engine boundary evaluation)', async () => {
    const due = new Date(Date.now() + 70000);
    const o = expect(await cmd(admin, 'ORDER_CREATE', { customerOrderRef: 'PO-T-CUTOFF', lines: [{ productId: 'TANK-A', requiredGoodQty: 1, dueAt: due.toISOString() }] }), 201, 'order due in ~70 s').result;
    const lid = o.lines[0].orderLineId;
    const seq0 = (await db.collection('sim_sessions').findOne({ SESSION_ID: SID })).EVENT_SEQ;
    const row = await waitFor(async () => {
      const s = await db.collection('sim_sessions').findOne({ SESSION_ID: SID });
      if (s.EVENT_SEQ !== seq0) return null;
      const p = await db.collection('sim_projections').find({ SESSION_ID: SID, KIND: 'ORDER_FORECAST_SUMMARY', PROJECTION_VERSION: { $lte: s.PROJECTION_VERSION }, AS_OF: { $gt: due } }).sort({ PROJECTION_VERSION: -1 }).limit(1).toArray();
      const l = p[0] && p[0].DATA.find(x => x.ORDER_LINE_ID === lid);
      return l && l.CUTOFF_ELAPSED ? { l, trigger: p[0].TRIGGER } : null;
    }, { timeoutMs: 300000, everyMs: 4000, what: 'cutoff elapsed evaluated without a new event' });
    assert.equal(row.l.BAND, 'RED');
    assert.ok(/BOUNDARY|PERIODIC/.test(row.trigger), row.trigger);
  });

  await t.test('X5 new worker login with zero history; future start; deactivation keeps history', async () => {
    const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const e = expect(await admin.post('/api/admin/workers', { firstName: 'Eve', lastName: 'New', workerRole: 'PRODUCTION_OPERATOR', homeWorkCenterId: 'FIN', shiftCode: 'D', initialPin: PINS.eve, loginId: 'eve.new', startOption: 'FUTURE_START', startDate: tomorrow, qualifications: [{ skillId: 'SK-PAINT', validFrom: tomorrow }] }, key()), 201, 'Eve');
    assert.ok(new Date(e.firstShift.plannedStartAt) > new Date(), 'first shift in the future');
    const c = new Client('operator');
    await c.login('eve.new', PINS.eve);
    const h = expect(await c.get(`/api/sessions/${SID}/me/home`), 200, 'home');
    assert.equal(h.points.total.TOTAL, 0); assert.equal(h.currentTask, null); assert.notEqual(h.worker.attendance, 'CLOCKED_IN');
    const p = expect(await c.get(`/api/sessions/${SID}/me/progress`), 200, 'progress');
    assert.ok(p);
    expect(await admin.post(`/api/admin/workers/${S.dan.workerId}/deactivate`, {}, key()), 200, 'deactivate Dan');
    expect(await S.danC.get(`/api/sessions/${SID}/me/home`), 401, 'deactivated sign-in ends');
    assert.equal(await db.collection('worker_master').countDocuments({ WORKER_ID: S.dan.workerId }), 1, 'record kept');
  });

  await t.test('X6 duplicate start/submit requests have one effect', async () => {
    const due = new Date(Date.now() + 2 * 86400000).toISOString();
    const o = expect(await cmd(admin, 'ORDER_CREATE', { customerOrderRef: 'PO-T-DUP', lines: [{ productId: 'TANK-A', requiredGoodQty: 1, dueAt: due }] }), 201, 'order').result;
    expect(await cmd(admin, 'MATERIAL_RECEIPT', { materialId: 'MAT-SHELL', qty: 1, lotId: 'LOT-004' }), 201, 'stock');
    const u = expect(await cmd(admin, 'BATCH_RELEASE', { batchId: o.lines[0].batches[0] }), 201, 'release').result.tanks[0].unitId;
    // T4 still occupies FAB-01 awaiting inspection; use FAB-02
    const a = expect(await cmd(admin, 'OPERATION_START', { unitId: u, workstationId: 'FAB-02', crew: [S.ana.workerId, S.ben.workerId] }), 201, 'assign');
    const [ta] = a.result.tasks;
    const k = key();
    const [r1, r2] = await Promise.all([cmd(S.anaC, 'TASK_START', { taskId: ta }, k), cmd(S.anaC, 'TASK_START', { taskId: ta }, k)]);
    assert.ok([r1.status, r2.status].every(s => [200, 201].includes(s)), `${r1.status} ${r2.status}`);
    const starts = await db.collection('sim_events').countDocuments({ SESSION_ID: SID, EVENT_TYPE: 'TASK_WORKING', ENTITY_ID: ta });
    assert.equal(starts, 1, 'one start event');
    const consumed = await db.collection('sim_events').countDocuments({ SESSION_ID: SID, EVENT_TYPE: 'MATERIAL_CONSUMED', 'PAYLOAD.UNIT_ID': u });
    assert.equal(consumed, 1, 'material consumed once');
  });

  await t.test('X7 reset protection: disabled by default, refused without the flag', async () => {
    const pv = expect(await admin.get('/api/factory/reset'), 200, 'preview');
    if (pv.enabled) { t.diagnostic('ALLOW_FACTORY_RESET is enabled in this run - protection checked in reset.test.js'); return; }
    assert.equal(pv.enabled, false);
    assert.equal(pv.target.database, process.env.MONGODB_DB_NAME);
    expect(await admin.post('/api/factory/reset', { confirmText: pv.confirmText, factoryName: 'Team Test Plant', acknowledge: true }, key()), 403, 'reset refused while disabled');
    expect(await S.anaC.get('/api/factory/reset'), 403, 'operators cannot even preview');
    assert.ok((await db.collection('sim_units').countDocuments({ SESSION_ID: SID })) > 0, 'nothing was deleted');
  });
});
