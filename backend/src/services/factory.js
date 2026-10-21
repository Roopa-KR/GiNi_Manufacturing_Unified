'use strict';
/*
 * Fresh Factory mode (GINI_ENVIRONMENT=FRESH_FACTORY).
 *
 * The factory starts EMPTY: no workers, orders, batches, tanks or history. An administrator configures it from the admin
 * application (factory and timezone, work centres and stations, skills, shifts, equipment and materials, products and routes,
 * inspection checklists, workers and logins), enters the first order and releases the first batch.
 *
 * Operational activity lives in ONE permanent session, S-FACTORY (no checkpoint, no inherited history, real-time clock in Manual
 * Team Test mode). It is created by the explicit bootstrap command `npm run factory:init` - never at application start-up.
 *
 * Every configuration write is one transaction together with its audit record (services/audit.adminTx); a retry with the same
 * Idempotency-Key returns the first result. Configuration documents are deactivated, never deleted, so past records keep resolving.
 */
const fs = require('fs');
const path = require('path');
const { getDb, withTransaction } = require('../lib/db');
const { config } = require('../config/env');
const { localIso, localToUtc, setPlantTz, simNow } = require('../lib/time');
const E = require('../lib/errors');
const A = require('./audit');
const C = require('../domain/catalog');

const FACTORY_SESSION_ID = 'S-FACTORY';
const MODES = ['MANUAL_TEAM_TEST', 'SIMULATED_TEST'];
const CAL_DAYS = 60;                 // shift calendar generated this many days ahead (extended lazily)
const ID = /^[A-Z][A-Z0-9_-]{1,31}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// operational (session-scoped) collections cleared by the guarded reset; configuration collections are kept unless asked
const OPERATIONAL_COLLS = ['factory_baseline_samples', 'sim_units', 'sim_operations', 'sim_tasks', 'sim_workers', 'sim_equipment', 'sim_materials', 'sim_inspections', 'sim_holds', 'sim_returns', 'sim_plan_releases',
  'sim_material_requests', 'sim_events', 'sim_participation', 'sim_readings', 'sim_evidence', 'sim_dispositions', 'sim_defects', 'sim_investigations', 'sim_points_ledger', 'sim_alerts',
  'sim_alert_transitions', 'sim_forecasts', 'sim_projections', 'sim_actions', 'sim_replacements', 'sim_milestones', 'sim_attendance', 'sim_support_requests', 'sim_handovers',
  'sim_transfers', 'sim_overtime', 'sim_attendance_corrections', 'sim_progress', 'sim_points_evaluations', 'sim_batch_membership', 'sim_batches', 'sim_scans', 'sim_change_log'];
const SESSION_TAGGED = ['production_orders', 'order_lines', 'production_batches', 'production_plan'];
const PEOPLE_COLLS = ['worker_master', 'worker_qualifications', 'app_users', 'app_shift_roster'];
const CONFIG_COLLS = ['work_center_master', 'workstation_master', 'skill_master', 'equipment_master', 'equipment_operation_map', 'material_master', 'material_requirements', 'product_master',
  'routing_operations', 'route_dependencies', 'crew_capacity_rules', 'operation_skill_requirements', 'milestone_definitions', 'operation_instructions', 'instruction_steps',
  'ctq_check_master', 'ctq_specifications', 'transfer_rules', 'dispatch_rules', 'disposition_policies', 'disposition_matrix', 'shift_templates', 'shift_calendar', 'calendar_intervals'];

function requireFresh() {
  if (!config().isFresh) throw E.conflict('NOT_FRESH_FACTORY', 'This is only available when the API runs with GINI_ENVIRONMENT=FRESH_FACTORY');
}
const ds = () => config().datasetId;
const isoDate = d => new Date(d).toISOString().slice(0, 10);
const utcMidnight = s => new Date(`${s}T00:00:00Z`);
function addDays(s, n) { const d = utcMidnight(s); d.setUTCDate(d.getUTCDate() + n); return isoDate(d); }
function isoDow(s) { const d = utcMidnight(s).getUTCDay(); return d === 0 ? 7 : d; }      // 1 = Monday ... 7 = Sunday
function str(v, max = 120) { return v === undefined || v === null ? null : String(v).trim().slice(0, max); }
function num(v) { return v === null || v === undefined || v === '' ? null : Number(v); }
function yn(v, d = 'Y') { if (v === undefined || v === null || v === '') return d; return v === true || v === 'Y' || v === 'y' || v === 'true' ? 'Y' : 'N'; }
function idOf(v) { return String(v || '').trim().toUpperCase(); }
function fail(errors, code = 'INVALID_CONFIGURATION') { if (errors.length) throw E.bad(code, errors.join('; '), { errors }); }

// ------------------------------------------------------------------------------------------------ settings / environment
async function settings(db) {
  db = db || await getDb();
  return db.collection('factory_settings').findOne({ dataset_id: ds() }, { projection: { _id: 0 } });
}
async function session(db) {
  db = db || await getDb();
  return db.collection('sim_sessions').findOne({ SESSION_ID: FACTORY_SESSION_ID });
}
/** applies the configured plant timezone to the API's local-time helpers (called when master data is loaded) */
async function applyTimezone(db) {
  if (!config().isFresh) return null;
  const s = await settings(db);
  if (s && s.TIMEZONE) { try { setPlantTz(s.TIMEZONE); } catch (e) { /* validated on save */ } }
  return s;
}

async function environment(req) {
  const c = config();
  const db = await getDb();
  const out = { environment: c.environment, environmentName: c.environmentName, datasetId: c.datasetId, freshFactory: c.isFresh, production: c.isProd,
    allowFactoryReset: c.isFresh && c.allowFactoryReset && !c.isProd };
  const signedIn = !!(req && req.auth);
  if (signedIn) out.database = c.mongoDb;           // the database NAME only (never the URI) for signed-in users
  if (c.isFresh) {
    const s = await settings(db);
    const sess = await session(db);
    const now = new Date();
    const tz = (s && s.TIMEZONE) || null;
    out.factory = s ? { name: s.FACTORY_NAME, siteId: s.SITE_ID, timezone: s.TIMEZONE, operatingMode: s.OPERATING_MODE, workingDays: s.WORKING_DAYS, serialPrefix: s.SERIAL_PREFIX } : null;
    out.session = sess ? { sessionId: sess.SESSION_ID, status: sess.STATUS, operatingMode: sess.OPERATING_MODE, realTime: !!(sess.CLOCK || {}).REAL_TIME } : null;
    out.operationalDate = tz ? localIso(now, tz).slice(0, 10) : null;
    out.operationalTimeLocal = tz ? localIso(now, tz) : null;
    out.timezone = tz;
    out.bootstrap = sess ? 'DONE' : 'NOT_RUN';
    if (!sess) out.hint = 'The factory is not initialised yet: run "npm run factory:init" in the backend folder (see FRESH_FACTORY_SETUP.md).';
  }
  return out;
}

function validTz(tz) { try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch (e) { return false; } }

async function saveSettings(b, actor, meta = {}) {
  requireFresh();
  const err = [];
  const name = str(b.factoryName, 80); const site = idOf(b.siteId);
  if (!name || name.length < 2) err.push('factoryName is required');
  if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(site)) err.push('siteId: 2-32 capital letters, digits, _ or -');
  if (!b.timezone || !validTz(b.timezone)) err.push('timezone must be an IANA zone such as America/Bogota or Europe/Berlin');
  const mode = b.operatingMode || 'MANUAL_TEAM_TEST';
  if (!MODES.includes(mode)) err.push(`operatingMode must be ${MODES.join(' or ')}`);
  const days = Array.isArray(b.workingDays) && b.workingDays.length ? [...new Set(b.workingDays.map(Number))].sort() : [1, 2, 3, 4, 5];
  if (days.some(d => !(d >= 1 && d <= 7))) err.push('workingDays are ISO weekdays 1 (Monday) .. 7 (Sunday)');
  const prefix = idOf(b.serialPrefix || 'TANK');
  if (!/^[A-Z][A-Z0-9-]{1,15}$/.test(prefix)) err.push('serialPrefix: 2-16 capital letters, digits or -');
  // barcode / typed scan of the tank label (its serial) before people start work / an inspection - off unless switched on
  const scanReq = { START_WORK: b.scanRequiredStartWork === true, INSPECTION: b.scanRequiredInspection === true };
  fail(err);
  const db = await getDb();
  const sess = await session(db);
  // changing the timezone or the mode while tanks are in progress would reinterpret shift times: only allowed before work starts
  if (sess) {
    const prev = await settings(db);
    const active = await db.collection('sim_units').countDocuments({ SESSION_ID: FACTORY_SESSION_ID, STATE: { $nin: ['ROUTE_COMPLETE', 'SCRAPPED'] } });
    if (prev && active && prev.TIMEZONE !== b.timezone) throw E.conflict('TANKS_ACTIVE', `The timezone cannot change while ${active} tank(s) are in progress`);
    // leaving Simulated Test: the simulated clock may not be ahead of real time (the event timeline never goes backwards)
    if (prev && prev.OPERATING_MODE === 'SIMULATED_TEST' && mode === 'MANUAL_TEAM_TEST' && !(sess.CLOCK || {}).REAL_TIME) {
      const ahead = (simNow(sess) - new Date()) / 60000;
      if (ahead > 1) throw E.conflict('SIMULATED_CLOCK_AHEAD', `The simulated clock is ${Math.round(ahead)} min ahead of real time; wait until real time catches up before returning to Manual Team Test`);
    }
  }
  const res = await A.adminTx({ actor, action: 'FACTORY_SETTINGS_SAVED', target: ds(), idempotencyKey: meta.idempotencyKey, request: b, requestId: meta.requestId }, async (s) => {
    const before = await db.collection('factory_settings').findOne({ dataset_id: ds() }, { session: s, projection: { _id: 0 } });
    const doc = { dataset_id: ds(), FACTORY_NAME: name, SITE_ID: site, TIMEZONE: b.timezone, OPERATING_MODE: mode, WORKING_DAYS: days, SERIAL_PREFIX: prefix, SCAN_REQUIRED: scanReq,
      CALENDAR_NOTE: str(b.calendarNote, 300), UPDATED_AT: new Date(), UPDATED_BY: actor, _origin: 'APP' };
    await db.collection('factory_settings').updateOne({ dataset_id: ds() }, { $set: doc, $setOnInsert: { CREATED_AT: new Date(), CREATED_BY: actor }, $inc: { VERSION: 1 } }, { upsert: true, session: s });
    if (sess) {
      await db.collection('sim_sessions').updateOne({ SESSION_ID: FACTORY_SESSION_ID }, { $set: { PLANT_TIMEZONE: b.timezone, OPERATING_MODE: mode, SERIAL_PREFIX: prefix, SITE_ID: site, FACTORY_NAME: name, SCAN_REQUIRED: scanReq,
        NAME: `${name} (${mode === 'MANUAL_TEAM_TEST' ? 'manual team test' : 'simulated test'})`, CLOCK: clockFor(sess, mode, actor) } }, { session: s });
    }
    return { before, after: doc, result: { ok: true, settings: doc } };
  });
  setPlantTz(b.timezone);
  C.invalidate();
  await ensureCalendar(db, actor, { force: true });
  return res;
}

/** Manual Team Test runs on real time. Simulated Test starts from the current time and can then be paused / sped up (forward only). */
function clockFor(sess, mode, actor) {
  const now = new Date();
  const c = sess.CLOCK || {};
  if (mode === 'MANUAL_TEAM_TEST') return { REAL_TIME: true, PAUSED: false, SPEED: 1, ANCHOR_SIM_AT: now, ANCHOR_WALL_AT: now, UPDATED_AT: now, CONTROLLER_LOGIN_ID: actor };
  if (c.REAL_TIME || !c.ANCHOR_SIM_AT) return { REAL_TIME: false, PAUSED: false, SPEED: 1, ANCHOR_SIM_AT: now, ANCHOR_WALL_AT: now, UPDATED_AT: now, CONTROLLER_LOGIN_ID: actor };
  return c;                         // already simulated: keep its clock
}

