'use strict';
/* Durable MongoDB-backed sessions (auth_sessions), host-only HttpOnly cookies per app kind, CSRF double-submit bound to the session. */
const { config } = require('../config/env');
const { getDb } = require('../lib/db');
const { sha256, token } = require('../lib/ids');
const { unauthorized, forbidden } = require('../lib/errors');
const PERMS = require('../../contracts/permissions.json');

const cookieName = (kind, what) => `gini_${what}_${kind === 'admin' ? 'admin' : 'operator'}`;

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function cookieOpts(httpOnly) {
  const c = config();
  return { httpOnly, secure: c.isProd, sameSite: 'lax', path: '/', maxAge: c.sessionAbsoluteH * 3600 * 1000 };
}

async function createSession(req, res, account, worker) {
  const c = config();
  const db = await getDb();
  const sid = token(32), csrf = token(24);
  const now = new Date();
  const roles = account.roles || [];
  const perms = [...new Set(roles.flatMap(r => PERMS.roles[r] || []))];
  await db.collection('auth_sessions').insertOne({
    SID_HASH: sha256(sid), CSRF_HASH: sha256(csrf), LOGIN_ID: account.login_id, WORKER_ID: account.worker_id || null, DATASET_ID: account.dataset_id,
    ROLES: roles, PERMISSIONS: perms, APP_KIND: req.appKind, CREATED_AT: now, LAST_SEEN_AT: now,
    IDLE_EXPIRES_AT: new Date(now.getTime() + c.sessionIdleMin * 60000), ABSOLUTE_EXPIRES_AT: new Date(now.getTime() + c.sessionAbsoluteH * 3600000),
    USER_AGENT: String(req.get('user-agent') || '').slice(0, 200), IP: req.ip, REVOKED_AT: null, _origin: 'APP',
    NOTE: 'Application authentication session - not attendance and not the historical APP_SESSIONS device record',
  });
  res.cookie(cookieName(req.appKind, 'sid'), sid, cookieOpts(true));
  res.cookie(cookieName(req.appKind, 'csrf'), csrf, cookieOpts(false));
  return { csrf, permissions: perms };
}

async function loadSession(req, res, next) {
  try {
    const cookies = parseCookies(req);
    const sid = cookies[cookieName(req.appKind, 'sid')];
    req.auth = null;
    if (!sid) return next();
    const db = await getDb();
    const now = new Date();
    const s = await db.collection('auth_sessions').findOne({ SID_HASH: sha256(sid) });
    if (!s || s.REVOKED_AT || s.IDLE_EXPIRES_AT < now || s.ABSOLUTE_EXPIRES_AT < now || s.APP_KIND !== req.appKind) return next();
    const acct = await db.collection('accounts').findOne({ dataset_id: s.DATASET_ID, login_id: s.LOGIN_ID });
    if (!acct || acct.status !== 'ACTIVE') return next();
    req.auth = { sessionId: s._id, loginId: s.LOGIN_ID, workerId: s.WORKER_ID, datasetId: s.DATASET_ID, roles: acct.roles || s.ROLES, permissions: [...new Set((acct.roles || s.ROLES).flatMap(r => PERMS.roles[r] || []))], csrfHash: s.CSRF_HASH, mustChange: !!acct.pin_must_change, appKind: s.APP_KIND };
    // sliding idle expiry (bounded write: at most once per minute)
    if (now - s.LAST_SEEN_AT > 60000) {
      await db.collection('auth_sessions').updateOne({ _id: s._id }, { $set: { LAST_SEEN_AT: now, IDLE_EXPIRES_AT: new Date(now.getTime() + config().sessionIdleMin * 60000) } });
    }
    next();
  } catch (e) { next(e); }
}

function requireAuth(req, res, next) {
  if (!req.auth) return next(unauthorized());
  next();
}
function requirePerm(...perms) {
  return (req, res, next) => {
    if (!req.auth) return next(unauthorized());
    if (!perms.some(p => req.auth.permissions.includes(p))) return next(forbidden(`Requires permission: ${perms.join(' or ')}`, { required: perms }));
    next();
  };
}
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.auth) return next();          // unauthenticated unsafe routes (login) are protected by the origin guard
  const t = req.get('x-csrf-token');
  if (!t || sha256(t) !== req.auth.csrfHash) return next(forbidden('Missing or invalid CSRF token'));
  next();
}
async function revokeSession(req, res) {
  if (req.auth) {
    const db = await getDb();
    await db.collection('auth_sessions').updateOne({ _id: req.auth.sessionId }, { $set: { REVOKED_AT: new Date() } });
  }
  res.clearCookie(cookieName(req.appKind, 'sid'), { path: '/' });
  res.clearCookie(cookieName(req.appKind, 'csrf'), { path: '/' });
}

const has = (req, p) => !!(req.auth && req.auth.permissions.includes(p));

module.exports = { loadSession, requireAuth, requirePerm, csrfGuard, createSession, revokeSession, parseCookies, has, cookieName };
