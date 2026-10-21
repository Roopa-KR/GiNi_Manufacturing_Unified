'use strict';
/* /api/sessions/:sid/me/* - the signed-in worker's own views (actor derived from the session, never from the request). */
const express = require('express');
const S = require('../services/sessions');
const V = require('../services/viewsCommon');
const OV = require('../services/operatorViews');
const { requireAuth } = require('../middleware/auth');
const E = require('../lib/errors');

const r = express.Router({ mergeParams: true });
r.use(requireAuth);

async function ctxFor(req) {
  const s = await S.get(req.params.sid);
  if (s.STATUS === 'INITIALIZING') throw E.conflict('SESSION_INITIALIZING', 'The simulation is being initialised from the checkpoint - try again in a few seconds');
  const x = await V.ctx(s);
  x.perms = req.auth.permissions;
  if (!req.auth.workerId) throw E.bad('NO_WORKER', 'This account is not linked to a worker');
  return x;
}

r.get('/home', E.asyncH(async (req, res) => res.json(await OV.home(await ctxFor(req), req.auth.workerId))));
r.get('/queue', E.asyncH(async (req, res) => res.json(await OV.queue(await ctxFor(req), req.auth.workerId))));
r.get('/progress', E.asyncH(async (req, res) => res.json(await OV.progress(await ctxFor(req), req.auth.workerId))));
r.get('/tasks/:taskId', E.asyncH(async (req, res) => {
  const x = await ctxFor(req);
  const t = await V.simOne(x, 'sim_tasks', { TASK_ID: req.params.taskId });
  if (!t || (t.WORKER_ID !== req.auth.workerId && !req.auth.permissions.includes('operational_supervision'))) throw E.notFound('Task');
  res.json(await OV.taskDetail(x, t, t.WORKER_ID));
}));

module.exports = r;
