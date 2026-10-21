'use strict';
/* Acceptance checks against the REAL API + shared database (+ the Python worker for initialisation and recalculation).
   Covers: login/reload never restarts work (AT2), shared simulation across browser sessions and read-only replay (AT3),
   concurrent conflicting commands and inspection submissions (AT20), clock play/speed/pause continuity with no lost or
   overlapping events and no double-booked labour (AT19/AT23), KNOWN_AT visibility in replay (AT17), material shortage
   changing the forecast with the right cause (AT13), plant attendance reconciliation and an attendance correction (AT22),
   points ledger idempotency under repeated recalculation (AT9). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client, demoPin, waitFor, adminClient, freshSession } = require('./helpers');

let mongo = null;
async function db() {
  if (!mongo) { const { MongoClient } = require('mongodb'); mongo = new MongoClient(process.env.MONGODB_URI); await mongo.connect(); }
  return mongo.db(process.env.MONGODB_DB_NAME);
}
test.after(async () => { if (mongo) await mongo.close(); });

async function recalcAndWait(admin, sid) {
  // waits for a pass that has seen every event so far (published watermark >= current event sequence), not just any newer pass
  const s0 = (await admin.get(`/api/sessions/${sid}`)).data.session;
  await admin.post(`/api/sessions/${sid}/recalculate`, {});
  await waitFor(async () => { const s = (await admin.get(`/api/sessions/${sid}`)).data.session; return s.engine.projectionVersion > s0.engine.projectionVersion && s.engine.watermarkSeq >= s0.eventSeq; }, { timeoutMs: 90000, what: 'recalculation published' });
}

async function workingOperator(admin, sid, skip = []) {
  const wf = await admin.get(`/api/sessions/${sid}/workforce?state=WORKING&role=PRODUCTION_OPERATOR&pageSize=200`);
  for (const w of wf.data.workers) {
    if (skip.includes(w.workerId)) continue;
    const c = new Client('operator');
    await c.login(w.workerId, demoPin(w.workerId));
    const h = await c.get(`/api/sessions/${sid}/me/home`);
    if (h.status === 200 && h.data.currentTask && h.data.currentTask.task.status === 'WORKING' && h.data.currentTask.operation.kind === 'LABOR') return { c, home: h.data, workerId: w.workerId };
  }
  return null;
}

/** the workforce view pages at most 200 people per request: read every page */
async function allWorkers(admin, sid) {
  const first = (await admin.get(`/api/sessions/${sid}/workforce?pageSize=200&page=1`)).data;
  const out = { ...first, workers: [...first.workers] };
  for (let p = 2; out.workers.length < first.total; p++) out.workers.push(...(await admin.get(`/api/sessions/${sid}/workforce?pageSize=200&page=${p}`)).data.workers);
  return out;
}

let shared = null;   // one paused session reused by the read-mostly checks
async function sharedSession(admin) { if (!shared) shared = await freshSession(admin, 'acceptance'); return shared; }

