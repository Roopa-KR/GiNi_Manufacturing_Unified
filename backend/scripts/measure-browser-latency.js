'use strict';
/* Browser-visible latency (real Chromium on the built apps, real API + database + engine; background agents active):
     A. operator clicks Pause on the current task -> the UI shows the committed paused state ("Resume" visible)   target <= 5 s
        (and End break -> "Pause" visible again)
     B. equipment breakdown (scenario command) -> the M11 row appears on the supervisor Alerts page               target <= 15 s
     C. a command -> the supervisor header shows "Analytics up to date" for a projection that includes it         target <= 15 s
   Times include the apps' normal polling intervals (what a user actually sees).
     node scripts/measure-browser-latency.js [--iterations 5] [--speed 1] [--out docs/test-results/latency-browser.json]
   Env: API_URL, OPERATOR_URL, ADMIN_URL, ADMIN_LOGIN, ADMIN_PASSWORD, DEMO_PIN_SEED, CHROMIUM_PATH (optional). */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { Client, demoPin, waitFor, adminClient } = require('../tests/integration/helpers');

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const N = Number(arg('iterations', 5));
const SPEED = Number(arg('speed', 1));
const OUT = arg('out', null);
const OP = (process.env.OPERATOR_URL || 'http://localhost:5173').replace(/\/+$/, '');
const AD = (process.env.ADMIN_URL || 'http://localhost:5174').replace(/\/+$/, '');
const stats = xs => { const s = [...xs].sort((a, b) => a - b); const q = p => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; return s.length ? { n: s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1], min: s[0] } : { n: 0 }; };

