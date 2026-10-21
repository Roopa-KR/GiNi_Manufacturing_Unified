'use strict';
/* Supervisor / shared plant read models: observe (overview, workforce, work centres, orders), drill-downs (tank passport, worker timeline),
   quality, alerts, forecasts, actions, materials/equipment, event deltas. Derived analytics come from engine projections (sim_projections,
   sim_alerts, sim_forecasts, sim_points_ledger); observed state comes straight from the session's operational records. */
const V = require('./viewsCommon');
const C = require('../domain/catalog');
const E = require('../lib/errors');

const WIP = {
  QUEUED: ['QUEUED', 'READY', 'QUEUED_FOR_REWORK', 'RECEIVED_AT_REWORK_STATION', 'RETURN_REQUESTED', 'AUTHORIZED_REWORK'],
  IN_PROCESS: ['WORKING', 'PAUSED', 'REWORK_IN_PROGRESS', 'CURING'],
  AWAITING_INSPECTION: ['WORK_COMPLETED_AWAITING_INSPECTION', 'INSPECTION_IN_PROGRESS', 'PASS_PENDING_RELEASE', 'REWORK_COMPLETE_AWAITING_REINSPECTION', 'REINSPECTION_IN_PROGRESS'],
  QUALITY_HOLD: ['FAILED_INSPECTION', 'QUALITY_HOLD', 'PENDING_REVIEW', 'INCOMPLETE_INSPECTION_HOLD'],
  IN_TRANSFER: ['IN_TRANSFER', 'IN_RETURN_TRANSFER', 'RELEASED_TO_NEXT_OPERATION'],
};
function bucketOf(state) { for (const [k, v] of Object.entries(WIP)) if (v.includes(state)) return k; return state === 'ROUTE_COMPLETE' ? 'GOOD_COMPLETED' : state === 'SCRAPPED' ? 'SCRAPPED' : 'OTHER'; }

const latestProjection = (x, kind, entityId) => V.projection(x, kind, entityId);

async function overview(x) {
  const [workers, units, eqs, alerts, wcProj, orderProj] = await Promise.all([
    V.sim(x, 'sim_workers', {}, { projection: { WORKER_ID: 1, ATTENDANCE_STATE: 1, ACTIVITY_STATE: 1, CURRENT_WORK_CENTER_ID: 1, PLANNED_WORK_CENTER_ID: 1, HOME_WORK_CENTER_ID: 1, WORKER_ROLE: 1, ROSTER_STATUS: 1, SHIFT_ID: 1 } }),
    V.sim(x, 'sim_units', {}, { projection: { UNIT_ID: 1, STATE: 1, CURRENT_WORK_CENTER_ID: 1, CURRENT_WORKSTATION_ID: 1, ROUTE_COMPLETED_AT: 1, SCRAPPED_AT: 1, ORDER_LINE_ID: 1, BLOCKED_ARRIVAL: 1, TERMINAL_IN_SESSION: 1 } }),
    V.sim(x, 'sim_equipment', {}),
    V.sim(x, 'sim_alerts', { EVALUATION_STATE: { $in: ['PENDING', 'FIRING', 'RECOVERING', 'NO_DATA'] } }),
    latestProjection(x, 'WORK_CENTER_SUMMARY'), latestProjection(x, 'ORDER_FORECAST_SUMMARY'),
  ]);
  const fork = V.goodBoundary(x);
  // fresh factory: every active configured work centre; synthetic demo: the four core work centres
  const wcs = Object.values(x.cat.wcs).filter(w => x.session.FACTORY_SESSION ? w.ACTIVE_FLAG !== 'N' : (w.DEMO_SCOPE === 'CORE_DEMO' || ['WC1', 'WC2', 'WC3', 'WC4'].includes(w.WORK_CENTER_ID)))
    .sort((a, b) => (a.ROUTE_SEQUENCE || 0) - (b.ROUTE_SEQUENCE || 0) || a.WORK_CENTER_ID.localeCompare(b.WORK_CENTER_ID));
  const cards = wcs.map(wc => {
    const id = wc.WORK_CENTER_ID;
    const ws = workers.filter(w => (w.CURRENT_WORK_CENTER_ID || w.PLANNED_WORK_CENTER_ID) === id && w.ATTENDANCE_STATE === 'CLOCKED_IN');
    const us = units.filter(u => u.CURRENT_WORK_CENTER_ID === id);
    const stations = C.stationsOf(x.cat, id);
    const down = eqs.filter(e => e.WORK_CENTER_ID === id && e.STATUS === 'DOWN');
    const queued = us.filter(u => ['QUEUED', 'QUEUED_FOR_REWORK', 'RECEIVED_AT_REWORK_STATION'].includes(u.STATE)).length;
    const proj = wcProj && (wcProj.DATA || {})[id];
    return {
      workCenterId: id, name: wc.WORK_CENTER_NAME, queueCapacity: wc.QUEUE_CAPACITY_UNITS,
      workers: { present: ws.length, working: ws.filter(w => ['WORKING', 'INSPECTING', 'REPAIRING'].includes(w.ACTIVITY_STATE)).length, waiting: ws.filter(w => ['WAITING', 'AVAILABLE'].includes(w.ACTIVITY_STATE)).length,
        onBreak: ws.filter(w => w.ACTIVITY_STATE === 'BREAK').length, other: ws.filter(w => !['WORKING', 'INSPECTING', 'REPAIRING', 'WAITING', 'AVAILABLE', 'BREAK'].includes(w.ACTIVITY_STATE)).length },
      units: { queued, inProcess: us.filter(u => WIP.IN_PROCESS.includes(u.STATE)).length, awaitingInspection: us.filter(u => WIP.AWAITING_INSPECTION.includes(u.STATE)).length,
        onHold: us.filter(u => WIP.QUALITY_HOLD.includes(u.STATE)).length, blockedArrivals: units.filter(u => u.BLOCKED_ARRIVAL && u.STATE === 'IN_TRANSFER').length },
      queueOccupancyPct: wc.QUEUE_CAPACITY_UNITS ? Math.round(queued / wc.QUEUE_CAPACITY_UNITS * 100) : null,
      stations: { total: stations.length, occupied: new Set(us.filter(u => u.CURRENT_WORKSTATION_ID && !['QUEUED'].includes(u.STATE)).map(u => u.CURRENT_WORKSTATION_ID)).size, down: down.length },
      equipmentDown: down.map(e => ({ equipmentId: e.EQUIPMENT_ID, reason: e.REASON_CODE, since: e.SINCE })),
      goodReleasedSinceFork: null,
      forecast: proj ? { status: proj.STATUS, limitingConstraint: proj.LIMITING_CONSTRAINT, predictedNoWorkAt: proj.PREDICTED_NO_WORK_AT, predictedNoWorkLocal: V.loc(x, proj.PREDICTED_NO_WORK_AT), nextArrivalAt: proj.NEXT_ARRIVAL_AT, nextArrivalLocal: V.loc(x, proj.NEXT_ARRIVAL_AT), loadStdMin: proj.LOAD_STD_MIN, availableLaborMin: proj.AVAILABLE_LABOR_MIN, computedAt: wcProj.COMPUTED_AT, kind: 'FORECAST' } : null,
    };
  });
  const people = { rostered: workers.filter(w => w.ROSTER_STATUS === 'SCHEDULED').length, clockedIn: workers.filter(w => w.ATTENDANCE_STATE === 'CLOCKED_IN').length,
    working: workers.filter(w => ['WORKING', 'INSPECTING', 'REPAIRING'].includes(w.ACTIVITY_STATE)).length, absent: workers.filter(w => w.ATTENDANCE_STATE === 'ABSENT').length, plantTotal: workers.length };
  const goodSince = units.filter(u => u.STATE === 'ROUTE_COMPLETE' && (u.TERMINAL_IN_SESSION || (u.ROUTE_COMPLETED_AT && new Date(u.ROUTE_COMPLETED_AT) > fork))).length;
  const scrapSince = units.filter(u => u.STATE === 'SCRAPPED' && (u.TERMINAL_IN_SESSION || (u.SCRAPPED_AT && new Date(u.SCRAPPED_AT) > fork))).length;
  const orders = orderProj ? (orderProj.DATA || []) : [];
  return {
    session: header(x), freshness: V.freshness(x), people, workCenters: cards,
    production: { goodRouteCompleteSinceFork: goodSince, scrappedSinceFork: scrapSince, wipActive: units.filter(u => !['ROUTE_COMPLETE', 'SCRAPPED'].includes(u.STATE)).length, onHold: units.filter(u => WIP.QUALITY_HOLD.includes(u.STATE)).length },
    ordersAtRisk: orders.filter(o => ['RED', 'AMBER', 'UNKNOWN'].includes(o.BAND)).slice(0, 10),
    alerts: { open: alerts.length, firing: alerts.filter(a => a.EVALUATION_STATE === 'FIRING').length, top: alerts.sort((a, b) => sevRank(b.SEVERITY) - sevRank(a.SEVERITY)).slice(0, 6).map(mapAlert(x)) },
    note: 'Observed state is live from operational records; forecasts are labelled FORECAST and carry their computation time.',
  };
}
function sevRank(s) { return { HIGH: 3, MEDIUM: 2, LOW: 1 }[s] || 0; }
function header(x) {
  return { sessionId: x.sid, mode: x.session.MODE, factorySession: !!x.session.FACTORY_SESSION, operatingMode: x.session.OPERATING_MODE || null, realTime: !!(x.session.CLOCK || {}).REAL_TIME, factoryName: x.session.FACTORY_NAME || null, siteId: x.session.SITE_ID || null,
    modeLabel: x.session.FACTORY_SESSION ? (x.session.OPERATING_MODE === 'SIMULATED_TEST' ? 'Fresh factory - simulated test' : 'Fresh factory - manual team test') : (x.session.MODE === 'REPLAY' ? 'Synthetic live replay' : 'Synthetic interactive demo'), simNow: x.now, simNowLocal: V.loc(x, x.now), timezone: x.tz,
    forkAt: x.session.FORK_AT, forkLocal: V.loc(x, x.session.FORK_AT), checkpointId: x.session.CHECKPOINT_ID, sourceRunId: x.src, status: x.session.STATUS, speed: (x.session.CLOCK || {}).SPEED, paused: !!(x.session.CLOCK || {}).PAUSED, policyId: x.session.DISPOSITION_POLICY_ID };
}
const mapAlert = x => a => ({ alertId: a.ALERT_ID, episodeId: a.EPISODE_ID, ruleId: a.RULE_ID, ruleName: a.RULE_NAME, ruleVersion: a.RULE_VERSION, scope: a.SCOPE, entityId: a.ENTITY_ID, evaluation: a.EVALUATION_STATE, workflow: a.WORKFLOW_STATE,
  severity: a.SEVERITY, actual: a.ACTUAL, expected: a.EXPECTED, delta: a.DELTA, threshold: a.THRESHOLD, window: a.WINDOW, message: a.MESSAGE, recommended: a.RECOMMENDED, evidence: a.EVIDENCE || [], sample: a.SAMPLE || null,
  firstDetectedAt: a.FIRST_DETECTED_AT, firingAt: a.FIRING_AT, resolvedAt: a.RESOLVED_AT, firstDetectedLocal: V.loc(x, a.FIRST_DETECTED_AT), owner: a.OWNER_ID || null, version: a.VERSION, legacy: a.LEGACY_MAPPING || null });