test('AT2: signing in again and reloading never restarts work, attendance or time; GET requests never mutate', { timeout: 240000 }, async () => {
  const admin = await adminClient();
  const sid = await sharedSession(admin);
  const S = `/api/sessions/${sid}`;
  const found = await workingOperator(admin, sid);
  assert.ok(found, 'a working operator exists at the checkpoint');
  const seq0 = (await admin.get(`/api/sessions/${sid}`)).data.session.eventSeq;
  const h1 = found.home;
  assert.ok(h1.currentTask.task.startedAt, 'the inherited task shows its start time from history');
  assert.ok(new Date(h1.currentTask.task.startedAt) <= new Date(h1.session.simNow));
  assert.ok(h1.currentTask.time.eligibleFromHistoryMin > 0, 'prior progress from history is shown');
  // a second browser / device signs in as the same worker, and the first reloads
  const second = new Client('operator');
  await second.login(found.workerId, demoPin(found.workerId));
  const h2 = (await second.get(`${S}/me/home`)).data;
  const h3 = (await found.c.get(`${S}/me/home`)).data;
  for (const h of [h2, h3]) {
    assert.equal(h.currentTask.task.taskId, h1.currentTask.task.taskId);
    assert.equal(h.currentTask.task.startedAt, h1.currentTask.task.startedAt);
    assert.equal(h.currentTask.task.status, 'WORKING');
    assert.equal(h.shift.firstClockInAt, h1.shift.firstClockInAt, 'login is not attendance');
    assert.equal(h.currentTask.time.eligibleElapsedMin, h1.currentTask.time.eligibleElapsedMin, 'paused clock: no time passes on reload');
  }
  for (const p of ['/me/queue', '/me/progress', '/overview', '/workforce', '/orders', '/quality', '/alerts', '/forecasts', '/materials']) {
    const r = p.startsWith('/me') ? await found.c.get(S + p) : await admin.get(S + p);
    assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  assert.equal((await admin.get(`/api/sessions/${sid}`)).data.session.eventSeq, seq0, 'logins and reads created no simulation events');
});

test('AT3: two browser sessions share one simulation; replay sessions are read-only', { timeout: 240000 }, async () => {
  const admin = await adminClient();
  const sid = await sharedSession(admin);
  const S = `/api/sessions/${sid}`;
  const a = await workingOperator(admin, sid);
  assert.ok(a);
  const p = await a.c.cmd(sid, 'TASK_PAUSE', { taskId: a.home.currentTask.task.taskId, reason: 'WAITING_FOR_INSTRUCTION' });
  assert.equal(p.status, 201, JSON.stringify(p.data));
  // the supervisor's browser and a colleague's browser see the same change immediately (observed state, no engine needed)
  const wf = await allWorkers(admin, sid);
  const me = wf.workers.find(w => w.workerId === a.workerId);
  assert.notEqual(me.activity, 'WORKING');
  const b = await workingOperator(admin, sid, [a.workerId]);
  const wc = await b.c.get(`${S}/work-centers/${a.home.currentTask.operation.workCenterId || me.workCenterId}`);
  assert.equal(wc.status, 200);
  assert.ok(JSON.stringify(wc.data).includes(a.workerId), 'the colleague view lists the paused worker');
  const r = await a.c.cmd(sid, 'TASK_RESUME', { taskId: a.home.currentTask.task.taskId });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  // replay is read-only
  const rp = await admin.post('/api/sessions', { mode: 'REPLAY', checkpointId: 'CK-20261015-1055', name: 'acceptance replay' });
  assert.equal(rp.status, 201, JSON.stringify(rp.data));
  const rsid = rp.data.session.sessionId;
  try {
    await waitFor(async () => ((await admin.get(`/api/sessions/${rsid}`)).data.session || {}).status === 'READY', { timeoutMs: 120000, what: 'replay ready' });
    const w = await admin.cmd(rsid, 'EQUIPMENT_BREAKDOWN', { equipmentId: 'FX-01', estimatedRecoveryMin: 30, reasonCode: 'RANDOM_FAILURE' });
    assert.equal(w.status, 409);
    assert.equal(w.data.error.code, 'READ_ONLY_REPLAY');
  } finally { await admin.post(`/api/sessions/${rsid}/archive`, {}); }
});

test('AT20: concurrent conflicting commands - exactly one wins; duplicate retries replay one result', { timeout: 300000 }, async () => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'concurrency');
  const S = `/api/sessions/${sid}`;
  const op = await workingOperator(admin, sid);
  assert.ok(op);
  const ct = op.home.currentTask;
  for (const m of ct.milestones.milestones.filter(x => !x.done && x.attended && !x.final)) await op.c.cmd(sid, 'MILESTONE_COMPLETE', { operationInstanceId: ct.operation.operationInstanceId, milestoneId: m.milestoneId });
  // same Idempotency-Key sent twice concurrently: one execution, identical responses
  const key = `dup-${Date.now()}`;
  const seq0 = (await admin.get(`/api/sessions/${sid}`)).data.session.eventSeq;
  const [d1, d2] = await Promise.all([op.c.cmd(sid, 'TASK_FINISH', { taskId: ct.task.taskId }, key), op.c.cmd(sid, 'TASK_FINISH', { taskId: ct.task.taskId }, key)]);
  const okOnes = [d1, d2].filter(r => r.status === 201);
  assert.ok(okOnes.length >= 1, JSON.stringify([d1.data, d2.data]));
  for (const r of [d1, d2]) if (r.status === 201) assert.equal(r.data.correlationId, okOnes[0].data.correlationId, 'a retry returns the original result');
  const seq1 = (await admin.get(`/api/sessions/${sid}`)).data.session.eventSeq;
  const finishEvents = (await admin.get(`${S}/events?limit=50`)).data.events.filter(e => e.seq > seq0 && e.type === 'TASK_COMPLETED' && e.entityId === ct.task.taskId);
  assert.equal(finishEvents.length, 1, 'one finish event despite two requests');
  assert.ok(seq1 > seq0);
  // a different key for the same, now-finished task is a conflict, not a second finish
  const again = await op.c.cmd(sid, 'TASK_FINISH', { taskId: ct.task.taskId });
  assert.equal(again.status, 409);

  // conflicting inspection submissions: two inspectors' devices submit the same inspection at once
  const unitId = ct.unit.unitId;
  const insp = await admin.get(`${S}/workforce?role=QUALITY_INSPECTOR&pageSize=200`);
  const crewIds = ct.crew.map(c => c.workerId);
  let inspector = null, started = null;
  for (const w of insp.data.workers.filter(w => w.attendance === 'CLOCKED_IN' && !['INSPECTING', 'BREAK', 'TRANSFER'].includes(w.activity) && !crewIds.includes(w.workerId))) {
    const c = new Client('operator');
    await c.login(w.workerId, demoPin(w.workerId));
    const r = await c.cmd(sid, 'INSPECTION_START', { unitId, inspectorId: w.workerId });
    if (r.status === 201) { inspector = c; started = r.data.result.inspection; break; }
  }
  assert.ok(inspector, 'an inspector could start the gate inspection');
  const view = await inspector.get(`${S}/inspections/${started.INSPECTION_ID}`);
  const answers = {};
  for (const c of view.data.checklist) {
    if (c.answerType === 'YES_NO') { answers[c.checkId] = { answer: c.failureAnswer === 'No' ? 'Yes' : 'No' }; continue; }
    const values = {};
    for (const s of c.specs) { const nom = s.nominal ?? (s.lower !== null && s.upper !== null ? (s.lower + s.upper) / 2 : 0); values[s.position] = Array.from({ length: s.readings || 1 }, () => nom); }
    answers[c.checkId] = { values };
  }
  const device2 = new Client('operator');
  await device2.login(inspector.user.workerId, demoPin(inspector.user.workerId));
  const body = { inspectionId: started.INSPECTION_ID, answers, expectedVersion: view.data.inspection.version };
  const [s1, s2] = await Promise.all([inspector.cmd(sid, 'INSPECTION_SUBMIT', body), device2.cmd(sid, 'INSPECTION_SUBMIT', body)]);
  const statuses = [s1.status, s2.status].sort();
  assert.deepEqual(statuses, [201, 409], `exactly one submission wins: ${JSON.stringify([s1.data, s2.data]).slice(0, 400)}`);
  const pp = await admin.get(`${S}/units/${unitId}`);
  assert.equal(pp.data.inspections.filter(i => i.inspectionId === started.INSPECTION_ID).length, 1);
});

