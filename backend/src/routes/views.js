'use strict';
/* Read-only session views. GET endpoints never advance time or mutate state. */
const express = require('express');
const S = require('../services/sessions');
const V = require('../services/viewsCommon');
const P = require('../services/plantViews');
const Passport = require('../services/passport');
const { requireAuth, requirePerm, has } = require('../middleware/auth');
const E = require('../lib/errors');

const r = express.Router({ mergeParams: true });
r.use(requireAuth);

async function ctxFor(req) {
  const s = await S.get(req.params.sid);
  const x = await V.ctx(s);
  x.perms = req.auth.permissions;
  return x;
}
const SUP = ['operational_supervision', 'quality_approval', 'view_all_workers', 'scenario_control'];
const get = (path, perms, fn) => r.get(path, ...(perms ? [requirePerm(...perms)] : []), E.asyncH(async (req, res) => {
  const x = await ctxFor(req);
  if (x.session.STATUS === 'INITIALIZING') return res.status(409).json({ error: { code: 'SESSION_INITIALIZING', message: 'The simulation is being initialised from the checkpoint - try again in a few seconds' }, session: S.publicSession(x.session) });
  res.json(await fn(x, req));
}));

get('/overview', SUP, x => P.overview(x));
get('/workforce', SUP, (x, req) => P.workforce(x, req.query));
get('/workers/:wid', null, async (x, req) => {
  if (req.params.wid !== req.auth.workerId && !SUP.some(p => has(req, p))) throw E.forbidden('You can only view your own timeline');
  return P.workerDetail(x, req.params.wid);
});
get('/work-centers/:wc', null, (x, req) => P.workCenter(x, req.params.wc));
get('/orders', SUP, x => P.orders(x));
get('/orders/:lineId', SUP, (x, req) => P.orderLine(x, req.params.lineId));
get('/units/:unitId', null, (x, req) => Passport.full(x, req.params.unitId, req.auth));
get('/quality', ['quality_approval', 'operational_supervision', 'perform_quality_inspection', 'view_all_workers'], x => P.quality(x));
get('/inspections/:id', null, async (x, req) => {
  const out = await P.inspection(x, req.params.id);
  if (out.inspection.inspectorId !== req.auth.workerId && !['view_evidence', 'quality_approval', 'operational_supervision', 'perform_quality_inspection'].some(p => has(req, p))) throw E.forbidden('Not your inspection');
  return out;
});
get('/alerts', SUP, (x, req) => P.alerts(x, req.query));
get('/forecasts', SUP, x => P.forecasts(x));
get('/actions', SUP, x => P.actions(x));
get('/materials', null, x => P.materials(x));
get('/events', SUP, (x, req) => P.events(x, req.query));
get('/support-requests', SUP, x => P.supportRequests(x));
get('/search', null, async (x, req) => {
  // tank search by unit ID or serial (prefix, case-insensitive); history rows only as known at the cut. Also used by the
  // operator app's scanner (barcode / QR / manual entry) - it resolves tank serials, unit IDs and station IDs
  const q = String(req.query.q || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (q.length < 3) return { query: q, units: [], stations: [], note: 'Type at least 3 characters of a tank ID or serial' };
  const rx = new RegExp('^' + q);
  const sess = await V.sim(x, 'sim_units', { $or: [{ UNIT_ID: rx }, { TANK_SERIAL_NO: rx }] }, { limit: 20, projection: { UNIT_ID: 1, TANK_SERIAL_NO: 1, STATE: 1, ORDER_LINE_ID: 1, CURRENT_WORK_CENTER_ID: 1 } });
  const seen = new Set(sess.map(u => u.UNIT_ID));
  const hist = await x.db.collection('unit_master').find({ RUN_ID: x.src, KNOWN_AT: { $lte: x.histCut }, $or: [{ UNIT_ID: rx }, { TANK_SERIAL_NO: rx }] }, { projection: { UNIT_ID: 1, TANK_SERIAL_NO: 1, ORDER_LINE_ID: 1 } }).limit(20).toArray();
  // stations (scanned station labels): exact or prefix match on the configured workstation IDs, with the tank currently there
  const stationIds = Object.keys(x.cat.stations || {}).filter(id => id.toUpperCase().startsWith(q)).slice(0, 10);
  const atStation = stationIds.length ? await V.sim(x, 'sim_units', { CURRENT_WORKSTATION_ID: { $in: stationIds }, STATE: { $nin: ['ROUTE_COMPLETE', 'SCRAPPED'] } }, { limit: 50, projection: { UNIT_ID: 1, TANK_SERIAL_NO: 1, STATE: 1, CURRENT_WORKSTATION_ID: 1 } }) : [];
  const stations = stationIds.map(id => { const st = x.cat.stations[id]; return { workstationId: id, name: st.WORKSTATION_NAME || st.NAME || null, workCenterId: st.WORK_CENTER_ID || null,
    tanks: atStation.filter(u => u.CURRENT_WORKSTATION_ID === id).map(u => ({ unitId: u.UNIT_ID, serial: u.TANK_SERIAL_NO, state: u.STATE })) }; });
  return { query: q, stations, units: [...sess.map(u => ({ unitId: u.UNIT_ID, serial: u.TANK_SERIAL_NO, state: u.STATE, orderLineId: u.ORDER_LINE_ID, workCenterId: u.CURRENT_WORK_CENTER_ID || null, source: 'SESSION' })),
    ...hist.filter(h => !seen.has(h.UNIT_ID)).map(h => ({ unitId: h.UNIT_ID, serial: h.TANK_SERIAL_NO, state: null, orderLineId: h.ORDER_LINE_ID, workCenterId: null, source: 'HISTORY' }))].slice(0, 20) };
});
get('/freshness', null, x => ({ session: P.header(x), freshness: V.freshness(x) }));

module.exports = r;
