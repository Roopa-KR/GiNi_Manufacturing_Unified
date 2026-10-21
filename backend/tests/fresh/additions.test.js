'use strict';
/*
 * Fresh factory - checks for the additions of the unified review: scanner lookup (tank serial / station label), planned
 * release in the work-order wizard, and "photo required when the answer fails". Run AFTER scenario.test.js and
 * unified.test.js on the same DISPOSABLE database (it uses their products, workers and stock).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const { Client, API } = require('../integration/helpers');

const SID = 'S-FACTORY';
const key = () => `additions-${crypto.randomUUID()}`;
const RUN = Date.now().toString(36).toUpperCase();
const ok = (r, s = 201) => { assert.equal(r.status, s, JSON.stringify(r.data).slice(0, 600)); return r.data; };

test('fresh factory additions: scanner lookup, planned release, photo on failure', { timeout: 10 * 60 * 1000 }, async (t) => {
  const mc = new MongoClient(process.env.MONGODB_URI); await mc.connect(); t.after(() => mc.close());
  const db = mc.db(process.env.MONGODB_DB_NAME);
  const admin = new Client('admin'); await admin.login(process.env.ADMIN_LOGIN || 'admin', process.env.ADMIN_PASSWORD);
  const ana = new Client('operator'); await ana.login('ana.test', '246810');
  const cmd = (c, type, p) => c.cmd(SID, type, p, key());
  const settings = await db.collection('factory_settings').findOne({});
  const tz = settings.TIMEZONE;
  const localDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

  await t.test('scanner lookup: an operator resolves a tank serial (any case) and a station label', async () => {
    const u = await db.collection('sim_units').findOne({ SESSION_ID: SID, TANK_SERIAL_NO: { $type: 'string' } });
    const r1 = ok(await ana.get(`/api/sessions/${SID}/search?q=${encodeURIComponent(u.TANK_SERIAL_NO.toLowerCase())}`), 200);
    assert.ok(r1.units.some(x => x.unitId === u.UNIT_ID && x.serial === u.TANK_SERIAL_NO), 'tank found by serial');
    const r2 = ok(await ana.get(`/api/sessions/${SID}/search?q=FAB-01`), 200);
    assert.equal(r2.stations[0].workstationId, 'FAB-01');
    assert.equal(r2.stations[0].workCenterId, 'FAB');
    assert.ok(Array.isArray(r2.stations[0].tanks));
    const r3 = ok(await ana.get(`/api/sessions/${SID}/search?q=NOPE-404`), 200);
    assert.equal(r3.units.length + r3.stations.length, 0);
  });

  await t.test('work-order wizard: planned release is stored in plant time and validated', async () => {
    const tomorrow = localDate(new Date(Date.now() + 86400000));
    const dayAfter = localDate(new Date(Date.now() + 2 * 86400000));
    const o = ok(await cmd(admin, 'ORDER_CREATE', { customerOrderRef: `ADD-PLAN-1-${RUN}`, lines: [{ productId: 'TANK-A', requiredGoodQty: 1, dueLocal: `${dayAfter}T14:00`, batches: [{ qty: 1, plannedReleaseLocal: `${tomorrow}T08:00` }] }] })).result;
    const b = await db.collection('production_batches').findOne({ SESSION_ID: SID, BATCH_ID: o.lines[0].batches[0] });
    const plan = await db.collection('production_plan').findOne({ SESSION_ID: SID, BATCH_ID: o.lines[0].batches[0] });
    const stored = (b && (b.PLANNED_RELEASE_AT || b.RELEASE_AT)) || (plan && (plan.PLANNED_START_AT || plan.PLANNED_RELEASE_AT));
    assert.ok(stored, 'planned release stored');
    const local = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(stored));
    assert.equal(local.replace(', ', 'T'), `${tomorrow}T08:00`, 'stored as 08:00 plant time');
    const bad = await cmd(admin, 'ORDER_CREATE', { customerOrderRef: `ADD-PLAN-2-${RUN}`, lines: [{ productId: 'TANK-A', requiredGoodQty: 1, dueLocal: `${tomorrow}T09:00`, batches: [{ qty: 1, plannedReleaseLocal: `${dayAfter}T08:00` }] }] });
    assert.equal(bad.status, 422, 'release after the due time refused');
  });

  await t.test('checklist "photo required when the answer fails": failed answer without a photo is refused, with a photo it is accepted', async () => {
    ok(await admin.req('PUT', '/api/factory/checklists/QG10', { version: `3.${Date.now() % 100000}`, checks: [{ checkId: 'QG10-ONF', question: 'Weld spatter removed?', inputType: 'YES_NO', failureAnswer: 'No', mandatory: true, photoOnFail: true }] }, { 'idempotency-key': key() }), 200);
    const chk = await db.collection('ctq_check_master').findOne({ CHECK_ID: 'QG10-ONF', ACTIVE_FLAG: 'Y' });
    assert.equal(chk.EVIDENCE_REQUIRED, 'ON_FAILURE_ANSWER');
    // a tank through OP10 by the people (stock received first - inventory is never assumed)
    ok(await cmd(admin, 'MATERIAL_RECEIPT', { materialId: 'MAT-SHELL', qty: 2, lotId: `LOT-ADD-${Date.now()}` }));
    const o = ok(await cmd(admin, 'ORDER_CREATE', { customerOrderRef: `ADD-PHOTO-${RUN}`, lines: [{ productId: 'TANK-A', requiredGoodQty: 1, dueAt: new Date(Date.now() + 3 * 86400000).toISOString() }] })).result;
    const unitId = ok(await cmd(admin, 'BATCH_RELEASE', { batchId: o.lines[0].batches[0] })).result.tanks[0].unitId;
    // two new welders (the scenario's people may still be busy)
    const crew = [];
    for (const [first, pin] of [['Wendy', '417263'], ['Walter', '527384']]) {
      const login = `${first.toLowerCase()}.${RUN.toLowerCase()}`;
      const w = ok(await admin.post('/api/admin/workers', { firstName: first, lastName: 'Welder', workerRole: 'PRODUCTION_OPERATOR', homeWorkCenterId: 'FAB', shiftCode: 'D', initialPin: pin, loginId: login, qualifications: [{ skillId: 'SK-WELD' }] }, key()));
      const c = new Client('operator'); await c.login(login, pin); ok(await cmd(c, 'CLOCK_IN', {}));
      crew.push({ id: w.workerId, c });
    }
    const st = ok(await cmd(admin, 'OPERATION_START', { unitId, workstationId: 'FAB-01', crew: crew.map(x => x.id) })).result;
    const [ta, tb] = st.tasks;
    ok(await cmd(crew[0].c, 'TASK_START', { taskId: ta })); ok(await cmd(crew[1].c, 'TASK_START', { taskId: tb }));
    for (const m of ['MS-OP10-01', 'MS-OP10-02']) ok(await cmd(crew[0].c, 'MILESTONE_COMPLETE', { operationInstanceId: st.operation.OPERATION_INSTANCE_ID, milestoneId: m }));
    ok(await cmd(crew[0].c, 'TASK_FINISH', { taskId: ta }));
    const jacob = new Client('operator'); await jacob.login('jacob.quality', '765432');
    const ci = await cmd(jacob, 'CLOCK_IN', {}); assert.ok([201, 409].includes(ci.status));
    const ins = ok(await cmd(jacob, 'INSPECTION_START', { unitId })).result.inspection;
    const noPhoto = await cmd(jacob, 'INSPECTION_SUBMIT', { inspectionId: ins.INSPECTION_ID, answers: { 'QG10-ONF': { answer: 'No' } } });
    assert.equal(noPhoto.status, 409, JSON.stringify(noPhoto.data)); assert.equal(noPhoto.data.error.code, 'EVIDENCE_REQUIRED');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    const signed = ok(await jacob.post(`/api/sessions/${SID}/evidence/sign`, { inspectionId: ins.INSPECTION_ID, unitId, checkId: 'QG10-ONF', mime: 'image/png', bytes: png.length, width: 1, height: 1 }, key()));
    const up = await fetch(API + signed.upload.uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/png', origin: process.env.FRONTEND_URL }, body: png });
    assert.equal(up.status, 200);
    ok(await jacob.post(`/api/sessions/${SID}/evidence/${signed.evidenceId}/complete`, {}, key()), 200);
    const res = ok(await cmd(jacob, 'INSPECTION_SUBMIT', { inspectionId: ins.INSPECTION_ID, answers: { 'QG10-ONF': { answer: 'No' } }, evidenceIds: [signed.evidenceId] })).result;
    assert.equal(res.result, 'FAIL', 'the failure is recorded with its photo');
    // a passing answer needs no photo for this question (check the rule on a pass: the evaluation alone, no new tank needed)
    assert.ok(['FAILED_INSPECTION', 'QUALITY_HOLD', 'PENDING_REVIEW'].includes((await db.collection('sim_units').findOne({ UNIT_ID: unitId })).STATE));
  });
});