test('AT19/AT23: play, speed change and pause keep one continuous timeline - no lost, duplicated or overlapping events or labour', { timeout: 300000 }, async () => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'clock continuity');
  const S = `/api/sessions/${sid}`;
  const t0 = new Date((await admin.get(S)).data.session.simNow);
  await admin.post(`${S}/clock`, { action: 'SPEED', speed: 60 });
  await admin.post(`${S}/clock`, { action: 'PLAY' });
  await new Promise(r => setTimeout(r, 8000));
  const mid = new Date((await admin.get(S)).data.session.simNow);
  await admin.post(`${S}/clock`, { action: 'SPEED', speed: 120 });
  const afterSpeed = new Date((await admin.get(S)).data.session.simNow);
  assert.ok(afterSpeed >= mid, 'a speed change never moves time backwards');
  await new Promise(r => setTimeout(r, 8000));
  await admin.post(`${S}/clock`, { action: 'PAUSE' });
  const p1 = new Date((await admin.get(S)).data.session.simNow);
  await new Promise(r => setTimeout(r, 3000));
  const p2 = new Date((await admin.get(S)).data.session.simNow);
  assert.equal(p2.getTime(), p1.getTime(), 'paused time does not move');
  assert.ok(p1 - t0 >= 10 * 60000, `the clock advanced (${(p1 - t0) / 60000} simulated minutes)`);
  // let the engine catch up to the paused clock, then check the event log and labour
  await waitFor(async () => { const s = (await admin.get(S)).data.session; return s.engine.simAt && new Date(s.engine.simAt) >= new Date(p1.getTime() - 60000) && s.engine.lagSeq === 0; }, { timeoutMs: 120000, what: 'engine caught up' });
  const d = await db();
  const ev = await d.collection('sim_events').find({ SESSION_ID: sid }, { projection: { EVENT_SEQ: 1, EVENT_ID: 1, EVENT_TIME: 1 } }).toArray();
  const seqs = ev.map(e => e.EVENT_SEQ).sort((a, b) => a - b);
  assert.ok(seqs.length > 0, 'background agents produced events');
  assert.equal(new Set(seqs).size, seqs.length, 'no duplicated sequence numbers');
  assert.equal(seqs[seqs.length - 1] - seqs[0] + 1, seqs.length, 'no gaps in the event sequence');
  assert.equal(new Set(ev.map(e => e.EVENT_ID)).size, ev.length, 'no duplicated event IDs');
  assert.ok(ev.every(e => new Date(e.EVENT_TIME) <= p1), 'no event in the simulated future');
  // no double-booked labour: a worker has at most one WORKING task, a workstation at most one active labour attempt
  const working = await d.collection('sim_tasks').find({ SESSION_ID: sid, STATUS: 'WORKING' }, { projection: { WORKER_ID: 1 } }).toArray();
  const byW = {};
  for (const t of working) byW[t.WORKER_ID] = (byW[t.WORKER_ID] || 0) + 1;
  assert.deepEqual(Object.entries(byW).filter(([, n]) => n > 1), [], 'no worker is working two tasks at once');
  const ops = await d.collection('sim_operations').find({ SESSION_ID: sid, OPERATION_KIND: 'LABOR', STATE: { $in: ['WORKING', 'PAUSED'] } }, { projection: { WORKSTATION_ID: 1 } }).toArray();
  const byS = {};
  for (const o of ops) if (o.WORKSTATION_ID) byS[o.WORKSTATION_ID] = (byS[o.WORKSTATION_ID] || 0) + 1;
  assert.deepEqual(Object.entries(byS).filter(([, n]) => n > 1), [], 'no workstation hosts two active labour attempts');
  // stable identities and unique active batch membership
  const units = await d.collection('sim_units').find({ SESSION_ID: sid }, { projection: { UNIT_ID: 1, BATCH_ID: 1, STATE: 1 } }).toArray();
  assert.equal(new Set(units.map(u => u.UNIT_ID)).size, units.length, 'each tank appears once in the session');
  assert.ok(units.filter(u => !['ROUTE_COMPLETE', 'SCRAPPED'].includes(u.STATE)).every(u => u.BATCH_ID), 'every active tank belongs to exactly one batch');
});

