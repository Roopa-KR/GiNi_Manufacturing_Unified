'use strict';
/* Playwright end-to-end tests: real Chromium driving the BUILT operator and admin apps, which call the REAL API (same-origin /api
   proxy, cookies, CSRF) on the shared database with the engine worker running. No mocked page content.
   Env: OPERATOR_URL (default http://localhost:5173), ADMIN_URL (http://localhost:5174), API_URL, ADMIN_LOGIN, ADMIN_PASSWORD,
        DEMO_PIN_SEED, optional CHROMIUM_PATH. Screenshots of each step go to tests/e2e/.artifacts/. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { Client, demoPin, waitFor, adminClient, freshSession } = require('../integration/helpers');

const OP = (process.env.OPERATOR_URL || 'http://localhost:5173').replace(/\/+$/, '');
const AD = (process.env.ADMIN_URL || 'http://localhost:5174').replace(/\/+$/, '');
const ART = path.join(__dirname, '.artifacts');
fs.mkdirSync(ART, { recursive: true });

let browser;
test.before(async () => {
  const opts = { args: ['--no-sandbox'] };
  if (process.env.CHROMIUM_PATH) opts.executablePath = process.env.CHROMIUM_PATH;
  browser = await chromium.launch(opts);
});
test.after(async () => { if (browser) await browser.close(); });

/** a browser context pinned to a simulation session (the apps remember the chosen session in localStorage) */
async function context(sid) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  if (sid) await ctx.addInitScript(s => { try { localStorage.setItem('gini_session', s); } catch (e) { /* ignore */ } }, sid);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  return { ctx, page, errors };
}
const shot = (page, name) => page.screenshot({ path: path.join(ART, `${name}.png`), fullPage: true });

