'use strict';
/* /api/admin/* - worker administration (manage_workers), rule settings (rule_editing), audit, import validation, jobs, notifications, integration status. */
const express = require('express');
const { getDb, withTransaction } = require('../lib/db');
const { config } = require('../config/env');
const { requireAuth, requirePerm } = require('../middleware/auth');
const W = require('../services/workersAdmin');
const R = require('../services/rules');
const E = require('../lib/errors');
const { audit } = require('../services/sessions');

const r = express.Router({ mergeParams: true });
r.use(requireAuth);

r.get('/workers', requirePerm('manage_workers', 'view_all_workers'), E.asyncH(async (req, res) => res.json(await W.list(req.query))));
// worker administration: one transaction per action (writes + audit); an Idempotency-Key makes a retry return the first result
const meta = req => ({ idempotencyKey: req.get('Idempotency-Key') || null, requestId: req.get('X-Request-Id') || null });
r.post('/workers', requirePerm('manage_workers'), E.asyncH(async (req, res) => { const out = await W.createWorker(req.body || {}, req.auth.loginId, meta(req)); res.status(out.replayed ? 200 : 201).json(out); }));
r.post('/workers/:wid/delete', requirePerm('manage_workers'), E.asyncH(async (req, res) => res.json(await W.deleteWorker(req.params.wid, req.body || {}, req.auth.loginId, meta(req)))));
r.patch('/workers/:wid', requirePerm('manage_workers'), E.asyncH(async (req, res) => res.json(await W.updateWorker(req.params.wid, req.body || {}, req.auth.loginId, meta(req)))));
r.post('/workers/:wid/deactivate', requirePerm('manage_workers'), E.asyncH(async (req, res) => res.json(await W.setActive(req.params.wid, false, req.auth.loginId, meta(req)))));
r.post('/workers/:wid/activate', requirePerm('manage_workers'), E.asyncH(async (req, res) => res.json(await W.setActive(req.params.wid, true, req.auth.loginId, meta(req)))));
r.post('/workers/:wid/reset-pin', requirePerm('manage_workers'), E.asyncH(async (req, res) => res.json(await W.resetPin(req.params.wid, (req.body || {}).pin, req.auth.loginId, meta(req)))));

r.get('/reference', E.asyncH(async (req, res) => {
  const C = require('../domain/catalog');
  const cat = await C.catalog();
  const c = config();
  const db = await getDb();
  const tpls = c.isFresh ? await db.collection('shift_templates').find({ dataset_id: c.datasetId, ACTIVE_FLAG: { $ne: 'N' } }, { projection: { _id: 0 } }).sort({ SHIFT_CODE: 1 }).toArray() : [];
  const fst = c.isFresh ? await require('../services/factory').settings(db) : null;
  res.json({ freshFactory: c.isFresh, operatingMode: fst ? fst.OPERATING_MODE : null, timezone: fst ? fst.TIMEZONE : null,
    workCenters: Object.values(cat.wcs).filter(w => !c.isFresh || w.ACTIVE_FLAG !== 'N').map(w => ({ id: w.WORK_CENTER_ID, name: w.WORK_CENTER_NAME, scope: w.DEMO_SCOPE })), skills: Object.values(cat.skills).filter(s => s.ACTIVE_FLAG !== 'N').map(s => ({ id: s.SKILL_ID, name: s.SKILL_NAME, workCenterId: s.WORK_CENTER_ID })),
    roles: W.ROLES, shifts: c.isFresh ? tpls.map(t => t.SHIFT_CODE) : ['A', 'B'], shiftTemplates: tpls.map(t => ({ code: t.SHIFT_CODE, name: t.SHIFT_NAME, start: t.START_LOCAL, end: t.END_LOCAL, overnight: !!t.OVERNIGHT, days: t.DAYS_OF_WEEK })),
    products: Object.values(cat.products).map(p => ({ id: p.PRODUCT_ID, name: p.PRODUCT_NAME, status: p.STATUS || (p.ACTIVE_FLAG === 'N' ? 'INACTIVE' : 'RELEASED'), routeVersion: p.ROUTE_VERSION, illustrative: !!p.ILLUSTRATIVE })), checkpoints: cat.checkpoints.map(c => ({ id: c.CHECKPOINT_ID, runId: c.RUN_ID, asOf: c.AS_OF_AT, asOfLocal: c.AS_OF_LOCAL, purpose: c.PURPOSE })),
    runs: Object.values(cat.runCatalog).map(x => ({ runId: x.RUN_ID, type: x.RUN_TYPE, storage: x.STORAGE_MODE, policy: x.DISPOSITION_POLICY_ID, description: x.DESCRIPTION })),
    equipment: Object.values(cat.equipment).map(e => ({ id: e.EQUIPMENT_ID, name: e.EQUIPMENT_NAME, workCenterId: e.WORK_CENTER_ID, workstationId: e.WORKSTATION_ID })),
    materials: Object.values(cat.materials).map(m => ({ id: m.MATERIAL_ID, name: m.MATERIAL_NAME, uom: m.UOM })), policies: Object.values(cat.policies),
    stations: Object.values(cat.stations).map(s => ({ id: s.WORKSTATION_ID, workCenterId: s.WORK_CENTER_ID, type: s.WORKSTATION_TYPE, equipmentId: s.EQUIPMENT_ID })) });
}));

