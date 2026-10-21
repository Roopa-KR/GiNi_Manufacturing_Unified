'use strict';
/* Server-to-server routes for the Python engine (Bearer INTERNAL_SERVICE_TOKEN). Not reachable with browser cookies. */
const express = require('express');
const crypto = require('crypto');
const { config } = require('../config/env');
const { execute } = require('../domain/executor');
const N = require('../services/notifications');
const E = require('../lib/errors');
const PERMS = require('../../contracts/permissions.json');

const r = express.Router({ mergeParams: true });
const ALL = Object.keys(PERMS.permissions);

r.use((req, res, next) => {
  const c = config();
  const h = String(req.get('authorization') || '');
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = Buffer.from(tok), b = Buffer.from(c.internalToken || '');
  if (!c.internalToken || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return next(E.unauthorized('Internal token required'));
  next();
});

/** agent / engine commands: executed one by one through the same command bus and domain transitions as human commands */
r.post('/commands', E.asyncH(async (req, res) => {
  const { sessionId, commands } = req.body || {};
  if (!sessionId || !Array.isArray(commands) || commands.length > 200) throw E.bad('INVALID_BATCH', 'sessionId and up to 200 commands required');
  const results = [];
  for (const cmd of commands) {
    try {
      const out = await execute({ sessionId, type: cmd.type, payload: cmd.payload || {}, at: cmd.at, idempotencyKey: cmd.idempotencyKey, causationId: cmd.causationId || null, correlationId: cmd.correlationId,
        source: cmd.source || 'ENGINE_AGENT', actor: { kind: cmd.system ? 'SYSTEM' : 'AGENT', workerId: cmd.actorWorkerId || null, loginId: cmd.actorWorkerId ? `agent:${cmd.actorWorkerId}` : 'engine', permissions: ALL, roles: ['AGENT'] } });
      results.push({ ok: true, type: cmd.type, ref: cmd.ref || null, result: out.result, events: out.events.length, replayed: !!out.replayed });
    } catch (e) {
      results.push({ ok: false, type: cmd.type, ref: cmd.ref || null, status: e.status || 500, code: e.code || 'ERROR', message: e.message });
      if (!e.status || e.status >= 500) { if (cmd.stopOnServerError !== false) break; }
    }
  }
  res.json({ results });
}));

r.post('/notifications/dispatch', E.asyncH(async (req, res) => {
  const out = await N.dispatch(Math.min(50, Number((req.body || {}).limit || 20)), 'api');
  res.json(out);
}));

module.exports = r;
