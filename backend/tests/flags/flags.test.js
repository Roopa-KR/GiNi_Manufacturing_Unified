'use strict';
/* LIVE end-to-end tests for the six requested variance flags (F1-F6) on the Final dataset, each in its own interactive session:
     healthy at the start -> the condition is created through ordinary commands -> the alert appears in the supervisor UI (real
     Chromium) -> exactly one FIRING notification is captured (Nodemailer capture transport; EMAIL_MODE=capture) -> acknowledging
     keeps the alert FIRING -> the cause is corrected through commands -> the alert RESOLVES.
   The simulation clock runs at x60 where time must pass (background agents active); the session's notification policy allows
   capture at that speed (notify.suppressSpeed 240) so the single notification is observable. Screenshots: tests/flags/.artifacts/.
   Env as for the integration and e2e suites (API_URL, ADMIN_URL, ADMIN_LOGIN, ADMIN_PASSWORD, DEMO_PIN_SEED, CHROMIUM_PATH). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { Client, demoPin, waitFor, adminClient } = require('../integration/helpers');

const AD = (process.env.ADMIN_URL || 'http://localhost:5174').replace(/\/+$/, '');
const ART = path.join(__dirname, '.artifacts');
fs.mkdirSync(ART, { recursive: true });
const report = [];
let browser;
test.before(async () => {
  const opts = { args: ['--no-sandbox'] };
  if (process.env.CHROMIUM_PATH) opts.executablePath = process.env.CHROMIUM_PATH;
  browser = await chromium.launch(opts);
});
test.after(async () => {
  if (browser) await browser.close();
  fs.writeFileSync(path.join(ART, 'flags-report.json'), JSON.stringify(report, null, 2));
});

const created = [];
test.after(async () => { const a = await adminClient(); for (const sid of created) await a.post(`/api/sessions/${sid}/archive`, {}); });

async function flagSession(admin, name) {
  const r = await admin.post('/api/sessions', { mode: 'INTERACTIVE', checkpointId: 'CK-20261015-1055', name, notify: { suppressSpeed: 240, cooldownSeconds: 0 } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const sid = r.data.session.sessionId;
  created.push(sid);
  await waitFor(async () => ((await admin.get(`/api/sessions/${sid}`)).data.session || {}).status === 'READY', { timeoutMs: 180000, what: 'session READY' });
  await recalc(admin, sid);
  return sid;
}
async function recalc(admin, sid) {
  const s0 = (await admin.get(`/api/sessions/${sid}`)).data.session;
  await admin.post(`/api/sessions/${sid}/recalculate`, {});
  await waitFor(async () => { const s = (await admin.get(`/api/sessions/${sid}`)).data.session; return s.engine.projectionVersion > s0.engine.projectionVersion && s.engine.watermarkSeq >= s0.eventSeq; }, { timeoutMs: 120000, what: 'recalculation published' });
}
const clock = (admin, sid, body) => admin.post(`/api/sessions/${sid}/clock`, body);
async function play(admin, sid, speed = 60) { await clock(admin, sid, { action: 'SPEED', speed }); await clock(admin, sid, { action: 'PLAY' }); }
async function pause(admin, sid) { await clock(admin, sid, { action: 'PAUSE' }); }
async function alertOf(admin, sid, ruleId, entity) {
  const r0 = await admin.get(`/api/sessions/${sid}/alerts`);
  const a0 = r0.data.alerts.find(a => a.ruleId === ruleId && (!entity || a.entityId === entity));
  const r = a0 ? await admin.get(`/api/sessions/${sid}/alerts?alertId=${encodeURIComponent(a0.alertId)}`) : r0;
  return { alert: r.data.alerts.find(a => a.ruleId === ruleId && (!entity || a.entityId === entity)) || null, notifications: r.data.notifications, evaluation: (r.data.ruleEvaluation || {}).rules || [] };
}
async function evalOf(admin, sid, ruleId, entity) {
  const r = await admin.get(`/api/sessions/${sid}/alerts`);
  return ((r.data.ruleEvaluation || {}).rules || []).filter(o => o.rule_id === ruleId && (!entity || o.entity_id === entity));
}
async function waitState(admin, sid, ruleId, entity, state, timeoutMs = 240000) {
  return waitFor(async () => { const { alert } = await alertOf(admin, sid, ruleId, entity); return alert && alert.evaluation === state ? alert : null; }, { timeoutMs, everyMs: 1500, what: `${ruleId} ${entity || ''} ${state}` });
}
async function ack(admin, sid, alertId) {
  for (let i = 0; i < 5; i++) {                       // the engine may update the alert concurrently: retry a version conflict
    const r = await admin.cmd(sid, 'ALERT_WORKFLOW', { alertId, action: 'ACK', note: 'Seen - investigating (flag test)' });
    if (r.status === 201) return r;
    if (r.status !== 409) throw new Error(JSON.stringify(r.data));
  }
  throw new Error('acknowledge kept conflicting');
}
async function uiShows(sid, ruleId, entity, name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(s => { try { localStorage.setItem('gini_session', s); } catch (e) { /* ignore */ } }, sid);
  const page = await ctx.newPage();
  try {
    await page.goto(`${AD}/`);
    await page.fill('#lid', process.env.ADMIN_LOGIN || 'admin');
    await page.fill('#pin', process.env.ADMIN_PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForSelector('nav.sidebar', { timeout: 30000 });
    await page.goto(`${AD}/alerts`);
    await page.waitForSelector(`tr:has(b:text-is("${ruleId}")):has-text("${entity}")`, { timeout: 60000 });
    await page.screenshot({ path: path.join(ART, `${name}.png`), fullPage: true });
    return true;
  } finally { await ctx.close(); }
}
/** the full lifecycle checks shared by every flag once the condition exists */
async function lifecycle(admin, sid, ruleId, entity, correct, name, opts = {}) {
  const t0 = Date.now();
  const firing = await waitState(admin, sid, ruleId, entity, 'FIRING', opts.fireTimeoutMs);
  if (opts.pauseOnFire !== false) await pause(admin, sid);
  const shown = await uiShows(sid, ruleId, entity, `${name}-firing`);
  const n = await waitFor(async () => {
    const { notifications } = await alertOf(admin, sid, ruleId, entity);
    const mine = notifications.filter(x => x.alertId === firing.alertId && x.episodeId === firing.episodeId && x.transition === 'FIRING');
    return mine.length && mine.every(x => x.status === 'CAPTURED') ? mine : null;
  }, { timeoutMs: 60000, what: `${ruleId} FIRING notification captured` });
  assert.equal(n.length, 1, `exactly one FIRING notification for ${firing.alertId}`);
  await ack(admin, sid, firing.alertId);
  await recalc(admin, sid);
  const afterAck = (await alertOf(admin, sid, ruleId, entity)).alert;
  assert.equal(afterAck.workflow, 'ACKNOWLEDGED');
  assert.equal(afterAck.evaluation, 'FIRING', 'acknowledging does not resolve the condition');
  await correct();
  const resolved = await waitFor(async () => {
    await recalc(admin, sid);
    const { alert } = await alertOf(admin, sid, ruleId, entity);
    return alert && alert.evaluation === 'RESOLVED' ? alert : null;
  }, { timeoutMs: 240000, everyMs: 500, what: `${ruleId} RESOLVED` });
  const { notifications } = await alertOf(admin, sid, ruleId, entity);
  report.push({ ruleId, entity, sessionId: sid, alertId: firing.alertId, episodeId: firing.episodeId, firingAt: firing.firingAt, resolvedAt: resolved.resolvedAt, uiScreenshot: `${name}-firing.png`, uiShown: shown,
    notifications: notifications.filter(x => x.alertId === firing.alertId && x.episodeId === firing.episodeId).map(x => ({ transition: x.transition, status: x.status, messageId: x.messageId })), wallSeconds: Math.round((Date.now() - t0) / 1000) });
  return { firing, resolved };
}
async function operatorLogin(workerId) { const c = new Client('operator'); await c.login(workerId, demoPin(workerId)); return c; }