test('AT17: replay hides records not yet KNOWN_AT and shows them once known, without rewriting history', { timeout: 300000 }, async () => {
  const admin = await adminClient();
  const d = await db();
  const ds = process.env.DATASET_ID || 'GINI_SYNTH_V3';
  const fork = new Date('2026-10-15T15:55:00Z');
  // late evidence: an inspection completed after the checkpoint but entered (KNOWN_AT) more than 5 minutes later
  const cands = await d.collection('inspection_header').find({ RUN_ID: 'RUN-BASE', COMPLETED_AT: { $gt: fork, $lte: new Date(fork.getTime() + 48 * 3600000) } }).toArray();
  const ins = cands.filter(i => i.KNOWN_AT && new Date(i.KNOWN_AT) - new Date(i.COMPLETED_AT) > 5 * 60000).sort((x, y) => new Date(x.KNOWN_AT) - new Date(y.KNOWN_AT))[0];
  assert.ok(ins, 'the dataset contains late-entered inspections after the checkpoint');
  const rp = await admin.post('/api/sessions', { mode: 'REPLAY', checkpointId: 'CK-20261015-1055', name: 'known-at replay' });
  assert.equal(rp.status, 201);
  const rsid = rp.data.session.sessionId;
  try {
    await waitFor(async () => ((await admin.get(`/api/sessions/${rsid}`)).data.session || {}).status === 'READY', { timeoutMs: 120000, what: 'replay ready' });
    const between = new Date(new Date(ins.COMPLETED_AT).getTime() + 60000).toISOString();
    const s1 = await admin.post(`/api/sessions/${rsid}/clock`, { action: 'SEEK', seekTo: between });
    assert.equal(s1.status, 200, JSON.stringify(s1.data));
    await new Promise(r => setTimeout(r, 1500));
    const before = await admin.get(`/api/sessions/${rsid}/units/${ins.UNIT_ID}`);
    assert.equal(before.status, 200, JSON.stringify(before.data).slice(0, 300));
    assert.ok(!JSON.stringify(before.data).includes(ins.INSPECTION_ID), `${ins.INSPECTION_ID} (completed ${new Date(ins.COMPLETED_AT).toISOString()}) is invisible before it was known (${new Date(ins.KNOWN_AT).toISOString()})`);
    const seek = await admin.post(`/api/sessions/${rsid}/clock`, { action: 'SEEK', seekTo: new Date(new Date(ins.KNOWN_AT).getTime() + 60000).toISOString() });
    assert.equal(seek.status, 200, JSON.stringify(seek.data));
    const after = await waitFor(async () => { const r = await admin.get(`/api/sessions/${rsid}/units/${ins.UNIT_ID}`); return JSON.stringify(r.data).includes(ins.INSPECTION_ID) ? r : null; }, { timeoutMs: 60000, what: 'late inspection visible after its KNOWN_AT' });
    assert.ok(after);
    const stored = await d.collection('inspection_header').findOne({ RUN_ID: 'RUN-BASE', INSPECTION_ID: ins.INSPECTION_ID });
    assert.equal(stored.KNOWN_AT.toISOString(), new Date(ins.KNOWN_AT).toISOString(), 'the historical known-at record is unchanged');
  } finally { await admin.post(`/api/sessions/${rsid}/archive`, {}); }
});