const MD = require('../domain/masterData');
r.get('/master/products', E.asyncH(async (req, res) => res.json({ products: await MD.listProducts() })));
// validated product input: 422 with every problem when routing, standards, inspection specs or materials are incomplete; nothing is written then
r.post('/master/products', requirePerm('rule_editing', 'scenario_control'), E.asyncH(async (req, res) => res.status(req.query.dryRun === '1' ? 200 : 201).json(await MD.createProduct(req.body || {}, req.auth.loginId, { dryRun: req.query.dryRun === '1' }))));
// rework labour standards: approval by a named, authorised person with a version and an effective date (one transaction + audit)
const RS = require('../domain/reworkStandards');
r.get('/master/rework-standards', E.asyncH(async (req, res) => res.json(await RS.list(req.query))));
r.post('/master/rework-standards', requirePerm('rule_editing'), E.asyncH(async (req, res) => { const out = await RS.approve(req.body || {}, req.auth.loginId, meta(req)); res.status(out.replayed ? 200 : 201).json(out); }));
r.post('/master/rework-standards/:id/withdraw', requirePerm('rule_editing'), E.asyncH(async (req, res) => res.json(await RS.withdraw(req.params.id, (req.body || {}).reason, req.auth.loginId, meta(req)))));
// points policy: versions confirmed by a named person; the shipped default keeps the client's formula (adjustments OFF)
const PP = require('../services/pointsPolicy');
r.get('/points-policy', E.asyncH(async (req, res) => res.json(await PP.versions())));
r.post('/points-policy', requirePerm('rule_editing'), E.asyncH(async (req, res) => { const out = await PP.confirm(req.body || {}, req.auth.loginId, meta(req)); res.status(out.replayed ? 200 : 201).json(out); }));
r.get('/rules', E.asyncH(async (req, res) => res.json(await R.listVersions())));
r.put('/rules', requirePerm('rule_editing'), E.asyncH(async (req, res) => res.status(201).json(await R.saveVersion(req.body || {}, req.auth.loginId))));

r.get('/audit', requirePerm('view_audit', 'manage_workers'), E.asyncH(async (req, res) => {
  const db = await getDb();
  const rows = await db.collection('audit_log').find({}).sort({ AT: -1 }).skip(Number(req.query.skip || 0)).limit(Math.min(200, Number(req.query.limit || 100))).toArray();
  res.json({ entries: rows });
}));

r.get('/import-status', requirePerm('view_audit', 'manage_workers', 'scenario_control'), E.asyncH(async (req, res) => {
  const db = await getDb();
  const c = config();
  const manifests = await db.collection('import_manifests').find({ dataset_id: c.datasetId }).toArray();
  const runs = await db.collection('seed_runs').find({ dataset_id: c.datasetId }).sort({ started_at: -1 }).limit(10).toArray();
  const importRuns = await db.collection('import_runs').find({ dataset_id: c.datasetId }, { projection: { _id: 0 } }).sort({ started_at: -1 }).limit(10).toArray();
  const rec = await db.collection('reconciliation_reports').find({}).sort({ checked_at: -1 }).limit(3).toArray();
  const quarantine = await db.collection('import_quarantine').find({}).limit(200).toArray();
  const readiness = await db.collection('run_readiness').find({}).toArray();
  res.json({ manifests: manifests.map(m => ({ datasetVersion: m.dataset_version, manifestSha256: m.manifest_sha256, firstSeededAt: m.first_seeded_at, sourceWorkbooks: m.source_workbooks, collections: Object.keys(m.counts || {}).length, documents: Object.values(m.counts || {}).reduce((s, v) => s + v, 0) })),
    seedRuns: runs, importRuns, reconciliation: rec.map(x => ({ result: x.result, checkedAt: x.checked_at, store: x.store, checks: (x.checks || []).length, failing: (x.checks || []).filter(c2 => c2.result === 'FAIL').length })),
    quarantine, runReadiness: readiness, note: 'Seeding is an explicit command (backend/seed). A quarantined or incomplete run is never shown as fully validated.' });
}));