// ------------------------------------------------------------------------------------------------ generic configuration writer
/**
 * upsert one configuration document keyed by {dataset_id, key: id} in one transaction with its audit record.
 * build(existing, s) returns the fields to set (validated before the transaction where possible).
 */
async function saveConfig({ coll, key, id, action, actor, meta, request, fields, after }) {
  const db = await getDb();
  const res = await A.adminTx({ actor, action, target: id, idempotencyKey: meta.idempotencyKey, request, requestId: meta.requestId }, async (s) => {
    const before = await db.collection(coll).findOne({ dataset_id: ds(), [key]: id }, { session: s, projection: { _id: 0 } });
    const now = new Date();
    const set = { ...fields, [key]: id, dataset_id: ds(), ORIGIN: (before && before.ORIGIN) || 'FACTORY_ADMIN', UPDATED_AT: now, UPDATED_BY: actor, _origin: 'APP' };
    await db.collection(coll).updateOne({ dataset_id: ds(), [key]: id }, { $set: set, $setOnInsert: { CREATED_AT: now, CREATED_BY: actor }, $inc: { CONFIG_VERSION: 1 } }, { upsert: true, session: s });
    if (after) await after(s, db, before, set);
    return { before, after: set, details: { collection: coll, created: !before }, result: { ok: true, created: !before, id, record: set } };
  });
  C.invalidate();
  await recalc(db);
  return res;
}

/** configuration changed: queue one (deduplicated) recalculation of the factory session so forecasts use the new setup */
async function recalc(db) {
  try { if (await db.collection('sim_sessions').findOne({ SESSION_ID: FACTORY_SESSION_ID, STATUS: { $in: ['READY', 'RUNNING', 'PAUSED'] } }, { projection: { _id: 1 } })) await require('./sessions').enqueueJob(db, FACTORY_SESSION_ID, 'RECALC', { reason: 'CONFIGURATION_CHANGED' }, 3); } catch (e) { /* the periodic pass catches up */ }
}

async function activeUnitsWhere(db, filter) {
  return db.collection('sim_units').countDocuments({ SESSION_ID: FACTORY_SESSION_ID, STATE: { $nin: ['ROUTE_COMPLETE', 'SCRAPPED'] }, ...filter });
}

// ------------------------------------------------------------------------------------------------ work centres, stations, skills
async function saveWorkCenter(id, b, actor, meta = {}) {
  requireFresh();
  id = idOf(id || b.workCenterId);
  const err = [];
  if (!ID.test(id)) err.push('workCenterId: 2-32 capital letters, digits, _ or -, starting with a letter');
  if (!str(b.name)) err.push('name is required');
  const qcap = num(b.queueCapacity);
  if (qcap !== null && !(Number.isInteger(qcap) && qcap >= 1)) err.push('queueCapacity must be a whole number >= 1 (leave empty for no limit)');
  const cap = num(b.capacity);
  if (cap !== null && !(Number.isInteger(cap) && cap >= 1)) err.push('capacity (tanks worked at the same time) must be a whole number >= 1');
  fail(err);
  const active = yn(b.active);
  const db = await getDb();
  if (active === 'N' && await activeUnitsWhere(db, { CURRENT_WORK_CENTER_ID: id })) throw E.conflict('IN_USE', `${id} has tanks in progress; finish or move them before deactivating it`);
  return saveConfig({ coll: 'work_center_master', key: 'WORK_CENTER_ID', id, action: 'WORK_CENTER_SAVED', actor, meta, request: b, fields: {
    WORK_CENTER_NAME: str(b.name), WORK_CENTER_TYPE: str(b.type, 40) || 'PRODUCTION', AREA_ID: b.areaId ? idOf(b.areaId) : null, QUEUE_CAPACITY_UNITS: qcap, UNIT_CAPACITY: cap,
    APPLICABLE_OPERATIONS: (b.applicableOperations || []).map(idOf).filter(Boolean), ROUTE_SEQUENCE: num(b.sequence), ACTIVE_FLAG: active, DEMO_SCOPE: 'FRESH_FACTORY' } });
}

const STATION_TYPES = ['WORKSTATION', 'INSPECTION_BAY', 'CURE_ZONE', 'HOLD_AREA'];
async function saveStation(id, b, actor, meta = {}) {
  requireFresh();
  id = idOf(id || b.workstationId);
  const cat = await C.catalog(true);
  const err = [];
  if (!ID.test(id)) err.push('workstationId: 2-32 capital letters, digits, _ or -');
  if (!str(b.name)) err.push('name is required');
  const wc = idOf(b.workCenterId);
  if (!cat.wcs[wc]) err.push(`workCenterId ${wc || '(empty)'} is not a configured work centre`);
  else if (cat.wcs[wc].ACTIVE_FLAG === 'N') err.push(`work centre ${wc} is inactive`);
  const type = b.type || 'WORKSTATION';
  if (!STATION_TYPES.includes(type)) err.push(`type must be one of ${STATION_TYPES.join(', ')}`);
  const cap = num(b.capacity) ?? 1;
  if (!(Number.isInteger(cap) && cap >= 1)) err.push('capacity must be a whole number >= 1');
  const eq = b.equipmentId ? idOf(b.equipmentId) : null;
  if (eq && !cat.equipment[eq]) err.push(`equipment ${eq} is not configured`);
  fail(err);
  const active = yn(b.active);
  const db = await getDb();
  if (active === 'N' && await activeUnitsWhere(db, { CURRENT_WORKSTATION_ID: id })) throw E.conflict('IN_USE', `${id} has a tank on it; finish or move it first`);
  return saveConfig({ coll: 'workstation_master', key: 'WORKSTATION_ID', id, action: 'STATION_SAVED', actor, meta, request: b, fields: {
    WORKSTATION_NAME: str(b.name), WORKSTATION_TYPE: type, WORK_CENTER_ID: wc, AREA_ID: (cat.wcs[wc] || {}).AREA_ID || null, EQUIPMENT_ID: eq, UNIT_CAPACITY: cap,
    APPLICABLE_OPERATIONS: (b.applicableOperations || []).map(idOf).filter(Boolean), ACTIVE_FLAG: active } });
}

async function saveSkill(id, b, actor, meta = {}) {
  requireFresh();
  id = idOf(id || b.skillId);
  const cat = await C.catalog(true);
  const err = [];
  if (!ID.test(id)) err.push('skillId: 2-32 capital letters, digits, _ or -');
  if (!str(b.name)) err.push('name is required');
  const wc = b.workCenterId ? idOf(b.workCenterId) : null;
  if (wc && !cat.wcs[wc]) err.push(`work centre ${wc} is not configured`);
  fail(err);
  return saveConfig({ coll: 'skill_master', key: 'SKILL_ID', id, action: 'SKILL_SAVED', actor, meta, request: b, fields: {
    SKILL_NAME: str(b.name), SKILL_CATEGORY: str(b.category, 30) || 'PRODUCTION', WORK_CENTER_ID: wc, ACTIVE_FLAG: yn(b.active) } });
}

// ------------------------------------------------------------------------------------------------ equipment and materials
async function saveEquipment(id, b, actor, meta = {}) {
  requireFresh();
  id = idOf(id || b.equipmentId);
  const cat = await C.catalog(true);
  const err = [];
  if (!ID.test(id)) err.push('equipmentId: 2-32 capital letters, digits, _ or -');
  if (!str(b.name)) err.push('name is required');
  const ws = b.workstationId ? idOf(b.workstationId) : null;
  let wc = b.workCenterId ? idOf(b.workCenterId) : null;
  if (ws) { if (!cat.stations[ws]) err.push(`station ${ws} is not configured`); else wc = wc || cat.stations[ws].WORK_CENTER_ID; if (cat.stations[ws] && wc && cat.stations[ws].WORK_CENTER_ID !== wc) err.push(`station ${ws} belongs to ${cat.stations[ws].WORK_CENTER_ID}, not ${wc}`); }
  if (!wc || !cat.wcs[wc]) err.push('workCenterId (or a station) is required');
  const skills = (b.requiredSkills || []).map(idOf).filter(Boolean);
  for (const s of skills) if (!cat.skills[s]) err.push(`unknown skill ${s}`);
  const availability = b.availability || 'AVAILABLE';
  if (!['AVAILABLE', 'UNAVAILABLE'].includes(availability)) err.push('availability must be AVAILABLE or UNAVAILABLE');
  const mttr = num(b.mttrMin);
  if (mttr !== null && !(mttr > 0)) err.push('mttrMin must be positive when given');
  fail(err);
  return saveConfig({ coll: 'equipment_master', key: 'EQUIPMENT_ID', id, action: 'EQUIPMENT_SAVED', actor, meta, request: b, fields: {
    EQUIPMENT_NAME: str(b.name), EQUIPMENT_TYPE: str(b.type, 40) || 'GENERAL', WORKSTATION_ID: ws, WORK_CENTER_ID: wc, REQUIRED_SKILL_IDS: skills, AVAILABILITY: availability, MTTR_MIN: mttr, ACTIVE_FLAG: yn(b.active) },
    after: async (s, db, before) => {
      if (ws) await db.collection('workstation_master').updateOne({ dataset_id: ds(), WORKSTATION_ID: ws, $or: [{ EQUIPMENT_ID: null }, { EQUIPMENT_ID: id }, { EQUIPMENT_ID: { $exists: false } }] }, { $set: { EQUIPMENT_ID: id } }, { session: s });
      // the live status starts from the configured availability; later changes are breakdown / repair events (audited commands)
      await db.collection('sim_equipment').updateOne({ SESSION_ID: FACTORY_SESSION_ID, EQUIPMENT_ID: id }, {
        $set: { WORKSTATION_ID: ws, WORK_CENTER_ID: wc, UPDATED_AT: new Date() },
        $setOnInsert: { SESSION_ID: FACTORY_SESSION_ID, RUN_ID: 'RUN-FACTORY', DATASET_ID: ds(), EQUIPMENT_ID: id, STATUS: availability === 'AVAILABLE' ? 'UP' : 'DOWN', SINCE: new Date(),
          REASON_CODE: availability === 'AVAILABLE' ? null : 'CONFIGURED_UNAVAILABLE', ORIGIN: 'FACTORY_CONFIG', VERSION: 1, _origin: 'APP' } }, { upsert: true, session: s });
    } });
}

async function saveMaterial(id, b, actor, meta = {}) {
  requireFresh();
  id = idOf(id || b.materialId);
  const err = [];
  if (!ID.test(id)) err.push('materialId: 2-32 capital letters, digits, _ or -');
  if (!str(b.name)) err.push('name is required');
  if (!str(b.uom, 12)) err.push('uom (unit of measure, e.g. KIT, EA, KG, L) is required');
  fail(err);
  return saveConfig({ coll: 'material_master', key: 'MATERIAL_ID', id, action: 'MATERIAL_SAVED', actor, meta, request: b, fields: {
    MATERIAL_NAME: str(b.name), UOM: str(b.uom, 12).toUpperCase(), LOT_TRACKED: yn(b.lotTracked, 'N'), REORDER_POINT: num(b.reorderPoint), ACTIVE_FLAG: yn(b.active) },
    after: async (s, db) => {
      // stock starts at ZERO: inventory is never unlimited; quantities come only from explicit receipts (MATERIAL_RECEIPT)
      await db.collection('sim_materials').updateOne({ SESSION_ID: FACTORY_SESSION_ID, MATERIAL_ID: id }, {
        $set: { MATERIAL_NAME: str(b.name), UOM: str(b.uom, 12).toUpperCase(), UPDATED_AT: new Date() },
        $setOnInsert: { SESSION_ID: FACTORY_SESSION_ID, RUN_ID: 'RUN-FACTORY', DATASET_ID: ds(), MATERIAL_ID: id, ON_HAND_QTY: 0, HOLD_QTY: 0, RESERVED_QTY: 0, LOTS: [], ORIGIN: 'FACTORY_CONFIG', VERSION: 1, _origin: 'APP' } },
      { upsert: true, session: s });
    } });
}

