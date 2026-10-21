'use strict';
/* /api/factory/* - fresh-factory setup (factory_configuration), readiness and the guarded reset (factory_reset). Admin application only. */
const express = require('express');
const F = require('../services/factory');
const { requireAuth, requirePerm } = require('../middleware/auth');
const E = require('../lib/errors');

const r = express.Router({ mergeParams: true });
r.use(requireAuth);
r.use((req, res, next) => { try { F.requireFresh(); next(); } catch (e) { next(e); } });

const meta = req => ({ idempotencyKey: req.get('Idempotency-Key') || null, requestId: req.get('X-Request-Id') || null });
const cfg = requirePerm('factory_configuration');
const view = requirePerm('factory_configuration', 'operational_supervision', 'manage_workers');
const send = (res, out) => res.status(out && out.created ? 201 : 200).json(out);

r.get('/setup', view, E.asyncH(async (req, res) => res.json(await F.setup())));
r.get('/master', view, E.asyncH(async (req, res) => res.json(await F.master())));
r.get('/readiness', view, E.asyncH(async (req, res) => res.json({ tanks: await F.readiness(req.query.unitId || null) })));

r.get('/settings', view, E.asyncH(async (req, res) => res.json({ settings: await F.settings() })));
r.put('/settings', cfg, E.asyncH(async (req, res) => res.json(await F.saveSettings(req.body || {}, req.auth.loginId, meta(req)))));

r.put('/work-centers/:id', cfg, E.asyncH(async (req, res) => send(res, await F.saveWorkCenter(req.params.id, req.body || {}, req.auth.loginId, meta(req)))));
r.put('/stations/:id', cfg, E.asyncH(async (req, res) => send(res, await F.saveStation(req.params.id, req.body || {}, req.auth.loginId, meta(req)))));
r.put('/skills/:id', cfg, E.asyncH(async (req, res) => send(res, await F.saveSkill(req.params.id, req.body || {}, req.auth.loginId, meta(req)))));
r.put('/equipment/:id', cfg, E.asyncH(async (req, res) => send(res, await F.saveEquipment(req.params.id, req.body || {}, req.auth.loginId, meta(req)))));
r.put('/materials/:id', cfg, E.asyncH(async (req, res) => send(res, await F.saveMaterial(req.params.id, req.body || {}, req.auth.loginId, meta(req)))));
r.put('/shifts/:code', cfg, E.asyncH(async (req, res) => send(res, await F.saveShiftTemplate(req.params.code, req.body || {}, req.auth.loginId, meta(req)))));
r.post('/calendar/regenerate', cfg, E.asyncH(async (req, res) => res.json(await F.ensureCalendar(null, req.auth.loginId, { force: true }))));
r.put('/checklists/:gate', cfg, E.asyncH(async (req, res) => res.json(await F.saveChecklist(req.params.gate, req.body || {}, req.auth.loginId, meta(req)))));
r.post('/products', cfg, E.asyncH(async (req, res) => { const out = await F.saveProduct(req.body || {}, req.auth.loginId, meta(req)); res.status(out.dryRun ? 200 : 201).json(out); }));
r.post('/products/:id/release', cfg, E.asyncH(async (req, res) => res.json(await F.releaseProduct(req.params.id, req.auth.loginId, meta(req)))));

r.get('/template', cfg, E.asyncH(async (req, res) => res.json(await F.templatePreview())));
r.post('/template/import', cfg, E.asyncH(async (req, res) => res.status(201).json(await F.importTemplate(req.body || {}, req.auth.loginId, meta(req)))));

r.get('/reset', requirePerm('factory_reset'), E.asyncH(async (req, res) => res.json(await F.resetPreview(req))));
r.post('/reset', requirePerm('factory_reset'), E.asyncH(async (req, res) => res.json(await F.reset(req.body || {}, req.auth.loginId, req))));

module.exports = r;