async function workforce(x, q) {
  const f = {};
  if (q.shiftOnly === '1') f.ROSTER_STATUS = 'SCHEDULED';
  if (q.workCenterId) f.$or = [{ CURRENT_WORK_CENTER_ID: q.workCenterId }, { PLANNED_WORK_CENTER_ID: q.workCenterId }, { HOME_WORK_CENTER_ID: q.workCenterId }];
  if (q.role) f.WORKER_ROLE = q.role;
  let rows = await V.sim(x, 'sim_workers', f, { sort: { WORKER_ID: 1 } });
  if (q.q) { const s = String(q.q).toLowerCase(); rows = rows.filter(w => (w.DISPLAY_NAME || '').toLowerCase().includes(s) || w.WORKER_ID.toLowerCase().includes(s)); }
  if (q.state) rows = rows.filter(w => V.plantState(w) === q.state);
  const counts = {};
  for (const w of rows) { const k = V.plantState(w); counts[k] = (counts[k] || 0) + 1; }
  const page = Math.max(1, Number(q.page || 1)), size = Math.min(200, Number(q.pageSize || 50));
  return { session: header(x), total: rows.length, stateCounts: counts, page, pageSize: size, scope: q.shiftOnly === '1' ? 'Rostered for the current shift only' : 'Full plant roster (off-shift people included)',
    workers: rows.slice((page - 1) * size, page * size).map(w => V.mapWorker(x, w)) };
}

