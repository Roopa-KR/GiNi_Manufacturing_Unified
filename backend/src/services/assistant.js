'use strict';
/* GiNi Assistant - Google Gemini chatbot grounded in the signed-in user's live, permission-filtered plant data.
   The API key lives only in backend/.env (GEMINI_API_KEY) and is never sent to the browser. The assistant is read-only:
   it explains and guides, it never executes commands. */
const { config } = require('../config/env');
const E = require('../lib/errors');

const SUP = ['operational_supervision', 'quality_approval', 'view_all_workers', 'scenario_control'];
const MAX_HISTORY = 12;
const MAX_MSG_CHARS = 4000;
const MAX_CONTEXT_CHARS = 60000;

/* ------------------------------------------------------------------ per-user rate limit (in-memory, per API instance) */
const hits = new Map();
function rateLimit(key) {
  const c = config();
  const now = Date.now(), win = 60000;
  const arr = (hits.get(key) || []).filter(t => now - t < win);
  if (arr.length >= c.gemini.ratePerMin) {
    const err = new E.AppError(429, 'ASSISTANT_RATE_LIMIT', `Too many assistant questions - wait a minute (limit ${c.gemini.ratePerMin} per minute)`);
    throw err;
  }
  arr.push(now);
  hits.set(key, arr);
}

/* ------------------------------------------------------------------ compact JSON: trims long arrays/strings so the prompt stays small */
function compact(value, { maxArray = 25, maxString = 400 } = {}) {
  const seen = new WeakSet();
  return JSON.stringify(value, function (k, v) {
    if (k === '_id' || k === '_seed' || k === 'dataset_id') return undefined;
    if (v && typeof v === 'object') {
      if (seen.has(v)) return undefined;
      seen.add(v);
      if (Array.isArray(v) && v.length > maxArray) return [...v.slice(0, maxArray), `... ${v.length - maxArray} more not shown`];
    }
    if (typeof v === 'string' && v.length > maxString) return v.slice(0, maxString) + '…';
    return v;
  });
}

async function safe(label, fn, out) {
  try { const v = await fn(); if (v !== undefined && v !== null) out.push(`### ${label}\n${typeof v === 'string' ? v : compact(v)}`); }
  catch (e) { out.push(`### ${label}\n(unavailable: ${e.message})`); }
}