// ------------------------------------------------------------------------------------------------ shifts
async function saveShiftTemplate(code, b, actor, meta = {}) {
  requireFresh();
  code = idOf(code || b.shiftCode);
  const cat = await C.catalog(true);
  const err = [];
  if (!/^[A-Z0-9]{1,8}$/.test(code)) err.push('shiftCode: 1-8 capital letters or digits (e.g. A, B, N)');
  if (!str(b.name)) err.push('name is required');
  if (!HHMM.test(b.startLocal || '') || !HHMM.test(b.endLocal || '')) err.push('startLocal and endLocal are HH:MM (24 h, plant local time)');
  if (b.startLocal && b.startLocal === b.endLocal) err.push('a shift cannot start and end at the same time');
  const days = Array.isArray(b.daysOfWeek) && b.daysOfWeek.length ? [...new Set(b.daysOfWeek.map(Number))].sort() : null;
  if (!days || days.some(d => !(d >= 1 && d <= 7))) err.push('daysOfWeek: ISO weekdays 1 (Monday) .. 7 (Sunday), at least one');
  if (b.effectiveFrom && !DATE.test(b.effectiveFrom)) err.push('effectiveFrom is YYYY-MM-DD');
  if (b.effectiveTo && !DATE.test(b.effectiveTo)) err.push('effectiveTo is YYYY-MM-DD');
  if (b.effectiveFrom && b.effectiveTo && b.effectiveTo < b.effectiveFrom) err.push('effectiveTo is before effectiveFrom');
  const overnight = !!(b.startLocal && b.endLocal && b.endLocal < b.startLocal);
  const mins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const inShift = t => { const s = mins(b.startLocal), e = mins(b.endLocal), x = mins(t); return overnight ? (x >= s || x <= e) : (x >= s && x <= e); };
  const breaks = (b.breaks || []).map((x, i) => {
    const at = `break ${i + 1}`;
    if (!HHMM.test(x.startLocal || '') || !HHMM.test(x.endLocal || '')) err.push(`${at}: startLocal and endLocal are HH:MM`);
    else if (b.startLocal && b.endLocal && HHMM.test(b.startLocal) && HHMM.test(b.endLocal) && (!inShift(x.startLocal) || !inShift(x.endLocal))) err.push(`${at}: must lie inside the shift`);
    const res = (x.resourceIds || []).map(idOf).filter(Boolean);
    for (const r of res) if (r !== 'SUPPORT' && !cat.wcs[r]) err.push(`${at}: unknown work centre ${r} (use SUPPORT for inspectors and support staff)`);
    return { START_LOCAL: x.startLocal, END_LOCAL: x.endLocal, RESOURCE_IDS: res, LABEL: str(x.label, 40) };
  });
  fail(err);
  const db = await getDb();
  const out = await saveConfig({ coll: 'shift_templates', key: 'SHIFT_CODE', id: code, action: 'SHIFT_TEMPLATE_SAVED', actor, meta, request: b, fields: {
    SHIFT_NAME: str(b.name), START_LOCAL: b.startLocal, END_LOCAL: b.endLocal, OVERNIGHT: overnight, DAYS_OF_WEEK: days, BREAKS: breaks,
    EFFECTIVE_FROM: b.effectiveFrom || null, EFFECTIVE_TO: b.effectiveTo || null, ACTIVE_FLAG: yn(b.active) } });
  const gen = await ensureCalendar(db, actor, { force: true, codes: [code] });
  return { ...out, calendar: gen };
}

/**
 * Dated shift calendar (shift_calendar + calendar_intervals) generated from the shift templates for today .. today+CAL_DAYS, and the
 * planned roster (app_shift_roster) of every active worker for those shifts. Past dates are never rewritten; future dates of a
 * changed template are regenerated. Called on every template / settings / worker change and lazily when the horizon runs short.
 */
async function ensureCalendar(db, actor = 'SYSTEM', opts = {}) {
  if (!config().isFresh) return null;
  db = db || await getDb();
  const st = await settings(db);
  if (!st || !st.TIMEZONE) return { skipped: 'factory settings (timezone) not saved yet' };
  const tz = st.TIMEZONE;
  const today = localIso(new Date(), tz).slice(0, 10);
  const horizon = addDays(today, CAL_DAYS);
  if (!opts.force && st.CALENDAR_GENERATED_TO && st.CALENDAR_GENERATED_TO >= addDays(today, 30)) return { upToDate: st.CALENDAR_GENERATED_TO };
  const tpls = await db.collection('shift_templates').find({ dataset_id: ds() }).toArray();
  const wcs = await db.collection('work_center_master').find({ dataset_id: ds(), ACTIVE_FLAG: { $ne: 'N' } }).toArray();
  const from = addDays(today, -1);       // yesterday's overnight shift may still be running
  let shifts = 0, intervals = 0;
  for (const t of tpls) {
    if (opts.codes && !opts.codes.includes(t.SHIFT_CODE)) continue;
    // regenerate this template's future dates (from yesterday); earlier dates stay as they were recorded
    await db.collection('shift_calendar').deleteMany({ dataset_id: ds(), SHIFT_CODE: t.SHIFT_CODE, SHIFT_DATE: { $gte: utcMidnight(from) }, ORIGIN: 'FACTORY_SHIFT_TEMPLATE' });
    await db.collection('calendar_intervals').deleteMany({ dataset_id: ds(), SHIFT_CODE: t.SHIFT_CODE, SHIFT_DATE: { $gte: utcMidnight(from) }, ORIGIN: 'FACTORY_SHIFT_TEMPLATE' });
    if (t.ACTIVE_FLAG === 'N') continue;
    const rows = [], ivs = [];
    for (let d = from; d <= horizon; d = addDays(d, 1)) {
      if (!t.DAYS_OF_WEEK.includes(isoDow(d))) continue;
      if (t.EFFECTIVE_FROM && d < t.EFFECTIVE_FROM) continue;
      if (t.EFFECTIVE_TO && d > t.EFFECTIVE_TO) continue;
      const sid = `SH-${d.replace(/-/g, '')}-${t.SHIFT_CODE}`;
      rows.push({ dataset_id: ds(), SHIFT_ID: sid, SHIFT_DATE: utcMidnight(d), SHIFT_CODE: t.SHIFT_CODE, START_AT_LOCAL: t.START_LOCAL, END_AT_LOCAL: t.END_LOCAL, DAY_TYPE: 'WORK',
        TIMEZONE: tz, OVERNIGHT: !!t.OVERNIGHT, ORIGIN: 'FACTORY_SHIFT_TEMPLATE', TEMPLATE_VERSION: t.CONFIG_VERSION || 1, _origin: 'APP', CREATED_AT: new Date() });
      (t.BREAKS || []).forEach((br, i) => {
        const res = br.RESOURCE_IDS && br.RESOURCE_IDS.length ? br.RESOURCE_IDS : [...wcs.map(w => w.WORK_CENTER_ID), 'SUPPORT'];
        for (const r of res) ivs.push({ dataset_id: ds(), INTERVAL_ID: `BRK-${sid}-${r}-${i + 1}`, SHIFT_ID: sid, SHIFT_CODE: t.SHIFT_CODE, SHIFT_DATE: utcMidnight(d), RESOURCE_ID: r,
          RESOURCE_TYPE: r === 'SUPPORT' ? 'SUPPORT' : 'WORK_CENTER', INTERVAL_TYPE: 'PLANNED_BREAK', START_AT_LOCAL: br.START_LOCAL, END_AT_LOCAL: br.END_LOCAL, LABOR_PAUSES: 'Y', PROCESS_CONTINUES: 'Y',
          LABEL: br.LABEL || null, ORIGIN: 'FACTORY_SHIFT_TEMPLATE', _origin: 'APP' });
      });
    }
    if (rows.length) await db.collection('shift_calendar').insertMany(rows);
    if (ivs.length) await db.collection('calendar_intervals').insertMany(ivs);
    shifts += rows.length; intervals += ivs.length;
  }
  await db.collection('factory_settings').updateOne({ dataset_id: ds() }, { $set: { CALENDAR_GENERATED_TO: horizon, CALENDAR_GENERATED_AT: new Date() } });
  C.invalidate();
  const roster = await extendRosters(db, actor);
  return { shifts, breakIntervals: intervals, generatedTo: horizon, rosterRows: roster };
}

/** planned roster rows of every active worker for the generated shifts of their crew (no attendance is ever created) */
async function extendRosters(db, actor) {
  const cat = await C.catalog(true);
  const workers = await db.collection('worker_master').find({ dataset_id: ds(), ACTIVE_FLAG: 'Y' }).toArray();
  const W = require('./workersAdmin');
  let n = 0;
  const today = localIso(new Date()).slice(0, 10);
  for (const w of workers) {
    const start = w.HIRE_DATE ? isoDate(w.HIRE_DATE) : today;
    const rows = W.rosterRows(cat, w.WORKER_ID, w.SHIFT_CREW, start > today ? start : addDays(today, -1), w.HOME_WORK_CENTER_ID, w.WORKER_ROLE);
    // rows of shifts that no longer exist (template changed) are removed for future dates; history stays
    const ids = new Set(rows.map(r => r.ROSTER_ID));
    await db.collection('app_shift_roster').deleteMany({ dataset_id: ds(), WORKER_ID: w.WORKER_ID, ORIGIN: 'APP_ADMIN', PLANNED_START_AT: { $gt: new Date() }, ROSTER_ID: { $nin: [...ids] } });
    for (const r of rows) {
      const u = await db.collection('app_shift_roster').updateOne({ ROSTER_ID: r.ROSTER_ID }, { $setOnInsert: r }, { upsert: true });
      if (u.upsertedCount) n++;
    }
  }
  if (n) await db.collection('sim_sessions').updateOne({ SESSION_ID: FACTORY_SESSION_ID }, { $inc: { ROSTER_VERSION: 1 } });
  return n;
}

// ------------------------------------------------------------------------------------------------ inspection checklists
const ANSWER_TYPES = ['NUMERIC', 'YES_NO'];
/**
 * one checklist version for an inspection gate operation (e.g. QG10). Saving a new version keeps the previous version in
 * ctq_check_history; inspections already started keep the snapshot they were started with (quality.startInspection).
 */