(async () => {
  const admin = await adminClient();
  const r = await admin.post('/api/sessions', { mode: 'INTERACTIVE', checkpointId: 'CK-20261015-1055', name: 'browser latency' });
  const sid = r.data.session.sessionId, S = `/api/sessions/${sid}`;
  await waitFor(async () => ((await admin.get(S)).data.session || {}).status === 'READY', { timeoutMs: 180000, what: 'session ready' });
  await admin.post(`${S}/clock`, { action: 'SPEED', speed: SPEED });
  await admin.post(`${S}/clock`, { action: 'PLAY' });
  const opts = { args: ['--no-sandbox'] };
  if (process.env.CHROMIUM_PATH) opts.executablePath = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch(opts);
  const result = { sessionId: sid, measuredAt: new Date().toISOString(), speed: SPEED, iterations: N, method: 'Playwright Chromium on the built apps; wall-clock from the user action/command to the visible UI state' };
  try {
    // ---------------------------------------------------------------- A. operator command -> visible state
    const wf = await admin.get(`${S}/workforce?state=WORKING&role=PRODUCTION_OPERATOR&pageSize=200`);
    let who = null;
    for (const w of wf.data.workers) {
      const c = new Client('operator'); await c.login(w.workerId, demoPin(w.workerId));
      const h = await c.get(`${S}/me/home`);
      if (h.data.currentTask && h.data.currentTask.task.status === 'WORKING' && h.data.currentTask.operation.kind === 'LABOR') { who = w.workerId; break; }
    }
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    await ctx.addInitScript(s => { try { localStorage.setItem('gini_session', s); } catch (e) { /* ignore */ } }, sid);
    const page = await ctx.newPage();
    await page.goto(`${OP}/`);
    await page.fill('#lid', who);
    await page.fill('#pin', demoPin(who));
    await page.click('button[type=submit]');
    await page.waitForSelector('button:has-text("Pause")', { timeout: 30000 });
    const pauseMs = [], resumeMs = [];
    for (let i = 0; i < N; i++) {
      await page.click('button:has-text("Pause")');
      const t0 = Date.now();
      await page.click('[role=dialog] button.primary:has-text("Pause")');
      await page.waitForSelector('button:has-text("End break")', { timeout: 15000 });
      pauseMs.push(Date.now() - t0);
      const t1 = Date.now();
      await page.click('button:has-text("End break")');
      await page.waitForSelector('button:has-text("Pause")', { timeout: 15000 });
      resumeMs.push(Date.now() - t1);
    }
    await ctx.close();
    result.operatorCommandToVisibleMs = { pause: stats(pauseMs), endBreakResume: stats(resumeMs), targetMs: 5000 };
    // ---------------------------------------------------------------- B/C. supervisor UI
    const actx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await actx.addInitScript(s => { try { localStorage.setItem('gini_session', s); } catch (e) { /* ignore */ } }, sid);
    const ap = await actx.newPage();
    await ap.goto(`${AD}/`);
    await ap.fill('#lid', process.env.ADMIN_LOGIN || 'admin');
    await ap.fill('#pin', process.env.ADMIN_PASSWORD);
    await ap.click('button[type=submit]');
    await ap.waitForSelector('nav.sidebar', { timeout: 30000 });
    await ap.goto(`${AD}/alerts`);
    await ap.waitForSelector('h1', { timeout: 30000 });
    const mats = (await admin.get(`${S}/materials`)).data.equipment.filter(e => e.status !== 'DOWN');
    const alertMs = [], analyticsMs = [];
    for (const eq of mats.slice(0, Math.min(3, N))) {
      const t0 = Date.now();
      const b = await admin.cmd(sid, 'EQUIPMENT_BREAKDOWN', { equipmentId: eq.equipmentId, estimatedRecoveryMin: 60, reasonCode: 'RANDOM_FAILURE' });
      if (b.status !== 201) continue;
      await ap.waitForSelector(`tr:has(b:text-is("M11")):has-text("${eq.workstationId}")`, { timeout: 60000 });
      alertMs.push(Date.now() - t0);
      await admin.cmd(sid, 'EQUIPMENT_REPAIRED', { equipmentId: eq.equipmentId });
    }
    for (let i = 0; i < Math.min(3, N); i++) {
      const before = (await admin.get(S)).data.session;
      const t0 = Date.now();
      await admin.cmd(sid, 'MATERIAL_REQUEST', { materialId: 'MAT-KIT-S', qty: 1, needByMin: 240 });
      const target = before.eventSeq + 1;
      // what the user sees: the header badge returns to "Analytics up to date" once a projection that includes the command is published
      await waitFor(async () => {
        const s = (await admin.get(S)).data.session;
        if (s.engine.watermarkSeq < target) return false;
        return ap.isVisible('text=Analytics up to date');
      }, { timeoutMs: 60000, everyMs: 250, what: 'analytics up to date' });
      analyticsMs.push(Date.now() - t0);
    }
    await actx.close();
    result.eventToAlertVisibleMs = { ...stats(alertMs), targetMs: 15000 };
    result.eventToAnalyticsVisibleMs = { ...stats(analyticsMs), targetMs: 15000 };
    const db = await (require('mongodb').MongoClient.connect(process.env.MONGODB_URI));
    const identity = await (async () => { try { const bi = await db.db().admin().command({ buildInfo: 1 }); return bi.version; } catch (e) { return 'unknown'; } })();
    await db.close();
    result.environment = { node: process.version, cpus: os.cpus().length, cpuModel: (os.cpus()[0] || {}).model, memGb: Math.round(os.totalmem() / 2 ** 30), database: /docdb/.test(identity) ? `TEST SUBSTITUTE (${identity})` : `MongoDB ${identity}` };
    result.pass = result.operatorCommandToVisibleMs.pause.max <= 5000 && result.operatorCommandToVisibleMs.endBreakResume.max <= 5000 && (result.eventToAlertVisibleMs.max || 0) <= 15000 && (result.eventToAnalyticsVisibleMs.max || 0) <= 15000;
  } finally {
    await browser.close();
    await admin.post(`${S}/archive`, {});
  }
  const txt = JSON.stringify(result, null, 2);
  console.log(txt);
  if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, txt); }
})().catch(e => { console.error(e); process.exit(1); });
