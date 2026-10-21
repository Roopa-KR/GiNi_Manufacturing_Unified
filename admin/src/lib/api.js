// API client: same-origin /api (Vite proxy locally, Vercel rewrite in production), host-only HttpOnly session cookie,
// CSRF double-submit header, Idempotency-Key on every write (the same key is reused when a write is retried).
const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
export const API_BASE = env.VITE_API_BASE_URL || '/api';
export const APP_KIND = env.VITE_APP_KIND || 'admin';
export const POLL_MS = Number(env.VITE_POLL_INTERVAL_MS || 5000);
export const SHOW_SYNTHETIC_BANNER = String(env.VITE_SHOW_SYNTHETIC_BANNER ?? 'true') !== 'false';

export class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}

function csrfToken() {
  const name = `gini_csrf_${APP_KIND === 'admin' ? 'admin' : 'operator'}=`;
  for (const part of document.cookie.split(';')) { const p = part.trim(); if (p.startsWith(name)) return decodeURIComponent(p.slice(name.length)); }
  try { return sessionStorage.getItem('gini_csrf') || ''; } catch (e) { return ''; }
}
export function rememberCsrf(t) { try { sessionStorage.setItem('gini_csrf', t || ''); } catch (e) { /* storage unavailable */ } }
export function newKey(prefix = 'ui') { return `${prefix}-${(crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36))}`; }

export async function request(method, path, body, opts = {}) {
  const headers = { Accept: 'application/json', 'X-App-Kind': APP_KIND };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken();
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  let res;
  try {
    res = await fetch(API_BASE + path, { method, headers, credentials: 'same-origin', body: body !== undefined ? JSON.stringify(body) : undefined, signal: opts.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', 'No connection to the GiNi API - your entry is kept; retry when the connection is back');
  }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    const err = (data && data.error) || {};
    throw new ApiError(res.status, err.code || `HTTP_${res.status}`, err.message || (res.status >= 500 ? 'Server error - nothing was changed unless the result says so; retry' : `Request failed (${res.status})`), { ...(err.details || {}), body: data });
  }
  return data;
}

export const api = {
  get: (p, o) => request('GET', p, undefined, o),
  post: (p, b, o) => request('POST', p, b ?? {}, o),
  put: (p, b, o) => request('PUT', p, b ?? {}, o),
  patch: (p, b, o) => request('PATCH', p, b ?? {}, o),
};

/** domain command through the shared command bus; a network failure retries once with the SAME idempotency key */
export async function command(sessionId, type, payload = {}, key = newKey(type.toLowerCase())) {
  try {
    return await request('POST', `/sessions/${encodeURIComponent(sessionId)}/commands/${type}`, payload, { idempotencyKey: key });
  } catch (e) {
    if (e.status === 0) {
      await new Promise(r => setTimeout(r, 1200));
      return request('POST', `/sessions/${encodeURIComponent(sessionId)}/commands/${type}`, payload, { idempotencyKey: key });
    }
    throw e;
  }
}