async function saveChecklist(gate, b, actor, meta = {}) {
  requireFresh();
  gate = idOf(gate || b.gateOperationId);
  const err = [];
  if (!ID.test(gate)) err.push('gateOperationId: the inspection operation ID used in the route, e.g. QG10');
  const version = str(b.version, 16) || '1.0';
  const checks = Array.isArray(b.checks) ? b.checks : [];
  if (!checks.length) err.push('at least one question is required');
  const seen = new Set();
  const docs = checks.map((q, i) => {
    const at = `question ${i + 1}`;
    const cid = idOf(q.checkId || `CTQ-${gate}-${String(i + 1).padStart(2, '0')}`);
    if (!ID.test(cid)) err.push(`${at}: checkId must be 2-32 capital letters, digits, _ or -`);
    if (seen.has(cid)) err.push(`${at}: duplicate checkId ${cid}`); seen.add(cid);
    if (!str(q.question, 500)) err.push(`${at}: question text is required`);
    const type = q.inputType || 'YES_NO';
    if (!ANSWER_TYPES.includes(type)) err.push(`${at}: inputType must be NUMERIC or YES_NO`);
    const specs = [];
    if (type === 'NUMERIC') {
      const positions = Array.isArray(q.positions) && q.positions.length ? q.positions : [{ position: 'VALUE', unit: q.unit, lower: q.lower, upper: q.upper, nominal: q.nominal, readings: q.readings }];
      positions.forEach((p, j) => {
        const lo = num(p.lower), hi = num(p.upper), n = num(p.readings) ?? 1;
        if (!str(p.unit, 16)) err.push(`${at}: a numeric question needs a unit`);
        if (lo === null && hi === null) err.push(`${at}: a numeric question needs a lower or upper limit (limits are your own - none are invented)`);
        if ((lo !== null && !Number.isFinite(lo)) || (hi !== null && !Number.isFinite(hi))) err.push(`${at}: limits must be numbers`);
        if (lo !== null && hi !== null && lo > hi) err.push(`${at}: lower limit is above the upper limit`);
        if (!(Number.isInteger(n) && n >= 1 && n <= 20)) err.push(`${at}: readings must be 1-20`);
        specs.push({ SPEC_ID: `SPEC-${cid}-${idOf(p.position || 'VALUE')}-v${version}`, MEASUREMENT_POSITION: idOf(p.position || 'VALUE'), MEASUREMENT_UNIT: str(p.unit, 16), LOWER_LIMIT: lo, UPPER_LIMIT: hi,
          NOMINAL_VALUE: num(p.nominal), REQUIRED_READING_COUNT: n, SPEC_SOURCE: 'FACTORY_ADMIN_INPUT', CHECK_VERSION: version, AGGREGATION_RULE: 'EVERY_READING' });
      });
    } else if (q.failureAnswer && !['Yes', 'No'].includes(q.failureAnswer)) err.push(`${at}: failureAnswer must be Yes or No`);
    return { CHECK_ID: cid, OPERATION_ID: gate, CHECK_VERSION: version, CHECKLIST_VERSION: version, QUESTION_TEXT: str(q.question, 500), REQUIREMENT_TEXT: str(q.requirement, 500), SECTION: str(q.section, 60),
      QUESTION_GROUP: str(q.group, 60), ANSWER_TYPE: type, FAILURE_ANSWER: type === 'YES_NO' ? (q.failureAnswer || 'No') : null, MANDATORY_FLAG: yn(q.mandatory), INSTRUMENT_TYPE: str(q.instrument, 60),
      EVIDENCE_REQUIRED: q.photoRequired ? 'PHOTO' : (q.photoOnFail ? 'ON_FAILURE_ANSWER' : 'NONE_SPECIFIED'), PHOTO_REQUIRED: !!q.photoRequired, DEFAULT_SPECS: specs, SEQUENCE_NO: i + 1, ACTIVE_FLAG: 'Y',
      SPEC_SOURCE: type === 'NUMERIC' ? 'FACTORY_ADMIN_INPUT' : null };
  });
  fail(err);
  const db = await getDb();
  const res = await A.adminTx({ actor, action: 'CHECKLIST_SAVED', target: `${gate} v${version}`, idempotencyKey: meta.idempotencyKey, request: b, requestId: meta.requestId }, async (s) => {
    const prev = await db.collection('ctq_check_master').find({ dataset_id: ds(), OPERATION_ID: gate }, { session: s, projection: { _id: 0 } }).toArray();
    if (prev.length && prev[0].CHECKLIST_VERSION === version && !b.replaceSameVersion) throw E.conflict('VERSION_EXISTS', `Checklist ${gate} version ${version} already exists - save the change as a new version (inspections keep the version they were started with)`);
    const clash = await db.collection('ctq_check_master').findOne({ dataset_id: ds(), CHECK_ID: { $in: docs.map(d => d.CHECK_ID) }, OPERATION_ID: { $ne: gate } }, { session: s });
    if (clash) throw E.conflict('CHECK_ID_IN_USE', `${clash.CHECK_ID} already belongs to gate ${clash.OPERATION_ID}`);
    if (prev.length) await db.collection('ctq_check_history').insertMany(prev.map(p => ({ ...p, ARCHIVED_AT: new Date(), ARCHIVED_BY: actor, SUPERSEDED_BY_VERSION: version })), { session: s });
    await db.collection('ctq_check_master').deleteMany({ dataset_id: ds(), OPERATION_ID: gate }, { session: s });
    const now = new Date();
    await db.collection('ctq_check_master').insertMany(docs.map(d => ({ ...d, dataset_id: ds(), ORIGIN: 'FACTORY_ADMIN', CREATED_AT: now, CREATED_BY: actor, _origin: 'APP' })), { session: s });
    return { before: { version: prev[0] ? prev[0].CHECKLIST_VERSION : null, questions: prev.length }, after: { version, questions: docs.length },
      result: { ok: true, gateOperationId: gate, version, questions: docs.length, previousVersion: prev[0] ? prev[0].CHECKLIST_VERSION : null } };
  });
  C.invalidate();
  await recalc(db);
  return res;
}

// ------------------------------------------------------------------------------------------------ products, routes, BOM
/**
 * A product with its route (operations in order), crew and labour standards, milestones, BOM and inspection gates.
 * Saved as RELEASED when complete; otherwise as DRAFT with the list of what is missing ("configuration saved" vs "ready to release").
 * A product with tanks in progress cannot change its route; a change creates the next ROUTE_VERSION (the old rows are archived).
 */
async function saveProduct(b, actor, meta = {}) {
  requireFresh();
  const MD = require('../domain/masterData');
  const db = await getDb();
  const cat = await C.catalog(true);
  const pid = idOf(b.productId);
  const existing = cat.products[pid] || null;
  if (existing && b.revise !== true) throw E.conflict('PRODUCT_EXISTS', `${pid} exists - send revise: true to save a new route version`);
  if (existing && await activeUnitsWhere(db, { PRODUCT_ID: pid })) throw E.conflict('ROUTE_IN_USE', `${pid} has tanks in progress on route version ${existing.ROUTE_VERSION}; finish them before changing the route`);
  const nextVersion = existing ? String((Math.floor(Number(existing.ROUTE_VERSION || '1')) || 1) + 1) + '.0' : (b.routeVersion || '1.0');
  const body = { ...b, productId: pid, routeVersion: nextVersion, templateProductId: undefined, specsFromProductId: undefined };
  // milestones: the given list per labour operation; a labour operation without one gets a single "Work complete" milestone
  const msRows = [];
  for (const o of b.operations || []) {
    if ((o.kind || 'LABOR') !== 'LABOR') continue;
    const opId = idOf(o.operationId);
    const names = (o.milestones || []).map(x => str(typeof x === 'string' ? x : x.name, 120)).filter(Boolean);
    const have = cat.milestones.filter(m => m.OPERATION_ID === opId && (m.INSTRUCTION_TYPE || 'STANDARD') === 'STANDARD');
    if (have.length && !names.length) continue;                    // the operation's existing milestone set is reused
    const list = names.length ? names : ['Work complete'];
    if (have.length && names.length && JSON.stringify(have.map(m => m.MILESTONE_NAME)) !== JSON.stringify(list)) throw E.conflict('MILESTONES_DIFFER', `Operation ${opId} already has milestones (${have.map(m => m.MILESTONE_NAME).join(', ')}); use another operation ID for a different step list`);
    if (have.length) continue;
    list.forEach((name, i) => msRows.push({ MILESTONE_ID: `MS-${opId}-${String(i + 1).padStart(2, '0')}`, OPERATION_ID: opId, MILESTONE_NAME: name, SEQUENCE_NO: i + 1, PROGRESS_THRESHOLD: Math.round(((i + 1) / list.length) * 1000) / 1000,
      INSTRUCTION_TYPE: 'STANDARD', ATTENDED: 'Y', COUNTS_AS_RELEASE: 'N', MILESTONE_SET_VERSION: '1.0', CONTENT_STATUS: names.length ? 'FACTORY_ADMIN_INPUT' : 'DEFAULT_SINGLE_MILESTONE' }));
  }
  const cat2 = { ...cat, milestones: [...cat.milestones, ...msRows], products: { ...cat.products } };
  if (existing) delete cat2.products[pid];
  const def = MD.buildDefinition(cat2, body);
  def.ops.forEach(o => { o.OPERATION_ID = idOf(o.OPERATION_ID); o.WORK_CENTER_ID = idOf(o.WORK_CENTER_ID); if (o.REQUIRED_SKILL_ID) o.REQUIRED_SKILL_ID = idOf(o.REQUIRED_SKILL_ID); if (o.GATE_OPERATION_ID) o.GATE_OPERATION_ID = idOf(o.GATE_OPERATION_ID); });
  for (const o of b.operations || []) { const d = def.ops.find(x => x.OPERATION_ID === idOf(o.operationId)); if (d) { d.ATTENDED = o.attended === false || d.OPERATION_KIND === 'PROCESS' ? 'N' : 'Y'; d.APPLICABLE_STATIONS = (o.stations || []).map(idOf); } }
  const all = MD.validateDefinition(cat2, def);
  // structural problems refuse the save; completeness problems (checklists, specs, materials) save a DRAFT
  const completeness = p => /no CTQ checklist|has no specification|material requirement|unknown material|is consumed at/.test(p);
  const structural = all.filter(p => !completeness(p));
  for (const o of def.ops) for (const st of o.APPLICABLE_STATIONS || []) if (!cat.stations[st] || cat.stations[st].WORK_CENTER_ID !== o.WORK_CENTER_ID) structural.push(`operation ${o.OPERATION_ID}: station ${st} is not a station of ${o.WORK_CENTER_ID}`);
  for (const o of def.ops.filter(x => x.OPERATION_KIND === 'LABOR')) if (!Object.values(cat.stations).some(s => s.WORK_CENTER_ID === o.WORK_CENTER_ID && s.ACTIVE_FLAG !== 'N' && !['CURE_ZONE', 'HOLD_AREA'].includes(s.WORKSTATION_TYPE))) structural.push(`operation ${o.OPERATION_ID}: work centre ${o.WORK_CENTER_ID} has no active workstation`);
  if (structural.length) throw E.unprocessable('PRODUCT_INVALID', `Product cannot be saved: ${structural.length} problem(s)`, { problems: structural });
  const missing = all.filter(completeness);
  const status = missing.length ? 'DRAFT' : 'RELEASED';
  if (b.dryRun) return { ok: true, dryRun: true, status, missing };
  const now = new Date();
  const base = { dataset_id: ds(), ORIGIN: 'FACTORY_ADMIN', _origin: 'APP', CREATED_AT: now, CREATED_BY: actor };
  const res = await A.adminTx({ actor, action: existing ? 'PRODUCT_ROUTE_REVISED' : 'PRODUCT_CREATED', target: pid, idempotencyKey: meta.idempotencyKey, request: b, requestId: meta.requestId }, async (s) => {
    let before = null;
    if (existing) {
      const oldOps = await db.collection('routing_operations').find({ dataset_id: ds(), PRODUCT_ID: pid }, { session: s, projection: { _id: 0 } }).toArray();
      const oldMat = await db.collection('material_requirements').find({ dataset_id: ds(), PRODUCT_ID: pid }, { session: s, projection: { _id: 0 } }).toArray();
      if (oldOps.length) await db.collection('routing_operations_history').insertMany(oldOps.map(o => ({ ...o, ARCHIVED_AT: now, ARCHIVED_BY: actor, SUPERSEDED_BY_VERSION: nextVersion })), { session: s });
      await db.collection('routing_operations').deleteMany({ dataset_id: ds(), PRODUCT_ID: pid }, { session: s });
      await db.collection('material_requirements').deleteMany({ dataset_id: ds(), PRODUCT_ID: pid }, { session: s });
      await db.collection('product_master').deleteOne({ dataset_id: ds(), PRODUCT_ID: pid }, { session: s });
      before = { routeVersion: existing.ROUTE_VERSION, operations: oldOps.length, materials: oldMat.length };
    }
    await db.collection('product_master').insertOne({ ...def.product, ACTIVE_FLAG: 'Y', STATUS: status, READINESS: { missing, checkedAt: now }, ...base }, { session: s });
    await db.collection('routing_operations').insertMany(def.ops.map(o => ({ ...o, PRODUCT_ID: pid, ROUTE_ID: def.product.ROUTE_ID, ROUTE_VERSION: def.product.ROUTE_VERSION, ...base })), { session: s });
    for (let i = 0; i + 1 < def.ops.length; i++) {
      await db.collection('route_dependencies').updateOne({ dataset_id: ds(), ROUTE_ID: def.product.ROUTE_ID, PREDECESSOR_OPERATION_ID: def.ops[i].OPERATION_ID, SUCCESSOR_OPERATION_ID: def.ops[i + 1].OPERATION_ID },
        { $set: { ROUTE_VERSION: def.product.ROUTE_VERSION, TRANSFER_MIN: num((b.operations || []).find(o => idOf(o.operationId) === def.ops[i + 1].OPERATION_ID)?.transferMin) || 0, RELEASE_CONDITION: 'OPERATION_FINISHED', ...base } }, { upsert: true, session: s });
    }
    if (def.materials.length) await db.collection('material_requirements').insertMany(def.materials.map(m => ({ ...m, MATERIAL_ID: idOf(m.MATERIAL_ID), CONSUMED_AT_OPERATION_ID: idOf(m.CONSUMED_AT_OPERATION_ID), PRODUCT_ID: pid, ...base })), { session: s });
    if (msRows.length) await db.collection('milestone_definitions').insertMany(msRows.map(m => ({ ...m, ...base })), { session: s });
    return { before, after: { status, routeVersion: def.product.ROUTE_VERSION, operations: def.ops.map(o => `${o.SEQUENCE_NO} ${o.OPERATION_ID} ${o.OPERATION_KIND} ${o.WORK_CENTER_ID}`), materials: def.materials.length, milestonesCreated: msRows.length, missing },
      result: { ok: true, productId: pid, status, routeVersion: def.product.ROUTE_VERSION, missing, milestonesCreated: msRows.map(m => `${m.OPERATION_ID}: ${m.MILESTONE_NAME}`),
        note: status === 'RELEASED' ? 'Ready to order.' : 'Configuration saved as DRAFT - complete the missing items, then release the product.' } };
  });
  C.invalidate();
  await recalc(db);
  return res;
}