async function workerDetail(x, wid) {
  const w = await V.simOne(x, 'sim_workers', { WORKER_ID: wid });
  if (!w) throw E.notFound('Worker');
  const since = w.PLANNED_START_AT ? new Date(new Date(w.PLANNED_START_AT).getTime() - 2 * 3600000) : new Date(x.histCut.getTime() - 12 * 3600000);
  const histEv = await x.db.collection('worker_events').find({ RUN_ID: x.src, WORKER_ID: wid, EVENT_TIME: { $lte: x.histCut, $gte: since }, KNOWN_AT: { $lte: x.histCut } }, { projection: { _seed: 0, _id: 0 } }).sort({ EVENT_TIME: 1 }).toArray();
  const histAtt = await x.db.collection('attendance_events').find({ RUN_ID: x.src, WORKER_ID: wid, EVENT_TIME: { $lte: x.histCut, $gte: since }, KNOWN_AT: { $lte: x.histCut } }, { projection: { _seed: 0, _id: 0 } }).toArray();
  const sessEv = await V.sim(x, 'sim_events', { $or: [{ ENTITY_ID: wid }, { 'PAYLOAD.WORKER_ID': wid }] }, { sort: { EVENT_SEQ: 1 }, limit: 300 });
  const segs = await V.sim(x, 'sim_participation', { WORKER_ID: wid }, { sort: { START_AT: 1 } });
  const timeline = [
    ...histEv.map(e => ({ at: e.EVENT_TIME, local: V.loc(x, e.EVENT_TIME), source: 'HISTORY', type: e.EVENT_TYPE, state: e.STATE_AFTER, reason: e.REASON_CODE, workCenterId: e.WORK_CENTER_ID, workstationId: e.WORKSTATION_ID, unitId: e.UNIT_ID, knownAt: e.KNOWN_AT })),
    ...histAtt.map(e => ({ at: e.EVENT_TIME, local: V.loc(x, e.EVENT_TIME), source: 'HISTORY', type: e.EVENT_TYPE, reason: e.REASON_CODE, knownAt: e.KNOWN_AT })),
    ...sessEv.map(e => ({ at: e.EVENT_TIME, local: V.loc(x, e.EVENT_TIME), source: 'SESSION', type: e.EVENT_TYPE, state: (e.PAYLOAD || {}).ACTIVITY_STATE, reason: (e.PAYLOAD || {}).REASON_CODE, workCenterId: (e.PAYLOAD || {}).WORK_CENTER_ID, workstationId: (e.PAYLOAD || {}).WORKSTATION_ID, unitId: (e.PAYLOAD || {}).UNIT_ID, actor: e.ACTOR_ID, knownAt: e.KNOWN_AT })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));
  const tasks = await V.sim(x, 'sim_tasks', { WORKER_ID: wid }, { sort: { STATUS_SINCE: -1 }, limit: 30 });
  const quals = (x.cat.quals[wid] || []).map(q => ({ skillId: q.SKILL_ID, skill: (x.cat.skills[q.SKILL_ID] || {}).SKILL_NAME, level: q.QUALIFICATION_LEVEL, status: q.QUALIFICATION_STATUS, validFrom: q.VALID_FROM, validTo: q.VALID_TO,
    validNow: C.qualified(x.cat, wid, q.SKILL_ID, x.now), independent: q.CAN_WORK_INDEPENDENTLY, supervisionRequired: q.SUPERVISION_REQUIRED }));
  const pts = await V.pointsFor(x, wid);
  const insights = [await V.projection(x, 'WORKER_METRICS', wid)].filter(Boolean);
  // application sign-in state (wall clock) is reported separately from attendance (simulated plant time)
  const wallNow = new Date();
  const live = await x.db.collection('auth_sessions').find({ WORKER_ID: wid, REVOKED_AT: null, IDLE_EXPIRES_AT: { $gt: wallNow }, ABSOLUTE_EXPIRES_AT: { $gt: wallNow } }, { projection: { APP_KIND: 1, LAST_SEEN_AT: 1, CREATED_AT: 1 } }).toArray();
  const appSession = { signedIn: live.length > 0, apps: [...new Set(live.map(l => l.APP_KIND))], lastSeenAt: live.map(l => l.LAST_SEEN_AT || l.CREATED_AT).sort().pop() || null,
    note: 'Application sign-in is not attendance: clock-in/out is recorded separately' };
  return { session: header(x), worker: V.mapWorker(x, w), appSession, qualifications: quals, timeline, participation: segs.map(s => ({ category: s.CATEGORY, start: s.START_AT, end: s.END_AT, startLocal: V.loc(x, s.START_AT), endLocal: V.loc(x, s.END_AT), reason: s.REASON, operationInstanceId: s.OPERATION_INSTANCE_ID, unitId: s.UNIT_ID, eligible: s.TIME_POINTS_ELIGIBLE })),
    tasks: tasks.map(t => ({ taskId: t.TASK_ID, status: t.STATUS, unitId: t.UNIT_ID, operationId: t.OPERATION_ID, operationInstanceId: t.OPERATION_INSTANCE_ID, statusSince: t.STATUS_SINCE, pauseReason: t.PAUSE_REASON, origin: t.ORIGIN })),
    points: pts, metrics: insights[0] ? insights[0].DATA : null, metricsComputedAt: insights[0] ? insights[0].COMPUTED_AT : null,
    fairness: 'Waiting for upstream supply, material, equipment, planned breaks and supervisor-directed transfers are shown with their reason and never counted as poor performance. Stale data shows "last known".' };
}

async function workCenter(x, wcId) {
  const wc = x.cat.wcs[wcId];
  if (!wc) throw E.notFound('Work centre');
  const stations = Object.values(x.cat.stations).filter(s => s.WORK_CENTER_ID === wcId).sort((a, b) => a.WORKSTATION_ID.localeCompare(b.WORKSTATION_ID));
  const units = await V.sim(x, 'sim_units', { CURRENT_WORK_CENTER_ID: wcId, STATE: { $nin: ['ROUTE_COMPLETE', 'SCRAPPED'] } });
  const ops = await V.sim(x, 'sim_operations', { WORK_CENTER_ID: wcId, STATE: { $in: ['CREATED', 'WORKING', 'PAUSED', 'BELOW_MIN_CREW', 'CURING'] } });
  const workers = await V.sim(x, 'sim_workers', { $or: [{ CURRENT_WORK_CENTER_ID: wcId }, { PLANNED_WORK_CENTER_ID: wcId, ATTENDANCE_STATE: 'CLOCKED_IN' }] });
  const eqs = await V.sim(x, 'sim_equipment', { WORK_CENTER_ID: wcId });
  const proj = await latestProjection(x, 'WORK_CENTER_SUMMARY');
  const st = stations.map(s => {
    const op = ops.find(o => o.WORKSTATION_ID === s.WORKSTATION_ID);
    const unit = units.find(u => u.CURRENT_WORKSTATION_ID === s.WORKSTATION_ID && u.STATE !== 'QUEUED');
    const eq = eqs.find(e => e.EQUIPMENT_ID === s.EQUIPMENT_ID);
    return { workstationId: s.WORKSTATION_ID, name: s.WORKSTATION_NAME, type: s.WORKSTATION_TYPE, equipmentId: s.EQUIPMENT_ID, equipmentStatus: eq ? eq.STATUS : null, equipmentReason: eq ? eq.REASON_CODE : null,
      unit: unit ? { unitId: unit.UNIT_ID, serial: unit.TANK_SERIAL_NO, state: unit.STATE, routeStep: unit.ROUTE_STEP } : null,
      operation: op ? V.mapOp(x, op) : null, crewNames: op ? (op.CREW || []).map(w => V.name(x, w)) : [] };
  });
  const queue = units.filter(u => ['QUEUED', 'QUEUED_FOR_REWORK', 'RECEIVED_AT_REWORK_STATION'].includes(u.STATE))
    .sort((a, b) => (a.PRIORITY_CLASS || 3) - (b.PRIORITY_CLASS || 3) || new Date(a.DUE_AT || 8.64e15) - new Date(b.DUE_AT || 8.64e15) || new Date(a.QUEUE_ENTERED_AT || 0) - new Date(b.QUEUE_ENTERED_AT || 0))
    .map((u, i) => ({ rank: i + 1, ...V.mapUnit(x, u), waitedMin: u.QUEUE_ENTERED_AT ? Math.max(0, Math.round((x.now - new Date(u.QUEUE_ENTERED_AT)) / 60000)) : null }));
  return { session: header(x), workCenterId: wcId, name: wc.WORK_CENTER_NAME, queueCapacity: wc.QUEUE_CAPACITY_UNITS, stations: st, queue,
    workers: workers.map(w => ({ ...V.mapWorker(x, w), qualifiedHere: x.cat.routing.filter(r => r.WORK_CENTER_ID === wcId && r.REQUIRED_SKILL_ID).some(r => C.qualified(x.cat, w.WORKER_ID, r.REQUIRED_SKILL_ID, x.now)) })),
    awaitingInspection: units.filter(u => WIP.AWAITING_INSPECTION.includes(u.STATE)).map(u => V.mapUnit(x, u)),
    holds: units.filter(u => WIP.QUALITY_HOLD.includes(u.STATE)).map(u => V.mapUnit(x, u)),
    forecast: proj && (proj.DATA || {})[wcId] ? { ...proj.DATA[wcId], computedAt: proj.COMPUTED_AT, kind: 'FORECAST' } : null };
}

