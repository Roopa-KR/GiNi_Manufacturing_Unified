'use strict';
const express = require('express');
const fs = require('fs');
const S = require('../services/sessions');
const EV = require('../services/evidence');
const { execute } = require('../domain/executor');
const { getDb } = require('../lib/db');
const { requireAuth, has } = require('../middleware/auth');
const E = require('../lib/errors');

const r = express.Router({ mergeParams: true });
r.use(requireAuth);
const actor = req => ({ kind: 'HUMAN', loginId: req.auth.loginId, workerId: req.auth.workerId, roles: req.auth.roles, permissions: req.auth.permissions });

/** step 1: authorise an upload (returns Cloudinary signed fields or a local upload URL) */
r.post('/sign', E.asyncH(async (req, res) => {
  const out = await execute({ sessionId: req.params.sid, type: 'EVIDENCE_REQUEST_UPLOAD', payload: req.body || {}, idempotencyKey: req.get('idempotency-key'), actor: actor(req), source: 'UI' });
  res.status(201).json(out.result);
}));

/** step 2: after the browser uploaded, the API verifies the stored asset (client metadata is not trusted) */
r.post('/:evidenceId/complete', E.asyncH(async (req, res) => {
  const db = await getDb();
  const ev = await db.collection('sim_evidence').findOne({ SESSION_ID: req.params.sid, EVIDENCE_ID: req.params.evidenceId });
  if (!ev) throw E.notFound('Evidence');
  if (ev.WORKER_ID !== req.auth.workerId) throw E.forbidden('Not your upload');
  const result = await EV.verify(ev);
  const out = await execute({ sessionId: req.params.sid, type: 'EVIDENCE_MARK_VERIFIED', payload: { evidenceId: ev.EVIDENCE_ID, result }, idempotencyKey: req.get('idempotency-key') || `verify-${ev.EVIDENCE_ID}-${Date.now()}`, actor: actor(req), source: 'UI', trusted: true });
  res.json(out.result);
}));

/** role-restricted viewing: signed authenticated URL (Cloudinary) or streamed bytes (local) */
r.get('/:evidenceId/view', E.asyncH(async (req, res) => {
  const db = await getDb();
  const ev = await db.collection('sim_evidence').findOne({ SESSION_ID: req.params.sid, EVIDENCE_ID: req.params.evidenceId });
  if (!ev) throw E.notFound('Evidence');
  if (ev.WORKER_ID !== req.auth.workerId && !['view_evidence', 'quality_approval', 'perform_quality_inspection'].some(p => has(req, p))) throw E.forbidden('Not permitted to view this evidence');
  if (ev.UPLOAD_STATUS !== 'VERIFIED') throw E.conflict('NOT_VERIFIED', `Evidence is ${ev.UPLOAD_STATUS}`);
  const v = EV.viewUrl(ev);
  if (v.url) return res.json({ url: v.url, kind: v.kind, expiresNote: 'Signed delivery URL for an authenticated asset' });
  const file = EV.localPath(ev.PUBLIC_ID);
  if (!fs.existsSync(file)) throw E.notFound('Evidence file');
  res.set('Content-Type', ev.MIME || 'application/octet-stream');
  res.set('Cache-Control', 'private, no-store');
  res.send(fs.readFileSync(file));
}));

module.exports = r;