/** re-check a DRAFT product (after checklists / BOM were added) and release it when complete */
async function releaseProduct(pid, actor, meta = {}) {
  requireFresh();
  const MD = require('../domain/masterData');
  pid = idOf(pid);
  const cat = await C.catalog(true);
  const p = cat.products[pid];
  if (!p) throw E.notFound('Product');
  const problems = productProblems(cat, pid);
  if (problems.length) throw E.unprocessable('PRODUCT_INCOMPLETE', `${pid} is not complete: ${problems.length} problem(s)`, { problems });
  const db = await getDb();
  const res = await A.adminTx({ actor, action: 'PRODUCT_RELEASED', target: pid, idempotencyKey: meta.idempotencyKey, request: { pid }, requestId: meta.requestId }, async (s) => {
    await db.collection('product_master').updateOne({ dataset_id: ds(), PRODUCT_ID: pid }, { $set: { STATUS: 'RELEASED', READINESS: { missing: [], checkedAt: new Date() }, RELEASED_AT: new Date(), RELEASED_BY: actor } }, { session: s });
    return { before: { status: p.STATUS }, after: { status: 'RELEASED' }, result: { ok: true, productId: pid, status: 'RELEASED' } };
  });
  C.invalidate();
  void MD;
  return res;
}

/** completeness of a saved product: every gate has a checklist, numeric checks have limits, BOM materials exist */
function productProblems(cat, pid) {
  const p = [];
  const ops = cat.routing.filter(r => r.PRODUCT_ID === pid).sort((a, b) => a.SEQUENCE_NO - b.SEQUENCE_NO);
  if (!ops.length) p.push('no route');
  for (const o of ops.filter(x => x.OPERATION_KIND === 'INSPECTION')) {
    const checks = Object.values(cat.ctq).filter(c => c.OPERATION_ID === o.OPERATION_ID && c.ACTIVE_FLAG !== 'N');
    if (!checks.length) p.push(`gate ${o.OPERATION_ID}: no inspection checklist`);
    for (const c of checks.filter(c => c.ANSWER_TYPE === 'NUMERIC' && (c.MANDATORY_FLAG || 'Y') === 'Y')) {
      if (!cat.specs.some(s => s.CHECK_ID === c.CHECK_ID && s.PRODUCT_ID === pid) && !(c.DEFAULT_SPECS || []).length) p.push(`gate ${o.OPERATION_ID}: numeric check ${c.CHECK_ID} has no limits`);
    }
  }
  for (const o of ops.filter(x => x.OPERATION_KIND === 'LABOR')) if (!C.milestonesFor(cat, o.OPERATION_ID).length) p.push(`operation ${o.OPERATION_ID}: no milestones`);
  const mats = cat.matReqs.filter(m => m.PRODUCT_ID === pid);
  if (!mats.length) p.push('no material requirement (BOM)');
  for (const m of mats) if (!cat.materials[m.MATERIAL_ID]) p.push(`BOM material ${m.MATERIAL_ID} is not configured`);
  if (ops.length && ops[ops.length - 1].OPERATION_KIND !== 'INSPECTION') p.push('route must end with an inspection gate');
  return p;
}

// ------------------------------------------------------------------------------------------------ master overview
async function master() {
  requireFresh();
  const db = await getDb();
  await ensureCalendar(db);
  const cat = await C.catalog(true);
  const sess = await session(db);
  const stock = sess ? await db.collection('sim_materials').find({ SESSION_ID: FACTORY_SESSION_ID }, { projection: { _id: 0 } }).toArray() : [];
  const eqLive = sess ? await db.collection('sim_equipment').find({ SESSION_ID: FACTORY_SESSION_ID }, { projection: { _id: 0 } }).toArray() : [];
  const tpls = await db.collection('shift_templates').find({ dataset_id: ds() }, { projection: { _id: 0 } }).toArray();
  const hist = await db.collection('ctq_check_history').aggregate([{ $match: { dataset_id: ds() } }, { $group: { _id: { gate: '$OPERATION_ID', v: '$CHECKLIST_VERSION' }, n: { $sum: 1 } } }]).toArray();
  const strip = o => { const { _id, _seed, ...r } = o; return r; };
  return {
    settings: await settings(db),
    workCenters: Object.values(cat.wcs).map(strip), stations: Object.values(cat.stations).map(strip), skills: Object.values(cat.skills).map(strip),
    equipment: Object.values(cat.equipment).map(e => ({ ...strip(e), liveStatus: (eqLive.find(x => x.EQUIPMENT_ID === e.EQUIPMENT_ID) || {}).STATUS || null })),
    materials: Object.values(cat.materials).map(m => { const s = stock.find(x => x.MATERIAL_ID === m.MATERIAL_ID) || {}; return { ...strip(m), onHand: s.ON_HAND_QTY ?? null, reserved: s.RESERVED_QTY || 0, lots: s.LOTS || [] }; }),
    shiftTemplates: tpls,
    checklists: Object.values(Object.values(cat.ctq).reduce((a, c) => { (a[c.OPERATION_ID] = a[c.OPERATION_ID] || { gateOperationId: c.OPERATION_ID, version: c.CHECKLIST_VERSION || c.CHECK_VERSION, illustrative: !!c.ILLUSTRATIVE, checks: [] }).checks.push(strip(c)); return a; }, {}))
      .map(g => ({ ...g, checks: g.checks.sort((a, b) => (a.SEQUENCE_NO || 0) - (b.SEQUENCE_NO || 0) || a.CHECK_ID.localeCompare(b.CHECK_ID)), previousVersions: hist.filter(h => h._id.gate === g.gateOperationId).map(h => h._id.v) })),
    products: Object.values(cat.products).map(p => ({ ...strip(p), problems: productProblems(cat, p.PRODUCT_ID),
      route: cat.routing.filter(r => r.PRODUCT_ID === p.PRODUCT_ID).sort((a, b) => a.SEQUENCE_NO - b.SEQUENCE_NO).map(r => ({ ...strip(r), milestones: C.milestonesFor(cat, r.OPERATION_ID).map(m => m.MILESTONE_NAME) })),
      bom: cat.matReqs.filter(m => m.PRODUCT_ID === p.PRODUCT_ID).map(strip) })),
    templateAvailable: fs.existsSync(TEMPLATE_FILE),
  };
}

