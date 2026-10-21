'use strict';
const { config } = require('../config/env');
const { forbidden } = require('../lib/errors');

/** security headers + private/no-store caching for every API response containing user/session/operational data */
function headers(req, res, next) {
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Frame-Options', 'DENY');
  res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  next();
}

/** exact-origin policy. Same-origin /api rewrites mean browsers send the app origin; anything else is rejected for unsafe methods. */
function appKindFromOrigin(origin) {
  const c = config();
  if (!origin) return null;
  const o = origin.replace(/\/+$/, '');
  if (o === c.frontendUrl.replace(/\/+$/, '')) return 'operator';
  if (o === c.adminUrl.replace(/\/+$/, '')) return 'admin';
  if (c.extraOrigins.includes(o)) return 'extra';
  return null;
}

function originGuard(req, res, next) {
  const c = config();
  const origin = req.get('origin') || (req.get('referer') ? new URL(req.get('referer')).origin : null);
  const kindHeader = (req.get('x-app-kind') || '').toLowerCase();
  const fromOrigin = appKindFromOrigin(origin);
  if (origin && !c.allowedOrigins.includes(origin.replace(/\/+$/, ''))) {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') return next(forbidden('Origin not allowed'));
  }
  // app kind: from exact origin mapping; a header can only narrow an "extra" origin, never re-label a mapped one
  req.appKind = fromOrigin && fromOrigin !== 'extra' ? fromOrigin : (['operator', 'admin'].includes(kindHeader) ? kindHeader : 'operator');
  if (fromOrigin && fromOrigin !== 'extra' && kindHeader && kindHeader !== fromOrigin) return next(forbidden('App kind does not match origin'));
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

module.exports = { headers, originGuard, appKindFromOrigin };
