'use strict';
/* v3 repair acceptance tests against the REAL API + database + engine on the Final dataset (CK-20261015-1055):
   responsibility validation and points re-evaluation with linked reversals (Section 6), the before/after change log (Section 2),
   batch split / membership history and good-output counting with scrap + replacement (Section 9), the validated product/order
   input path through the same engines with branch isolation (Section 9), the tank passport (Section 7) and deadline-aware
   scheduling evidence (Section 12). Expected values are stated from the rules, not read back from the implementation. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const { Client, demoPin, waitFor, adminClient, freshSession } = require('./helpers');

let mongo;
async function db() {
  if (!mongo) mongo = await MongoClient.connect(process.env.MONGODB_URI);
  return mongo.db(process.env.MONGODB_DB_NAME);
}
test.after(async () => { if (mongo) await mongo.close(); });

async function recalcAndWait(admin, sid) {
  const s0 = (await admin.get(`/api/sessions/${sid}`)).data.session;
  await admin.post(`/api/sessions/${sid}/recalculate`, {});
  await waitFor(async () => { const s = (await admin.get(`/api/sessions/${sid}`)).data.session; return s.engine.projectionVersion > s0.engine.projectionVersion && s.engine.watermarkSeq >= s0.eventSeq; }, { timeoutMs: 120000, what: 'recalculation published' });
}
async function net(sid, subject) {
  const rows = await (await db()).collection('sim_points_ledger').find({ SESSION_ID: sid, SUBJECT_KEY: subject }).toArray();
  const out = {};
  for (const r of rows) out[r.WORKER_ID] = Math.round(((out[r.WORKER_ID] || 0) + r.POINTS_DELTA) * 100) / 100;
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== 0));
}
async function operatorWith(admin, sid, perm = 'report_incoming_defect') {
  const wf = await admin.get(`/api/sessions/${sid}/workforce?role=PRODUCTION_OPERATOR&pageSize=200`);
  for (const w of wf.data.workers.filter(x => x.attendance === 'CLOCKED_IN')) {
    const c = new Client('operator');
    try { await c.login(w.workerId, demoPin(w.workerId)); } catch (e) { continue; }
    if ((c.user.permissions || []).includes(perm)) return c;
  }
  throw new Error('no clocked-in operator found');
}

test('responsibility validation, DD4 deduction, corrected shares and equipment cause post linked reversals only', { timeout: 400000 }, async (t) => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'repair: responsibility');
  const S = `/api/sessions/${sid}`;
  // a received tank downstream of its first labour operation
  let unit = null;
  for (const wc of ['WC2', 'WC3', 'WC4']) {
    const v = await admin.get(`${S}/work-centers/${wc}`);
    unit = (v.data.queue || []).find(u => u.state === 'QUEUED');
    if (unit) break;
  }
  assert.ok(unit, 'a queued tank exists downstream of OP10 at the checkpoint');
  const pass = (await admin.get(`${S}/units/${unit.unitId}`)).data;
  const steps = pass.sections.progress.routeSteps;
  const cur = steps.findIndex(s => s.status === 'CURRENT');
  const origin = steps.slice(0, cur).reverse().find(s => s.kind === 'LABOR');
  assert.ok(origin, 'a prior labour operation exists');
  const reporter = await operatorWith(admin, sid);
  const rep = await reporter.cmd(sid, 'INCOMING_DEFECT_REPORT', { unitId: unit.unitId, suspectedOriginOperationId: origin.operationId, description: 'Weld spatter found on receipt (test)' });
  assert.equal(rep.status, 201, JSON.stringify(rep.data));
  const inv = (await admin.get(`${S}/units/${unit.unitId}`)).data.sections.quality.investigations.find(i => i.source === 'SESSION');
  assert.ok(inv, 'an investigation was opened with unknown cause');
  assert.equal(inv.status, 'OPEN_UNKNOWN');
  const defectId = inv.defectId;
  const subject = `DD4|${defectId}`;
  // two real workers who are not the detector
  const roster = (await admin.get(`${S}/workforce?role=PRODUCTION_OPERATOR&pageSize=200`)).data.workers.map(w => w.workerId).filter(w => w !== reporter.user.workerId);
  const [wa, wb] = roster;
  const upd = (body, key) => admin.cmd(sid, 'INVESTIGATION_UPDATE', { investigationId: inv.investigationId, ...body }, key);
  const ev = 'Weld bead profile photographed; operator interview confirms technique (test evidence)';

  await t.test('invalid responsibility is rejected and nothing is booked', async () => {
    const cases = [
      [{ status: 'CONFIRMED', causeCategory: 'WORKER', evidenceNote: ev, responsible: [{ workerId: 'W9999', share: 1 }] }, 'RESPONSIBLE_UNKNOWN_WORKER'],
      [{ status: 'CONFIRMED', causeCategory: 'WORKER', evidenceNote: ev, responsible: [{ workerId: wa, share: 0.5 }, { workerId: wa, share: 0.5 }] }, 'RESPONSIBLE_DUPLICATE'],
      [{ status: 'CONFIRMED', causeCategory: 'WORKER', evidenceNote: ev, responsible: [{ workerId: wa, share: 0.6 }, { workerId: wb, share: 0.6 }] }, 'SHARES_INVALID'],
      [{ status: 'CONFIRMED', causeCategory: 'WORKER', evidenceNote: ev, responsible: [{ workerId: wa, share: -1 }, { workerId: wb, share: 2 }] }, 'SHARES_INVALID'],
      [{ status: 'CONFIRMED', causeCategory: 'WORKER', evidenceNote: ev, responsible: [{ workerId: wa, share: 'abc' }] }, 'SHARES_INVALID'],
      [{ status: 'CONFIRMED', causeCategory: 'WORKER', responsible: [{ workerId: wa, share: 1 }] }, 'EVIDENCE_REQUIRED'],
      [{ status: 'CONFIRMED', causeCategory: 'EQUIPMENT', evidenceNote: ev, responsible: [{ workerId: wa, share: 1 }] }, 'RESPONSIBLE_NOT_ALLOWED'],
      [{ status: 'CONFIRMED', causeCategory: 'WORKER', evidenceNote: ev, responsible: [{ workerId: reporter.user.workerId, share: 1 }] }, 'DETECTOR_NAMED'],
    ];
    for (const [body, code] of cases) {
      const r = await upd(body);
      assert.equal(r.status, 400, `${code}: ${JSON.stringify(r.data)}`);
      assert.equal(r.data.error.code, code);
    }
    const sus = await upd({ status: 'SUSPECTED', causeCategory: 'WORKER', responsible: [{ workerId: wa, share: 1 }], note: 'suspected only' });
    assert.equal(sus.status, 201, JSON.stringify(sus.data));
    await recalcAndWait(admin, sid);
    assert.deepEqual(await net(sid, subject), {}, 'unknown / suspected causes book nothing');
    const e = await (await db()).collection('sim_points_evaluations').findOne({ SESSION_ID: sid, SUBJECT_KEY: subject });
    assert.equal(e.STATUS, 'PENDING');
  });

  await t.test('confirmed worker cause: -4 to the named worker, posted once', async () => {
    const r = await upd({ status: 'CONFIRMED', causeCategory: 'WORKER', evidenceNote: ev, responsible: [{ workerId: wa, share: 1 }] });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await recalcAndWait(admin, sid);
    assert.deepEqual(await net(sid, subject), { [wa]: -4 });
    await recalcAndWait(admin, sid);
    assert.equal(await (await db()).collection('sim_points_ledger').countDocuments({ SESSION_ID: sid, SUBJECT_KEY: subject }), 1, 'unchanged evidence posts no new transaction');
  });

  await t.test('corrected shares reverse and re-post with links; history is never edited', async () => {
    const r = await upd({ status: 'CONFIRMED', causeCategory: 'WORKER', evidenceNote: `${ev} - corrected after crew review`, responsible: [{ workerId: wa, share: 0.5 }, { workerId: wb, share: 0.5 }] });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await recalcAndWait(admin, sid);
    assert.deepEqual(await net(sid, subject), { [wa]: -2, [wb]: -2 });
    const rows = await (await db()).collection('sim_points_ledger').find({ SESSION_ID: sid, SUBJECT_KEY: subject }).sort({ AWARD_KEY: 1, WORKER_ID: 1 }).toArray();
    const first = rows.find(x => x.AWARD_KEY === `${subject}|R1`);
    const rev = rows.find(x => x.ENTRY_TYPE === 'REVERSAL');
    assert.ok(first && rev, 'original and reversal rows exist');
    assert.equal(rev.REVERSAL_OF_ID, first.POINTS_TRANSACTION_ID);
    assert.equal(rev.POINTS_DELTA, 4);
    assert.equal(rows.length, 4, 'R1 original, X2 reversal, R2 for both workers');
  });

  await t.test('a confirmed equipment cause removes the deduction (no worker fault) by reversal', async () => {
    const r = await upd({ status: 'CONFIRMED', causeCategory: 'EQUIPMENT', evidenceNote: 'Fixture FX-04 clamp found misaligned by maintenance (test evidence)', partyId: 'FX-04' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await recalcAndWait(admin, sid);
    assert.deepEqual(await net(sid, subject), {});
    const e = await (await db()).collection('sim_points_evaluations').findOne({ SESSION_ID: sid, SUBJECT_KEY: subject });
    assert.equal(e.STATUS, 'NO_DEDUCTION');
  });

  await t.test('the change log holds before/after values, actor, correlation and idempotency key - and no secrets', async () => {
    const d = await db();
    const log = await d.collection('sim_change_log').find({ SESSION_ID: sid, COMMAND_TYPE: 'INVESTIGATION_UPDATE' }).sort({ RECEIVED_AT: 1 }).toArray();
    assert.ok(log.length >= 4, 'one change set per accepted update');
    const c = log[log.length - 1];
    const ch = c.CHANGES.find(x => x.COLLECTION === 'sim_investigations');
    assert.equal(ch.BEFORE.CAUSE_CATEGORY, 'WORKER');
    assert.equal(ch.AFTER.CAUSE_CATEGORY, 'EQUIPMENT');
    assert.ok(ch.VERSION_AFTER > ch.VERSION_BEFORE);
    for (const k of ['ACTOR_ID', 'CORRELATION_ID', 'IDEMPOTENCY_KEY', 'EVENT_TIME', 'KNOWN_AT', 'SOURCE', 'RUN_ID', 'DATASET_ID']) assert.ok(c[k], `${k} recorded`);
    const all = JSON.stringify(await d.collection('sim_change_log').find({}).toArray());
    assert.ok(!/scrypt\$/.test(all), 'no PIN/password hash in the change log');
  });
});

test('batch: four accepted + one scrap shows 4 good (not 5); the accepted replacement satisfies the fifth (Final data, replay)', { timeout: 300000 }, async () => {
  const admin = await adminClient();
  // PB-00002 (WO-2026-0102-L1, planned 5): TNK-000003 scrapped, replacement TNK-000013 route-complete 2026-09-15 03:41:49Z,
  // last original tank completed 02:10:26Z. Replay between the two shows 4 good; after the replacement it shows 5 (one from the replacement).
  const at = async (iso) => {
    const r = await admin.post('/api/sessions', { mode: 'REPLAY', forkAt: iso, name: `repair replay ${iso}` });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const sid = r.data.session.sessionId;
    await waitFor(async () => ((await admin.get(`/api/sessions/${sid}`)).data.session || {}).status === 'READY', { timeoutMs: 180000, what: 'replay READY' });
    const v = (await admin.get(`/api/sessions/${sid}/orders/WO-2026-0102-L1`)).data;
    await admin.post(`/api/sessions/${sid}/archive`, {});
    return v.batches.find(b => b.BATCH_ID === 'PB-00002').summary;
  };
  const mid = await at('2026-09-15T03:00:00Z');
  assert.equal(mid.demandQty, 5);
  assert.equal(mid.goodQty, 4, mid.explanation);
  assert.equal(mid.scrappedQty, 1);
  assert.equal(mid.stillNeeded, 1);
  assert.ok(mid.replacementTanks.some(r => r.unitId === 'TNK-000013' && r.replaces === 'TNK-000003' && r.state !== 'ROUTE_COMPLETE'));
  const after = await at('2026-09-15T03:45:00Z');
  assert.equal(after.goodQty, 5, after.explanation);
  assert.equal(after.goodFromReplacements, 1);
  assert.equal(after.scrappedQty, 1, 'the scrapped tank stays scrapped');
  assert.equal(after.stillNeeded, 0);
});

test('batch split keeps one active membership per tank, mixed states, and membership history in the passport', { timeout: 300000 }, async () => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'repair: batch split');
  const S = `/api/sessions/${sid}`;
  const orders = (await admin.get(`${S}/orders`)).data.lines;
  let line = null, batch = null;
  for (const o of orders) {
    const v = (await admin.get(`${S}/orders/${o.orderLineId}`)).data;
    batch = v.batches.find(b => b.tanks.filter(t => !['ROUTE_COMPLETE', 'SCRAPPED', 'RELEASED_BEFORE_WINDOW'].includes(t.state)).length >= 2);
    if (batch) { line = o.orderLineId; break; }
  }
  assert.ok(batch, 'a batch with two or more active tanks exists at the checkpoint');
  const active = batch.tanks.filter(t => !['ROUTE_COMPLETE', 'SCRAPPED', 'RELEASED_BEFORE_WINDOW'].includes(t.state));
  const moving = active[0].unitId;
  const r = await admin.cmd(sid, 'BATCH_SPLIT', { batchId: batch.BATCH_ID, unitIds: [moving], reason: 'Expedite one tank (test)' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const child = r.data.result.childBatchId;
  assert.equal(child, `${batch.BATCH_ID}-S1`);
  const again = await admin.cmd(sid, 'BATCH_SPLIT', { batchId: batch.BATCH_ID, unitIds: [moving], reason: 'second split of the same tank' });
  assert.equal(again.status, 400, 'a tank already moved is no longer a member of the parent');
  const all = await admin.cmd(sid, 'BATCH_SPLIT', { batchId: child, unitIds: [moving], reason: 'empty the child' });
  assert.equal(all.status, 400, 'a split must leave at least one tank');
  const v = (await admin.get(`${S}/orders/${line}`)).data;
  assert.ok(v.batches.some(b => b.BATCH_ID === child && b.PARENT_BATCH_ID === batch.BATCH_ID && b.tanks.some(t => t.unitId === moving)));
  const d = await db();
  const open = await d.collection('sim_batch_membership').find({ SESSION_ID: sid, UNIT_ID: moving, VALID_TO: null }).toArray();
  assert.equal(open.length, 1, 'exactly one open membership');
  assert.equal(open[0].BATCH_ID, child);
  const pp = (await admin.get(`${S}/units/${moving}`)).data;
  assert.ok(pp.sections.identity.batchHistory.some(b => b.source === 'SESSION' && b.batchId === child && b.parentBatchId === batch.BATCH_ID));
  assert.equal(pp.sections.identity.batchId, child);
});

test('validated product and order input: incomplete product refused, complete product + order run through the same engines, isolated per branch', { timeout: 400000 }, async (t) => {
  const admin = await adminClient();
  const pid = `TTX-T${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  await t.test('an incomplete product is refused with every problem and nothing is written', async () => {
    const r = await admin.post('/api/admin/master/products', { productId: pid, productName: 'Test tank (incomplete)', drawingRef: 'DWG-TEST', drawingRevision: 'A',
      operations: [{ operationId: 'OP10', kind: 'LABOR', workCenterId: 'WC1', sequenceNo: 10, standardLaborMin: 0, standardElapsedMin: 60, minCrew: 3, stdCrew: 2, maxCrew: 5 }] });
    assert.equal(r.status, 422, JSON.stringify(r.data));
    const p = r.data.error.details.problems.join(' | ');
    for (const frag of ['standard labour and elapsed minutes must be positive', 'crew sizes', 'must end with an inspection gate', 'material requirement']) assert.ok(p.includes(frag), `${frag} in ${p}`);
    const list = (await admin.get('/api/admin/master/products')).data.products;
    assert.ok(!list.some(x => x.productId === pid), 'nothing written');
  });
  await t.test('a complete product (template routing, copied synthetic specs) is released', async () => {
    const dry = await admin.post('/api/admin/master/products?dryRun=1', { productId: pid, productName: 'Test tank variant (fictional)', drawingRef: 'DWG-TEST', drawingRevision: 'A', templateProductId: 'TT-S', specsFromProductId: 'TT-S',
      operations: [{ operationId: 'OP10', standardLaborMin: 390, standardElapsedMin: 98 }] });
    assert.equal(dry.status, 200, JSON.stringify(dry.data));
    const r = await admin.post('/api/admin/master/products', { productId: pid, productName: 'Test tank variant (fictional)', drawingRef: 'DWG-TEST', drawingRevision: 'A', templateProductId: 'TT-S', specsFromProductId: 'TT-S',
      operations: [{ operationId: 'OP10', standardLaborMin: 390, standardElapsedMin: 98 }] });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const again = await admin.post('/api/admin/master/products', { productId: pid, productName: 'dup', drawingRef: 'D', drawingRevision: 'A', templateProductId: 'TT-S', specsFromProductId: 'TT-S' });
    assert.equal(again.status, 422, 'duplicate product refused');
  });
  const sid = await freshSession(admin, 'repair: new order');
  const other = await freshSession(admin, 'repair: other branch');
  const S = `/api/sessions/${sid}`;
  const simNow = new Date((await admin.get(S)).data.session.simNow);
  await t.test('order validation refuses unknown products, bad quantities and past due dates', async () => {
    const r = await admin.cmd(sid, 'ORDER_CREATE', { lines: [{ productId: 'NOPE', requiredGoodQty: 0, dueAt: new Date(simNow.getTime() - 3600000).toISOString() }] });
    assert.equal(r.status, 422, JSON.stringify(r.data));
    const p = r.data.error.details.problems.join(' | ');
    for (const frag of ['unknown product NOPE', 'requiredGoodQty must be a whole number', 'dueAt must be after the current simulated time']) assert.ok(p.includes(frag), `${frag} in ${p}`);
  });
  let created;
  await t.test('a new order + plan releases new tanks that the engines schedule and forecast', async () => {
    const due = new Date(simNow.getTime() + 3 * 86400000).toISOString();
    const r = await admin.cmd(sid, 'ORDER_CREATE', { priority: 'HIGH', lines: [{ productId: pid, requiredGoodQty: 2, dueAt: due }] });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    created = r.data.result;
    const line = created.lines[0];
    const rel = await admin.cmd(sid, 'BATCH_RELEASE', { batchId: line.batches[0] });
    assert.equal(rel.status, 201, JSON.stringify(rel.data));
    assert.equal(rel.data.result.units.length, 2);
    const v = (await admin.get(`${S}/orders/${line.orderLineId}`)).data;
    assert.equal(v.line.PRODUCT_ID, pid);
    assert.equal(v.batches[0].tanks.length, 2);
    await recalcAndWait(admin, sid);
    const fc = (await admin.get(`${S}/forecasts`)).data.orders.find(o => o.ORDER_LINE_ID === line.orderLineId);
    assert.ok(fc, 'the forecast includes the new line');
    assert.ok(['GREEN', 'AMBER', 'RED', 'UNKNOWN'].includes(fc.BAND));
    const tank = rel.data.result.units[0];
    const pp = (await admin.get(`${S}/units/${tank}`)).data;
    assert.equal(pp.sections.identity.productId, pid);
    assert.equal(pp.sections.progress.routeSteps[0].operationId, 'OP10');
  });
  await t.test('another branch never sees the order', async () => {
    const r = await admin.get(`/api/sessions/${other}/orders/${created.lines[0].orderLineId}`);
    assert.equal(r.status, 404);
    const lines = (await admin.get(`/api/sessions/${other}/orders`)).data.lines;
    assert.ok(!lines.some(l => l.orderId === created.orderId));
  });
});

test('tank passport: role-limited for operators, full for supervisors, Not recorded instead of invented values, no future records', { timeout: 200000 }, async () => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'repair: passport');
  const S = `/api/sessions/${sid}`;
  const wc = (await admin.get(`${S}/work-centers/WC1`)).data;
  const unitId = (wc.stations.find(s => s.unit) || {}).unit ? wc.stations.find(s => s.unit).unit.unitId : wc.queue[0].unitId;
  const sup = (await admin.get(`${S}/units/${unitId}`)).data;
  assert.equal(sup.access.level, 'SUPERVISOR');
  for (const k of ['identity', 'current', 'progress', 'people', 'quality', 'traceability']) assert.ok(sup.sections[k], `${k} section present`);
  assert.equal(sup.sections.identity.unitId, unitId);
  // next action is explained for the tank's real state (every contract state is covered: tests/unit/passport-next-action.test.js)
  assert.ok(sup.sections.progress.expectedNextAction && !/^No guidance/.test(sup.sections.progress.expectedNextAction), `next action for ${sup.sections.current.state}: ${sup.sections.progress.expectedNextAction}`);
  // the passports of every active tank in this session explain their next step
  const wc1 = (await admin.get(`${S}/work-centers/WC1`)).data;
  for (const u of [...wc1.stations.filter(st => st.unit).map(st => st.unit), ...wc1.queue].slice(0, 8)) {
    const p = (await admin.get(`${S}/units/${u.unitId}`)).data;
    assert.ok(p.sections.progress.expectedNextAction && !/^No guidance/.test(p.sections.progress.expectedNextAction), `${u.unitId} ${p.sections.current.state}: ${p.sections.progress.expectedNextAction}`);
  }
  const fork = new Date(sup.session.forkAt);
  for (const e of sup.sections.traceability.events.filter(x => x.source === 'HISTORY')) assert.ok(new Date(e.knownAt || e.at) <= fork, 'no history record known after the fork');
  const op = await operatorWith(admin, sid);
  const lim = (await op.get(`${S}/units/${unitId}`)).data;
  assert.equal(lim.access.level, 'OPERATOR');
  assert.equal(lim.sections.traceability.pointsEvaluations, 'RESTRICTED');
  for (const p of lim.sections.traceability.points) assert.equal(p.workerId, op.user.workerId, 'operators see only their own points');
  for (const a of lim.sections.people.attempts) for (const l of a.labour) if (l.workerId !== op.user.workerId) assert.equal(l.minutesByCategory, 'RESTRICTED');
  const missing = await admin.get(`${S}/units/TNK-DOES-NOT-EXIST`);
  assert.equal(missing.status, 404);
});

test('deadline-aware scheduling: the engine records the next boundaries, exact to the second (the crossing itself is tested in e2e)', { timeout: 200000 }, async () => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'repair: boundaries');
  await recalcAndWait(admin, sid);
  const s = await (await db()).collection('sim_sessions').findOne({ SESSION_ID: sid });
  assert.ok(s.ENGINE.NEXT_BOUNDARY_SIM_AT, 'a next boundary is scheduled');
  assert.ok(new Date(s.ENGINE.NEXT_BOUNDARY_SIM_AT) > new Date(s.FORK_AT));
  assert.ok((s.ENGINE.NEXT_BOUNDARIES || []).every(b => b.reason && b.at));
  // buffer-deadline and cutoff boundaries are the first second after the inclusive deadline (14:30:00 AMBER -> 14:30:01), never +1 min
  for (const b of s.ENGINE.NEXT_BOUNDARIES.filter(x => /buffer deadline|cutoff/.test(x.reason))) assert.equal(new Date(b.at).getUTCSeconds(), 1, `${b.reason} at ${new Date(b.at).toISOString()}`);
  // this test does not cross a deadline: see e2e 'deadline crossing at x1' for the evaluation at the boundary and its latency
});

test('recovery: an explicit no-action option and relief-worker call-ins are offered, executed through commands and scoped to the session', { timeout: 400000 }, async () => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'repair: recovery options');
  const other = await freshSession(admin, 'repair: recovery other branch');
  const S = `/api/sessions/${sid}`;
  await recalcAndWait(admin, sid);
  const line = (await admin.get(`${S}/forecasts`)).data.orders.find(o => o.BAND !== 'COMPLETE' && o.ACTIVE_UNITS > 0);
  assert.ok(line, 'an open order line with active tanks');
  await admin.post(`${S}/recalculate`, { kind: 'RECOVERY', orderLineId: line.ORDER_LINE_ID });
  const rec = await waitFor(async () => (await admin.get(`${S}/forecasts`)).data.recovery.find(r => r.orderLineId === line.ORDER_LINE_ID), { timeoutMs: 180000, what: 'recovery options' });
  const na = rec.options.find(o => o.ACTION_TYPE === 'NO_ACTION');
  assert.ok(na && na.FEASIBLE && na.STEPS.length === 0, 'explicit no-action option');
  assert.deepEqual(na.RESULT, rec.baseline, 'no-action equals the baseline forecast');
  const relief = rec.options.filter(o => o.ACTION_TYPE === 'RELIEF_WORKER');
  assert.ok(relief.length >= 1, 'a relief-worker option is generated from off-shift qualified people');
  for (const o of relief) assert.ok(o.CHECKS.some(c => c.check === 'MINIMUM_USEFUL_DURATION') && o.STEPS[0].type === 'RELIEF_CALL_IN');
  // the no-action decision is recorded and verified like any other action
  const p = await admin.cmd(sid, 'ACTION_PROPOSE', { forecastId: rec.forecastId, optionId: na.OPTION_ID });
  assert.equal(p.status, 201, JSON.stringify(p.data));
  const id = p.data.result.action.ACTION_ID;
  assert.equal((await admin.cmd(sid, 'ACTION_APPROVE', { actionId: id })).status, 201);
  const ex = await admin.cmd(sid, 'ACTION_START', { actionId: id });
  assert.equal(ex.status, 201, JSON.stringify(ex.data));
  assert.equal(ex.data.result.action.STATUS, 'STARTED');
  // relief call-in through its command: session-scoped roster row, absent people refused
  const wf = (await admin.get(`${S}/workforce?pageSize=200`)).data.workers;
  const off = wf.find(w => w.attendance === 'OFF_SHIFT' && w.role === 'PRODUCTION_OPERATOR' && w.homeWorkCenterId === 'WC1');
  const absent = wf.find(w => w.attendance === 'ABSENT');
  assert.ok(off, 'an off-shift WC1 operator exists');
  const r = await admin.cmd(sid, 'RELIEF_CALL_IN', { workerId: off.workerId, toWorkCenterId: 'WC1' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  if (absent) assert.equal((await admin.cmd(sid, 'RELIEF_CALL_IN', { workerId: absent.workerId, toWorkCenterId: 'WC1' })).status, 409);
  const d = await db();
  assert.equal(await d.collection('app_shift_roster').countDocuments({ SESSION_ID: sid, WORKER_ID: off.workerId, ORIGIN: 'RELIEF_CALL_IN' }), 1);
  assert.equal(await d.collection('app_shift_roster').countDocuments({ SESSION_ID: other, ORIGIN: 'RELIEF_CALL_IN' }), 0, 'other branches never see the call-in');
  // every call-in roster row has its own ROSTER_ID (regression: rows without one collided on the unique index, so the second
  // call-in anywhere in the database failed with 409 DUPLICATE)
  const off2 = wf.find(w => w.attendance === 'OFF_SHIFT' && w.role === 'PRODUCTION_OPERATOR' && w.homeWorkCenterId === 'WC1' && w.workerId !== off.workerId);
  assert.ok(off2, 'a second off-shift WC1 operator exists');
  const r2 = await admin.cmd(sid, 'RELIEF_CALL_IN', { workerId: off2.workerId, toWorkCenterId: 'WC1' });
  assert.equal(r2.status, 201, `second call-in: ${JSON.stringify(r2.data)}`);
  const callIns = await d.collection('app_shift_roster').find({ SESSION_ID: sid, ORIGIN: 'RELIEF_CALL_IN' }).toArray();
  assert.equal(callIns.length, 2);
  assert.ok(callIns.every(x => x.ROSTER_ID) && new Set(callIns.map(x => x.ROSTER_ID)).size === 2, 'distinct ROSTER_IDs');
});