// ------------------------------------------------------------------------------------------------ setup checklist
async function setup() {
  requireFresh();
  const db = await getDb();
  await ensureCalendar(db);
  const cat = await C.catalog(true);
  const st = await settings(db);
  const sess = await session(db);
  const sid = FACTORY_SESSION_ID;
  const wcs = Object.values(cat.wcs).filter(w => w.ACTIVE_FLAG !== 'N');
  const stations = Object.values(cat.stations).filter(s => s.ACTIVE_FLAG !== 'N');
  const products = Object.values(cat.products).filter(p => p.ACTIVE_FLAG !== 'N');
  const released = products.filter(p => p.STATUS === 'RELEASED' || (!p.STATUS && p.ACTIVE_FLAG === 'Y'));
  const gates = [...new Set(cat.routing.filter(r => products.some(p => p.PRODUCT_ID === r.PRODUCT_ID) && r.OPERATION_KIND === 'INSPECTION').map(r => r.OPERATION_ID))];
  const gatesWithChecklist = gates.filter(g => Object.values(cat.ctq).some(c => c.OPERATION_ID === g));
  const labourOps = cat.routing.filter(r => products.some(p => p.PRODUCT_ID === r.PRODUCT_ID) && r.OPERATION_KIND === 'LABOR');
  const neededSkills = [...new Set(labourOps.map(o => o.REQUIRED_SKILL_ID).filter(Boolean))];
  const tpls = await db.collection('shift_templates').find({ dataset_id: ds(), ACTIVE_FLAG: { $ne: 'N' } }).toArray();
  const workers = await db.collection('worker_master').find({ dataset_id: ds(), ACTIVE_FLAG: 'Y' }).toArray();
  const accounts = await db.collection('accounts').find({ dataset_id: ds(), worker_id: { $ne: null }, status: 'ACTIVE' }, { projection: { worker_id: 1 } }).toArray();
  const quals = Object.values(cat.quals).flat();
  const skillsCovered = neededSkills.filter(s => quals.some(q => q.SKILL_ID === s && (q.QUALIFICATION_STATUS || 'VALID') === 'VALID'));
  const inspectors = workers.filter(w => ['QUALITY_INSPECTOR', 'QUALITY_SUPERVISOR'].includes(w.WORKER_ROLE));
  const bomMats = [...new Set(cat.matReqs.filter(m => released.some(p => p.PRODUCT_ID === m.PRODUCT_ID)).map(m => m.MATERIAL_ID))];
  const stock = sess ? await db.collection('sim_materials').find({ SESSION_ID: sid }).toArray() : [];
  const stocked = bomMats.filter(m => (stock.find(x => x.MATERIAL_ID === m) || {}).ON_HAND_QTY > 0);
  const eqNeeded = [...new Set(labourOps.map(o => o.EQUIPMENT_TYPE).filter(Boolean))];
  const eqTypes = new Set(Object.values(cat.equipment).map(e => e.EQUIPMENT_TYPE));
  const orders = sess ? await db.collection('production_orders').countDocuments({ SESSION_ID: sid }) : 0;
  const releases = sess ? await db.collection('sim_plan_releases').find({ SESSION_ID: sid }).toArray() : [];
  const tasks = sess ? await db.collection('sim_tasks').countDocuments({ SESSION_ID: sid }) : 0;
  const illustrative = (await db.collection('product_master').countDocuments({ dataset_id: ds(), ILLUSTRATIVE: true })) > 0;
  const step = (n, key, title, link, status, missing, validation = []) => ({ n, key, title, link, status, missing, validation });
  const steps = [
    step(1, 'factory', 'Factory and timezone', '/setup/factory', st && st.TIMEZONE ? 'READY' : 'NOT_CONFIGURED', st ? [] : ['Factory name, site ID and timezone'],
      st ? [`${st.FACTORY_NAME} - ${st.SITE_ID} - ${st.TIMEZONE} - ${st.OPERATING_MODE}`] : []),
    step(2, 'workCenters', 'Work centres and stations', '/setup/work-centres', !wcs.length ? 'NOT_CONFIGURED' : (wcs.every(w => stations.some(s => s.WORK_CENTER_ID === w.WORK_CENTER_ID)) ? 'READY' : 'PARTIAL'),
      [...(!wcs.length ? ['At least one work centre'] : []), ...wcs.filter(w => !stations.some(s => s.WORK_CENTER_ID === w.WORK_CENTER_ID)).map(w => `Work centre ${w.WORK_CENTER_ID} has no station`)],
      [`${wcs.length} work centre(s), ${stations.length} station(s)`]),
    step(3, 'products', 'Products and routes', '/setup/products', !products.length ? 'NOT_CONFIGURED' : (released.length ? 'READY' : 'PARTIAL'),
      [...(!products.length ? ['At least one product with its route'] : []), ...products.filter(p => p.STATUS === 'DRAFT').map(p => `${p.PRODUCT_ID} is a draft: ${productProblems(cat, p.PRODUCT_ID).join('; ')}`)],
      products.map(p => `${p.PRODUCT_ID} ${p.STATUS || 'RELEASED'} route v${p.ROUTE_VERSION}`)),
    step(4, 'checklists', 'Inspection checklists', '/setup/checklists', !gates.length ? 'NOT_CONFIGURED' : (gatesWithChecklist.length === gates.length ? 'READY' : 'PARTIAL'),
      gates.length ? gates.filter(g => !gatesWithChecklist.includes(g)).map(g => `Gate ${g} has no checklist`) : ['Define products first: their routes name the inspection gates'],
      [`${gatesWithChecklist.length} of ${gates.length} gate(s) have a checklist`]),
    step(5, 'skills', 'Skills and crew', '/setup/skills', !Object.keys(cat.skills).length ? 'NOT_CONFIGURED' : (neededSkills.every(s => cat.skills[s]) ? 'READY' : 'PARTIAL'),
      [...(!Object.keys(cat.skills).length ? ['At least one skill'] : []), ...neededSkills.filter(s => !cat.skills[s]).map(s => `Skill ${s} used by a route is not defined`)],
      labourOps.map(o => `${o.PRODUCT_ID} ${o.OPERATION_ID}: crew ${o.MIN_CREW_SIZE}-${o.STD_CREW_SIZE}-${o.MAX_CREW_SIZE}, skill ${o.REQUIRED_SKILL_ID || 'none'}`).slice(0, 12)),
    step(6, 'shifts', 'Shifts', '/setup/shifts', tpls.length ? 'READY' : 'NOT_CONFIGURED', tpls.length ? [] : ['At least one shift (start/end, days, breaks)'],
      tpls.map(t => `${t.SHIFT_CODE} ${t.START_LOCAL}-${t.END_LOCAL}${t.OVERNIGHT ? ' (overnight)' : ''} days ${t.DAYS_OF_WEEK.join(',')}`).concat(st && st.CALENDAR_GENERATED_TO ? [`calendar generated to ${st.CALENDAR_GENERATED_TO}`] : [])),
    step(7, 'resources', 'Equipment and materials', '/setup/resources', !bomMats.length && !eqNeeded.length ? (Object.keys(cat.materials).length ? 'PARTIAL' : 'NOT_CONFIGURED') : (stocked.length === bomMats.length && eqNeeded.every(t => eqTypes.has(t)) ? 'READY' : 'PARTIAL'),
      [...bomMats.filter(m => !stocked.includes(m)).map(m => `No stock received for ${m} (receive stock - inventory is never unlimited)`), ...eqNeeded.filter(t => !eqTypes.has(t)).map(t => `No equipment of type ${t} required by a route`)],
      [`${Object.keys(cat.equipment).length} equipment, ${Object.keys(cat.materials).length} material(s), ${stocked.length}/${bomMats.length} BOM material(s) in stock`]),
    step(8, 'workers', 'Workers and logins', '/workforce', !workers.length ? 'NOT_CONFIGURED' : (skillsCovered.length === neededSkills.length && inspectors.length && accounts.length ? 'READY' : 'PARTIAL'),
      [...(!workers.length ? ['Create workers with logins'] : []), ...neededSkills.filter(s => !skillsCovered.includes(s)).map(s => `Nobody is qualified for ${s}`), ...(workers.length && !inspectors.length ? ['No quality inspector (gate inspections need one)'] : [])],
      [`${workers.length} active worker(s), ${accounts.length} worker login(s)`]),
    step(9, 'order', 'First order', '/orders', orders ? 'READY' : 'NOT_CONFIGURED', orders ? [] : ['Create a work order (required quantity = accepted good tanks)'], [`${orders} order(s)`]),
    step(10, 'release', 'Release the first batch and assign work', '/orders', releases.some(r => r.RELEASED) ? (tasks ? 'READY' : 'PARTIAL') : 'NOT_CONFIGURED',
      [...(!releases.some(r => r.RELEASED) ? ['Release a batch (tank identities are generated)'] : []), ...(releases.some(r => r.RELEASED) && !tasks ? ['Assign a crew to the first operation'] : [])],
      [`${releases.filter(r => r.RELEASED).length} of ${releases.length} batch(es) released, ${tasks} task(s)`]),
  ];
  const configSaved = steps.slice(0, 8).every(s => s.status !== 'NOT_CONFIGURED');
  const readyToRelease = ['factory', 'workCenters', 'products', 'checklists', 'skills', 'shifts'].every(k => steps.find(s => s.key === k).status === 'READY') && released.length > 0;
  const readyToStart = readyToRelease && steps.find(s => s.key === 'workers').status === 'READY' && steps.find(s => s.key === 'resources').status === 'READY';
  return { bootstrap: sess ? 'DONE' : 'NOT_RUN', sessionId: sess ? sid : null, steps, configurationSaved: configSaved, readyToRelease, readyToStart, illustrativeConfiguration: illustrative,
    note: 'Configuration saved = every area has data. Ready to release = factory, work centres, released products with checklists, skills and shifts. Ready to start = also workers who cover the required skills, an inspector, and stock for the BOM.' };
}

// ------------------------------------------------------------------------------------------------ dispatch readiness (why work can't start)
async function readiness(unitId) {
  requireFresh();
  const db = await getDb();
  const cat = await C.catalog();
  const units = await db.collection('sim_units').find({ SESSION_ID: FACTORY_SESSION_ID, ...(unitId ? { UNIT_ID: unitId } : { STATE: { $nin: ['ROUTE_COMPLETE', 'SCRAPPED'] } }) }).toArray();
  const workers = await db.collection('sim_workers').find({ SESSION_ID: FACTORY_SESSION_ID }).toArray();
  const occupied = new Set(units.filter(u => u.CURRENT_WORKSTATION_ID && !['QUEUED', 'IN_TRANSFER', 'CURING'].includes(u.STATE)).map(u => u.CURRENT_WORKSTATION_ID));
  const eqs = await db.collection('sim_equipment').find({ SESSION_ID: FACTORY_SESSION_ID }).toArray();
  const mats = await db.collection('sim_materials').find({ SESSION_ID: FACTORY_SESSION_ID }).toArray();
  const ops = await db.collection('sim_operations').find({ SESSION_ID: FACTORY_SESSION_ID, STATE: { $in: ['CREATED', 'WORKING', 'PAUSED', 'BELOW_MIN_CREW'] } }).toArray();
  const tasks = await db.collection('sim_tasks').find({ SESSION_ID: FACTORY_SESSION_ID, STATUS: { $in: ['ASSIGNED', 'ACCEPTED', 'WORKING', 'PAUSED'] } }).toArray();
  const now = simNow(await session(db));
  return units.map(u => {
    const def = C.opDef(cat, u.PRODUCT_ID, u.ROUTE_STEP) || {};
    const blockers = [];
    const op = ops.find(o => o.UNIT_ID === u.UNIT_ID && o.OPERATION_KIND === 'LABOR');
    if (['QUALITY_HOLD', 'FAILED_INSPECTION', 'PENDING_REVIEW', 'INCOMPLETE_INSPECTION_HOLD'].includes(u.STATE)) blockers.push({ code: 'ON_HOLD', message: `On ${u.STATE.replace(/_/g, ' ').toLowerCase()} - a quality decision is needed first` });
    if (['WORK_COMPLETED_AWAITING_INSPECTION', 'REWORK_COMPLETE_AWAITING_REINSPECTION', 'PASS_PENDING_RELEASE', 'INSPECTION_IN_PROGRESS', 'REINSPECTION_IN_PROGRESS'].includes(u.STATE)) blockers.push({ code: 'AWAITING_INSPECTION', message: 'Waiting for the gate inspection / release' });
    const stations = Object.values(cat.stations).filter(s => s.WORK_CENTER_ID === def.WORK_CENTER_ID && s.ACTIVE_FLAG !== 'N' && !['CURE_ZONE', 'HOLD_AREA'].includes(s.WORKSTATION_TYPE));
    const free = stations.filter(s => !occupied.has(s.WORKSTATION_ID) || u.CURRENT_WORKSTATION_ID === s.WORKSTATION_ID);
    if (def.OPERATION_KIND === 'LABOR' && !op) {
      if (!stations.length) blockers.push({ code: 'NO_STATION', message: `No active station in ${def.WORK_CENTER_ID}` });
      else if (!free.length) blockers.push({ code: 'STATIONS_BUSY', message: `All ${stations.length} station(s) of ${def.WORK_CENTER_ID} are occupied` });
    }
    const st = op ? cat.stations[op.WORKSTATION_ID] : null;
    const eqId = op ? op.EQUIPMENT_ID : null;
    const eq = eqId && eqs.find(e => e.EQUIPMENT_ID === eqId);
    if (eq && eq.STATUS === 'DOWN') blockers.push({ code: 'EQUIPMENT_DOWN', message: `${eqId} is down` });
    if (!op && free.length && free.every(s => s.EQUIPMENT_ID && (eqs.find(e => e.EQUIPMENT_ID === s.EQUIPMENT_ID) || {}).STATUS === 'DOWN')) blockers.push({ code: 'EQUIPMENT_DOWN', message: 'The equipment of every free station is down' });
    if (def.OPERATION_KIND === 'LABOR' && !(op && op.MATERIAL_CONSUMED)) {
      for (const r of cat.matReqs.filter(m => m.PRODUCT_ID === u.PRODUCT_ID && m.CONSUMED_AT_OPERATION_ID === u.ROUTE_STEP)) {
        const m = mats.find(x => x.MATERIAL_ID === r.MATERIAL_ID);
        const avail = m ? Number(m.ON_HAND_QTY || 0) - Number(m.HOLD_QTY || 0) - Number(m.RESERVED_QTY || 0) + (u.RESERVED_MATERIAL === r.MATERIAL_ID ? Number(r.QTY_PER_UNIT || 0) : 0) : 0;
        if (avail < Number(r.QTY_PER_UNIT || 0)) blockers.push({ code: 'MATERIAL_SHORTAGE', message: `${r.MATERIAL_ID}: ${avail} available, ${r.QTY_PER_UNIT} ${r.UOM || ''} needed` });
      }
    }
    const crewTasks = op ? tasks.filter(t => t.OPERATION_INSTANCE_ID === op.OPERATION_INSTANCE_ID) : [];
    const crew = crewTasks.map(t => { const w = workers.find(x => x.WORKER_ID === t.WORKER_ID) || {}; return { workerId: t.WORKER_ID, name: w.DISPLAY_NAME, task: t.STATUS, clockedIn: w.ATTENDANCE_STATE === 'CLOCKED_IN' }; });
    const minCrew = op ? (op.MIN_CREW_SIZE || 1) : (def.MIN_CREW_SIZE || 1);
    if (def.OPERATION_KIND === 'LABOR') {
      if (op && crew.length < minCrew) blockers.push({ code: 'BELOW_MIN_CREW', message: `${crew.length} assigned, minimum crew ${minCrew}` });
      if (op && crew.filter(c => c.clockedIn).length < minCrew) blockers.push({ code: 'CREW_NOT_CLOCKED_IN', message: `${crew.filter(c => c.clockedIn).length} of the minimum ${minCrew} crew are clocked in` });
      if (op && op.STATE === 'BELOW_MIN_CREW') blockers.push({ code: 'BELOW_MIN_CREW_WORKING', message: `Only ${crewTasks.filter(t => t.STATUS === 'WORKING').length} working - the minimum crew of ${minCrew} must be working before the work progresses` });
    }
    const skill = def.REQUIRED_SKILL_ID;
    const qualifiedPeople = workers.filter(w => (cat.workers[w.WORKER_ID] || {}).ACTIVE_FLAG !== 'N' && (!skill || C.qualified(cat, w.WORKER_ID, skill, now)));
    const inspectors = workers.filter(w => ['QUALITY_INSPECTOR', 'QUALITY_SUPERVISOR'].includes((cat.workers[w.WORKER_ID] || {}).WORKER_ROLE) && (cat.workers[w.WORKER_ID] || {}).ACTIVE_FLAG !== 'N' && (!skill || C.qualified(cat, w.WORKER_ID, skill, now)));
    if (def.OPERATION_KIND === 'LABOR' && qualifiedPeople.length < minCrew) blockers.push({ code: 'NOT_ENOUGH_QUALIFIED', message: `${qualifiedPeople.length} worker(s) qualified for ${skill}, minimum crew ${minCrew}` });
    return { assignedInspectorId: u.ASSIGNED_INSPECTOR_ID || null, qualifiedInspectors: inspectors.map(w => ({ workerId: w.WORKER_ID, name: w.DISPLAY_NAME })), dueAt: u.DUE_AT, orderId: u.ORDER_ID, batchId: u.BATCH_ID, standardElapsedMin: def.STANDARD_ELAPSED_MIN, standardLaborMin: def.STANDARD_LABOR_MIN, unitId: u.UNIT_ID, serial: u.TANK_SERIAL_NO, state: u.STATE, productId: u.PRODUCT_ID, routeVersion: u.ROUTE_VERSION || null, routeStep: u.ROUTE_STEP, operationKind: def.OPERATION_KIND || null,
      workCenterId: def.WORK_CENTER_ID || u.CURRENT_WORK_CENTER_ID, requiredSkill: skill || null, minCrew, stdCrew: def.STD_CREW_SIZE || null, maxCrew: def.MAX_CREW_SIZE || null,
      operationInstanceId: op ? op.OPERATION_INSTANCE_ID : null, operationState: op ? op.STATE : null, workstationId: op ? op.WORKSTATION_ID : null, stationName: st ? st.WORKSTATION_NAME : null, freeStations: free.map(s => s.WORKSTATION_ID),
      crew, qualifiedWorkers: qualifiedPeople.map(w => ({ workerId: w.WORKER_ID, name: w.DISPLAY_NAME, clockedIn: w.ATTENDANCE_STATE === 'CLOCKED_IN', busy: tasks.some(t => t.WORKER_ID === w.WORKER_ID && t.STATUS === 'WORKING') })),
      canStart: blockers.length === 0 && (def.OPERATION_KIND !== 'LABOR' || !!op), blockers };
  });
}

