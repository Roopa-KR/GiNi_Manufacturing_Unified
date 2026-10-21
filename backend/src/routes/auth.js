'use strict';
const express = require('express');
const { getDb, withTransaction } = require('../lib/db');
const { config } = require('../config/env');
const { verifyPin, hashPin, DUMMY } = require('../lib/pin');
const { createSession, revokeSession, requireAuth } = require('../middleware/auth');
const E = require('../lib/errors');
const PERMS = require('../../contracts/permissions.json');
const { audit } = require('../services/sessions');

const r = express.Router({ mergeParams: true });

async function rateLimited(db, loginId, ip) {
  const c = config();
  const since = new Date(Date.now() - c.loginRateWindowMin * 60000);
  // per account: LOGIN_RATE_MAX failures; per IP: 5x that, because a demo room or office shares one NAT address
  const byLogin = await db.collection('login_attempts').countDocuments({ LOGIN_ID: loginId, SUCCESS: false, AT: { $gte: since } });
  if (byLogin >= c.loginRateMax) return true;
  const byIp = await db.collection('login_attempts').countDocuments({ IP: ip, SUCCESS: false, AT: { $gte: since } });
  return byIp >= c.loginRateMax * 5;
}

r.post('/login', E.asyncH(async (req, res) => {
  const c = config();
  const loginId = String((req.body || {}).loginId || '').trim();
  const pin = (req.body || {}).pin;
  if (!loginId || typeof pin !== 'string' || !pin) throw E.bad('CREDENTIALS_REQUIRED', 'Enter your employee ID and PIN (the PIN is text - leading zeros count)');
  const db = await getDb();
  if (await rateLimited(db, loginId, req.ip)) throw new E.AppError(429, 'TOO_MANY_ATTEMPTS', `Too many failed attempts - try again in ${c.loginRateWindowMin} minutes`);
  const acct = await db.collection('accounts').findOne({ dataset_id: c.datasetId, login_id: { $in: [loginId, loginId.toUpperCase()] } });
  const ok = await verifyPin(pin, acct ? acct.pin_hash : DUMMY);
  const allowedRoles = PERMS.app_kinds[req.appKind] || [];
  const roleOk = acct && (acct.roles || []).some(x => allowedRoles.includes(x));
  await db.collection('login_attempts').insertOne({ LOGIN_ID: loginId, IP: req.ip, AT: new Date(), SUCCESS: !!(ok && acct && acct.status === 'ACTIVE' && roleOk), APP_KIND: req.appKind, _origin: 'APP' });
  if (!acct || !ok) throw E.unauthorized('Employee ID or PIN not recognised');
  if (acct.status !== 'ACTIVE') throw E.forbidden('This account is deactivated');
  if (!roleOk) throw E.forbidden(req.appKind === 'admin' ? 'This account cannot use the supervisor/admin application' : 'This account cannot use the operator application');
  const s = await createSession(req, res, acct);
  const worker = acct.worker_id ? await db.collection('worker_master').findOne({ dataset_id: c.datasetId, WORKER_ID: acct.worker_id }, { projection: { _seed: 0 } }) : null;
  res.json({ ok: true, csrfToken: s.csrf, user: { loginId: acct.login_id, workerId: acct.worker_id, name: worker ? worker.DISPLAY_NAME : (acct.display_name || acct.login_id), roles: acct.roles, permissions: s.permissions, mustChangePin: !!acct.pin_must_change },
    note: 'Signing in does not clock you in, start a task or change your shift.' });
}));

r.post('/logout', E.asyncH(async (req, res) => {
  await revokeSession(req, res);
  res.json({ ok: true });
}));

r.get('/me', requireAuth, E.asyncH(async (req, res) => {
  const c = config();
  const db = await getDb();
  const worker = req.auth.workerId ? await db.collection('worker_master').findOne({ dataset_id: c.datasetId, WORKER_ID: req.auth.workerId }, { projection: { _seed: 0, _id: 0 } }) : null;
  const acct = await db.collection('accounts').findOne({ dataset_id: c.datasetId, login_id: req.auth.loginId }, { projection: { pin_hash: 0 } });
  res.json({ user: { loginId: req.auth.loginId, workerId: req.auth.workerId, name: worker ? worker.DISPLAY_NAME : (acct && acct.display_name) || req.auth.loginId, role: worker ? worker.WORKER_ROLE : 'ADMIN',
    homeWorkCenterId: worker ? worker.HOME_WORK_CENTER_ID : null, roles: req.auth.roles, permissions: req.auth.permissions, mustChangePin: req.auth.mustChange, appKind: req.appKind } });
}));

r.post('/change-pin', requireAuth, E.asyncH(async (req, res) => {
  const c = config();
  const { currentPin, newPin } = req.body || {};
  if (typeof newPin !== 'string' || newPin.length < (req.auth.roles.includes('ADMIN') ? 15 : 6)) throw E.bad('PIN_TOO_SHORT', req.auth.roles.includes('ADMIN') ? 'Admin passwords need at least 15 characters' : 'PINs need at least 6 characters');
  const db = await getDb();
  const acct = await db.collection('accounts').findOne({ dataset_id: c.datasetId, login_id: req.auth.loginId });
  if (!acct || !(await verifyPin(String(currentPin || ''), acct.pin_hash))) throw E.unauthorized('Current PIN/password is wrong');
  const pinHash = await hashPin(newPin);
  await withTransaction(async (txs) => {
    await db.collection('accounts').updateOne({ _id: acct._id }, { $set: { pin_hash: pinHash, pin_must_change: false, pin_changed_at: new Date(), _app: { modified_at: new Date(), modified_by: req.auth.loginId } } }, { session: txs });
    await audit(db, req.auth.loginId, 'PIN_CHANGED', req.auth.loginId, {}, { session: txs });
  });
  res.json({ ok: true });
}));

module.exports = r;