test('AT13: a material shortage changes the forecast and names material as the cause', { timeout: 300000 }, async () => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'material shortage');
  const S = `/api/sessions/${sid}`;
  await recalcAndWait(admin, sid);
  const f0 = (await admin.get(`${S}/forecasts`)).data;
  const mats = (await admin.get(`${S}/materials`)).data.materials.filter(m => m.materialId.startsWith('MAT-KIT-'));
  for (const m of mats) {
    const r = await admin.cmd(sid, 'MATERIAL_SHORTAGE', { materialId: m.materialId, setOnHandQty: 0, supplyDelayMin: 1440, reason: 'SUPPLIER_SHORT_DELIVERY' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  await recalcAndWait(admin, sid);
  const f1 = (await admin.get(`${S}/forecasts`)).data;
  const key = o => `${o.ORDER_LINE_ID}|${o.FORECAST_FINISH_AT}|${o.FORECAST_GOOD_BY_DUE}`;
  const changed = f1.orders.filter(o => { const b = f0.orders.find(x => x.ORDER_LINE_ID === o.ORDER_LINE_ID); return b && key(b) !== key(o); });
  assert.ok(changed.length > 0, 'at least one order-line forecast changed after the shortage');
  const named = JSON.stringify(f1).includes('MATERIAL');
  assert.ok(named, 'the forecast names MATERIAL as a limiting constraint');
  // a replenishment request placed now is promised no earlier than the supplier can deliver
  const mr = await admin.cmd(sid, 'MATERIAL_REQUEST', { materialId: mats[0].materialId, qty: 4, promisedMin: 30, expedite: true });
  assert.equal(mr.status, 201, JSON.stringify(mr.data));
  assert.ok(new Date(mr.data.result.request.PROMISED_AT) >= new Date(new Date(mr.data.simTime).getTime() + 1439 * 60000), 'expedite cannot beat the supply interruption');
  const ov = (await admin.get(`${S}/overview`)).data;
  assert.ok(ov.workCenters.some(w => w.forecast && w.forecast.limitingConstraint === 'MATERIAL') || f1.orders.some(o => (o.LIMITING_CONSTRAINTS || []).some(c => c.constraint === 'MATERIAL')), 'material appears as the limiting constraint for a line or work centre');
});

test('AT22: plant attendance reconciles across views; an attendance correction is recorded and visible', { timeout: 240000 }, async () => {
  const admin = await adminClient();
  const sid = await sharedSession(admin);
  const S = `/api/sessions/${sid}`;
  const wf = await allWorkers(admin, sid);
  const sum = Object.values(wf.stateCounts).reduce((a, b) => a + b, 0);
  assert.equal(sum, wf.total, 'state counts sum to the plant roster');
  assert.equal(wf.workers.length, wf.total);
  const ov = (await admin.get(`${S}/overview`)).data;
  assert.equal(ov.people.plantTotal, wf.total, 'overview and workforce agree on the plant roster');
  const productive = ['WORKING', 'INSPECTING', 'REPAIRING'];
  assert.equal(ov.people.working, wf.workers.filter(w => productive.includes(w.plantState)).length, 'overview "productively working" = workforce WORKING + INSPECTING + REPAIRING');
  assert.equal(ov.people.clockedIn, wf.workers.filter(w => w.attendance === 'CLOCKED_IN').length, 'overview clocked-in = workforce clocked-in');
  // attendance correction: a missing clock-in (badge fault) appended for a rostered worker who shows as not clocked in -> late start
  const w = wf.workers.find(x => x.plantState === 'NOT_CLOCKED_IN' || (x.rosterStatus === 'SCHEDULED' && x.attendance !== 'CLOCKED_IN' && x.plannedStartAt && new Date(x.plannedStartAt) < new Date(wf.session.simNow)));
  assert.ok(w, 'a rostered worker without a clock-in exists at the checkpoint');
  const corrected = new Date(Math.min(new Date(w.plannedStartAt).getTime() + 7 * 60000, new Date(wf.session.simNow).getTime())).toISOString();
  const r = await admin.cmd(sid, 'ATTENDANCE_CORRECTION', { workerId: w.workerId, correctionType: 'ADD_MISSING_CLOCK_IN', correctedTime: corrected, reason: 'BADGE_READER_FAULT' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const wf2 = await allWorkers(admin, sid);
  const w2 = wf2.workers.find(x => x.workerId === w.workerId);
  assert.equal(w2.attendance, 'CLOCKED_IN');
  assert.equal(new Date(w2.firstClockInAt).toISOString(), corrected, 'late start recorded at the corrected time');
  assert.equal(Object.values(wf2.stateCounts).reduce((a, b) => a + b, 0), wf2.total, 'still reconciles after the correction');
  const det = await admin.get(`${S}/workers/${w.workerId}`);
  assert.equal(det.status, 200);
  assert.ok(JSON.stringify(det.data).includes('ATTENDANCE_CORRECTION'), 'the correction is visible on the worker timeline');
});

test('AT9: repeated recalculation never duplicates points; ledger totals equal the shown totals', { timeout: 300000 }, async () => {
  const admin = await adminClient();
  const sid = await sharedSession(admin);
  await recalcAndWait(admin, sid);
  const d = await db();
  const n1 = await d.collection('sim_points_ledger').countDocuments({ SESSION_ID: sid });
  await recalcAndWait(admin, sid);
  await recalcAndWait(admin, sid);
  const n2 = await d.collection('sim_points_ledger').countDocuments({ SESSION_ID: sid });
  assert.equal(n2, n1, 'no new ledger rows without new evidence');
  const rows = await d.collection('sim_points_ledger').find({ SESSION_ID: sid }).toArray();
  const keys = rows.map(r => `${r.AWARD_KEY}|${r.WORKER_ID}`);
  assert.equal(new Set(keys).size, keys.length, 'ledger rows are unique by dedup key');
  // shown totals = history ledger (known at the checkpoint) + session ledger, for a sample of workers
  const wf = (await admin.get(`/api/sessions/${sid}/workforce?role=PRODUCTION_OPERATOR&pageSize=10`)).data;
  for (const w of wf.workers.slice(0, 5)) {
    const c = new Client('operator');
    await c.login(w.workerId, demoPin(w.workerId));
    const p = (await c.get(`/api/sessions/${sid}/me/progress`)).data.points;
    const hist = await d.collection('points_ledger').find({ RUN_ID: 'RUN-BASE', WORKER_ID: w.workerId, KNOWN_AT: { $lte: new Date('2026-10-15T15:55:00Z') } }).toArray();
    const sess = rows.filter(r => r.WORKER_ID === w.workerId);
    const total = [...hist, ...sess].reduce((a, r) => a + Number(r.POINTS_DELTA || 0), 0);
    assert.equal(p.total.TOTAL, Math.round(total * 100) / 100, `${w.workerId} shown total equals the ledger`);
  }
});

test('rule settings are versioned and effective-dated: a future version waits, then takes over; the previous stays in history', { timeout: 60000 }, async () => {
  const admin = await adminClient();
  const before = (await admin.get('/api/admin/rules')).data;
  const at = new Date(Date.now() + 4000).toISOString();
  const r = await admin.req('PUT', '/api/admin/rules', { rules: before.active.RULES.rules, note: 'acceptance test: identical content, scheduled', effectiveFrom: at });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const mid = (await admin.get('/api/admin/rules')).data;
  assert.equal(mid.active.VERSION_NO, before.active.VERSION_NO, 'the current version stays in force until the effective time');
  assert.equal(mid.versions.find(v => v.version === r.data.version).status, 'SCHEDULED');
  await new Promise(res => setTimeout(res, 5000));
  const after = (await admin.get('/api/admin/rules')).data;
  assert.equal(after.active.VERSION_NO, r.data.version, 'the scheduled version is effective after its time');
  assert.ok(after.versions.some(v => v.version === before.active.VERSION_NO && v.status === 'SUPERSEDED'), 'history keeps the previous version');
  const bad = await admin.req('PUT', '/api/admin/rules', { rules: [{ rule_id: 'M01', persistence: -1 }], note: 'invalid' });
  assert.equal(bad.status, 400, 'invalid settings are refused');
});
