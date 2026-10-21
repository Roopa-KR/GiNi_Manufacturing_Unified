'use strict';
/* AT25 latency measurement against the REAL API + database + engine worker (no mocks).
     node scripts/measure-latency.js [--iterations 10] [--speed 1] [--out docs/test-results/latency.json]
   Creates a fresh interactive session, runs the clock at the given speed (background agents active = the demo workload), and measures:
     A. operator command -> immediately visible observed state (POST command, then poll GET /me/home)          target <= 5 s
     B. event -> recomputed alert (equipment breakdown -> M11 FIRING visible in GET /alerts, no manual recalc)  target <= 15 s
     C. event -> recomputed forecast (command -> new projection version published, analytics UP_TO_DATE)      target <= 15 s
   Reports p50/p95/max, the hardware, the database kind and the job backlog. Requires ADMIN_PASSWORD and DEMO_PIN_SEED (local demo PINs). */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Client, demoPin, waitFor, adminClient } = require('../tests/integration/helpers');

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const N = Number(arg('iterations', 10));
const SPEED = Number(arg('speed', 1));
const OUT = arg('out', null);
const stats = xs => { const s = [...xs].sort((a, b) => a - b); const q = p => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; return { n: s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1], min: s[0] }; };
const ms = t0 => Date.now() - t0;

(async () => {
  const admin = await adminClient();
  const r = await admin.post('/api/sessions', { mode: 'INTERACTIVE', checkpointId: 'CK-20261015-1055', name: 'latency measurement' });
  if (r.status !== 201) throw new Error(JSON.stringify(r.data));
  const sid = r.data.session.sessionId, S = `/api/sessions/${sid}`;
  const tInit = Date.now();
  await waitFor(async () => ((await admin.get(S)).data.session || {}).status === 'READY', { timeoutMs: 180000, what: 'session ready' });
  const initMs = ms(tInit);
  const result = { sessionId: sid, measuredAt: new Date().toISOString(), speed: SPEED, iterations: N, sessionInitMs: initMs };
  try {
    await admin.post(`${S}/clock`, { action: 'SPEED', speed: SPEED });
    await admin.post(`${S}/clock`, { action: 'PLAY' });
    // A. operator command -> visible observed state
    const wf = await admin.get(`${S}/workforce?state=WORKING&role=PRODUCTION_OPERATOR&pageSize=200`);
    let op = null, task = null;
    for (const w of wf.data.workers) {
      const c = new Client('operator'); await c.login(w.workerId, demoPin(w.workerId));
      const h = await c.get(`${S}/me/home`);
      if (h.data.currentTask && h.data.currentTask.task.status === 'WORKING' && h.data.currentTask.operation.kind === 'LABOR') { op = c; task = h.data.currentTask.task.taskId; break; }
    }
    const take = await op.cmd(sid, 'TAKE_CONTROL', {});   // human control: background agents leave this worker alone during the measurement
    const A = [], cmdOnly = [];
    for (let i = 0; i < N; i++) {
      const pause = i % 2 === 0;
      const t0 = Date.now();
      const c = await op.cmd(sid, pause ? 'TASK_PAUSE' : 'TASK_RESUME', pause ? { taskId: task, reason: 'WAITING_FOR_INSTRUCTION' } : { taskId: task });
      cmdOnly.push(ms(t0));
      if (c.status !== 201) throw new Error(`A: ${JSON.stringify(c.data)}`);
      await waitFor(async () => { const h = await op.get(`${S}/me/home`); const st = h.data.currentTask && h.data.currentTask.task.status; return pause ? st === 'PAUSED' : st === 'WORKING'; }, { timeoutMs: 30000, everyMs: 50, what: 'observed state' });
      A.push(ms(t0));
    }
    if (take.status === 201) await op.cmd(sid, 'RELEASE_CONTROL', {});
    // B. event -> recomputed alert (the engine picks up the new event on its own)
    const mats = (await admin.get(`${S}/materials`)).data.equipment.filter(e => e.status === 'UP');
    const B = [];
    for (const eq of mats.slice(0, Math.min(3, Math.max(1, Math.floor(N / 3))))) {
      const t0 = Date.now();
      const b = await admin.cmd(sid, 'EQUIPMENT_BREAKDOWN', { equipmentId: eq.equipmentId, estimatedRecoveryMin: 60, reasonCode: 'RANDOM_FAILURE' });
      if (b.status !== 201) throw new Error(`B: ${JSON.stringify(b.data)}`);
      await waitFor(async () => ((await admin.get(`${S}/alerts?open=1`)).data.alerts || []).some(a => a.ruleId === 'M11' && a.entityId === eq.workstationId && ['FIRING', 'PENDING'].includes(a.evaluation)), { timeoutMs: 90000, everyMs: 200, what: 'M11 visible' });
      B.push(ms(t0));
      await admin.cmd(sid, 'EQUIPMENT_REPAIRED', { equipmentId: eq.equipmentId });
    }
    // C. event -> recomputed forecast/projection
    const C = [];
    const mat = (await admin.get(`${S}/materials`)).data.materials[0];
    for (let i = 0; i < Math.min(5, N); i++) {
      const v0 = (await admin.get(S)).data.session.engine.projectionVersion;
      const t0 = Date.now();
      const m = await admin.cmd(sid, 'MATERIAL_SHORTAGE', { materialId: mat.materialId, holdQty: i % 2, reason: 'QUALITY_HOLD' });
      if (m.status !== 201) throw new Error(`C: ${JSON.stringify(m.data)}`);
      const seq = m.data.events[m.data.events.length - 1].EVENT_SEQ;
      await waitFor(async () => { const s = (await admin.get(S)).data.session; return s.engine.projectionVersion > v0 && s.engine.watermarkSeq >= seq; }, { timeoutMs: 90000, everyMs: 200, what: 'projection published' });
      C.push(ms(t0));
    }
    const jobs = await admin.get('/api/admin/jobs');
    const integ = await admin.get('/api/admin/integrations');
    Object.assign(result, {
      A_operatorCommandToVisibleStateMs: stats(A), A_commandRoundTripMs: stats(cmdOnly), A_targetMs: 5000, A_pass: stats(A).max <= 5000,
      B_eventToAlertMs: stats(B), B_targetMs: 15000, B_pass: stats(B).max <= 15000,
      C_eventToForecastMs: stats(C), C_targetMs: 15000, C_pass: stats(C).max <= 15000,
      backlog: jobs.data.counts, engine: integ.data.engine, database: integ.data.database,
      hardware: { cpus: os.cpus().length, cpuModel: (os.cpus()[0] || {}).model, memoryGb: Math.round(os.totalmem() / 1e9), platform: `${os.platform()} ${os.release()}`, node: process.version },
      note: 'Single machine running API, engine and database together; agents active at the stated speed. Acceptance targets, not guarantees; re-measure on the deployed stack (Vercel + Render + Atlas) where network round trips add latency.',
    });
  } finally {
    await admin.post(`${S}/clock`, { action: 'PAUSE' });
    await admin.post(`${S}/archive`, {});
  }
  const txt = JSON.stringify(result, null, 2);
  console.log(txt);
  if (OUT) { fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true }); fs.writeFileSync(OUT, txt + '\n'); }
})().catch(e => { console.error(e); process.exit(1); });