async function orders(x) {
  const lines = await x.db.collection('order_lines').find({ RUN_ID: x.src, $or: [{ SESSION_ID: null }, { SESSION_ID: x.sid }], RELEASE_AT: { $lte: new Date(x.now.getTime() + 2 * 86400000) } }, { projection: { _seed: 0, _id: 0 } }).toArray();
  const fork = V.goodBoundary(x);
  const goodAtFork = ((x.session.INIT || {}).GOOD_BY_LINE_AT_FORK) || {};
  const scrapAtFork = ((x.session.INIT || {}).SCRAP_BY_LINE_AT_FORK) || {};
  const units = await V.sim(x, 'sim_units', {}, { projection: { UNIT_ID: 1, STATE: 1, ORDER_LINE_ID: 1, ROUTE_COMPLETED_AT: 1, SCRAPPED_AT: 1, TERMINAL_IN_SESSION: 1, REPLACED_BY_UNIT_ID: 1, REPLACEMENT_FOR_UNIT_ID: 1, BATCH_ID: 1 } });
  const repl = await V.sim(x, 'sim_replacements', {});
  const plans = await V.sim(x, 'sim_plan_releases', {}, { projection: { BATCH_ID: 1, ORDER_LINE_ID: 1, PLANNED_QTY: 1, RELEASED: 1, RELEASED_AT: 1, PLANNED_RELEASE_AT: 1, UNIT_IDS: 1 } });
  const orderDocs = x.session.FACTORY_SESSION ? await x.db.collection('production_orders').find({ SESSION_ID: x.sid }, { projection: { _id: 0, ORDER_ID: 1, CUSTOMER_ORDER_REF: 1, CUSTOMER_NAME: 1, PRIORITY: 1, STATUS: 1 } }).toArray() : [];
  const fc = await latestProjection(x, 'ORDER_FORECAST_SUMMARY');
  const fcBy = Object.fromEntries(((fc || {}).DATA || []).map(o => [o.ORDER_LINE_ID, o]));
  const out = [];
  for (const l of lines) {
    const us = units.filter(u => u.ORDER_LINE_ID === l.ORDER_LINE_ID);
    const good = (goodAtFork[l.ORDER_LINE_ID] || 0) + us.filter(u => u.STATE === 'ROUTE_COMPLETE' && (u.TERMINAL_IN_SESSION || (u.ROUTE_COMPLETED_AT && new Date(u.ROUTE_COMPLETED_AT) > fork))).length;
    const scrap = (scrapAtFork[l.ORDER_LINE_ID] || 0) + us.filter(u => u.STATE === 'SCRAPPED' && (u.TERMINAL_IN_SESSION || (u.SCRAPPED_AT && new Date(u.SCRAPPED_AT) > fork))).length;
    if (good >= l.REQUIRED_GOOD_QTY && !us.some(u => !['ROUTE_COMPLETE', 'SCRAPPED'].includes(u.STATE)) && new Date(l.DUE_AT) < new Date(x.now.getTime() - 2 * 86400000)) continue;
    const b = { QUEUED: 0, IN_PROCESS: 0, AWAITING_INSPECTION: 0, QUALITY_HOLD: 0, IN_TRANSFER: 0 };
    for (const u of us) { const k = bucketOf(u.STATE); if (k in b) b[k]++; }
    const wip = Object.values(b).reduce((s, v) => s + v, 0);
    const replPending = repl.filter(r => r.ORDER_LINE_ID === l.ORDER_LINE_ID && ['REQUESTED', 'BLOCKED'].includes(r.STATUS)).length;
    const f = fcBy[l.ORDER_LINE_ID];
    const od = orderDocs.find(o => o.ORDER_ID === l.ORDER_ID) || {};
    const pb = plans.filter(r => r.ORDER_LINE_ID === l.ORDER_LINE_ID).map(r => ({ batchId: r.BATCH_ID, qty: r.PLANNED_QTY, released: !!r.RELEASED, releasedAt: r.RELEASED_AT || null, plannedReleaseAt: r.PLANNED_RELEASE_AT || null, plannedReleaseLocal: V.loc(x, r.PLANNED_RELEASE_AT), tanks: (r.UNIT_IDS || []).length }));
    out.push({ customerOrderRef: od.CUSTOMER_ORDER_REF || null, customerName: od.CUSTOMER_NAME || null, priority: od.PRIORITY || null, routeVersion: l.ROUTE_VERSION || null, plannedBatches: pb,
      complete: good >= l.REQUIRED_GOOD_QTY, orderId: l.ORDER_ID, orderLineId: l.ORDER_LINE_ID, productId: l.PRODUCT_ID, requiredGoodQty: l.REQUIRED_GOOD_QTY, dueAt: l.DUE_AT, dueLocal: V.loc(x, l.DUE_AT), releaseAt: l.RELEASE_AT,
      goodCompleted: good, scrapped: scrap, wip, buckets: b, replacementPending: replPending, notYetReleased: Math.max(0, l.REQUIRED_GOOD_QTY - good - wip),
      reconciliation: `required ${l.REQUIRED_GOOD_QTY} = good ${good} + active WIP ${wip} + not yet released/replacement needed ${Math.max(0, l.REQUIRED_GOOD_QTY - good - wip)} (scrap ${scrap} counted separately, never as good)`,
      forecast: f ? { band: f.BAND, forecastGoodByDue: f.FORECAST_GOOD_BY_DUE, shortfall: f.SHORTFALL, finishAt: f.FORECAST_FINISH_AT, finishLocal: V.loc(x, f.FORECAST_FINISH_AT), bufferDeadlineLocal: V.loc(x, f.BUFFER_DEADLINE_AT), basis: f.BASIS, computedAt: fc.COMPUTED_AT, kind: 'FORECAST' } : null });
  }
  out.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  return { session: header(x), lines: out, counting: 'Good = unique tanks route-complete (counted once, at the release of the final gate). Scrap never counts as good. A replacement satisfies existing demand and does not increase it.' };
}

