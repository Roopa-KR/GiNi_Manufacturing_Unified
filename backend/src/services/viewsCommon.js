'use strict';
/* Shared read helpers: session scoping, history-as-known-at, contract mapping (uppercase workbook columns -> camelCase API fields, documented in contracts/api-mapping.md). */
const { getDb } = require('../lib/db');
const { simNow, localIso, PLANT_TZ } = require('../lib/time');
const C = require('../domain/catalog');

async function ctx(session) {
  const db = await getDb();
  const now = simNow(session);
  const histCut = session.MODE === 'REPLAY' ? now : (new Date(session.FORK_AT) < now ? new Date(session.FORK_AT) : now);
  const cat = await C.catalog();
  const eng = await db.collection('engine_workers').find({}, { projection: { HEARTBEAT_AT: 1 } }).sort({ HEARTBEAT_AT: -1 }).limit(1).toArray();
  return { db, session, now, histCut, cat, sid: session.SESSION_ID, src: session.SOURCE_RUN_ID, tz: session.PLANT_TIMEZONE || PLANT_TZ, engineHeartbeatAt: eng[0] ? eng[0].HEARTBEAT_AT : null };
}
const sim = (x, coll, filter = {}, opts = {}) => {
  let cur = x.db.collection(coll).find({ SESSION_ID: x.sid, ...filter }, { projection: opts.projection });
  if (opts.sort) cur = cur.sort(opts.sort);
  if (opts.skip) cur = cur.skip(opts.skip);
  if (opts.limit) cur = cur.limit(opts.limit);
  return cur.toArray();
};
const simOne = (x, coll, filter) => x.db.collection(coll).findOne({ SESSION_ID: x.sid, ...filter });
/** latest PUBLISHED engine projection (never a half-written newer calculation pass) */
async function projection(x, kind, entityId) {
  const f = { SESSION_ID: x.sid, KIND: kind, PROJECTION_VERSION: { $lte: x.session.PROJECTION_VERSION || 0 } };
  if (entityId !== undefined && entityId !== null) f.ENTITY_ID = entityId;
  const rows = await x.db.collection('sim_projections').find(f).sort({ PROJECTION_VERSION: -1 }).limit(1).toArray();
  return rows[0] || null;
}
/** boundary between counts captured at initialisation (fork or replay projection time) and session completions */
function goodBoundary(x) { return new Date((x.session.INIT || {}).AS_OF || x.session.FORK_AT); }
/** history rows of the source run known at the cut (EVENT_TIME/anchor <= cut AND KNOWN_AT <= cut) */
const hist = (x, coll, filter = {}, timeField = 'EVENT_TIME', opts = {}) => {
  const f = { RUN_ID: x.src, ...filter };
  if (timeField) f[timeField] = { ...(f[timeField] || {}), $lte: x.histCut };
  if (opts.knownAt !== false) f.KNOWN_AT = { $lte: x.histCut };
  let cur = x.db.collection(coll).find(f, { projection: { _seed: 0, _id: 0, dataset_id: 0, _origin: 0 } });
  if (opts.sort) cur = cur.sort(opts.sort);
  if (opts.limit) cur = cur.limit(opts.limit);
  return cur.toArray();
};

function loc(x, d) { return d ? localIso(d, x.tz) : null; }
function name(x, wid) { const w = x.cat.workers[wid]; return w ? w.DISPLAY_NAME : wid; }

function plantState(w) {
  // single display value by precedence (WORKER_STATE_MODEL): off-shift > absent > not clocked in > activity
  if (!w) return 'UNKNOWN';
  if (w.ATTENDANCE_STATE === 'ABSENT') return 'ABSENT';
  if (w.ATTENDANCE_STATE === 'OFF_SHIFT' || w.ACTIVITY_STATE === 'OFF_SHIFT') return 'OFF_SHIFT';
  if (['NOT_CLOCKED_IN', 'NOT_RECORDED'].includes(w.ATTENDANCE_STATE) && !['WORKING', 'INSPECTING', 'REPAIRING'].includes(w.ACTIVITY_STATE)) return 'NOT_CLOCKED_IN';
  if (w.ATTENDANCE_STATE === 'CLOCKED_OUT') return 'OFF_SHIFT';
  return w.ACTIVITY_STATE || 'UNKNOWN';
}