async function operatorLogin(page, loginId, pin, usePad = true) {
  await page.goto(`${OP}/`);
  await page.fill('#lid', loginId);
  if (usePad) { for (const d of pin) await page.click(`button[aria-label="Digit ${d}"]`); } else await page.fill('#pin', pin);
  assert.equal(await page.inputValue('#pin'), pin, 'the keypad keeps leading zeros');
  await page.click('button[type=submit]');
}
async function adminLogin(page) {
  await page.goto(`${AD}/`);
  await page.fill('#lid', process.env.ADMIN_LOGIN || 'admin');
  await page.fill('#pin', process.env.ADMIN_PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForSelector('nav.sidebar', { timeout: 30000 });
}

async function findWorkingOperator(admin, sid) {
  const wf = await admin.get(`/api/sessions/${sid}/workforce?state=WORKING&role=PRODUCTION_OPERATOR&pageSize=200`);
  for (const w of wf.data.workers) {
    const c = new Client('operator');
    await c.login(w.workerId, demoPin(w.workerId));
    const h = await c.get(`/api/sessions/${sid}/me/home`);
    if (h.data.currentTask && h.data.currentTask.task.status === 'WORKING' && h.data.currentTask.operation.kind === 'LABOR') return { c, home: h.data, workerId: w.workerId };
  }
  return null;
}

test('operator: keypad login shows the running task; pause, reload and resume never restart work', { timeout: 240000 }, async () => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'e2e operator');
  const found = await findWorkingOperator(admin, sid);
  assert.ok(found);
  const { page, ctx, errors } = await context(sid);
  try {
    await operatorLogin(page, found.workerId, demoPin(found.workerId));
    const serial = found.home.currentTask.unit.serial;
    await page.waitForSelector(`text=${serial}`, { timeout: 30000 });
    await page.waitForSelector('button:has-text("Pause")');
    await shot(page, '01-operator-current-task');
    const eligible = await page.textContent('b.num');
    await page.click('button:has-text("Pause")');
    await page.click('[role=dialog] button.primary:has-text("Pause")');
    await page.waitForSelector('button:has-text("Resume")', { timeout: 15000 });
    await page.reload();
    await page.waitForSelector('button:has-text("Resume")', { timeout: 30000 });
    assert.ok(await page.isVisible(`text=${serial}`), 'after reload the same task is shown, paused - not restarted');
    await shot(page, '02-operator-paused-after-reload');
    assert.ok(await page.isVisible('text=You are on break'), 'a planned-break pause puts the worker on break; resuming needs End break first');
    await page.click('button:has-text("End break")');           // ends the break and resumes the paused task in one step
    await page.waitForSelector('button:has-text("Pause")', { timeout: 15000 });
    const h = await found.c.get(`/api/sessions/${sid}/me/home`);
    assert.equal(h.data.currentTask.task.status, 'WORKING');
    assert.equal(h.data.currentTask.task.taskId, found.home.currentTask.task.taskId);
    assert.ok(eligible, 'eligible time is displayed');
    // SPA deep link served by the app host (rewrite/fallback), still authenticated by cookie
    await page.goto(`${OP}/progress`);
    await page.waitForSelector('text=Points', { timeout: 30000 });
    await shot(page, '03-operator-progress-deeplink');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('inspector: photo evidence uploads, is verified and is kept with the submitted inspection', { timeout: 300000 }, async () => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'e2e inspection');
  const S = `/api/sessions/${sid}`;
  const op = await findWorkingOperator(admin, sid);
  const ct = op.home.currentTask;
  for (const m of ct.milestones.milestones.filter(x => !x.done && x.attended && !x.final)) await op.c.cmd(sid, 'MILESTONE_COMPLETE', { operationInstanceId: ct.operation.operationInstanceId, milestoneId: m.milestoneId });
  assert.equal((await op.c.cmd(sid, 'TASK_FINISH', { taskId: ct.task.taskId })).status, 201);
  const insp = await admin.get(`${S}/workforce?role=QUALITY_INSPECTOR&pageSize=200`);
  const crewIds = ct.crew.map(c => c.workerId);
  let inspector = null, ins = null;
  for (const w of insp.data.workers.filter(w => w.attendance === 'CLOCKED_IN' && !['INSPECTING', 'BREAK', 'TRANSFER'].includes(w.activity) && !crewIds.includes(w.workerId))) {
    const c = new Client('operator'); await c.login(w.workerId, demoPin(w.workerId));
    const r = await c.cmd(sid, 'INSPECTION_START', { unitId: ct.unit.unitId, inspectorId: w.workerId });
    if (r.status === 201) { inspector = { c, workerId: w.workerId }; ins = r.data.result.inspection; break; }
  }
  assert.ok(inspector, 'an independent inspector started the inspection');
  // answers entered earlier on another device (draft) - the browser continues from the saved draft
  const view = await inspector.c.get(`${S}/inspections/${ins.INSPECTION_ID}`);
  const answers = {};
  for (const c of view.data.checklist) {
    if (c.answerType === 'YES_NO') { answers[c.checkId] = { answer: c.failureAnswer === 'No' ? 'Yes' : 'No' }; continue; }
    const values = {};
    for (const s of c.specs) { const nom = s.nominal ?? (s.lower !== null && s.upper !== null ? (s.lower + s.upper) / 2 : 0); values[s.position] = Array.from({ length: s.readings || 1 }, () => nom); }
    answers[c.checkId] = { values };
  }
  const dr = await inspector.c.cmd(sid, 'INSPECTION_SAVE_DRAFT', { inspectionId: ins.INSPECTION_ID, answers, expectedVersion: view.data.inspection.version });
  assert.equal(dr.status, 201, JSON.stringify(dr.data));
  const { page, ctx, errors } = await context(sid);
  try {
    await operatorLogin(page, inspector.workerId, demoPin(inspector.workerId), false);
    await page.waitForSelector('nav, .tabbar, header', { timeout: 30000 });
    await page.goto(`${OP}/inspection/${ins.INSPECTION_ID}`);
    await page.waitForSelector('button:has-text("Submit inspection")', { timeout: 30000 });
    // a real PNG through the file input (same path as the camera fallback)
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAHklEQVR4nGNgGAWjYBSMglEwCkbBKBgFo2AUDAMAACwQAAGjnSJoAAAAAElFTkSuQmCC', 'base64');
    await page.locator('input[type=file]').first().setInputFiles({ name: 'weld-seam.png', mimeType: 'image/png', buffer: png });
    await page.waitForSelector('.photo .badge.ok:has-text("Verified")', { timeout: 60000 });
    await shot(page, '04-inspection-photo-verified');
    const rel = page.locator('label.check:has-text("Release to the next operation")');
    if (await rel.count()) await rel.locator('input').check();
    await page.click('button:has-text("Submit inspection")');
    await page.waitForSelector('text=PASS', { timeout: 30000 });
    await shot(page, '05-inspection-submitted');
    const after = await admin.get(`${S}/inspections/${ins.INSPECTION_ID}`);
    assert.equal(after.data.inspection.status, 'SUBMITTED');
    assert.equal(after.data.inspection.result, 'PASS');
    const ev = after.data.evidence || [];
    assert.ok(ev.some(e => e.status === 'VERIFIED'), 'the verified photo is attached to the submitted inspection');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('admin: creates a worker in the UI; the new person signs in to the operator app with zero prior activity', { timeout: 240000 }, async () => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'e2e onboarding');
  const { page, ctx, errors } = await context(sid);
  const last = `Tester${Date.now().toString().slice(-6)}`;
  const pin = '004211';
  let workerId;
  try {
    await adminLogin(page);
    await page.goto(`${AD}/admin?tab=workers`);
    await page.click('button:has-text("New worker")');
    const field = l => page.locator('[role=dialog] .field', { hasText: l }).locator('input, select').first();
    await field('First name').fill('Ana');
    await field('Last name').fill(last);
    await field('Initial PIN').fill(pin);
    await page.locator('[role=dialog] label.check', { hasText: 'Require a PIN change' }).locator('input').uncheck();
    await shot(page, '06-admin-new-worker-form');
    await page.click('[role=dialog] button:has-text("Create worker and login")');
    await page.waitForSelector('text=Worker created', { timeout: 30000 });
    workerId = (await page.locator('[role=dialog] .mono').first().textContent()).trim();
    await shot(page, '07-admin-worker-created');
    assert.match(workerId, /^W\d+/);
    // deep link into another admin section works (SPA fallback) and lists the new person
    await page.goto(`${AD}/workforce`);
    await page.waitForSelector('h1', { timeout: 30000 });
  } finally { await ctx.close(); }
  const o = await context(sid);
  try {
    await operatorLogin(o.page, workerId, pin);
    await o.page.waitForSelector(`text=Ana ${last}`, { timeout: 30000 });
    await shot(o.page, '08-new-worker-home');
    const c = new Client('operator'); await c.login(workerId, pin);
    const home = (await c.get(`/api/sessions/${sid}/me/home`)).data;
    assert.equal(home.currentTask, null, 'no fabricated current task');
    assert.equal(home.points.total.TOTAL, 0, 'zero points');
    assert.notEqual(home.shift.attendance, 'CLOCKED_IN', 'creation and sign-in are not attendance');
    const bad = new Client('operator');
    const r = await bad.req('POST', '/api/auth/login', { loginId: workerId, pin: '4211' });
    assert.equal(r.status, 401, 'leading zeros are part of the PIN');
    assert.deepEqual([...errors, ...o.errors], []);
  } finally { await o.ctx.close(); }
});

test('admin: a scenario-console breakdown appears as an M11 alert in the supervisor UI', { timeout: 240000 }, async () => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'e2e scenario');
  const { page, ctx, errors } = await context(sid);
  try {
    await adminLogin(page);
    await page.goto(`${AD}/admin?tab=scenario`);
    const card = page.locator('.card', { hasText: 'Equipment interruption' });
    await card.waitFor({ timeout: 30000 });
    const eq = await card.locator('select').inputValue();
    const ws = await card.locator('select option:checked').textContent();
    await card.locator('button:has-text("Break down")').click();
    await page.waitForSelector('text=Breakdown recorded', { timeout: 15000 });
    await page.goto(`${AD}/alerts`);
    const station = ws.split('·').pop().trim();
    // the page polls every 5 s: the new alert row for this workstation appears without a manual reload
    await page.waitForSelector(`tr:has(b:text-is("M11")):has-text("${station}")`, { timeout: 60000 });
    await shot(page, '09-admin-alert-m11');
    const al = await admin.get(`/api/sessions/${sid}/alerts?open=1`);
    assert.ok(al.data.alerts.some(a => a.ruleId === 'M11' && a.message.includes(eq)), 'the alert names the broken equipment');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('tank passport: tank links open the right passport in both apps and survive a reload; operators get the role-limited view', { timeout: 240000 }, async () => {
  const admin = await adminClient();
  const sid = await freshSession(admin, 'e2e passport');
  const found = await findWorkingOperator(admin, sid);
  assert.ok(found);
  const unitId = found.home.currentTask.unit.unitId;
  // operator app: the tank on the current-work card is a link
  let { page, ctx, errors } = await context(sid);
  try {
    await operatorLogin(page, found.workerId, demoPin(found.workerId));
    await page.click(`a.tank-link[href="/tanks/${unitId}"]`);
    await page.waitForSelector('text=Identity', { timeout: 30000 });
    assert.ok(page.url().endsWith(`/tanks/${unitId}`));
    assert.ok(await page.isVisible(`text=${unitId}`));
    assert.ok(await page.isVisible('text=Role-limited passport'), 'operators see the role-limited note');
    await page.reload();
    await page.waitForSelector('text=Traceability', { timeout: 30000 });
    await shot(page, '11-operator-tank-passport');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
  // admin app: work-centre station -> passport, and the top-bar search
  ({ page, ctx, errors } = await context(sid));
  try {
    await adminLogin(page);
    await page.goto(`${AD}/work-centers/WC1`);
    const link = page.locator('a.tank-link').first();
    await link.waitFor({ timeout: 30000 });
    const href = await link.getAttribute('href');
    await link.click();
    await page.waitForSelector('text=Current state', { timeout: 30000 });
    assert.ok(page.url().endsWith(href));
    await page.reload();
    await page.waitForSelector('text=People and labour', { timeout: 30000 });
    await shot(page, '12-admin-tank-passport');
    await page.fill('input[aria-label="Find tank by ID or serial"]', unitId);
    await page.click(`[role=listbox] a.tank-link[href="/units/${unitId}"]`, { timeout: 30000 });
    await page.waitForSelector(`text=${unitId}`, { timeout: 30000 });
    assert.ok(page.url().endsWith(`/units/${unitId}`));
    await shot(page, '13-admin-search-to-passport');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

// ------------------------------------------------------------------------------------------------------------------------------
// Every browser closed: the simulation continues on the server (clock, agents, engine) and nothing is restarted or duplicated
// when the person comes back in a brand-new browser context (no cookies, no local storage carried over).
test('browser closed: the simulation keeps running without any browser; a new browser sees the continued state, no restart', { timeout: 300000 }, async () => {
  const { MongoClient } = require('mongodb');
  const admin = await adminClient();
  const sid = await freshSession(admin, 'e2e browser closed');
  const S = `/api/sessions/${sid}`;
  const found = await findWorkingOperator(admin, sid);
  assert.ok(found, 'a working operator');
  const taskId = found.home.currentTask.task.taskId;
  const a = await context(sid), b = await context(sid);
  await operatorLogin(a.page, found.workerId, demoPin(found.workerId));
  await a.page.waitForSelector('button:has-text("Pause")', { timeout: 30000 });
  await adminLogin(b.page);
  const before = (await admin.get(S)).data.session;
  await a.ctx.close(); await b.ctx.close();                         // every browser for this session is gone
  await admin.post(`${S}/clock`, { action: 'SPEED', speed: 30 });
  await admin.post(`${S}/clock`, { action: 'PLAY' });
  await new Promise(r => setTimeout(r, 25000));                       // ~12 simulated minutes with no browser open
  await admin.post(`${S}/clock`, { action: 'PAUSE' });
  const after = await waitFor(async () => { const s = (await admin.get(S)).data.session; return s.engine.projectionVersion > before.engine.projectionVersion ? s : null; }, { timeoutMs: 60000, what: 'engine published while no browser was open' });
  const advancedMin = (new Date(after.simNow) - new Date(before.simNow)) / 60000;
  assert.ok(advancedMin >= 8, `the simulated clock advanced on the server (${advancedMin.toFixed(1)} min)`);
  assert.ok(after.eventSeq > before.eventSeq, 'events were processed while no browser was open');
  const mongo = await MongoClient.connect(process.env.MONGODB_URI);
  try {
    const db = mongo.db(process.env.MONGODB_DB_NAME);
    const t = await db.collection('sim_tasks').findOne({ SESSION_ID: sid, TASK_ID: taskId });
    assert.ok(t, 'the original task still exists');
    if (found.home.currentTask.task.startedAt) assert.equal(+new Date(t.STARTED_AT), +new Date(found.home.currentTask.task.startedAt), 'the task start time was not reset');
    const working = await db.collection('sim_tasks').countDocuments({ SESSION_ID: sid, WORKER_ID: found.workerId, STATUS: 'WORKING' });
    assert.ok(working <= 1, `never two running tasks for one person (${working})`);
    // a brand-new browser: same server state, nothing restarted
    const c = await context(sid);
    try {
      await operatorLogin(c.page, found.workerId, demoPin(found.workerId));
      const home = (await found.c.get(`${S}/me/home`)).data;
      if (home.currentTask && home.currentTask.task.taskId === taskId) {
        await c.page.waitForSelector(`text=${found.home.currentTask.unit.serial}`, { timeout: 30000 });
      }
      await c.page.waitForSelector('text=Synthetic interactive demo', { timeout: 30000 });
      await shot(c.page, '14-operator-new-browser-after-close');
      assert.deepEqual(c.errors, []);
    } finally { await c.ctx.close(); }
  } finally { await mongo.close(); }
});

// ------------------------------------------------------------------------------------------------------------------------------
// A cutoff passes with NO operational event for that line: the engine evaluates AT the boundary (cutoff + 1 s), the projection
// says so (TRIGGER "BOUNDARY: cutoff passed for <line>", AS_OF = boundary to the second), and the supervisor Recovery page shows
// "cutoff elapsed" within 15 s of the crossing at x1 (normal speed), including the page's own 5 s polling.
test('deadline crossing at x1: evaluated at cutoff + 1 s without an event and visible in the supervisor UI within 15 s', { timeout: 300000 }, async () => {
  const { MongoClient } = require('mongodb');
  const admin = await adminClient();
  const sid = await freshSession(admin, 'e2e deadline crossing');
  const S = `/api/sessions/${sid}`;
  const prods = (await admin.get('/api/admin/master/products')).data.products.filter(p => p.status === 'RELEASED' && p.routingOperations > 0);
  assert.ok(prods.length, 'a released product with routing');
  const simNow = new Date((await admin.get(S)).data.session.simNow);
  const due = new Date(simNow.getTime() + 75000);                     // cutoff 75 simulated seconds ahead
  const r = await admin.cmd(sid, 'ORDER_CREATE', { lines: [{ productId: prods[0].productId, requiredGoodQty: 1, dueAt: due.toISOString() }] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const lineId = r.data.result.lines[0].orderLineId;
  const boundary = new Date(due.getTime() + 1000);
  const mongo = await MongoClient.connect(process.env.MONGODB_URI);
  const db = mongo.db(process.env.MONGODB_DB_NAME);
  const { page, ctx, errors } = await context(sid);
  try {
    // the line is in a published forecast, cutoff not elapsed, and the cutoff boundary is scheduled to the second
    await waitFor(async () => { const s = await db.collection('sim_sessions').findOne({ SESSION_ID: sid }); return ((s.ENGINE || {}).NEXT_BOUNDARIES || []).some(b => +new Date(b.at) === +boundary && b.reason.includes(lineId)); }, { timeoutMs: 120000, what: 'cutoff boundary scheduled at cutoff + 1 s' });
    const pre = (await admin.get(`${S}/forecasts`)).data.orders.find(o => o.ORDER_LINE_ID === lineId);
    assert.ok(pre && pre.CUTOFF_ELAPSED === false, 'before the crossing the cutoff has not elapsed');
    await adminLogin(page);
    await page.goto(`${AD}/recovery`);
    await page.waitForSelector(`tr:has-text("${lineId}")`, { timeout: 30000 });
    assert.equal(await page.isVisible(`tr:has-text("${lineId}") >> text=cutoff elapsed`), false);
    await admin.post(`${S}/clock`, { action: 'SPEED', speed: 1 });
    await admin.post(`${S}/clock`, { action: 'PLAY' });
    await page.waitForSelector(`tr:has-text("${lineId}") >> text=cutoff elapsed`, { timeout: 150000 });
    const visibleAt = Date.now();
    await shot(page, '15-admin-cutoff-elapsed-at-boundary');
    const s = await db.collection('sim_sessions').findOne({ SESSION_ID: sid });
    const c = s.CLOCK;                                                // the wall time at which the shared clock reached the boundary
    const crossedAtWall = new Date(c.ANCHOR_WALL_AT).getTime() + (boundary - new Date(c.ANCHOR_SIM_AT)) / (c.SPEED || 1);
    const latencyMs = visibleAt - crossedAtWall;
    const proj = await db.collection('sim_projections').find({ SESSION_ID: sid, KIND: 'ORDER_FORECAST_SUMMARY', TRIGGER: { $regex: `^BOUNDARY: cutoff passed for ${lineId}` } }).toArray();
    assert.ok(proj.length >= 1, 'a projection was computed because of the boundary (not an event or the periodic pass)');
    assert.equal(+new Date(proj[0].AS_OF), +boundary, 'evaluated as of cutoff + 1 s exactly, not the next whole minute');
    const line = proj[0].DATA.find(o => o.ORDER_LINE_ID === lineId);
    assert.equal(line.CUTOFF_ELAPSED, true);
    assert.equal(line.BAND, 'RED', 'without the required output the line is RED once the cutoff has elapsed');
    fs.writeFileSync(path.join(ART, 'deadline-crossing.json'), JSON.stringify({ sessionId: sid, orderLineId: lineId, cutoff: due, boundary, projectionAsOf: proj[0].AS_OF, trigger: proj[0].TRIGGER, computedAt: proj[0].COMPUTED_AT, crossedAtWall: new Date(crossedAtWall), visibleInUiAt: new Date(visibleAt), latencyMs, targetMs: 15000, speed: c.SPEED }, null, 2));
    assert.ok(latencyMs <= 15000, `visible ${latencyMs} ms after the crossing (target <= 15000 ms at x1)`);
    assert.deepEqual(errors, []);
  } finally { await admin.post(`${S}/clock`, { action: 'PAUSE' }); await ctx.close(); await mongo.close(); }
});
