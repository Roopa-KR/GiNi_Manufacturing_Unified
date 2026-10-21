'use strict';
/* Master / configuration data cache (per serverless instance, 60 s TTL). Seeded uppercase columns are used as-is. */
const { getDb } = require('../lib/db');
const { config } = require('../config/env');

let cache = null;
let loadedAt = 0;
const TTL_MS = 60000;

async function load() {
  const db = await getDb();
  const ds = config().datasetId;
  // fresh factory: the configured plant timezone drives every local-time conversion of the API
  if (config().isFresh) await require('../services/factory').applyTimezone(db);
  const all = (c, f = {}) => db.collection(c).find({ dataset_id: ds, ...f }, { projection: { _seed: 0 } }).toArray();
  const [routing, routeDeps, crewRules, wcs, stations, equipment, skills, opSkills, ctq, specs, milestones, instructions, steps, transferRules, calendar, shifts, products,
    dispMatrix, policies, materials, matReqs, runCatalog, checkpoints, dispatchRules, workers, quals, users, configRows, scoringRules, contShifts, contCalendar] = await Promise.all([
    all('routing_operations'), all('route_dependencies'), all('crew_capacity_rules'), all('work_center_master'), all('workstation_master'), all('equipment_master'),
    all('skill_master'), all('operation_skill_requirements'), all('ctq_check_master'), all('ctq_specifications'), all('milestone_definitions'),
    all('operation_instructions'), all('instruction_steps'), all('transfer_rules'), all('calendar_intervals'), all('shift_calendar'), all('product_master'),
    all('disposition_matrix'), all('disposition_policies'), all('material_master'), all('material_requirements'), all('run_catalog'), all('checkpoints'), all('dispatch_rules'),
    all('worker_master'), all('worker_qualifications'), all('app_users'), all('config'), all('scoring_rules'),
    all('continuation_shift_calendar'), all('continuation_calendar_intervals'),
  ]);
  const by = (rows, k) => Object.fromEntries(rows.map(r => [r[k], r]));
  const qualsBy = {};
  for (const q of quals) (qualsBy[q.WORKER_ID] = qualsBy[q.WORKER_ID] || []).push(q);
  cache = {
    routing, routeDeps, crewRules, wcs: by(wcs, 'WORK_CENTER_ID'), stations: by(stations, 'WORKSTATION_ID'), equipment: by(equipment, 'EQUIPMENT_ID'), skills: by(skills, 'SKILL_ID'),
    opSkills, ctq: by(ctq, 'CHECK_ID'), specs, milestones, instructions: by(instructions, 'INSTRUCTION_VERSION_ID'), steps, transferRules, calendar: [...calendar, ...contCalendar], shifts: by([...shifts, ...contShifts], 'SHIFT_ID'),
    products: by(products, 'PRODUCT_ID'), dispMatrix, policies: by(policies, 'POLICY_ID'), materials: by(materials, 'MATERIAL_ID'), matReqs, runCatalog: by(runCatalog, 'RUN_ID'),
    checkpoints, dispatchRules, workers: by(workers, 'WORKER_ID'), quals: qualsBy, users: by(users, 'WORKER_ID'), config: Object.fromEntries(configRows.map(r => [r.PARAMETER, r.VALUE])),
    scoringRules: by(scoringRules, 'RULE_ID'),
  };
  loadedAt = Date.now();
  return cache;
}

let refreshing = null;
function refresh() {
  if (!refreshing) refreshing = load().finally(() => { refreshing = null; });
  return refreshing;
}
/* Commands call catalog() inside a database transaction. A cold cache is loaded (awaited); an expired cache is
   served while a background refresh runs, so a transaction never waits on a non-transactional master-data read. */
async function catalog(force = false) {
  if (!cache || force) await refresh();
  else if (Date.now() - loadedAt > TTL_MS) refresh().catch(() => {});
  return cache;
}
/** master data changed (worker, qualification, configuration): drop this instance's cache and bump the shared stamp so the Python
    engine (and other API instances) reload theirs at the next tick instead of waiting for the 60 s TTL */
function invalidate() {
  cache = null;
  getDb().then(db => db.collection('catalog_stamp').updateOne({ _id: config().datasetId }, { $inc: { N: 1 }, $set: { AT: new Date() } }, { upsert: true })).catch(() => {});
}