/** live context the user is allowed to see: the same read models the screens use, filtered by the user's permissions */
async function buildContext(req, sessionId, page) {
  const S = require('./sessions');
  const V = require('./viewsCommon');
  const P = require('./plantViews');
  const OV = require('./operatorViews');
  const Passport = require('./passport');
  const perms = req.auth.permissions || [];
  const isSup = SUP.some(p => perms.includes(p));
  const out = [];
  if (!sessionId) return { text: 'No simulation / factory session is active, so there is no live plant data.', isSup };
  let s;
  try { s = await S.get(sessionId); } catch (e) { return { text: `Session ${sessionId} could not be loaded (${e.message}).`, isSup }; }
  if (s.STATUS === 'INITIALIZING') return { text: `Session ${sessionId} is still being initialised by the engine worker - live data appears in a few seconds.`, isSup };
  const x = await V.ctx(s);
  x.perms = perms;

  if (isSup) {
    await safe('Plant overview (people, work centres, production, orders at risk, top alerts)', () => P.overview(x), out);
    await safe('Open alerts (most recent first)', async () => {
      const a = await P.alerts(x, { open: '1' });
      return a.alerts.slice(0, 30).map(r => ({ alertId: r.alertId, ruleId: r.ruleId, ruleName: r.ruleName, severity: r.severity, evaluation: r.evaluation, workflow: r.workflow, entityId: r.entityId, message: r.message, recommended: r.recommended, actual: r.actual, expected: r.expected, firstDetectedLocal: r.firstDetectedLocal, owner: r.owner }));
    }, out);
    await safe('Order forecasts', async () => { const f = await P.forecasts(x); return { orders: f.orders, computedAt: f.ordersComputedAt, method: f.method }; }, out);
  }
  if (req.auth.workerId) {
    await safe(`Signed-in worker's own view (${req.auth.workerId})`, () => OV.home(x, req.auth.workerId), out);
    if (!isSup) await safe('My queue', () => OV.queue(x, req.auth.workerId), out);
  }

  // what the user is looking at right now (deep links of both apps)
  const p = String(page || '').split('?')[0];
  let m;
  if ((m = /^\/(?:units|tanks)\/([^/]+)$/.exec(p))) await safe(`Tank passport currently open (${decodeURIComponent(m[1])})`, () => Passport.full(x, decodeURIComponent(m[1]), req.auth), out);
  else if ((m = /^\/work-centers\/([^/]+)$/.exec(p))) await safe(`Work centre currently open (${decodeURIComponent(m[1])})`, () => P.workCenter(x, decodeURIComponent(m[1])), out);
  else if (isSup && (m = /^\/orders\/([^/]+)$/.exec(p))) await safe(`Order line currently open (${decodeURIComponent(m[1])})`, () => P.orderLine(x, decodeURIComponent(m[1])), out);
  else if (isSup && (m = /^\/workforce\/([^/]+)$/.exec(p))) await safe(`Worker currently open (${decodeURIComponent(m[1])})`, () => P.workerDetail(x, decodeURIComponent(m[1])), out);
  else if (isSup && p.startsWith('/quality')) await safe('Quality & rework', () => P.quality(x), out);
  else if (isSup && p.startsWith('/materials')) await safe('Materials & equipment', () => P.materials(x), out);
  else if (isSup && p.startsWith('/workforce')) await safe('Workforce', () => P.workforce(x, {}), out);

  let text = out.join('\n\n');
  if (text.length > MAX_CONTEXT_CHARS) text = text.slice(0, MAX_CONTEXT_CHARS) + '\n…(context truncated)';
  return { text: text || 'No live data was available for this user.', isSup };
}

function systemPrompt({ appKind, isSup, user, page, contextText, environment }) {
  const app = appKind === 'admin' ? 'GiNi Supervisor (admin) app' : 'GiNi Operator app';
  const screens = appKind === 'admin'
    ? 'Screens: Overview, Orders & Batches (tank passports), Work Centers, Workforce, Quality & Rework, Alerts, Recovery, Verify, Materials & Equipment, Administration (workers, sessions & clock, scenario console, rules, jobs, notifications, import, audit). Fresh factory adds Factory setup and Dispatch & assign. The top bar has tank search, the simulation clock (play/pause/speed) and Recalculate.'
    : 'Screens: Work (current task, milestones, start/pause/help/handover), Queue, Progress (points ledger), Profile. The Scan button reads tank / station labels. After a task the operator completes the mandatory inspection (with photo evidence) and can report an incoming defect from the tank passport.';
  return [
    `You are "GiNi Assistant", the AI helper built into the ${app} of GiNi Manufacturing - a transformer-tank production demonstration (Siemens Energy use case). All data is synthetic: fictional people and plant.`,
    `The user is ${user.name || user.loginId} (roles: ${(user.roles || []).join(', ') || 'none'}; ${isSup ? 'supervisor-level access' : 'operator-level access - only their own work'}). Environment: ${environment}. Current screen: ${page || '/'}.`,
    screens,
    'Rules:',
    '- Answer from the LIVE CONTEXT below. Quote IDs (tank/unit, order line, work centre, alert, worker) exactly as they appear. Never invent numbers, IDs or states; if the answer is not in the context, say so and point to the screen where it can be found.',
    '- Distinguish observed state from FORECAST values, and mention the simulation time (simNowLocal) when timing matters.',
    '- You cannot change anything in the app. For actions (acknowledge an alert, start a task, approve rework, change the clock) explain where to click.',
    '- Do not reveal details about other workers to an operator-level user.',
    '- Be concise: short paragraphs or bullet lists, plain language suited to a shop floor or supervisor. Use **bold** for key figures.',
    '',
    '=== LIVE CONTEXT (JSON, read-only, generated just now) ===',
    contextText,
    '=== END OF CONTEXT ===',
  ].join('\n');
}