// ------------------------------------------------------------------------------------------------ illustrative template import
const TEMPLATE_FILE = path.join(__dirname, '..', '..', 'config', 'templates', 'illustrative_tank_line.json');
function reviveDates(v) {
  if (Array.isArray(v)) return v.map(reviveDates);
  if (v && typeof v === 'object') { if (Object.keys(v).length === 1 && v.$date) return new Date(v.$date); const o = {}; for (const [k, x] of Object.entries(v)) o[k] = reviveDates(x); return o; }
  return v;
}
const TEMPLATE_KEYS = { work_center_master: ['WORK_CENTER_ID'], workstation_master: ['WORKSTATION_ID'], skill_master: ['SKILL_ID'], equipment_master: ['EQUIPMENT_ID'], material_master: ['MATERIAL_ID'],
  product_master: ['PRODUCT_ID'], ctq_check_master: ['CHECK_ID'], milestone_definitions: ['MILESTONE_ID'], shift_templates: ['SHIFT_CODE'], disposition_policies: ['POLICY_ID'] };

async function templatePreview() {
  requireFresh();
  if (!fs.existsSync(TEMPLATE_FILE)) throw E.notFound('Illustrative template file');
  const t = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8'));
  const db = await getDb();
  const conflicts = [];
  for (const [coll, keys] of Object.entries(TEMPLATE_KEYS)) {
    const ids = (t.collections[coll] || []).map(d => d[keys[0]]);
    const have = await db.collection(coll).find({ dataset_id: ds(), [keys[0]]: { $in: ids } }, { projection: { [keys[0]]: 1 } }).toArray();
    for (const h of have) conflicts.push(`${coll}: ${h[keys[0]]} already exists`);
  }
  return { templateId: t.TEMPLATE_ID, label: t.LABEL, warning: t.WARNING, counts: Object.fromEntries(Object.entries(t.collections).map(([k, v]) => [k, v.length])), conflicts,
    contains: 'Configuration only - no workers, accounts, orders, batches, tanks, attendance, events or history.' };
}