// ---------------------------------------------------------------- helpers (pure, given a catalog)
function route(cat, product) {
  const ops = cat.routing.filter(r => r.PRODUCT_ID === product).sort((a, b) => (a.SEQUENCE_NO || 0) - (b.SEQUENCE_NO || 0)).map(r => r.OPERATION_ID);
  if (ops.length || config().isFresh) return ops;      // a fresh factory never falls back to the synthetic demo route
  return ['OP10', 'QG10', 'OP20', 'QG20', 'OP30', 'OP31', 'QG30', 'OP40', 'QG40'];
}
function opDef(cat, product, opId) { return cat.routing.find(r => r.PRODUCT_ID === product && r.OPERATION_ID === opId) || cat.routing.find(r => r.OPERATION_ID === opId) || null; }
function nextOp(cat, product, opId) { const s = route(cat, product); const i = s.indexOf(opId); return i < 0 ? null : (s[i + 1] || 'ROUTE_END'); }
function transferMin(cat, pred, succ) { const d = cat.routeDeps.find(x => x.PREDECESSOR_OPERATION_ID === pred && x.SUCCESSOR_OPERATION_ID === succ); return d ? Number(d.TRANSFER_MIN || 0) : 0; }
function gateOfWc(cat, wc) { const r = cat.routing.find(x => x.WORK_CENTER_ID === wc && x.OPERATION_KIND === 'INSPECTION'); return r ? r.OPERATION_ID : null; }
function laborOpOfGate(cat, product, gate) {
  const s = route(cat, product); const i = s.indexOf(gate);
  for (let j = i - 1; j >= 0; j--) { const o = opDef(cat, product, s[j]); if (o && o.OPERATION_KIND === 'LABOR') return s[j]; }
  return null;
}
function gateAfter(cat, product, opId) {
  const s = route(cat, product); let i = s.indexOf(opId);
  for (i = i + 1; i < s.length; i++) { const o = opDef(cat, product, s[i]); if (o && o.OPERATION_KIND === 'INSPECTION') return s[i]; }
  return null;
}
function qualified(cat, workerId, skillId, at) {
  if (cat.workers && cat.workers[workerId] && cat.workers[workerId].ACTIVE_FLAG === 'N') return false;
  if (!skillId) return true;
  return (cat.quals[workerId] || []).some(q => q.SKILL_ID === skillId && (q.QUALIFICATION_STATUS || 'VALID') === 'VALID' &&
    (!q.VALID_FROM || new Date(q.VALID_FROM) <= at) && (!q.VALID_TO || new Date(q.VALID_TO) >= at));
}
function qualificationOf(cat, workerId, skillId) { return (cat.quals[workerId] || []).find(q => q.SKILL_ID === skillId) || null; }
function elapsedForCrew(cat, product, opId, crew) {
  const rows = cat.crewRules.filter(r => r.PRODUCT_ID === product && r.OPERATION_ID === opId).sort((a, b) => a.QUALIFIED_CREW_COUNT - b.QUALIFIED_CREW_COUNT);
  if (!rows.length) { const o = opDef(cat, product, opId); return o ? Number(o.STANDARD_ELAPSED_MIN || 0) : null; }
  if (crew < rows[0].QUALIFIED_CREW_COUNT) return null;
  let best = rows[0]; for (const r of rows) if (r.QUALIFIED_CREW_COUNT <= crew) best = r;
  return Number(best.ELAPSED_MIN_PER_UNIT);
}
function milestonesFor(cat, opId, type = 'STANDARD') {
  let ms = cat.milestones.filter(m => m.OPERATION_ID === opId && (m.INSTRUCTION_TYPE || 'STANDARD') === type);
  if (!ms.length && type !== 'STANDARD') ms = cat.milestones.filter(m => m.OPERATION_ID === opId && (m.INSTRUCTION_TYPE || 'STANDARD') === 'STANDARD');
  return ms.sort((a, b) => a.SEQUENCE_NO - b.SEQUENCE_NO);
}
function instructionFor(cat, opId, product, drawingRevision, rework, at) {
  const type = rework ? 'REWORK' : 'STANDARD';
  const cands = Object.values(cat.instructions).filter(i => i.OPERATION_ID === opId && (i.INSTRUCTION_TYPE || 'STANDARD') === type &&
    (i.PRODUCT_ID === 'ALL' || i.PRODUCT_ID === product) && (i.DRAWING_REVISION === 'ALL' || i.DRAWING_REVISION === drawingRevision) &&
    (!i.EFFECTIVE_FROM || new Date(i.EFFECTIVE_FROM) <= at) && (!i.EFFECTIVE_TO || new Date(i.EFFECTIVE_TO) > at));
  cands.sort((a, b) => (b.PRODUCT_ID !== 'ALL') - (a.PRODUCT_ID !== 'ALL') || (b.DRAWING_REVISION !== 'ALL') - (a.DRAWING_REVISION !== 'ALL') || String(b.INSTRUCTION_VERSION).localeCompare(String(a.INSTRUCTION_VERSION)));
  return cands[0] || null;
}
/** the current checklist of a gate for a product: product-specific limits first, else the limits saved with the checklist (fresh factory) */
function checklist(cat, gate, product) {
  const checks = Object.values(cat.ctq).filter(c => c.OPERATION_ID === gate && c.ACTIVE_FLAG !== 'N')
    .sort((a, b) => (a.SEQUENCE_NO || 0) - (b.SEQUENCE_NO || 0) || a.CHECK_ID.localeCompare(b.CHECK_ID));
  return checks.map(c => {
    const own = cat.specs.filter(s => s.CHECK_ID === c.CHECK_ID && s.PRODUCT_ID === product);
    return { check: c, specs: own.length ? own : (c.DEFAULT_SPECS || []).map(s => ({ ...s, CHECK_ID: c.CHECK_ID, PRODUCT_ID: product })) };
  });
}
function dispositionRule(cat, policyId, detectionPoint, defectCode) {
  return cat.dispMatrix.find(m => m.POLICY_ID === policyId && m.DETECTION_POINT === detectionPoint && m.DEFECT_CODE === defectCode) || null;
}
function stationsOf(cat, wc) { return Object.values(cat.stations).filter(s => s.WORK_CENTER_ID === wc && !['CURE_ZONE', 'HOLD_AREA'].includes(s.WORKSTATION_TYPE)).sort((a, b) => a.WORKSTATION_ID.localeCompare(b.WORKSTATION_ID)); }
function transferRule(cat, from, to) { return cat.transferRules.find(t => t.FROM_WORK_CENTER_ID === from && t.TO_WORK_CENTER_ID === to) || null; }

module.exports = { catalog, invalidate, route, opDef, nextOp, transferMin, gateOfWc, laborOpOfGate, gateAfter, qualified, qualificationOf, elapsedForCrew, milestonesFor, instructionFor, checklist, dispositionRule, stationsOf, transferRule };