/* ------------------------------------------------------------------ Gemini REST call (no SDK dependency; Node 22 global fetch) */
async function callGemini(system, history) {
  const c = config().gemini;
  const contents = history.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const body = { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature: c.temperature } };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(c.model)}:generateContent`;
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': c.apiKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(c.timeoutMs) });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw E.unavailable('ASSISTANT_TIMEOUT', 'Gemini did not answer in time - try again');
    throw E.unavailable('ASSISTANT_UNREACHABLE', `Gemini could not be reached from the API server (${e.message})`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || `HTTP ${res.status}`;
    if (res.status === 400 && /api key/i.test(msg)) throw E.unavailable('ASSISTANT_BAD_KEY', 'Gemini rejected the API key - check GEMINI_API_KEY in backend/.env');
    if (res.status === 403) throw E.unavailable('ASSISTANT_FORBIDDEN', `Gemini refused the request (${msg}) - check that the key is valid and the Generative Language API is enabled`);
    if (res.status === 404) throw E.unavailable('ASSISTANT_MODEL', `Gemini model "${c.model}" was not found - set GEMINI_MODEL in backend/.env (e.g. gemini-2.5-flash)`);
    if (res.status === 429) throw new E.AppError(429, 'ASSISTANT_QUOTA', 'Gemini quota / rate limit reached - wait a moment and try again');
    throw E.unavailable('ASSISTANT_ERROR', `Gemini error: ${msg}`);
  }
  if (data.promptFeedback && data.promptFeedback.blockReason) return { text: `I can't answer that (blocked by Gemini safety filter: ${data.promptFeedback.blockReason}).`, finish: 'BLOCKED' };
  const cand = (data.candidates || [])[0] || {};
  const text = ((cand.content && cand.content.parts) || []).filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
  return { text: text || 'Gemini returned an empty answer - please rephrase the question.', finish: cand.finishReason || null, usage: data.usageMetadata || null };
}

function status() {
  const c = config().gemini;
  return { enabled: !!c.apiKey, model: c.model, hint: c.apiKey ? null : 'Add GEMINI_API_KEY=<your key> to backend/.env and restart the API.' };
}

async function chat(req, body) {
  const c = config();
  if (!c.gemini.apiKey) throw E.unavailable('ASSISTANT_NOT_CONFIGURED', 'The AI assistant is not configured - add GEMINI_API_KEY to backend/.env and restart the API');
  rateLimit(req.auth.loginId);
  const raw = Array.isArray(body && body.messages) ? body.messages : [];
  const history = raw.filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_HISTORY).map(m => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }));
  while (history.length && history[0].role !== 'user') history.shift();   // Gemini conversations must start with the user
  if (!history.length || history[history.length - 1].role !== 'user') throw E.bad('ASSISTANT_NO_QUESTION', 'Type a question first');
  const sessionId = body.sessionId ? String(body.sessionId).slice(0, 100) : null;
  const page = body.page ? String(body.page).slice(0, 300) : '/';
  const ctx = await buildContext(req, sessionId, page);
  const db = require('../lib/db');
  let user = { loginId: req.auth.loginId, roles: req.auth.roles };
  try {
    const d = await db.getDb();
    const w = req.auth.workerId ? await d.collection('worker_master').findOne({ dataset_id: c.datasetId, WORKER_ID: req.auth.workerId }, { projection: { DISPLAY_NAME: 1 } }) : null;
    const a = w ? null : await d.collection('accounts').findOne({ dataset_id: c.datasetId, login_id: req.auth.loginId }, { projection: { display_name: 1 } });
    user.name = (w && w.DISPLAY_NAME) || (a && a.display_name) || req.auth.loginId;
  } catch (e) { /* the name is optional */ }
  const system = systemPrompt({ appKind: req.appKind, isSup: ctx.isSup, user, page, contextText: ctx.text, environment: c.environmentName });
  const ans = await callGemini(system, history);
  return { reply: ans.text, model: c.gemini.model, finishReason: ans.finish, generatedAt: new Date().toISOString() };
}

module.exports = { chat, status, _compact: compact, _systemPrompt: systemPrompt };
