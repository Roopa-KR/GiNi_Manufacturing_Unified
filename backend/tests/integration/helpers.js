'use strict';
/* Integration-test client: the REAL Express API over HTTP (cookies, CSRF, exact origin, idempotency keys) against the shared database.
   Requires the API (npm start), the database and - for engine-driven checks - the Python worker. Env:
   API_URL (default http://localhost:5000), FRONTEND_URL/ADMIN_URL (origins the API allows), DEMO_PIN_SEED, ADMIN_LOGIN, ADMIN_PASSWORD. */
const crypto = require('crypto');

const API = (process.env.API_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/+$/, '');
const ORIGINS = { operator: process.env.FRONTEND_URL || 'http://localhost:5173', admin: process.env.ADMIN_URL || 'http://localhost:5174' };

function demoPin(loginId) {
  if (!process.env.DEMO_PIN_SEED) throw new Error('DEMO_PIN_SEED is required to derive local demo PINs for tests');
  const h = crypto.createHmac('sha256', process.env.DEMO_PIN_SEED).update(loginId).digest('hex');
  return String(BigInt('0x' + h) % 1000000n).padStart(6, '0');
}

class Client {
  constructor(kind = 'operator') { this.kind = kind; this.cookies = {}; this.csrf = null; this.user = null; }
  async req(method, path, body, headers = {}) {
    const h = { 'content-type': 'application/json', origin: ORIGINS[this.kind], 'x-app-kind': this.kind, ...headers };
    const ck = Object.entries(this.cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    if (ck) h.cookie = ck;
    if (this.csrf && method !== 'GET') h['x-csrf-token'] = this.csrf;
    const res = await fetch(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [kv] = sc.split(';'); const i = kv.indexOf('=');
      const k = kv.slice(0, i).trim(), v = decodeURIComponent(kv.slice(i + 1).trim());
      if (!v || /Expires=Thu, 01 Jan 1970/i.test(sc)) delete this.cookies[k]; else this.cookies[k] = v;
    }
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
    return { status: res.status, data };
  }
  async login(loginId, pin) {
    const r = await this.req('POST', '/api/auth/login', { loginId, pin });
    if (r.status !== 200) throw new Error(`login ${loginId} failed: ${r.status} ${JSON.stringify(r.data)}`);
    this.csrf = r.data.csrfToken; this.user = r.data.user;
    return r.data;
  }
  get(p) { return this.req('GET', p); }
  post(p, b, key) { return this.req('POST', p, b ?? {}, key ? { 'idempotency-key': key } : {}); }
  cmd(sid, type, payload, key = `t-${crypto.randomUUID()}`) { return this.req('POST', `/api/sessions/${sid}/commands/${type}`, payload || {}, { 'idempotency-key': key }); }
}

async function waitFor(fn, { timeoutMs = 60000, everyMs = 1000, what = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise(r => setTimeout(r, everyMs));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function adminClient() {
  const a = new Client('admin');
  await a.login(process.env.ADMIN_LOGIN || 'admin', process.env.ADMIN_PASSWORD);
  return a;
}

/* sessions created by a test file are archived when that file finishes, so the engine does not keep ticking test branches */
const created = [];
if (process.env.NODE_TEST_CONTEXT) require('node:test').after(async () => {   // only under the node --test runner
  for (const [admin, sid] of created.splice(0)) { try { await admin.post(`/api/sessions/${sid}/archive`, {}); } catch (e) { /* best effort */ } }
});

/** a fresh, PAUSED interactive session: background agents only act when the clock moves, so command flows are deterministic */
async function freshSession(admin, name = 'integration test') {
  const r = await admin.post('/api/sessions', { mode: 'INTERACTIVE', checkpointId: 'CK-20261015-1055', name });
  if (r.status !== 201) throw new Error(`create session failed ${r.status} ${JSON.stringify(r.data)}`);
  const sid = r.data.session.sessionId;
  created.push([admin, sid]);
  await waitFor(async () => ((await admin.get(`/api/sessions/${sid}`)).data.session || {}).status === 'READY', { timeoutMs: 120000, what: `session ${sid} READY (is the engine worker running?)` });
  return sid;
}

module.exports = { Client, demoPin, waitFor, adminClient, freshSession, API, ORIGINS };