async function orderLine(x, lineId) {
  const line = await x.db.collection('order_lines').findOne({ RUN_ID: x.src, ORDER_LINE_ID: lineId, $or: [{ SESSION_ID: null }, { SESSION_ID: x.sid }] }, { projection: { _seed: 0, _id: 0 } });
  if (!line) throw E.notFound('Order line');
  const batches = await x.db.collection('production_batches').find({ RUN_ID: x.src, ORDER_LINE_ID: lineId, $or: [{ SESSION_ID: null }, { SESSION_ID: x.sid }] }, { projection: { _seed: 0, _id: 0 } }).toArray();
  const hUnits = await x.db.collection('unit_master').find({ RUN_ID: x.src, ORDER_LINE_ID: lineId, KNOWN_AT: { $lte: x.histCut } }, { projection: { _seed: 0, _id: 0 } }).toArray();
  const sUnits = await V.sim(x, 'sim_units', { ORDER_LINE_ID: lineId });
  const terminalHist = await x.db.collection('production_events').find({ RUN_ID: x.src, ORDER_LINE_ID: lineId, EVENT_TYPE: { $in: ['ROUTE_COMPLETED', 'UNIT_SCRAPPED'] }, EVENT_TIME: { $lte: x.histCut }, KNOWN_AT: { $lte: x.histCut } }, { projection: { UNIT_ID: 1, EVENT_TYPE: 1, EVENT_TIME: 1 } }).toArray();
  const termBy = Object.fromEntries(terminalHist.map(e => [e.UNIT_ID, e]));
  const sBy = Object.fromEntries(sUnits.map(u => [u.UNIT_ID, u]));
  const ids = [...new Set([...hUnits.map(u => u.UNIT_ID), ...sUnits.map(u => u.UNIT_ID)])].sort();
  const tanks = ids.map(id => {
    const s = sBy[id], h = hUnits.find(u => u.UNIT_ID === id) || {};
    const t = termBy[id];
    const state = s ? s.STATE : (t ? (t.EVENT_TYPE === 'ROUTE_COMPLETED' ? 'ROUTE_COMPLETE' : 'SCRAPPED') : 'RELEASED_BEFORE_WINDOW');
    return { unitId: id, serial: (s || h).TANK_SERIAL_NO, batchId: (s || {}).BATCH_ID || h.INITIAL_BATCH_ID, state, bucket: bucketOf(state), routeStep: s ? s.ROUTE_STEP : null, workCenterId: s ? s.CURRENT_WORK_CENTER_ID : null,
      replacementFor: (s || h).REPLACEMENT_FOR_UNIT_ID || null, replacedBy: s ? s.REPLACED_BY_UNIT_ID || null : null };
  });
  const byBatch = {};
  for (const t of tanks) (byBatch[t.batchId] = byBatch[t.batchId] || []).push(t);
  const children = await V.sim(x, 'sim_batches', { ORDER_LINE_ID: lineId });
  const allBatches = [...batches.map(b => ({ ...b, source: 'HISTORY_PLAN' })), ...children.map(b => ({ ...b, source: 'SESSION_SPLIT' }))];
  // good output = uniquely accepted route-complete tanks; scrap never counts; a replacement satisfies the demand of the tank it replaces
  const summary = (b) => {
    const ts = byBatch[b.BATCH_ID] || [];
    const good = ts.filter(t => t.state === 'ROUTE_COMPLETE');
    const scrapped = ts.filter(t => t.state === 'SCRAPPED');
    const replacements = ts.filter(t => t.replacementFor);
    const demand = b.PLANNED_QTY ?? null;
    return { demandQty: demand, goodQty: good.length, goodFromReplacements: good.filter(t => t.replacementFor).length, scrappedQty: scrapped.length,
      activeQty: ts.filter(t => !['ROUTE_COMPLETE', 'SCRAPPED', 'RELEASED_BEFORE_WINDOW'].includes(t.state)).length, replacementTanks: replacements.map(t => ({ unitId: t.unitId, replaces: t.replacementFor, state: t.state })),
      stillNeeded: demand === null ? null : Math.max(0, demand - good.length), mixedStates: new Set(ts.map(t => t.state)).size > 1,
      explanation: demand === null ? `good ${good.length}` : `good ${good.length} of ${demand} demanded (scrap ${scrapped.length} never counts as good${replacements.length ? `; ${replacements.length} replacement tank(s) carry the scrapped tanks' demand` : ''})` };
  };
  const membership = await V.sim(x, 'sim_batch_membership', { UNIT_ID: { $in: ids } }, { sort: { VALID_FROM: 1 } });
  return { session: header(x), line, batches: allBatches.map(b => ({ ...b, tanks: byBatch[b.BATCH_ID] || [], counts: countBuckets(byBatch[b.BATCH_ID] || []), summary: summary(b) })),
    extraTanks: tanks.filter(t => !allBatches.some(b => b.BATCH_ID === t.batchId)), totals: countBuckets(tanks),
    goodTotal: tanks.filter(t => t.state === 'ROUTE_COMPLETE').length, requiredGoodQty: line.REQUIRED_GOOD_QTY,
    membershipHistory: membership.map(m => ({ unitId: m.UNIT_ID, batchId: m.BATCH_ID, parentBatchId: m.PARENT_BATCH_ID, from: m.VALID_FROM, to: m.VALID_TO, reason: m.MEMBERSHIP_REASON })),
    hierarchy: 'Work order -> order line -> production batch -> physical tank -> operation attempt' };
}
function countBuckets(ts) { const c = {}; for (const t of ts) c[t.bucket] = (c[t.bucket] || 0) + 1; return c; }

async function passport(x, unitId) {
  const s = await V.simOne(x, 'sim_units', { UNIT_ID: unitId });
  const h = await x.db.collection('unit_master').findOne({ RUN_ID: x.src, UNIT_ID: unitId, KNOWN_AT: { $lte: x.histCut } }, { projection: { _seed: 0, _id: 0 } });
  if (!s && !h) throw E.notFound('Tank');
  const q = { RUN_ID: x.src, UNIT_ID: unitId };
  const proj = { projection: { _seed: 0, _id: 0, dataset_id: 0, _origin: 0 } };
  const [hOps, hIns, hRead, hDisp, hDef, hEv, hRet, hHold, hCrew] = await Promise.all([
    x.db.collection('operation_instances').find({ ...q, CREATED_AT: { $lte: x.histCut } }, proj).toArray(),
    x.db.collection('inspection_header').find({ ...q, KNOWN_AT: { $lte: x.histCut } }, proj).toArray(),
    x.db.collection('inspection_readings').find({ ...q, KNOWN_AT: { $lte: x.histCut } }, proj).toArray(),
    x.db.collection('quality_dispositions').find({ ...q, KNOWN_AT: { $lte: x.histCut } }, proj).toArray(),
    x.db.collection('defect_records').find({ ...q, KNOWN_AT: { $lte: x.histCut } }, proj).toArray(),
    x.db.collection('production_events').find({ ...q, EVENT_TIME: { $lte: x.histCut }, KNOWN_AT: { $lte: x.histCut } }, proj).sort({ EVENT_TIME: 1 }).toArray(),
    x.db.collection('return_movements').find({ ...q, KNOWN_AT: { $lte: x.histCut } }, proj).toArray(),
    x.db.collection('hold_cases').find({ ...q, KNOWN_AT: { $lte: x.histCut } }, proj).toArray(),
    x.db.collection('operation_crew').find({ ...q, KNOWN_AT: { $lte: x.histCut } }, proj).toArray(),
  ]);
  const [sOps, sIns, sRead, sDisp, sDef, sEv, sRet, sHold, sInv, sEvid] = await Promise.all([
    V.sim(x, 'sim_operations', { UNIT_ID: unitId }), V.sim(x, 'sim_inspections', { UNIT_ID: unitId }), V.sim(x, 'sim_readings', { UNIT_ID: unitId }), V.sim(x, 'sim_dispositions', { UNIT_ID: unitId }),
    V.sim(x, 'sim_defects', { UNIT_ID: unitId }), V.sim(x, 'sim_events', { ENTITY_ID: unitId }, { sort: { EVENT_SEQ: 1 } }), V.sim(x, 'sim_returns', { UNIT_ID: unitId }), V.sim(x, 'sim_holds', { UNIT_ID: unitId }),
    V.sim(x, 'sim_investigations', { UNIT_ID: unitId }), V.sim(x, 'sim_evidence', { UNIT_ID: unitId }),
  ]);
  const crewBy = {};
  for (const c of hCrew) (crewBy[c.OPERATION_INSTANCE_ID] = crewBy[c.OPERATION_INSTANCE_ID] || new Set()).add(c.WORKER_ID);
  const sessOpIds = new Set(sOps.map(o => o.OPERATION_INSTANCE_ID));
  const sTasks = await V.sim(x, 'sim_tasks', { UNIT_ID: unitId });
  for (const t of sTasks) (crewBy[t.OPERATION_INSTANCE_ID] = crewBy[t.OPERATION_INSTANCE_ID] || new Set()).add(t.WORKER_ID);
  const attempts = [
    ...hOps.filter(o => !sessOpIds.has(o.OPERATION_INSTANCE_ID)).map(o => ({ source: 'HISTORY', operationInstanceId: o.OPERATION_INSTANCE_ID, operationId: o.OPERATION_ID, kind: o.OPERATION_KIND, attemptNo: o.ATTEMPT_NO, instanceType: o.INSTANCE_TYPE, workstationId: o.WORKSTATION_ID,
      createdAt: o.CREATED_AT, startedAt: o.STARTED_AT && new Date(o.STARTED_AT) <= x.histCut ? o.STARTED_AT : null, finishedAt: o.FINISHED_AT && new Date(o.FINISHED_AT) <= x.histCut ? o.FINISHED_AT : null, reworkOf: o.REWORK_OF_OPERATION_INSTANCE_ID || null,
      instructionVersionId: o.INSTRUCTION_VERSION_ID || null, crew: [...(crewBy[o.OPERATION_INSTANCE_ID] || [])].map(w => ({ workerId: w, name: V.name(x, w) })) })),
    ...sOps.map(o => ({ source: o.ORIGIN === 'INHERITED_AT_FORK' ? 'HISTORY+SESSION' : 'SESSION', operationInstanceId: o.OPERATION_INSTANCE_ID, operationId: o.OPERATION_ID, kind: o.OPERATION_KIND, attemptNo: o.ATTEMPT_NO, instanceType: o.INSTANCE_TYPE, workstationId: o.WORKSTATION_ID,
      createdAt: o.CREATED_AT, startedAt: o.STARTED_AT, finishedAt: o.WORK_COMPLETED_AT || null, state: o.STATE, reworkOf: o.REWORK_OF_OPERATION_INSTANCE_ID || null, reworkStandard: o.REWORK_STANDARD ? { ...o.REWORK_STANDARD, minutes: o.REWORK_STANDARD_LABOR_MIN } : null, instructionVersionId: o.INSTRUCTION_VERSION_ID, milestones: o.MILESTONES_DONE || [],
      crew: [...(crewBy[o.OPERATION_INSTANCE_ID] || [])].map(w => ({ workerId: w, name: V.name(x, w) })) })),
  ].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const inspections = [
    ...hIns.map(i => ({ source: 'HISTORY', inspectionId: i.INSPECTION_ID, gate: i.GATE_OPERATION_ID, inspectorId: i.INSPECTOR_ID, inspector: V.name(x, i.INSPECTOR_ID), attemptNo: i.ATTEMPT_NO, result: i.RESULT, trigger: i.INSPECTION_TRIGGER || null, completedAt: i.COMPLETED_AT, knownAt: i.KNOWN_AT, entryLagMin: i.ENTRY_LAG_MIN,
      readings: hRead.filter(r => r.INSPECTION_ID === i.INSPECTION_ID).map(r => ({ checkId: r.CHECK_ID, position: r.MEASUREMENT_POSITION, value: r.NUMERIC_VALUE, text: r.TEXT_ANSWER, unit: r.MEASUREMENT_UNIT, result: r.CHECK_RESULT, status: r.READING_STATUS })), photoEvidence: i.PHOTO_EVIDENCE_REF || null })),
    ...sIns.map(i => ({ source: 'SESSION', inspectionId: i.INSPECTION_ID, kind: i.INSPECTION_KIND, gate: i.GATE_OPERATION_ID, inspectorId: i.INSPECTOR_ID, inspector: V.name(x, i.INSPECTOR_ID), attemptNo: i.ATTEMPT_NO, status: i.STATUS, result: i.RESULT || null, trigger: i.INSPECTION_TRIGGER,
      reinspectionOf: i.REINSPECTION_OF_INSPECTION_ID, completedAt: i.COMPLETED_AT || null, knownAt: i.KNOWN_AT || null, entryLagMin: i.ENTRY_LAG_MIN || null, checkResults: i.CHECK_RESULTS || [],
      readings: sRead.filter(r => r.INSPECTION_ID === i.INSPECTION_ID).map(r => ({ checkId: r.CHECK_ID, position: r.MEASUREMENT_POSITION, value: r.NUMERIC_VALUE, text: r.TEXT_ANSWER, unit: r.MEASUREMENT_UNIT, lower: r.LOWER_LIMIT, upper: r.UPPER_LIMIT, result: r.CHECK_RESULT })),
      evidence: sEvid.filter(e => e.INSPECTION_ID === i.INSPECTION_ID).map(e => ({ evidenceId: e.EVIDENCE_ID, status: e.UPLOAD_STATUS, capturedAt: e.CAPTURED_AT, supersedes: e.SUPERSEDES_EVIDENCE_ID || null, synthetic: !!e.SYNTHETIC_FIXTURE })) })),
  ].sort((a, b) => new Date(a.completedAt || a.knownAt || 0) - new Date(b.completedAt || b.knownAt || 0));
  const events = [
    ...hEv.map(e => ({ source: 'HISTORY', at: e.EVENT_TIME, local: V.loc(x, e.EVENT_TIME), knownAt: e.KNOWN_AT, type: e.EVENT_TYPE, workCenterId: e.TO_WORK_CENTER_ID || e.FROM_WORK_CENTER_ID, workstationId: e.WORKSTATION_ID, state: e.UNIT_STATE_AFTER, reason: e.REASON_CODE })),
    ...sEv.map(e => ({ source: 'SESSION', at: e.EVENT_TIME, local: V.loc(x, e.EVENT_TIME), knownAt: e.KNOWN_AT, type: e.EVENT_TYPE, state: (e.PAYLOAD || {}).TO_STATE, workCenterId: (e.PAYLOAD || {}).WORK_CENTER_ID, workstationId: (e.PAYLOAD || {}).WORKSTATION_ID, actor: e.ACTOR_ID, reason: (e.PAYLOAD || {}).REASON || null })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));
  const unit = s ? V.mapUnit(x, s) : { unitId: h.UNIT_ID, serial: h.TANK_SERIAL_NO, productId: h.PRODUCT_ID, orderId: h.ORDER_ID, orderLineId: h.ORDER_LINE_ID, batchId: h.INITIAL_BATCH_ID, state: 'NOT_IN_ACTIVE_WINDOW', replacementForUnitId: h.REPLACEMENT_FOR_UNIT_ID };
  return { session: header(x), unit, identity: { unitId: unitId, serial: (s || h).TANK_SERIAL_NO, drawing: h ? `${h.DRAWING_REF || ''} rev ${h.DRAWING_REVISION || ''}` : (s && s.DRAWING_REVISION), materialLot: h ? h.MATERIAL_LOT_ID : null, createdAt: h ? h.CREATED_AT : s.CREATED_AT, replacementFor: (s || h).REPLACEMENT_FOR_UNIT_ID || null, replacedBy: s ? s.REPLACED_BY_UNIT_ID || null : null },
    attempts, inspections, dispositions: [...hDisp.map(d => ({ ...d, source: 'HISTORY' })), ...sDisp.map(d => ({ ...d, source: 'SESSION' }))], defects: [...hDef.map(d => ({ ...d, source: 'HISTORY' })), ...sDef.map(d => ({ ...d, source: 'SESSION' }))],
    investigations: sInv, returns: [...hRet.map(d => ({ ...d, source: 'HISTORY' })), ...sRet.map(d => ({ ...d, source: 'SESSION' }))], holds: [...hHold.map(d => ({ ...d, source: 'HISTORY' })), ...sHold.map(d => ({ ...d, source: 'SESSION' }))], events,
    note: 'History shows only records known at the fork (or at replay time). Detection location and participation are recorded separately from any confirmed cause.' };
}

async function quality(x) {
  const [holds, returns, inv, ins, disp, defects] = await Promise.all([
    V.sim(x, 'sim_holds', { RESOLUTION: { $in: ['OPEN', 'PENDING_REVIEW'] } }), V.sim(x, 'sim_returns', {}, { sort: { DETECTED_AT: -1 }, limit: 100 }), V.sim(x, 'sim_investigations', {}, { sort: { OPENED_AT: -1 }, limit: 100 }),
    V.sim(x, 'sim_inspections', {}, { sort: { STARTED_AT: -1 }, limit: 60 }), V.sim(x, 'sim_dispositions', {}, { sort: { DECIDED_AT: -1 }, limit: 60 }), V.sim(x, 'sim_defects', {}, { sort: { DETECTED_AT: -1 }, limit: 100 }),
  ]);
  const unitIds = [...new Set(holds.map(h => h.UNIT_ID))];
  const units = unitIds.length ? await V.sim(x, 'sim_units', { UNIT_ID: { $in: unitIds } }) : [];
  const uBy = Object.fromEntries(units.map(u => [u.UNIT_ID, u]));
  const holdRows = [];
  for (const h of holds) {
    const defs = defects.filter(d => (h.DEFECT_IDS || []).includes(d.DEFECT_ID));
    const code = (defs[0] || {}).DEFECT_CODE || 'UNCLASSIFIED';
    const rule = C.dispositionRule(x.cat, x.session.DISPOSITION_POLICY_ID, h.DETECTION_POINT || h.GATE_OPERATION_ID, code);
    holdRows.push({ holdId: h.HOLD_ID, unitId: h.UNIT_ID, serial: (uBy[h.UNIT_ID] || {}).TANK_SERIAL_NO, type: h.HOLD_TYPE, since: h.HOLD_STARTED_AT, sinceLocal: V.loc(x, h.HOLD_STARTED_AT), location: h.HOLD_LOCATION, locationType: h.HOLD_LOCATION_TYPE,
      detectionPoint: h.DETECTION_POINT || h.GATE_OPERATION_ID, defectIds: h.DEFECT_IDS || [], defects: defs.map(d => ({ defectId: d.DEFECT_ID, code: d.DEFECT_CODE, checkId: d.CHECK_ID, description: d.DESCRIPTION })),
      resolution: h.RESOLUTION, origin: h.ORIGIN, matrix: rule ? { disposition: rule.DISPOSITION, destinationRule: rule.RETURN_DESTINATION_RULE, retainAtStation: rule.RETAIN_AT_STATION, escalateAfter: rule.ESCALATE_AFTER_FAILED_REINSPECTIONS, status: rule.STATUS } : { disposition: 'NO_MATRIX_ENTRY', note: 'Stays on hold until a named approver decides with a reason' },
      originOperationInstanceId: h.ORIGIN_OPERATION_INSTANCE_ID || null, unitState: (uBy[h.UNIT_ID] || {}).STATE });
  }
  const replacements = await V.sim(x, 'sim_replacements', {}, { sort: { REQUESTED_AT: -1 }, limit: 50 });
  return { session: header(x), policyId: x.session.DISPOSITION_POLICY_ID, holds: holdRows, replacements,
    returns: returns.map(r => ({ ...r, detectedLocal: V.loc(x, r.DETECTED_AT) })), investigations: inv, inspections: ins.map(i => ({ inspectionId: i.INSPECTION_ID, unitId: i.UNIT_ID, gate: i.GATE_OPERATION_ID, kind: i.INSPECTION_KIND, status: i.STATUS, result: i.RESULT || null, inspector: V.name(x, i.INSPECTOR_ID), startedAt: i.STARTED_AT, completedAt: i.COMPLETED_AT, entryLagMin: i.ENTRY_LAG_MIN || null })),
    dispositions: disp, defects, note: 'Disposition and blame are independent: returning a tank to its origin station is not a finding about who caused the defect.' };
}

async function inspection(x, inspectionId) {
  const i = await V.simOne(x, 'sim_inspections', { INSPECTION_ID: inspectionId });
  if (!i) throw E.notFound('Inspection');
  const list = i.CHECKLIST_SNAPSHOT && i.CHECKLIST_SNAPSHOT.length ? i.CHECKLIST_SNAPSHOT : C.checklist(x.cat, i.GATE_OPERATION_ID, i.PRODUCT_ID);
  const unit = await V.simOne(x, 'sim_units', { UNIT_ID: i.UNIT_ID });
  const evid = await V.sim(x, 'sim_evidence', { $or: [{ INSPECTION_ID: inspectionId }, { DRAFT_INSPECTION_ID: inspectionId }] });
  const readings = i.STATUS === 'SUBMITTED' ? await V.sim(x, 'sim_readings', { INSPECTION_ID: inspectionId }) : [];
  return { session: header(x), inspection: { inspectionId: i.INSPECTION_ID, unitId: i.UNIT_ID, serial: unit && unit.TANK_SERIAL_NO, gate: i.GATE_OPERATION_ID, kind: i.INSPECTION_KIND, status: i.STATUS, result: i.RESULT || null,
    inspectorId: i.INSPECTOR_ID, inspector: V.name(x, i.INSPECTOR_ID), attemptNo: i.ATTEMPT_NO, trigger: i.INSPECTION_TRIGGER, reinspectionOf: i.REINSPECTION_OF_INSPECTION_ID, checklistVersion: i.CHECKLIST_VERSION,
    draftAnswers: i.DRAFT_ANSWERS || {}, answers: i.ANSWERS || null, comment: i.COMMENT || i.DRAFT_COMMENT || null, draftSavedAt: i.DRAFT_SAVED_AT || null, checkResults: i.CHECK_RESULTS || [], version: i.VERSION, startedAt: i.STARTED_AT, completedAt: i.COMPLETED_AT || null,
    evidenceIds: i.EVIDENCE_IDS || i.DRAFT_EVIDENCE_IDS || [] },
    checklist: list.map(({ check, specs }) => ({ checkId: check.CHECK_ID, version: check.CHECK_VERSION, section: check.SECTION, group: check.QUESTION_GROUP, requirement: check.REQUIREMENT_TEXT, question: check.QUESTION_TEXT,
      answerType: check.ANSWER_TYPE, failureAnswer: check.FAILURE_ANSWER, instrument: check.INSTRUMENT_TYPE, evidenceRequired: (check.PHOTO_REQUIRED === true || ['PHOTO', 'Y'].includes(check.EVIDENCE_REQUIRED)) ? 'Y' : 'N', photoOnFail: !!x.session.FACTORY_SESSION && check.EVIDENCE_REQUIRED === 'ON_FAILURE_ANSWER', mandatory: (check.MANDATORY_FLAG || 'Y') === 'Y',
      originalToleranceText: check.ORIGINAL_TOLERANCE_TEXT, interpretationNote: check.INTERPRETATION_NOTE, source: `${check.SOURCE_FILE || ''} / ${check.SOURCE_SHEET || ''} row ${check.SOURCE_ROW || ''}`,
      specs: specs.map(s => ({ specId: s.SPEC_ID, position: s.MEASUREMENT_POSITION, unit: s.MEASUREMENT_UNIT, nominal: s.NOMINAL_VALUE, lower: s.LOWER_LIMIT, upper: s.UPPER_LIMIT, readings: s.REQUIRED_READING_COUNT || 1, specSource: s.SPEC_SOURCE })) })),
    readings: readings.map(r => ({ checkId: r.CHECK_ID, position: r.MEASUREMENT_POSITION, sampleNo: r.SAMPLE_NO, value: r.NUMERIC_VALUE, text: r.TEXT_ANSWER, result: r.CHECK_RESULT })),
    evidence: evid.map(e => ({ evidenceId: e.EVIDENCE_ID, checkId: e.CHECK_ID, status: e.UPLOAD_STATUS, capturedAt: e.CAPTURED_AT, bytes: e.BYTES, width: e.WIDTH, height: e.HEIGHT, mime: e.MIME, supersedes: e.SUPERSEDES_EVIDENCE_ID || null, supersededBy: e.SUPERSEDED_BY || null, synthetic: !!e.SYNTHETIC_FIXTURE })),
    checklistPinned: !!(i.CHECKLIST_SNAPSHOT && i.CHECKLIST_SNAPSHOT.length),
    limitsNote: x.session.FACTORY_SESSION ? `Checklist version ${i.CHECKLIST_VERSION || '?'} as it was when this inspection started; limits were entered by the factory administrator${list.some(l => l.check.ILLUSTRATIVE) ? ' (ILLUSTRATIVE template - unconfirmed, not Siemens tolerances)' : ''}.`
      : 'Numeric limits are synthetic demo specifications (SPEC_SOURCE = SYNTHETIC_ASSUMPTION), not Siemens tolerances. Question wording is preserved from the supplied CTQ guide.' };
}

async function alerts(x, q) {
  const f = {};
  if (q.state) f.EVALUATION_STATE = q.state;
  if (q.open === '1') f.EVALUATION_STATE = { $in: ['PENDING', 'FIRING', 'RECOVERING', 'NO_DATA', 'INSUFFICIENT_DATA'] };
  const rows = await V.sim(x, 'sim_alerts', f, { sort: { UPDATED_AT: -1 }, limit: 200 });
  const transitions = q.alertId ? await V.sim(x, 'sim_alert_transitions', { ALERT_ID: q.alertId }, { sort: { AT: 1 } }) : [];
  const notif = await x.db.collection('notifications').find({ SESSION_ID: x.sid, ...(q.alertId ? { ALERT_ID: q.alertId } : {}) }, { projection: { BODY: 0 } }).sort({ CREATED_AT: -1 }).limit(30).toArray();
  const evalProj = await latestProjection(x, 'RULE_EVALUATION');
  return { session: header(x), freshness: V.freshness(x), alerts: rows.map(mapAlert(x)), transitions, notifications: notif.map(n => ({ notificationId: n.NOTIFICATION_ID, alertId: n.ALERT_ID, episodeId: n.EPISODE_ID || null, transition: n.TRANSITION, status: n.STATUS, attempts: n.ATTEMPTS, recipients: n.RECIPIENTS, createdAt: n.CREATED_AT, sentAt: n.SENT_AT || null, messageId: n.PROVIDER_MESSAGE_ID || null, error: n.LAST_ERROR || null, suppressedReason: n.SUPPRESSED_REASON || null })),
    ruleEvaluation: evalProj ? { computedAt: evalProj.COMPUTED_AT, rules: evalProj.DATA } : null,
    note: 'Evaluation state (NORMAL/PENDING/FIRING/RECOVERING/RESOLVED/NO_DATA) is separate from workflow (UNACKNOWLEDGED/ACKNOWLEDGED/IN_PROGRESS/CLOSED). Acknowledging is not resolving.' };
}

async function forecasts(x) {
  const fc = await latestProjection(x, 'ORDER_FORECAST_SUMMARY');
  const wc = await latestProjection(x, 'WORK_CENTER_SUMMARY');
  const rec = await V.sim(x, 'sim_forecasts', {}, { sort: { CREATED_AT: -1 }, limit: 5 });
  return { session: header(x), freshness: V.freshness(x), orders: fc ? fc.DATA : [], ordersComputedAt: fc ? fc.COMPUTED_AT : null, ordersAsOf: fc ? fc.AS_OF : null, method: fc ? fc.METHOD : null,
    workCenters: wc ? wc.DATA : {}, recovery: rec.map(r => ({ forecastId: r.FORECAST_ID, orderLineId: r.ORDER_LINE_ID, asOf: r.AS_OF, asOfLocal: V.loc(x, r.AS_OF), createdAt: r.CREATED_AT, baseline: r.BASELINE, options: r.OPTIONS, method: r.METHOD, inputWatermark: r.INPUT_WATERMARK, stale: (x.session.EVENT_SEQ || 0) > (r.INPUT_WATERMARK || 0) })) };
}

async function actions(x) {
  const rows = await V.sim(x, 'sim_actions', {}, { sort: { PROPOSED_AT: -1 }, limit: 50 });
  const out = [];
  for (const a of rows) {
    const transfers = await V.sim(x, 'sim_transfers', { ACTION_ID: a.ACTION_ID });
    const verify = await V.projection(x, 'ACTION_VERIFICATION', a.ACTION_ID);
    out.push({ ...a, transfers, verification: verify ? verify.DATA : null });
  }
  return { session: header(x), actions: out, note: 'Preview is not execution. Before/after forecasts are immutable; actual outcomes are recorded separately.' };
}

async function materials(x) {
  const mats = await V.sim(x, 'sim_materials', {});
  const reqs = await V.sim(x, 'sim_material_requests', {}, { sort: { NEED_BY_AT: 1 } });
  const ev = await V.sim(x, 'sim_events', { ENTITY_TYPE: 'MATERIAL' }, { sort: { EVENT_SEQ: -1 }, limit: 50 });
  const eqs = await V.sim(x, 'sim_equipment', {});
  return { session: header(x), materials: mats.map(m => ({ materialId: m.MATERIAL_ID, name: m.MATERIAL_NAME, uom: m.UOM, onHand: m.ON_HAND_QTY, hold: m.HOLD_QTY || 0, reserved: m.RESERVED_QTY || 0, available: Math.round((Number(m.ON_HAND_QTY || 0) - Number(m.HOLD_QTY || 0) - Number(m.RESERVED_QTY || 0)) * 1000) / 1000, shortageReason: m.SHORTAGE_REASON || null, supplyAvailableAt: m.SUPPLY_AVAILABLE_AT && new Date(m.SUPPLY_AVAILABLE_AT) > x.now ? m.SUPPLY_AVAILABLE_AT : null, supplyAvailableLocal: m.SUPPLY_AVAILABLE_AT && new Date(m.SUPPLY_AVAILABLE_AT) > x.now ? V.loc(x, m.SUPPLY_AVAILABLE_AT) : null, version: m.VERSION })),
    requests: reqs.map(r => ({ ...r, needByLocal: V.loc(x, r.NEED_BY_AT), promisedLocal: V.loc(x, r.PROMISED_AT), late: r.STATUS !== 'DELIVERED' && r.STATUS !== 'CANCELLED' && r.NEED_BY_AT && new Date(r.NEED_BY_AT) < x.now, outstanding: Math.max(0, Number(r.QTY || 0) - Number(r.DELIVERED_QTY || 0)) })),
    movements: ev.map(e => ({ at: e.EVENT_TIME, local: V.loc(x, e.EVENT_TIME), type: e.EVENT_TYPE, materialId: e.ENTITY_ID, payload: e.PAYLOAD })),
    equipment: eqs.map(e => ({ equipmentId: e.EQUIPMENT_ID, workstationId: e.WORKSTATION_ID, workCenterId: e.WORK_CENTER_ID, status: e.STATUS, since: e.SINCE, sinceLocal: V.loc(x, e.SINCE), reason: e.REASON_CODE, estimatedRecoveryAt: e.ESTIMATED_RECOVERY_AT, estimatedRecoveryLocal: V.loc(x, e.ESTIMATED_RECOVERY_AT), version: e.VERSION })) };
}

async function events(x, q) {
  const since = Number(q.since || 0);
  const rows = await V.sim(x, 'sim_events', { EVENT_SEQ: { $gt: since } }, { sort: { EVENT_SEQ: 1 }, limit: Math.min(500, Number(q.limit || 200)) });
  return { session: header(x), freshness: V.freshness(x), cursor: rows.length ? rows[rows.length - 1].EVENT_SEQ : since,
    events: rows.map(e => ({ seq: e.EVENT_SEQ, eventId: e.EVENT_ID, type: e.EVENT_TYPE, entityType: e.ENTITY_TYPE, entityId: e.ENTITY_ID, at: e.EVENT_TIME, local: V.loc(x, e.EVENT_TIME), knownAt: e.KNOWN_AT, receivedAt: e.RECEIVED_AT, actor: e.ACTOR_ID, actorType: e.ACTOR_TYPE, payload: e.PAYLOAD })) };
}

async function supportRequests(x) {
  const rows = await V.sim(x, 'sim_support_requests', {}, { sort: { REQUESTED_AT: -1 }, limit: 50 });
  return { session: header(x), requests: rows.map(r => ({ ...r, requester: V.name(x, r.REQUESTED_BY), requestedLocal: V.loc(x, r.REQUESTED_AT) })) };
}

module.exports = { overview, workforce, workerDetail, workCenter, orders, orderLine, passport, quality, inspection, alerts, forecasts, actions, materials, events, supportRequests, header, bucketOf, WIP };