// ------------------------------------------------------------------------------------------------------------------------------
test('F6 Replenishment Delay: outstanding request past need-by + 10 min fires; delivery resolves', { timeout: 600000 }, async () => {
  const admin = await adminClient();
  const sid = await flagSession(admin, 'flag F6');
  assert.equal((await alertOf(admin, sid, 'F6')).alert, null, 'healthy: no replenishment alert at the start');
  const r = await admin.cmd(sid, 'MATERIAL_REQUEST', { materialId: 'MAT-KIT-S', qty: 5, needByMin: 2, promisedMin: 600 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const reqId = r.data.result.request.REQUEST_ID;
  await play(admin, sid, 60);
  await lifecycle(admin, sid, 'F6', reqId, async () => {
    const d = await admin.cmd(sid, 'MATERIAL_DELIVERY', { materialId: 'MAT-KIT-S', qty: 5, requestId: reqId });
    assert.equal(d.status, 201, JSON.stringify(d.data));
  }, 'F6');
});

test('F5 Congestion: WC1 queue >= 85% of capacity fires; dispatching a queued tank resolves', { timeout: 600000 }, async () => {
  const admin = await adminClient();
  const sid = await flagSession(admin, 'flag F5');
  const S = `/api/sessions/${sid}`;
  const before = (await evalOf(admin, sid, 'F5', 'WC1'))[0];
  assert.ok(before && before.status === 'OK', `healthy: WC1 queue below 85% (${before && before.message})`);
  // release planned batches (the plan known at the fork) until the WC1 queue reaches the threshold
  const releases = ['PB-00150', 'PB-00149', 'PB-00151'];
  for (const b of releases) {
    const rr = await admin.cmd(sid, 'BATCH_RELEASE', { batchId: b });
    assert.equal(rr.status, 201, JSON.stringify(rr.data));
    await recalc(admin, sid);
    const e = (await evalOf(admin, sid, 'F5', 'WC1'))[0];
    if (e.status === 'BREACH') break;
  }
  for (let i = 0; i < 3; i++) await recalc(admin, sid);     // persistence 3 evaluations
  await lifecycle(admin, sid, 'F5', 'WC1', async () => {
    // correct: dispatch queued tanks to free WC1 stations until occupancy is below the threshold
    for (let i = 0; i < 6; i++) {
      const e = (await evalOf(admin, sid, 'F5', 'WC1'))[0];
      if (e.status === 'OK') break;
      const wc = (await admin.get(`${S}/work-centers/WC1`)).data;
      const free = wc.stations.find(s => !s.unit && !(s.equipment && s.equipment.status === 'DOWN'));
      const q = wc.queue.find(u => u.state === 'QUEUED');
      assert.ok(free && q, 'a free WC1 station and a queued tank exist');
      const st = await admin.cmd(sid, 'OPERATION_START', { unitId: q.unitId, workstationId: free.workstationId, crew: [] });
      assert.equal(st.status, 201, JSON.stringify(st.data));
      await recalc(admin, sid);
    }
  }, 'F5', { pauseOnFire: false });
});

test('F2 Regional Workload Imbalance: FAB overloaded while FIN is light fires; transferring qualified FIN people resolves', { timeout: 900000 }, async () => {
  const admin = await adminClient();
  const sid = await flagSession(admin, 'flag F2');
  const S = `/api/sessions/${sid}`;
  const e0 = (await evalOf(admin, sid, 'F2', 'AREAS'))[0];
  assert.equal(e0.status, 'OK', `healthy at the start: ${e0.message}`);
  for (const b of ['PB-00149', 'PB-00150', 'PB-00151', 'PB-00152', 'PB-00153', 'PB-00154']) {
    const rr = await admin.cmd(sid, 'BATCH_RELEASE', { batchId: b });
    assert.equal(rr.status, 201, JSON.stringify(rr.data));
    await recalc(admin, sid);
    if ((await evalOf(admin, sid, 'F2', 'AREAS'))[0].status === 'BREACH') break;
  }
  await recalc(admin, sid);
  await lifecycle(admin, sid, 'F2', 'AREAS', async () => {
    // FIN people qualified for FAB skills move to WC1/WC2 (departure, travel + handover, arrival) until the condition clears
    const moved = [];
    for (let round = 0; round < 8; round++) {
      const wf = (await admin.get(`${S}/workforce?pageSize=200`)).data.workers;
      // people on break or already travelling cannot be sent; a working person can, if the donor keeps its minimum crew
      const fin = wf.filter(w => ['WC3', 'WC4'].includes(w.tempWorkCenterId || w.workCenterId || w.homeWorkCenterId) && w.attendance === 'CLOCKED_IN' && w.role === 'PRODUCTION_OPERATOR' && !['TRANSFER', 'BREAK'].includes(w.activity) && !moved.includes(w.workerId));
      if (!fin.length) { await play(admin, sid, 60); await new Promise(r => setTimeout(r, 8000)); await pause(admin, sid); continue; }   // let breaks end
      // the rule counts people qualified for ANY FAB work centre (WC1 or WC2), so each person goes to a FAB centre they hold a
      // valid qualification for; the server refuses unqualified moves (403) and moves that would strip a donor crew (409)
      const batch = [], refused = {};
      for (const w of fin) {
        for (const dest of ['WC1', 'WC2']) {
          const r = await admin.cmd(sid, 'WORKER_TRANSFER', { workerId: w.workerId, toWorkCenterId: dest, reason: 'LABOR_SHORTAGE_AT_DESTINATION' });
          if (r.status === 201) { batch.push(w.workerId); break; }
          const k = `${dest}:${r.status}:${(r.data.error || {}).code}`; refused[k] = (refused[k] || 0) + 1;
        }
        if (batch.length >= 12) break;
      }
      console.log(`F2 round ${round}: ${batch.length} transfers started; refusals ${JSON.stringify(refused)}`);
      moved.push(...batch);
      if (!batch.length) { await play(admin, sid, 60); await new Promise(r => setTimeout(r, 8000)); await pause(admin, sid); continue; }
      await play(admin, sid, 60);
      // departure -> travel/handover -> arrival: only an arrived person counts at the destination
      await waitFor(async () => { const ws = (await admin.get(`${S}/workforce?pageSize=200`)).data.workers.filter(w => batch.includes(w.workerId)); return ws.every(w => ['WC1', 'WC2'].includes(w.tempWorkCenterId || w.workCenterId) && w.activity !== 'TRANSFER'); }, { timeoutMs: 180000, what: 'transfers arrived in FAB' });
      await pause(admin, sid);
      await recalc(admin, sid);
      const ev = (await evalOf(admin, sid, 'F2', 'AREAS'))[0];
      console.log(`F2 after transferring ${moved.length}: ${ev.status} - ${ev.message}`);
      if (ev.status === 'OK') break;
    }
    assert.ok(moved.length >= 2, `qualified FIN people were transferred (${moved.length})`);
  }, 'F2');
});

test('F3 Material Velocity: abnormal material issues per productive hour fire; reversing the mistaken issues resolves', { timeout: 900000 }, async () => {
  const admin = await adminClient();
  const sid = await flagSession(admin, 'flag F3');
  // productive time must exist before the rate can be judged (zero demand is not a fault)
  await play(admin, sid, 60);
  let okStreak = 0;
  await waitFor(async () => { const e = (await evalOf(admin, sid, 'F3', 'PLANT'))[0]; okStreak = e && e.status === 'OK' ? okStreak + 1 : 0; return okStreak >= 2; }, { timeoutMs: 300000, everyMs: 4000, what: 'F3 healthy with enough productive time' });
  await pause(admin, sid);
  await recalc(admin, sid);
  let e = (await evalOf(admin, sid, 'F3', 'PLANT'))[0];
  assert.equal(e.status, 'OK', `healthy: material issues within the normal range (${e.message})`);
  const { alert: pre } = await alertOf(admin, sid, 'F3', 'PLANT');
  assert.ok(!pre || pre.evaluation !== 'FIRING');
  const sample = e.sample;
  const need = Math.ceil(Math.max(2, 0.5 * sample.expected_issues) + Math.max(0, sample.expected_issues - sample.issues)) + 2;
  const issued = [];
  const mats = (await admin.get(`/api/sessions/${sid}/materials`)).data.materials;
  const mat = mats.slice().sort((a, b) => (b.available ?? b.onHand ?? 0) - (a.available ?? a.onHand ?? 0))[0];
  assert.ok(mat && (mat.available ?? mat.onHand) >= need, `a material with stock for ${need} issues exists`);
  for (let i = 0; i < need; i++) {
    const r = await admin.cmd(sid, 'MATERIAL_ISSUE', { materialId: mat.materialId, qty: 1, reason: 'DOUBLE_SCAN_AT_KITTING (test)' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    issued.push(r.data.result.eventId);
  }
  await recalc(admin, sid);
  e = (await evalOf(admin, sid, 'F3', 'PLANT'))[0];
  assert.equal(e.status, 'BREACH', e.message);
  await recalc(admin, sid);                                   // persistence 2
  await lifecycle(admin, sid, 'F3', 'PLANT', async () => {
    for (const id of issued) {
      const r = await admin.cmd(sid, 'MATERIAL_ISSUE_REVERSE', { eventId: id, reason: 'RECORDED_IN_ERROR' });
      assert.equal(r.status, 201, JSON.stringify(r.data));
    }
  }, 'F3', { pauseOnFire: false });
});

test('F1 Stalled Active Assignment and F4 Location Velocity: no progress evidence fires F1, a long dwell fires F4; progress and completion resolve them', { timeout: 1200000 }, async () => {
  const admin = await adminClient();
  const sid = await flagSession(admin, 'flag F1 F4');
  const S = `/api/sessions/${sid}`;
  // a working labour operation with a full standard crew (no automatic joins), controlled by testers so agents do not progress it
  const f1 = await evalOf(admin, sid, 'F1');
  const f4 = await evalOf(admin, sid, 'F4');
  const working = (await admin.get(`${S}/workforce?state=WORKING&pageSize=200`)).data.workers;
  let target = null;
  for (const o of f1.filter(x => x.status === 'OK')) {
    const crew = working.filter(w => w.currentOperationInstanceId === o.entity_id);
    if (crew.length < 4) continue;
    const ws = crew[0].workstationId;
    if (f4.some(x => x.entity_id === ws && x.status === 'BREACH')) continue;
    // the correction completes a milestone, so at least two non-final milestones must remain (finishing would also end F4)
    const c0 = await operatorLogin(crew[0].workerId);
    const h = (await c0.get(`${S}/me/home`)).data;
    const left = h.currentTask ? h.currentTask.milestones.milestones.filter(m => !m.done && m.attended && !m.final) : [];
    if (left.length < 2) continue;
    target = { oid: o.entity_id, crew: crew.map(w => w.workerId), ws };
    break;
  }
  assert.ok(target, 'a working operation with a crew of four exists');
  const f4pre = (await evalOf(admin, sid, 'F4', target.ws));
  assert.ok(!f4pre.length || f4pre[0].status === 'OK', 'healthy: the station dwell is below the threshold at the start');
  const controllers = [];
  for (const w of target.crew) {
    const c = await operatorLogin(w);
    const r = await c.cmd(sid, 'TAKE_CONTROL', {});
    assert.equal(r.status, 201, JSON.stringify(r.data));
    controllers.push(c);
  }
  const hb = setInterval(() => { for (const c of controllers) c.req('POST', `/api/sessions/${sid}/commands/CONTROL_HEARTBEAT`, {}).catch(() => {}); }, 20000);
  try {
    await play(admin, sid, 60);
    await lifecycle(admin, sid, 'F1', target.oid, async () => {
      const home = (await controllers[0].get(`${S}/me/home`)).data;
      const next = home.currentTask.milestones.milestones.find(m => !m.done && m.attended && !m.final);
      assert.ok(next, 'a next milestone exists');
      const r = await controllers[0].cmd(sid, 'MILESTONE_COMPLETE', { operationInstanceId: target.oid, milestoneId: next.milestoneId });
      assert.equal(r.status, 201, JSON.stringify(r.data));
    }, 'F1', { fireTimeoutMs: 300000 });
    await play(admin, sid, 60);
    await lifecycle(admin, sid, 'F4', target.ws, async () => {
      const home = (await controllers[0].get(`${S}/me/home`)).data;
      for (const m of home.currentTask.milestones.milestones.filter(x => !x.done && x.attended && !x.final)) {
        const r = await controllers[0].cmd(sid, 'MILESTONE_COMPLETE', { operationInstanceId: target.oid, milestoneId: m.milestoneId });
        assert.equal(r.status, 201, JSON.stringify(r.data));
      }
      const fin = await controllers[0].cmd(sid, 'TASK_FINISH', { taskId: home.currentTask.task.taskId });
      assert.equal(fin.status, 201, JSON.stringify(fin.data));
    }, 'F4', { fireTimeoutMs: 400000 });
  } finally { clearInterval(hb); await pause(admin, sid); }
});