r.get('/jobs', requirePerm('scenario_control', 'view_audit'), E.asyncH(async (req, res) => {
  const db = await getDb();
  const f = req.query.status ? { STATUS: req.query.status } : {};
  const jobs = await db.collection('jobs').find(f).sort({ UPDATED_AT: -1 }).limit(100).toArray();
  const counts = {};
  for (const s of ['PENDING', 'LEASED', 'DONE', 'FAILED', 'DEAD']) counts[s] = await db.collection('jobs').countDocuments({ STATUS: s });
  const engines = await db.collection('engine_workers').find({}).sort({ HEARTBEAT_AT: -1 }).limit(10).toArray();
  res.json({ counts, jobs, engines: engines.map(e => ({ workerId: e.WORKER_ID, at: e.HEARTBEAT_AT, ageSec: (Date.now() - new Date(e.HEARTBEAT_AT)) / 1000, version: e.ENGINE_VERSION, status: e.STATUS === 'RUNNING' && (Date.now() - new Date(e.HEARTBEAT_AT)) / 1000 > 60 ? 'NOT_RESPONDING' : e.STATUS, host: e.HOST, startedAt: e.STARTED_AT })) });
}));
r.post('/jobs/:jobId/retry', requirePerm('scenario_control'), E.asyncH(async (req, res) => {
  const db = await getDb();
  const j = await db.collection('jobs').findOne({ JOB_ID: req.params.jobId });
  if (!j) throw E.notFound('Job');
  if (!['DEAD', 'FAILED'].includes(j.STATUS)) throw E.conflict('NOT_DEAD', `Job is ${j.STATUS}`);
  await withTransaction(async (txs) => {
    await db.collection('jobs').updateOne({ JOB_ID: j.JOB_ID }, { $set: { STATUS: 'PENDING', ATTEMPTS: 0, AVAILABLE_AT: new Date(), UPDATED_AT: new Date() } }, { session: txs });
    await audit(db, req.auth.loginId, 'JOB_RETRIED', j.JOB_ID, {}, { session: txs, before: { status: j.STATUS, attempts: j.ATTEMPTS }, after: { status: 'PENDING', attempts: 0 } });
  });
  res.json({ ok: true });
}));

r.get('/notifications', requirePerm('scenario_control', 'view_audit', 'operational_supervision'), E.asyncH(async (req, res) => {
  const db = await getDb();
  const rows = await db.collection('notifications').find(req.query.sessionId ? { SESSION_ID: req.query.sessionId } : {}).sort({ CREATED_AT: -1 }).limit(100).toArray();
  res.json({ mode: config().email.mode, notifications: rows, note: 'Capture mode stores the rendered email instead of sending it. Live SMTP requires an explicit allowlist; fabricated worker addresses are never emailed.' });
}));

r.get('/integrations', E.asyncH(async (req, res) => {
  const c = config();
  const db = await getDb();
  const hb = (await db.collection('engine_workers').find({}).sort({ HEARTBEAT_AT: -1 }).limit(1).toArray()).map(e => ({ AT: e.HEARTBEAT_AT }));
  const { serverIdentity } = require('../lib/db');
  let dbId = null; try { dbId = await serverIdentity(); } catch (e) { dbId = { kind: 'UNAVAILABLE', error: e.message }; }
  res.json({ database: dbId.kind === 'MongoDB' ? `MongoDB ${dbId.version}` : dbId.kind, databaseDetail: dbId, email: { mode: c.email.mode, host: c.email.mode === 'smtp' ? c.email.host : null, allowlistCount: c.email.allowlist.length },
    evidence: { mode: c.evidenceMode, cloudinaryConfigured: !!(c.cloudinary.cloudName && c.cloudinary.apiKey) }, engine: hb[0] ? { lastHeartbeatAt: hb[0].AT, ageSec: (Date.now() - new Date(hb[0].AT)) / 1000, status: (Date.now() - new Date(hb[0].AT)) / 1000 < 60 ? 'RUNNING' : 'STALE' } : { status: 'NEVER_SEEN' },
    demoMode: c.demoMode });
}));

module.exports = r;