async function importTemplate(b, actor, meta = {}) {
  requireFresh();
  if (b.confirm !== 'IMPORT ILLUSTRATIVE TEMPLATE') throw E.bad('CONFIRMATION_REQUIRED', 'Type "IMPORT ILLUSTRATIVE TEMPLATE" to confirm; the template is illustrative and unconfirmed');
  const prev = await templatePreview();
  if (prev.conflicts.length) throw E.conflict('TEMPLATE_CONFLICT', `${prev.conflicts.length} configuration record(s) already exist; the template only fills an empty configuration`, { conflicts: prev.conflicts.slice(0, 50) });
  const t = reviveDates(JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8')));
  const db = await getDb();
  const now = new Date();
  const res = await A.adminTx({ actor, action: 'ILLUSTRATIVE_TEMPLATE_IMPORTED', target: t.TEMPLATE_ID, idempotencyKey: meta.idempotencyKey, request: { template: t.TEMPLATE_ID }, requestId: meta.requestId }, async (s) => {
    const counts = {};
    for (const [coll, docs] of Object.entries(t.collections)) {
      if (!docs.length) continue;
      const rows = docs.map(d => ({ ...d, dataset_id: ds(), ORIGIN: 'ILLUSTRATIVE_TEMPLATE', TEMPLATE_ID: t.TEMPLATE_ID, IMPORTED_AT: now, IMPORTED_BY: actor, _origin: 'APP',
        ...(coll === 'product_master' ? { STATUS: d.ACTIVE_FLAG === 'N' ? 'INACTIVE' : 'RELEASED' } : {}), ...(coll === 'shift_templates' ? { ACTIVE_FLAG: 'Y', CONFIG_VERSION: 1 } : {}) }));
      await db.collection(coll).insertMany(rows, { session: s });
      counts[coll] = rows.length;
    }
    // the illustrative policy becomes the factory session's disposition policy (its matrix still asks people for unknown cases)
    await db.collection('sim_sessions').updateOne({ SESSION_ID: FACTORY_SESSION_ID }, { $set: { DISPOSITION_POLICY_ID: 'DEFAULT_REPAIRABLE_RETURN_V1' } }, { session: s });
    return { after: counts, details: { warning: t.WARNING }, result: { ok: true, imported: counts, warning: t.WARNING, next: 'Receive material stock, create workers, review every illustrative value.' } };
  });
  C.invalidate();
  // live equipment / material rows of the factory session (equipment available, stock ZERO until received)
  const cat = await C.catalog(true);
  for (const e of Object.values(cat.equipment)) await db.collection('sim_equipment').updateOne({ SESSION_ID: FACTORY_SESSION_ID, EQUIPMENT_ID: e.EQUIPMENT_ID }, { $setOnInsert: { SESSION_ID: FACTORY_SESSION_ID, RUN_ID: 'RUN-FACTORY', DATASET_ID: ds(), EQUIPMENT_ID: e.EQUIPMENT_ID, WORKSTATION_ID: e.WORKSTATION_ID, WORK_CENTER_ID: e.WORK_CENTER_ID, STATUS: 'UP', SINCE: now, ORIGIN: 'FACTORY_CONFIG', VERSION: 1, _origin: 'APP' } }, { upsert: true });
  for (const m of Object.values(cat.materials)) await db.collection('sim_materials').updateOne({ SESSION_ID: FACTORY_SESSION_ID, MATERIAL_ID: m.MATERIAL_ID }, { $setOnInsert: { SESSION_ID: FACTORY_SESSION_ID, RUN_ID: 'RUN-FACTORY', DATASET_ID: ds(), MATERIAL_ID: m.MATERIAL_ID, MATERIAL_NAME: m.MATERIAL_NAME, UOM: m.UOM, ON_HAND_QTY: 0, HOLD_QTY: 0, RESERVED_QTY: 0, LOTS: [], ORIGIN: 'FACTORY_CONFIG', VERSION: 1, _origin: 'APP' } }, { upsert: true });
  await ensureCalendar(db, actor, { force: true });
  return res;
}

// ------------------------------------------------------------------------------------------------ guarded reset (never at start-up)
async function resetPreview(req) {
  requireFresh();
  const c = config();
  const db = await getDb();
  const st = await settings(db);
  const counts = {};
  for (const coll of OPERATIONAL_COLLS) { const n = await db.collection(coll).countDocuments({ SESSION_ID: FACTORY_SESSION_ID }); if (n) counts[coll] = n; }
  for (const coll of SESSION_TAGGED) { const n = await db.collection(coll).countDocuments({ SESSION_ID: FACTORY_SESSION_ID }); if (n) counts[coll] = n; }
  const people = {};
  for (const coll of PEOPLE_COLLS) { const n = await db.collection(coll).countDocuments({ dataset_id: ds() }); if (n) people[coll] = n; }
  people.worker_accounts = await db.collection('accounts').countDocuments({ dataset_id: ds(), worker_id: { $ne: null } });
  const configCounts = {};
  for (const coll of CONFIG_COLLS) { const n = await db.collection(coll).countDocuments({ dataset_id: ds() }); if (n) configCounts[coll] = n; }
  const enabled = c.allowFactoryReset && !c.isProd;
  return { enabled, reason: enabled ? null : (c.isProd ? 'Refused in production' : 'ALLOW_FACTORY_RESET is false (the default). Set it to true in backend/.env and restart the API to enable the reset.'),
    target: { database: c.mongoDb, datasetId: c.datasetId, factoryName: st ? st.FACTORY_NAME : null, sessionId: FACTORY_SESSION_ID }, confirmText: `RESET ${c.mongoDb}`,
    operational: counts, people, configuration: configCounts,
    keeps: ['bootstrap admin account(s)', 'roles and permissions', 'rule settings and points policy', 'audit log', 'factory_reset_log', 'evidence files in Cloudinary / local storage (never deleted)'],
    options: { clearWorkers: 'also remove workers, their logins, qualifications and rosters (admins are always kept)', clearConfiguration: 'also remove the factory configuration (otherwise master configuration is retained)' } };
}

async function reset(b, actor, req) {
  requireFresh();
  const c = config();
  if (c.isProd) throw E.forbidden('The factory reset is refused in production');
  if (!c.allowFactoryReset) throw E.forbidden('The factory reset is disabled (ALLOW_FACTORY_RESET=false)');
  const expected = `RESET ${c.mongoDb}`;
  if (b.confirmText !== expected) throw E.bad('CONFIRMATION_REQUIRED', `Type exactly "${expected}" to confirm`);
  const db = await getDb();
  const st = await settings(db);
  if (st && b.factoryName !== st.FACTORY_NAME) throw E.bad('CONFIRMATION_REQUIRED', 'Type the factory name exactly as configured');
  if (b.acknowledge !== true) throw E.bad('CONFIRMATION_REQUIRED', 'Tick the confirmation that operational data will be deleted');
  const sess = await session(db);
  if (!sess) throw E.conflict('NOT_INITIALISED', 'The factory session does not exist');
  const preview = await resetPreview(req);
  const resetId = `RST-${Date.now().toString(36).toUpperCase()}`;
  const generation = (sess.RESET_GENERATION || 0) + 1;
  // 1. quiesce: the session leaves the active states, so the engine and commands stop touching it (stale writes cannot recreate data)
  await withTransaction(async (s) => {
    await db.collection('sim_sessions').updateOne({ SESSION_ID: FACTORY_SESSION_ID }, { $set: { STATUS: 'RESETTING', RESET_REQUEST: { AT: new Date(), BY: actor, GENERATION: generation, RESET_ID: resetId } } }, { session: s });
    await db.collection('factory_reset_log').insertOne({ RESET_ID: resetId, STATUS: 'STARTED', AT: new Date(), BY: actor, DATABASE: c.mongoDb, DATASET_ID: c.datasetId, FACTORY_NAME: st ? st.FACTORY_NAME : null,
      PREVIEW: { operational: preview.operational, people: preview.people, configuration: preview.configuration }, OPTIONS: { clearWorkers: !!b.clearWorkers, clearConfiguration: !!b.clearConfiguration }, _origin: 'APP' }, { session: s });
  });
  await new Promise(r => setTimeout(r, 1500));      // let an in-flight engine step finish (it re-reads the session status every step)
  const removed = {};
  for (const coll of OPERATIONAL_COLLS) { const r = await db.collection(coll).deleteMany({ SESSION_ID: FACTORY_SESSION_ID }); if (r.deletedCount) removed[coll] = r.deletedCount; }
  for (const coll of SESSION_TAGGED) { const r = await db.collection(coll).deleteMany({ SESSION_ID: FACTORY_SESSION_ID }); if (r.deletedCount) removed[coll] = r.deletedCount; }
  await db.collection('jobs').deleteMany({ SESSION_ID: FACTORY_SESSION_ID });
  await db.collection('notifications').deleteMany({ SESSION_ID: FACTORY_SESSION_ID, STATUS: { $in: ['PENDING', 'RETRY'] } });
  await db.collection('idempotency_keys').deleteMany({ SESSION_ID: FACTORY_SESSION_ID });
  // operator sign-ins end (worker accounts); admin sign-ins stay
  const workerLogins = (await db.collection('accounts').find({ dataset_id: ds(), worker_id: { $ne: null } }, { projection: { login_id: 1 } }).toArray()).map(a => a.login_id);
  const rv = await db.collection('auth_sessions').updateMany({ LOGIN_ID: { $in: workerLogins }, REVOKED_AT: null }, { $set: { REVOKED_AT: new Date(), REVOKE_REASON: 'FACTORY_RESET' } });
  removed.revokedOperatorSignIns = rv.modifiedCount;
  if (b.clearWorkers) {
    for (const coll of PEOPLE_COLLS) { const r = await db.collection(coll).deleteMany({ dataset_id: ds() }); if (r.deletedCount) removed[coll] = r.deletedCount; }
    const r = await db.collection('accounts').deleteMany({ dataset_id: ds(), worker_id: { $ne: null } });     // admin accounts (worker_id null) are kept
    removed.workerAccounts = r.deletedCount;
  }
  if (b.clearConfiguration) {
    for (const coll of CONFIG_COLLS) { const r = await db.collection(coll).deleteMany({ dataset_id: ds() }); if (r.deletedCount) removed[coll] = r.deletedCount; }
  }
  // 2. the session is re-created empty (same permanent ID) with the configured equipment / materials (stock zero)
  const now = new Date();
  await db.collection('sim_sessions').updateOne({ SESSION_ID: FACTORY_SESSION_ID }, { $set: { STATUS: 'READY', EVENT_SEQ: 0, COUNTERS: {}, PROJECTION_VERSION: 0, FORK_AT: now, RESET_AT: now, RESET_BY: actor, RESET_GENERATION: generation,
    ENGINE: { SIM_AT: now, WATERMARK_SEQ: 0, LEASE_OWNER: null, LEASE_EXPIRES_AT: null, FENCE: (sess.ENGINE || {}).FENCE || 0 }, AGENT_SETTINGS: { BASELINES: { COMPUTED_FROM: 'NO_HISTORY (fresh factory)' }, FAIL_RATES: {} } },
  $unset: { RESET_REQUEST: '', LAST_EVENT_SIM_AT: '' }, $inc: { VERSION: 1 } });
  C.invalidate();
  const cat = await C.catalog(true);
  for (const e of Object.values(cat.equipment)) await db.collection('sim_equipment').insertOne({ SESSION_ID: FACTORY_SESSION_ID, RUN_ID: 'RUN-FACTORY', DATASET_ID: ds(), EQUIPMENT_ID: e.EQUIPMENT_ID, WORKSTATION_ID: e.WORKSTATION_ID, WORK_CENTER_ID: e.WORK_CENTER_ID, STATUS: e.AVAILABILITY === 'UNAVAILABLE' ? 'DOWN' : 'UP', SINCE: now, ORIGIN: 'FACTORY_CONFIG', VERSION: 1, _origin: 'APP' });
  for (const m of Object.values(cat.materials)) await db.collection('sim_materials').insertOne({ SESSION_ID: FACTORY_SESSION_ID, RUN_ID: 'RUN-FACTORY', DATASET_ID: ds(), MATERIAL_ID: m.MATERIAL_ID, MATERIAL_NAME: m.MATERIAL_NAME, UOM: m.UOM, ON_HAND_QTY: 0, HOLD_QTY: 0, RESERVED_QTY: 0, LOTS: [], ORIGIN: 'FACTORY_CONFIG', VERSION: 1, _origin: 'APP' });
  if (!b.clearWorkers) await addWorkersToSession(db);
  await db.collection('factory_reset_log').updateOne({ RESET_ID: resetId }, { $set: { STATUS: 'COMPLETED', COMPLETED_AT: new Date(), REMOVED: removed } });
  await A.audit(db, actor, 'FACTORY_RESET', c.mongoDb, { resetId, removed, options: { clearWorkers: !!b.clearWorkers, clearConfiguration: !!b.clearConfiguration } });
  return { ok: true, resetId, removed, generation };
}

/** every active worker gets a not-clocked-in row in the factory session (bootstrap, reset); nobody is clocked in automatically */
async function addWorkersToSession(db) {
  const workers = await db.collection('worker_master').find({ dataset_id: ds(), ACTIVE_FLAG: 'Y' }).toArray();
  const now = new Date();
  for (const w of workers) {
    await db.collection('sim_workers').updateOne({ SESSION_ID: FACTORY_SESSION_ID, WORKER_ID: w.WORKER_ID }, { $setOnInsert: {
      SESSION_ID: FACTORY_SESSION_ID, RUN_ID: 'RUN-FACTORY', DATASET_ID: ds(), WORKER_ID: w.WORKER_ID, DISPLAY_NAME: w.DISPLAY_NAME, WORKER_ROLE: w.WORKER_ROLE, HOME_WORK_CENTER_ID: w.HOME_WORK_CENTER_ID,
      SHIFT_ID: null, ROSTER_STATUS: 'NOT_ROSTERED', ATTENDANCE_STATE: 'OFF_SHIFT', ACTIVITY_STATE: 'OFF_SHIFT', REASON_CODE: null, CURRENT_TASK_ID: null, FIRST_CLOCK_IN_AT: null, STATE_SINCE: now, ACTIVE_TASK_COUNT: 0,
      SIMULATED_WORKER: !!w.SIMULATED_WORKER, CONTROL: w.SIMULATED_WORKER ? { MODE: 'AGENT', NOTE: 'Designated simulated worker (Simulated Test mode only)' } : { MODE: 'HUMAN_ONLY', NOTE: 'Real person - background agents never act for them' },
      ORIGIN: 'APP_ADMIN', VERSION: 1, UPDATED_AT: now, _origin: 'APP' } }, { upsert: true });
  }
  await db.collection('sim_sessions').updateOne({ SESSION_ID: FACTORY_SESSION_ID }, { $inc: { ROSTER_VERSION: 1 } });
  return workers.length;
}

/** the session document of the permanent factory session (used by scripts/factory-init.js) */
function sessionDoc(st, actor) {
  const now = new Date();
  const mode = (st && st.OPERATING_MODE) || 'MANUAL_TEAM_TEST';
  return {
    SESSION_ID: FACTORY_SESSION_ID, SHORT_ID: 'FACTORY', RUN_ID: 'RUN-FACTORY', NAME: `${(st && st.FACTORY_NAME) || 'Fresh factory'} (${mode === 'MANUAL_TEAM_TEST' ? 'manual team test' : 'simulated test'})`,
    MODE: 'INTERACTIVE', STATUS: 'READY', FACTORY_SESSION: true, OPERATING_MODE: mode, DATASET_ID: ds(), DATASET_VERSION_ID: 'FRESH_FACTORY',
    SOURCE_RUN_ID: 'NO-HISTORY', CHECKPOINT_ID: null, FORK_AT: now, HORIZON_AT: null, DISPOSITION_POLICY_ID: 'FACTORY_DEFAULT_NO_MATRIX',
    POLICY_PARAMETERS: { invalidate_downstream_after_return: true, retain_at_station: true, escalate_after_fails: 2 }, SEED: 42,
    PLANT_TIMEZONE: (st && st.TIMEZONE) || 'UTC', SERIAL_PREFIX: (st && st.SERIAL_PREFIX) || 'TANK', SITE_ID: (st && st.SITE_ID) || null, FACTORY_NAME: (st && st.FACTORY_NAME) || null,
    CLOCK: { REAL_TIME: true, PAUSED: false, SPEED: 1, ANCHOR_SIM_AT: now, ANCHOR_WALL_AT: now, CONTROLLER_LOGIN_ID: actor, UPDATED_AT: now },
    EVENT_SEQ: 0, COUNTERS: {}, ENGINE: { SIM_AT: now, WATERMARK_SEQ: 0, LEASE_OWNER: null, LEASE_EXPIRES_AT: null, FENCE: 0 }, PROJECTION_VERSION: 0,
    AGENT_SETTINGS: { BASELINES: { COMPUTED_FROM: 'NO_HISTORY (fresh factory)' }, FAIL_RATES: {} },
    INIT: { COMPLETED_AT: now, COUNTS: {}, SUMMARY: { note: 'Fresh factory: no history, no inherited work' }, WARNINGS: [], GOOD_BY_LINE_AT_FORK: {}, SCRAP_BY_LINE_AT_FORK: {}, BASIS: 'Fresh factory - empty operational session (no checkpoint)' },
    DEFAULT_FLAG: true, CREATED_BY: actor, CREATED_AT: now, UPDATED_AT: now, VERSION: 1, _origin: 'APP',
    NOTE: 'Permanent fresh-factory session: real people, real time. No synthetic history; nothing was imported.',
  };
}

module.exports = { FACTORY_SESSION_ID, MODES, requireFresh, settings, session, applyTimezone, environment, saveSettings, saveWorkCenter, saveStation, saveSkill, saveEquipment, saveMaterial,
  saveShiftTemplate, ensureCalendar, extendRosters, saveChecklist, saveProduct, releaseProduct, productProblems, master, setup, readiness, templatePreview, importTemplate, resetPreview, reset,
  addWorkersToSession, sessionDoc, OPERATIONAL_COLLS, CONFIG_COLLS, TEMPLATE_FILE };