function mapWorker(x, w) {
  return {
    workerId: w.WORKER_ID, name: w.DISPLAY_NAME || name(x, w.WORKER_ID), role: w.WORKER_ROLE, homeWorkCenterId: w.HOME_WORK_CENTER_ID, shiftId: w.SHIFT_ID, rosterStatus: w.ROSTER_STATUS,
    attendance: w.ATTENDANCE_STATE, activity: w.ACTIVITY_STATE, plantState: plantState(w), reason: w.REASON_CODE, currentTaskId: w.CURRENT_TASK_ID, currentOperationInstanceId: w.CURRENT_OPERATION_INSTANCE_ID,
    workstationId: w.CURRENT_WORKSTATION_ID, workCenterId: w.CURRENT_WORK_CENTER_ID, tempWorkCenterId: w.TEMP_WORK_CENTER_ID || null, firstClockInAt: w.FIRST_CLOCK_IN_AT, firstClockInLocal: loc(x, w.FIRST_CLOCK_IN_AT),
    plannedStartAt: w.PLANNED_START_AT, plannedEndAt: w.PLANNED_END_AT, plannedStartLocal: loc(x, w.PLANNED_START_AT), plannedEndLocal: loc(x, w.PLANNED_END_AT), stateSince: w.STATE_SINCE,
    lastActivityAt: w.LAST_ACTIVITY_AT, control: w.CONTROL || { MODE: 'AGENT' }, transferArriveAt: w.TRANSFER_ARRIVE_AT || null, version: w.VERSION, origin: w.ORIGIN,
    nextShiftId: w.NEXT_SHIFT_ID || null, nextPlannedStartLocal: loc(x, w.NEXT_PLANNED_START_AT),
  };
}
function mapUnit(x, u) {
  return {
    unitId: u.UNIT_ID, serial: u.TANK_SERIAL_NO, productId: u.PRODUCT_ID, orderId: u.ORDER_ID, orderLineId: u.ORDER_LINE_ID, batchId: u.BATCH_ID, state: u.STATE, routeStep: u.ROUTE_STEP,
    workCenterId: u.CURRENT_WORK_CENTER_ID, workstationId: u.CURRENT_WORKSTATION_ID, operationInstanceId: u.CURRENT_OPERATION_INSTANCE_ID, stateSince: u.STATE_SINCE, priorityClass: u.PRIORITY_CLASS,
    queueEnteredAt: u.QUEUE_ENTERED_AT, dueAt: u.DUE_AT, replacementForUnitId: u.REPLACEMENT_FOR_UNIT_ID || null, replacedByUnitId: u.REPLACED_BY_UNIT_ID || null, holdId: u.HOLD_ID || null,
    reworkPending: u.REWORK_PENDING || null, lastInspectionResult: u.LAST_INSPECTION_RESULT || null, routeCompletedAt: u.ROUTE_COMPLETED_AT || null, scrappedAt: u.SCRAPPED_AT || null,
    timingNote: u.TIMING_NOTE || null, origin: u.ORIGIN, version: u.VERSION, blockedArrival: !!u.BLOCKED_ARRIVAL, arriveAt: u.ARRIVE_AT || null, drawingRevision: u.DRAWING_REVISION || null,
  };
}
function mapOp(x, o) {
  return {
    operationInstanceId: o.OPERATION_INSTANCE_ID, unitId: o.UNIT_ID, operationId: o.OPERATION_ID, name: ((C.opDef(x.cat, o.PRODUCT_ID, o.OPERATION_ID) || {}).OPERATION_NAME) || null, kind: o.OPERATION_KIND, workCenterId: o.WORK_CENTER_ID, workstationId: o.WORKSTATION_ID, equipmentId: o.EQUIPMENT_ID,
    attemptNo: o.ATTEMPT_NO, instanceType: o.INSTANCE_TYPE, reworkStandard: o.REWORK_STANDARD ? { status: o.REWORK_STANDARD.STATUS, source: o.REWORK_STANDARD.SOURCE, standardId: o.REWORK_STANDARD.STANDARD_ID, version: o.REWORK_STANDARD.VERSION, approvedBy: o.REWORK_STANDARD.APPROVED_BY, minutes: o.REWORK_STANDARD_LABOR_MIN } : null, reworkOf: o.REWORK_OF_OPERATION_INSTANCE_ID || null, priorAttempt: o.PRIOR_ATTEMPT_OPERATION_INSTANCE_ID || null, instructionVersionId: o.INSTRUCTION_VERSION_ID,
    state: o.STATE, progressFraction: o.PROGRESS_FRACTION, crew: o.CREW || [], milestonesDone: o.MILESTONES_DONE || [], createdAt: o.CREATED_AT, startedAt: o.STARTED_AT, workCompletedAt: o.WORK_COMPLETED_AT || null,
    standardElapsedMin: o.STANDARD_ELAPSED_MIN, standardLaborMin: o.STANDARD_LABOR_MIN, minCrew: o.MIN_CREW_SIZE, stdCrew: o.STD_CREW_SIZE, maxCrew: o.MAX_CREW_SIZE, requiredSkillId: o.REQUIRED_SKILL_ID,
    blockedReason: o.BLOCKED_REASON || null, origin: o.ORIGIN, version: o.VERSION, forecastFinishAt: o.FORECAST_FINISH_AT || null,
  };
}

