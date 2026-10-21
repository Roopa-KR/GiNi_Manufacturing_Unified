'use strict';
const express = require('express');
const S = require('../services/sessions');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { execute } = require('../domain/executor');
const { getDb } = require('../lib/db');
const E = require('../lib/errors');

const r = express.Router({ mergeParams: true });
r.use(requireAuth);

r.get('/', E.asyncH(async (req, res) => res.json({ sessions: await S.list() })));

r.get('/default', E.asyncH(async (req, res) => {
  const s = await S.getDefault();
  res.json({ session: S.publicSession(s), hint: s ? null : 'No simulation session exists yet - an administrator creates one (Administration > Simulation) or runs `npm run session:create-default`.' });
}));

r.post('/', requirePerm('scenario_control'), E.asyncH(async (req, res) => {
  const b = req.body || {};
  const s = await S.create({ mode: b.mode === 'REPLAY' ? 'REPLAY' : 'INTERACTIVE', checkpointId: b.checkpointId, sourceRunId: b.sourceRunId, forkAt: b.forkAt, name: b.name, createdBy: req.auth.loginId, makeDefault: !!b.makeDefault, speed: b.speed, policyId: b.policyId, notify: b.notify });
  res.status(201).json({ session: S.publicSession(s), note: 'The engine initialises the session from the checkpoint; it becomes READY within a few seconds when the engine worker is running.' });
}));

r.get('/:sid', E.asyncH(async (req, res) => res.json({ session: S.publicSession(await S.get(req.params.sid)) })));

r.post('/:sid/clock', requirePerm('scenario_control'), E.asyncH(async (req, res) => {
  const s = await S.setClock(req.params.sid, req.body || {}, req.auth.loginId);
  res.json({ session: S.publicSession(s) });
}));

r.post('/:sid/reset', requirePerm('scenario_control'), E.asyncH(async (req, res) => {
  const s = await S.reset(req.params.sid, (req.body || {}).confirm, req.auth.loginId);
  res.json({ session: S.publicSession(s) });
}));

r.post('/:sid/archive', requirePerm('scenario_control'), E.asyncH(async (req, res) => {
  await S.archive(req.params.sid, req.auth.loginId);
  res.json({ ok: true });
}));

r.post('/:sid/default', requirePerm('scenario_control'), E.asyncH(async (req, res) => {
  const db = await getDb();
  await S.get(req.params.sid);
  await db.collection('sim_sessions').updateMany({ DEFAULT_FLAG: true }, { $set: { DEFAULT_FLAG: false } });
  await db.collection('sim_sessions').updateOne({ SESSION_ID: req.params.sid }, { $set: { DEFAULT_FLAG: true } });
  res.json({ ok: true });
}));

/** manual refresh/recalculate: enqueues a job; GET endpoints never advance time or mutate state */
r.post('/:sid/recalculate', requirePerm('operational_supervision', 'scenario_control', 'quality_approval'), E.asyncH(async (req, res) => {
  const db = await getDb();
  const s = await S.get(req.params.sid);
  const kind = (req.body || {}).kind === 'RECOVERY' ? 'RECOVERY' : 'RECALC';
  await S.enqueueJob(db, s.SESSION_ID, kind === 'RECOVERY' ? 'RECOVERY' : (s.MODE === 'REPLAY' ? 'REPLAY_REFRESH' : 'RECALC'), { requestedBy: req.auth.loginId, orderLineId: (req.body || {}).orderLineId || null }, 2, kind === 'RECOVERY' ? ((req.body || {}).orderLineId || 'AT_RISK') : null);
  res.status(202).json({ queued: true, kind });
}));

/** every write: POST /api/sessions/:sid/commands/:type with Idempotency-Key header and the expected entity version in the body where relevant */
r.post('/:sid/commands/:type', E.asyncH(async (req, res) => {
  const out = await execute({
    sessionId: req.params.sid, type: req.params.type, payload: req.body || {}, idempotencyKey: req.get('idempotency-key'), source: req.appKind === 'admin' ? 'ADMIN_UI' : 'OPERATOR_UI',
    actor: { kind: 'HUMAN', loginId: req.auth.loginId, workerId: req.auth.workerId, roles: req.auth.roles, permissions: req.auth.permissions },
  });
  res.status(out.replayed ? 200 : 201).json(out);
}));

module.exports = r;