/** eligible actual labour minutes of a worker on one attempt: history segments before the fork + session segments (open segment up to now) */
async function eligibleMinutes(x, workerId, opId) {
  let hist = 0;
  if (x.session.MODE === 'INTERACTIVE' || x.session.MODE === 'REPLAY') {
    const segs = await x.db.collection('labor_segments').find({ RUN_ID: x.src, OPERATION_INSTANCE_ID: opId, WORKER_ID: workerId, SEGMENT_START: { $lte: x.histCut } }, { projection: { SEGMENT_START: 1, SEGMENT_END: 1, SEGMENT_PHASE: 1, TIME_POINTS_ELIGIBLE_SEGMENT: 1 } }).toArray();
    for (const s of segs) {
      if (!['NORMAL', 'REWORK', 'CORRECTION'].includes(s.SEGMENT_PHASE)) continue;
      const end = new Date(s.SEGMENT_END) < x.histCut ? new Date(s.SEGMENT_END) : x.histCut;
      hist += Math.max(0, (end - new Date(s.SEGMENT_START)) / 60000);
    }
  }
  let sess = 0;
  if (x.session.MODE === 'INTERACTIVE') {
    const segs = await sim(x, 'sim_participation', { WORKER_ID: workerId, OPERATION_INSTANCE_ID: opId, CATEGORY: { $in: ['DIRECT', 'REWORK'] } });
    for (const s of segs) sess += Math.max(0, ((s.END_AT ? new Date(s.END_AT) : x.now) - new Date(s.START_AT)) / 60000);
  }
  return { historyMin: Math.round(hist * 10) / 10, sessionMin: Math.round(sess * 10) / 10, totalMin: Math.round((hist + sess) * 10) / 10 };
}

/** points as known at the session's current time: history ledger (known at the cut) + session ledger */
async function pointsFor(x, workerId) {
  const h = await x.db.collection('points_ledger').find({ RUN_ID: x.src, WORKER_ID: workerId, KNOWN_AT: { $lte: x.histCut } }, { projection: { POINTS_CATEGORY: 1, POINTS_DELTA: 1, ATTRIBUTION_STATUS: 1 } }).toArray();
  const s = x.session.MODE === 'INTERACTIVE' ? await sim(x, 'sim_points_ledger', { WORKER_ID: workerId, KNOWN_AT: { $lte: x.now } }) : [];
  const sum = rows => rows.reduce((acc, r) => { acc[r.POINTS_CATEGORY || 'UNSPECIFIED'] = (acc[r.POINTS_CATEGORY || 'UNSPECIFIED'] || 0) + Number(r.POINTS_DELTA || 0); acc.TOTAL += Number(r.POINTS_DELTA || 0); return acc; }, { TOTAL: 0 });
  const hs = sum(h), ss = sum(s);
  const round = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  return { historyKnownAtCut: round(hs), session: round(ss), total: round({ QUALITY: (hs.QUALITY || 0) + (ss.QUALITY || 0), TIME: (hs.TIME || 0) + (ss.TIME || 0), TOTAL: hs.TOTAL + ss.TOTAL }),
    historyTransactions: h.length, sessionTransactions: s.length, basis: `History ledger known at ${x.histCut.toISOString()} + session ledger known at simulated now` };
}

function freshness(x) {
  const e = x.session.ENGINE || {};
  const lag = (x.session.EVENT_SEQ || 0) - (e.WATERMARK_SEQ || 0);
  const age = t => (t ? (Date.now() - new Date(t)) / 1000 : null);
  const worker = age(x.engineHeartbeatAt);            // any engine worker process alive?
  const lease = age(e.HEARTBEAT_AT);                  // is a worker advancing THIS session?
  const workerDown = worker === null || worker > 60;
  const notAdvanced = !workerDown && (lease === null || lease > 60);
  return { operationalAsOf: x.now, analyticsWatermarkSeq: e.WATERMARK_SEQ || 0, eventSeq: x.session.EVENT_SEQ || 0, analyticsLagEvents: lag, engineHeartbeatAgeSec: lease, engineWorkerHeartbeatAgeSec: worker,
    analyticsStatus: workerDown ? 'ENGINE_UNAVAILABLE' : notAdvanced ? 'WAITING_FOR_ENGINE' : (lag > 0 ? 'RECALCULATING' : 'UP_TO_DATE'), projectionVersion: x.session.PROJECTION_VERSION || 0 };
}

module.exports = { ctx, sim, simOne, projection, goodBoundary, hist, loc, name, plantState, mapWorker, mapUnit, mapOp, eligibleMinutes, pointsFor, freshness };
