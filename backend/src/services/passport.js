'use strict';
/*
 * Tank passport (TANK_PASSPORT_FIELD_MAP.md). Builds on plantViews.passport (attempts, inspections, events) and adds the full
 * identity / current state / progress / people & labour / quality / traceability sections.
 *  - History is shown only as known at the cut (EVENT_TIME/anchor <= cut AND KNOWN_AT <= cut); session records as of simulated now.
 *  - A field with no record is null and is rendered "Not recorded" - nothing is invented.
 *  - Role filtering: investigation attribution and other workers' minutes/points need view_all_workers, operational_supervision or
 *    quality_approval; an operator sees crew names and their own minutes/points only.
 */
const V = require('./viewsCommon');
const P = require('./plantViews');
const C = require('../domain/catalog');

const PRIVILEGED = ['view_all_workers', 'operational_supervision', 'quality_approval'];
const PHASE_CATEGORY = { NORMAL: 'DIRECT', CORRECTION: 'REWORK', REWORK: 'REWORK', BELOW_MIN_OR_BLOCKED: 'WAITING', WAITING: 'WAITING', BREAK: 'BREAK', TRANSFER: 'TRANSFER', CURE: 'WAITING' };
const RESTRICTED = 'RESTRICTED';
const min = (a, b) => Math.max(0, (new Date(b) - new Date(a)) / 60000);
const r1 = v => Math.round(v * 10) / 10;

/** what happens next for the tank, for EVERY unit state in contracts/state_machines.json (a unit test checks the coverage).
    ctx: { gate, holdType, reworkDest, arriveAt, cureUntil, nextStep } - wording names who acts and what releases the tank. */
const NEXT = {
  PLANNED: c => 'Release the batch to production (Orders -> Release); the tank then joins the queue for its first operation',
  QUEUED: c => `Start ${c.step} when a qualified crew and a free station are available (dispatch order DR-1.0)`,
  READY: c => `Crew starts ${c.step} at the assigned station`,
  WORKING: c => `Crew records the remaining milestones of ${c.step}, then Finish work - finishing is not a pass; inspection ${c.gate || 'at the next gate'} follows`,
  PAUSED: c => `Resume ${c.step} when the pause reason clears (break, material, equipment or support request)`,
  CURING: c => `Wait for the cure to complete${c.cureUntil ? ` (until ${c.cureUntil})` : ''}; then the tank awaits inspection - no labour is booked while curing`,
  WORK_COMPLETED_AWAITING_INSPECTION: c => `An inspector inspects at ${c.gate || 'the next gate'}; no downstream work can start before PASS and release`,
  INSPECTION_IN_PROGRESS: c => `The inspector completes the checklist and submits: PASS -> release, FAIL -> quality hold, missing readings -> incomplete hold`,
  PASS_PENDING_RELEASE: c => (c.nextStep ? `Release to ${c.nextStep}` : 'Final release (route complete)'),
  INCOMPLETE_INSPECTION_HOLD: c => 'The inspector records the missing mandatory readings or evidence and resubmits - incomplete is a hold, not a failure or a release',
  FAILED_INSPECTION: c => 'A quality hold is opened; an authorised approver decides the disposition (rework, scrap or review)',
  QUALITY_HOLD: c => `An authorised approver decides the disposition${c.holdType ? ` (${c.holdType})` : ''}: same-station repair, return to the origin station, approved alternate station, or scrap - the hold stays until decided`,
  PENDING_REVIEW: c => 'A quality reviewer investigates the cause; the tank stays held until the review names a reason and a disposition',
  AUTHORIZED_REWORK: c => `Dispatch the tank to the authorised rework station${c.reworkDest ? ` ${c.reworkDest}` : ''} (or rework in place when retained at the station)`,
  RETURN_REQUESTED: c => `Move the tank back to the origin station${c.reworkDest ? ` ${c.reworkDest}` : ''} (departure -> transit -> arrival)`,
  IN_RETURN_TRANSFER: c => `Arrival at the rework station${c.reworkDest ? ` ${c.reworkDest}` : ''}${c.arriveAt ? ` (expected ${c.arriveAt})` : ''}`,
  RECEIVED_AT_REWORK_STATION: c => 'A qualified crew starts the rework attempt at this station',
  QUEUED_FOR_REWORK: c => 'A qualified crew starts the rework attempt when the rework station is free',
  REWORK_IN_PROGRESS: c => 'The crew completes the rework; then reinspection - rework completion is not a pass',
  REWORK_COMPLETE_AWAITING_REINSPECTION: c => `An inspector reinspects at ${c.gate || 'the gate'}; a second failure escalates to a quality supervisor`,
  REINSPECTION_IN_PROGRESS: c => 'The inspector submits the reinspection: PASS -> release, FAIL -> escalated hold',
  RELEASED_TO_NEXT_OPERATION: c => `Move to ${c.nextStep || 'the next route operation'}; it queues there for a crew`,
  IN_TRANSFER: c => `Arrival at ${c.nextStep ? `the work centre for ${c.nextStep}` : 'the destination'}${c.arriveAt ? ` (expected ${c.arriveAt})` : ''}, then it queues`,
  ROUTE_COMPLETE: c => 'None - route complete (final release recorded)',
  SCRAPPED: c => 'None - scrapped tanks stay scrapped; the demand is met by a replacement tank with a new ID',
};
// earlier / reconstructed state names that can appear in replayed history rows
const ALIASES = { IN_PROCESS: 'WORKING', IN_OPERATION: 'WORKING', WAITING_FOR_OPERATION: 'QUEUED', WORK_COMPLETED: 'WORK_COMPLETED_AWAITING_INSPECTION', QUEUED_FOR_INSPECTION: 'WORK_COMPLETED_AWAITING_INSPECTION',
  AWAITING_INSPECTION: 'WORK_COMPLETED_AWAITING_INSPECTION', ON_HOLD: 'QUALITY_HOLD', HELD: 'QUALITY_HOLD' };

function nextAction(u, ctx = {}) {
  if (!u || !u.STATE) return 'Not in the active window - history only (see the history sections)';
  const st = ALIASES[u.STATE] || u.STATE;
  const f = NEXT[st];
  if (!f) return `No guidance for state ${u.STATE} - check the state contract`;
  return f({ step: u.ROUTE_STEP || 'the current operation', ...ctx });
}

async function full(x, unitId, auth) {
  const base = await P.passport(x, unitId);
  const perms = (auth && auth.permissions) || x.perms || [];
  const viewer = auth && auth.workerId;
  const privileged = PRIVILEGED.some(p => perms.includes(p));
  const s = await V.simOne(x, 'sim_units', { UNIT_ID: unitId });
  const h = await x.db.collection('unit_master').findOne({ RUN_ID: x.src, UNIT_ID: unitId, KNOWN_AT: { $lte: x.histCut } }, { projection: { _seed: 0 } });
  const q = { RUN_ID: x.src, UNIT_ID: unitId };
  const proj = { projection: { _seed: 0, _id: 0, dataset_id: 0 } };
  const defectIds = base.defects.map(d => d.DEFECT_ID);
  const [segs, membH, matH, msH, invH, invEvH, rplH, ptsH, tasksH] = await Promise.all([
    x.db.collection('labor_segments').find({ ...q, SEGMENT_START: { $lte: x.histCut } }, proj).toArray(),
    x.db.collection('batch_unit_membership').find({ ...q, KNOWN_AT: { $lte: x.histCut } }, proj).sort({ VALID_FROM: 1 }).toArray(),
    x.db.collection('material_events').find({ ...q, EVENT_TIME: { $lte: x.histCut }, KNOWN_AT: { $lte: x.histCut } }, proj).sort({ EVENT_TIME: 1 }).toArray(),
    x.db.collection('operation_milestone_events').find({ ...q, EVENT_TIME: { $lte: x.histCut }, KNOWN_AT: { $lte: x.histCut } }, proj).sort({ EVENT_TIME: 1 }).toArray(),
    defectIds.length ? x.db.collection('defect_investigations').find({ RUN_ID: x.src, DEFECT_ID: { $in: defectIds }, KNOWN_AT: { $lte: x.histCut } }, proj).toArray() : [],
    Promise.resolve([]),
    x.db.collection('replacement_requests').find({ RUN_ID: x.src, $or: [{ SCRAPPED_UNIT_ID: unitId }, { NEW_UNIT_ID: unitId }], KNOWN_AT: { $lte: x.histCut } }, proj).toArray(),
    x.db.collection('points_ledger').find({ ...q, KNOWN_AT: { $lte: x.histCut } }, proj).toArray(),
    x.db.collection('task_assignments').find({ ...q, KNOWN_AT: { $lte: x.histCut } }, proj).toArray(),
  ]);
  void invEvH;
  const [parts, membS, tasksS, alerts, actions, ptsS, rplS, ptsEval] = await Promise.all([
    V.sim(x, 'sim_participation', { UNIT_ID: unitId }), V.sim(x, 'sim_batch_membership', { UNIT_ID: unitId }, { sort: { VALID_FROM: 1 } }), V.sim(x, 'sim_tasks', { UNIT_ID: unitId }),
    V.sim(x, 'sim_alerts', { $or: [{ ENTITY_ID: unitId }, { 'EVIDENCE.unitId': unitId }, { 'EVIDENCE.UNIT_ID': unitId }] }, { sort: { UPDATED_AT: -1 }, limit: 20 }),
    s ? V.sim(x, 'sim_actions', { $or: [{ UNIT_ID: unitId }, { ORDER_LINE_ID: s.ORDER_LINE_ID }] }, { sort: { PROPOSED_AT: -1 }, limit: 20 }) : [],
    V.sim(x, 'sim_points_ledger', { UNIT_ID: unitId, KNOWN_AT: { $lte: x.now } }),
    V.sim(x, 'sim_replacements', { $or: [{ SCRAPPED_UNIT_ID: unitId }, { NEW_UNIT_ID: unitId }] }),
    V.sim(x, 'sim_points_evaluations', { UNIT_ID: unitId }),
  ]);
  const product = s ? s.PRODUCT_ID : (h || {}).PRODUCT_ID;
  const route = product ? C.route(x.cat, product) : [];
  const u = s || {};
  const gate = u.ROUTE_STEP ? C.gateAfter(x.cat, product, u.ROUTE_STEP) : null;

  // ---------------------------------------------------------------- labour intervals per attempt and worker
  const labour = {};
  const add = (op, w, cat, a, b, source, phase) => {
    const k = `${op}|${w}`;
    const e = labour[k] || (labour[k] = { operationInstanceId: op, workerId: w, name: V.name(x, w), joinedAt: a, leftAt: b, intervals: [], minutesByCategory: {}, laborMin: 0, source });
    if (new Date(a) < new Date(e.joinedAt)) e.joinedAt = a;
    if (!e.leftAt || (b && new Date(b) > new Date(e.leftAt))) e.leftAt = b;
    const m = b ? min(a, b) : min(a, x.now);
    e.minutesByCategory[cat] = r1((e.minutesByCategory[cat] || 0) + m);
    if (['DIRECT', 'REWORK'].includes(cat)) e.laborMin = r1(e.laborMin + m);
    e.intervals.push({ from: a, to: b || null, category: cat, phase: phase || null, minutes: r1(m), source });
  };
  for (const g of segs) add(g.OPERATION_INSTANCE_ID, g.WORKER_ID, PHASE_CATEGORY[g.SEGMENT_PHASE] || g.SEGMENT_PHASE || 'UNCLASSIFIED', g.SEGMENT_START, new Date(g.SEGMENT_END) > x.histCut ? x.histCut : g.SEGMENT_END, 'HISTORY', g.SEGMENT_PHASE);
  for (const p of parts) add(p.OPERATION_INSTANCE_ID, p.WORKER_ID, p.REASON ? (p.CATEGORY === 'DIRECT' ? 'WAITING' : p.CATEGORY) : p.CATEGORY, p.START_AT, p.END_AT || null, 'SESSION', p.REASON || null);
  const crewLabour = Object.values(labour).map(e => (privileged || e.workerId === viewer ? e : { ...e, intervals: e.intervals.map(i => ({ from: i.from, to: i.to, category: i.category, minutes: null })), minutesByCategory: RESTRICTED, laborMin: null }));
  const attempts = base.attempts.map(a => {
    const rows = crewLabour.filter(l => l.operationInstanceId === a.operationInstanceId);
    const elapsed = a.startedAt ? r1(min(a.startedAt, a.finishedAt || x.now)) : null;
    const laborMin = privileged ? r1(rows.reduce((t, l) => t + (l.laborMin || 0), 0)) : null;
    return { ...a, labour: rows, elapsedMin: elapsed, laborMin, laborVsElapsed: privileged && elapsed ? `${laborMin} labour-min over ${elapsed} elapsed min` : null };
  });

  // ---------------------------------------------------------------- quality: investigations with role filtering
  const inv = [
    ...invH.map(i => ({ source: 'HISTORY', investigationId: i.INVESTIGATION_ID, defectId: i.DEFECT_ID, status: i.STATUS, cause: i.CAUSE_CATEGORY, suspectedOrigin: i.SUSPECTED_ORIGIN_OPERATION_INSTANCE_ID || i.SUSPECTED_ORIGIN_OPERATION_ID || null,
      confirmedOrigin: i.CONFIRMED_ORIGIN_OPERATION_ID || null, responsible: i.RESPONSIBLE_PARTY_ID ? [{ partyType: i.RESPONSIBLE_PARTY_TYPE, partyId: i.RESPONSIBLE_PARTY_ID }] : [], reviewedBy: i.REVIEWED_BY || null, actionOwner: i.ACTION_OWNER || null,
      openedAt: i.OPENED_AT, confirmedAt: i.CONFIRMED_AT && new Date(i.CONFIRMED_AT) <= x.histCut ? i.CONFIRMED_AT : null, knownAt: i.KNOWN_AT })),
    ...base.investigations.map(i => ({ source: 'SESSION', investigationId: i.INVESTIGATION_ID, defectId: i.DEFECT_ID, status: i.STATUS, cause: i.CAUSE_CATEGORY, suspectedOrigin: i.SUSPECTED_ORIGIN_OPERATION_INSTANCE_ID || null,
      confirmedOrigin: i.STATUS === 'CONFIRMED' ? i.SUSPECTED_ORIGIN_OPERATION_INSTANCE_ID : null, responsible: (i.RESPONSIBLE || []).map(r => ({ partyType: r.PARTY_TYPE, partyId: r.PARTY_ID, share: r.SHARE })),
      reviewedBy: i.REVIEWED_BY || null, actionOwner: i.ACTION_OWNER || null, openedAt: i.OPENED_AT, confirmedAt: i.CONFIRMED_AT || null, knownAt: i.KNOWN_AT, evidence: i.EVIDENCE || [] })),
  ].map(i => (privileged ? i : { ...i, cause: i.status === 'CONFIRMED' ? i.cause : i.cause, responsible: RESTRICTED, evidence: RESTRICTED, reviewedBy: i.reviewedBy }));
  const defects = base.defects.map(d => ({ defectId: d.DEFECT_ID, source: d.source, code: d.DEFECT_CODE, description: d.DESCRIPTION || d.DEFECT_DESCRIPTION || null, severity: d.SEVERITY || null,
    detectedAt: d.DETECTED_AT || null, knownAt: d.KNOWN_AT || null, detectedBy: d.DETECTED_BY || d.DETECTED_BY_WORKER_ID || null, detectedAtWorkCenter: d.DETECTED_AT_WORK_CENTER_ID || null,
    detectedAtWorkstation: d.DETECTED_AT_WORKSTATION_ID || null, detectionStage: d.DETECTION_STAGE || null, downstream: d.DOWNSTREAM_FLAG === 'Y',
    suspectedOriginOperation: d.SUSPECTED_ORIGIN_OPERATION_ID || d.ORIGIN_OPERATION_INSTANCE_ID || null, investigationId: d.INVESTIGATION_ID || null,
    note: 'Detected-at/by is where and by whom it was found - not who caused it' }));

  // ---------------------------------------------------------------- progress
  const passed = new Set(u.PASSED_GATES || []);
  const doneOps = new Set(base.attempts.filter(a => a.finishedAt || ['WORK_COMPLETED'].includes(a.state)).map(a => a.operationId));
  const routeSteps = route.map(op => {
    const def = C.opDef(x.cat, product, op) || {};
    const status = u.STATE === 'ROUTE_COMPLETE' ? 'COMPLETED' : op === u.ROUTE_STEP ? 'CURRENT'
      : (def.OPERATION_KIND === 'INSPECTION' ? (passed.has(op) ? 'PASSED' : 'PENDING') : (doneOps.has(op) && route.indexOf(op) < route.indexOf(u.ROUTE_STEP) ? 'COMPLETED' : 'PENDING'));
    return { operationId: op, name: def.OPERATION_NAME || null, kind: def.OPERATION_KIND || null, workCenterId: def.WORK_CENTER_ID || null, status, attempts: base.attempts.filter(a => a.operationId === op).length };
  });
  const nextRouteStep = u.ROUTE_STEP && route.indexOf(u.ROUTE_STEP) >= 0 ? route[route.indexOf(u.ROUTE_STEP) + 1] || null : null;
  const lastLabor = base.attempts.filter(a => a.kind === 'LABOR' && a.finishedAt).map(a => a.finishedAt).sort().pop() || null;
  const lastPass = base.inspections.filter(i => i.result === 'PASS').map(i => i.completedAt).sort().pop() || null;
  const opFc = u.CURRENT_OPERATION_INSTANCE_ID ? await V.projection(x, 'OPERATION_FORECAST', u.CURRENT_OPERATION_INSTANCE_ID) : null;
  const ordFc = await V.projection(x, 'ORDER_FORECAST_SUMMARY');
  const lineFc = ordFc && s ? (ordFc.DATA || []).find(l => l.ORDER_LINE_ID === s.ORDER_LINE_ID) : null;
  const curOp = u.CURRENT_OPERATION_INSTANCE_ID ? base.attempts.find(a => a.operationInstanceId === u.CURRENT_OPERATION_INSTANCE_ID) : null;
  const milestonesDone = curOp ? (curOp.milestones || []).length : null;
  const milestoneDefs = curOp && product ? (C.milestonesFor(x.cat, curOp.operationId) || []).length : null;

  // ---------------------------------------------------------------- current
  const working = tasksS.filter(t => t.STATUS === 'WORKING' && t.OPERATION_INSTANCE_ID === u.CURRENT_OPERATION_INSTANCE_ID);
  const assigned = tasksS.filter(t => ['ASSIGNED', 'ACCEPTED', 'PAUSED', 'WORKING'].includes(t.STATUS) && t.OPERATION_INSTANCE_ID === u.CURRENT_OPERATION_INSTANCE_ID);
  const lastEvent = base.events[base.events.length - 1] || null;
  const hold = base.holds.find(x2 => x2.source === 'SESSION' && ['OPEN', 'PENDING_REVIEW'].includes(x2.RESOLUTION)) || null;

  // ---------------------------------------------------------------- traceability
  const equipment = [...new Set(base.attempts.map(a => a.equipmentId).filter(Boolean))];
  const ptsRows = [...ptsH.map(p => ({ ...p, scope: 'HISTORY' })), ...ptsS.map(p => ({ ...p, scope: 'SESSION' }))]
    .filter(p => privileged || p.WORKER_ID === viewer)
    .map(p => ({ transactionId: p.POINTS_TRANSACTION_ID, scope: p.scope, workerId: p.WORKER_ID, rule: p.RULE_ID, delta: p.POINTS_DELTA, status: p.ATTRIBUTION_STATUS, reverses: p.REVERSAL_OF_ID || null,
      operationInstanceId: p.OPERATION_INSTANCE_ID || null, defectId: p.DEFECT_ID || null, knownAt: p.KNOWN_AT, eventTime: p.EVENT_TIME, note: p.CALCULATION_NOTE || null }));
  const lateRecords = base.events.filter(e => e.knownAt && e.at && new Date(e.knownAt) - new Date(e.at) > 60000)
    .map(e => ({ type: e.type, eventTime: e.at, knownAt: e.knownAt, lateMin: r1(min(e.at, e.knownAt)), source: e.source }));
  const replacement = [...rplH.map(r => ({ ...r, source: 'HISTORY' })), ...rplS.map(r => ({ ...r, source: 'SESSION' }))]
    .map(r => ({ requestId: r.REQUEST_ID, source: r.source, scrappedUnitId: r.SCRAPPED_UNIT_ID, newUnitId: r.NEW_UNIT_ID || null, status: r.STATUS, requestedAt: r.REQUESTED_AT, approvedBy: r.APPROVED_BY || null }));

  const sections = {
    identity: {
      unitId, serial: (s || h || {}).TANK_SERIAL_NO || null, productId: product || null, productName: ((x.cat.products || {})[product] || {}).PRODUCT_NAME || null,
      componentType: (h || {}).COMPONENT_TYPE || null, drawing: h ? (h.DRAWING_REF || null) : null, drawingRevision: (h || {}).DRAWING_REVISION || u.DRAWING_REVISION || null,
      routeId: (h || {}).ROUTE_ID || null, routeVersion: (h || {}).ROUTE_VERSION || null,
      orderId: (s || h || {}).ORDER_ID || null, orderLineId: (s || h || {}).ORDER_LINE_ID || null, batchId: u.BATCH_ID || (h || {}).INITIAL_BATCH_ID || null,
      batchHistory: [...membH.map(m => ({ source: 'HISTORY', batchId: m.BATCH_ID, from: m.VALID_FROM, to: m.VALID_TO, reason: m.MEMBERSHIP_REASON, knownAt: m.KNOWN_AT })),
        ...membS.map(m => ({ source: 'SESSION', batchId: m.BATCH_ID, from: m.VALID_FROM, to: m.VALID_TO || null, reason: m.MEMBERSHIP_REASON, parentBatchId: m.PARENT_BATCH_ID || null, knownAt: m.KNOWN_AT }))],
      replacementForUnitId: (s || h || {}).REPLACEMENT_FOR_UNIT_ID || null, replacedByUnitId: u.REPLACED_BY_UNIT_ID || (replacement.find(r => r.scrappedUnitId === unitId && r.newUnitId) || {}).newUnitId || null,
      createdAt: (h || s || {}).CREATED_AT || null,
    },
    current: {
      state: s ? s.STATE : 'NOT_IN_ACTIVE_WINDOW', stateSince: u.STATE_SINCE || null, physicalWorkCenterId: u.CURRENT_WORK_CENTER_ID || null, physicalWorkstationId: u.CURRENT_WORKSTATION_ID || null,
      inTransit: u.ARRIVE_AT ? { from: u.CURRENT_WORK_CENTER_ID || null, to: u.TRANSFER_TO_WORK_CENTER_ID || (u.REWORK_PENDING || {}).DEST_WORK_CENTER_ID || null, arriveAt: u.ARRIVE_AT } : null,
      proposedReworkDestination: u.REWORK_PENDING ? { workCenterId: u.REWORK_PENDING.DEST_WORK_CENTER_ID, workstationId: u.REWORK_PENDING.DEST_WORKSTATION_ID, returnId: u.REWORK_PENDING.RETURN_ID } : null,
      currentAttempt: curOp ? { operationInstanceId: curOp.operationInstanceId, operationId: curOp.operationId, attemptNo: curOp.attemptNo, instanceType: curOp.instanceType, state: curOp.state } : null,
      hold: hold ? { holdId: hold.HOLD_ID, type: hold.HOLD_TYPE, since: hold.HOLD_STARTED_AT, location: hold.HOLD_LOCATION } : null,
      blocker: (curOp && curOp.state && /BLOCK|WAIT|BELOW/.test(curOp.state)) ? curOp.state : (u.BLOCKED_ARRIVAL ? 'DESTINATION_BLOCKED' : null),
      assignedCrew: assigned.map(t => ({ workerId: t.WORKER_ID, name: V.name(x, t.WORKER_ID), taskStatus: t.STATUS })),
      productiveCrew: working.map(t => ({ workerId: t.WORKER_ID, name: V.name(x, t.WORKER_ID) })),
      lastEvent: lastEvent ? { type: lastEvent.type, at: lastEvent.at, knownAt: lastEvent.knownAt, source: lastEvent.source } : null,
      freshness: V.freshness(x),
    },
    progress: {
      routeSteps, attempts: attempts.map(a => ({ operationInstanceId: a.operationInstanceId, operationId: a.operationId, attemptNo: a.attemptNo ?? null, instanceType: a.instanceType || null, reworkOf: a.reworkOf, state: a.state || null, startedAt: a.startedAt || null, finishedAt: a.finishedAt || null })),
      reworkLoops: base.returns.length, milestones: { current: milestonesDone, defined: milestoneDefs, history: msH.length },
      expectedNextAction: nextAction(s, { gate, holdType: hold ? hold.HOLD_TYPE : null, reworkDest: u.REWORK_PENDING ? (u.REWORK_PENDING.DEST_WORKSTATION_ID || u.REWORK_PENDING.DEST_WORK_CENTER_ID) : null,
        arriveAt: u.ARRIVE_AT ? V.loc(x, u.ARRIVE_AT) : null, cureUntil: (u.CURE_UNTIL || u.CURE_END_AT) ? V.loc(x, u.CURE_UNTIL || u.CURE_END_AT) : null, nextStep: u.STATE === 'PASS_PENDING_RELEASE' || u.STATE === 'RELEASED_TO_NEXT_OPERATION' || u.STATE === 'IN_TRANSFER' ? (u.STATE === 'PASS_PENDING_RELEASE' ? nextRouteStep : u.ROUTE_STEP) : nextRouteStep }),
      workCompletedAt: lastLabor, inspectionPassedAt: lastPass, finalReleaseAt: u.ROUTE_COMPLETED_AT || null,
      forecast: { kind: 'FORECAST', nextMovementAt: opFc ? opFc.FORECAST_FINISH_AT : null, nextMovementBasis: opFc ? opFc.BASIS : null, lineCompletionAt: lineFc ? (lineFc.P50_FINISH_AT || lineFc.FORECAST_FINISH_AT || null) : null,
        lineBand: lineFc ? lineFc.BAND : null, computedAt: (opFc || ordFc || {}).COMPUTED_AT || null },
    },
    people: {
      attempts: attempts.map(a => ({ operationInstanceId: a.operationInstanceId, operationId: a.operationId, crew: a.crew, labour: a.labour, laborMin: a.laborMin, elapsedMin: a.elapsedMin })),
      inspectors: [...new Set(base.inspections.map(i => i.inspectorId).filter(Boolean))].map(w => ({ workerId: w, name: V.name(x, w) })),
      reviewers: [...new Set(inv.map(i => i.reviewedBy).filter(Boolean))].map(w => ({ workerId: w, name: V.name(x, w) })),
      dispositionApprovers: [...new Set(base.dispositions.map(d => d.DECIDED_BY || d.APPROVED_BY).filter(Boolean))].map(w => ({ workerId: w, name: V.name(x, w) })),
      actionOwners: [...new Set([...inv.map(i => i.actionOwner), ...actions.map(a => a.OWNER_ID)].filter(Boolean))].map(w => ({ workerId: w, name: V.name(x, w) })),
      historyAssignments: tasksH.length,
    },
    quality: {
      inspections: base.inspections, defects, investigations: inv,
      dispositions: base.dispositions.map(d => ({ dispositionId: d.DISPOSITION_ID, source: d.source, decision: d.DISPOSITION, result: d.RESULT || null, decidedBy: d.DECIDED_BY || d.APPROVED_BY || null, decidedAt: d.DECIDED_AT || d.EVENT_TIME || null, reason: d.REASON || d.REASON_CODE || null })),
      returns: base.returns.map(rt => ({ returnId: rt.RETURN_ID || rt.RETURN_MOVEMENT_ID, source: rt.source, reworkType: rt.REWORK_TYPE || null, authorizedBy: rt.AUTHORIZED_BY || null, destination: rt.AUTHORIZED_DESTINATION_WORKSTATION_ID || rt.TO_WORKSTATION_ID || null,
        basis: rt.DESTINATION_BASIS || null, alternateApprovedBy: rt.ALTERNATE_APPROVED_BY || null, loopStatus: rt.LOOP_STATUS || null, reinspectionResult: rt.REINSPECTION_RESULT || null })),
    },
    traceability: {
      materialLotId: (h || {}).MATERIAL_LOT_ID || null,
      materialEvents: matH.map(m => ({ type: m.EVENT_TYPE, materialId: m.MATERIAL_ID, lot: m.MATERIAL_LOT_ID, qty: m.QTY, eventTime: m.EVENT_TIME, knownAt: m.KNOWN_AT })),
      equipment, events: base.events, lateRecords,
      points: ptsRows, pointsEvaluations: privileged ? ptsEval.map(e => ({ subject: e.SUBJECT_KEY, status: e.STATUS, rule: e.RULE_ID, reason: e.REASON, calculationId: e.CALCULATION_ID, asOf: e.AS_OF })) : RESTRICTED,
      alerts: alerts.map(a => ({ alertId: a.ALERT_ID, ruleId: a.RULE_ID, evaluation: a.EVALUATION_STATE, workflow: a.WORKFLOW_STATE, firstDetectedAt: a.FIRST_DETECTED_AT })),
      recoveryActions: actions.map(a => ({ actionId: a.ACTION_ID, type: a.ACTION_TYPE || a.OPTION_TYPE, status: a.STATUS, proposedAt: a.PROPOSED_AT, owner: a.OWNER_ID || null })),
      replacement,
    },
  };
  const access = { level: privileged ? 'SUPERVISOR' : 'OPERATOR', restricted: privileged ? [] : ['investigation attribution and evidence', "other workers' minutes and points", 'points evaluations'],
    note: privileged ? 'Full passport' : 'Role-limited passport: names and intervals are shown for coordination; attribution and other workers\' performance details need supervisor or quality permission' };
  // label scans (barcode / camera / typed serial): every confirmation, location and wrong-tank scan of this tank
  const scanDocs = await V.sim(x, 'sim_scans', { $or: [{ UNIT_ID: unitId }, { EXPECTED_UNIT_ID: unitId }], SCANNED_AT: { $lte: x.now } }, { sort: { SCANNED_AT: -1 }, limit: 100 });
  const scans = {
    lastLocation: u.LAST_SCANNED_STATION_ID ? { stationId: u.LAST_SCANNED_STATION_ID, workCenterId: u.LAST_SCANNED_WORK_CENTER_ID || null, at: u.LAST_SCANNED_STATION_AT, atLocal: V.loc(x, u.LAST_SCANNED_STATION_AT) } : null,
    lastScanAt: u.LAST_SCANNED_AT || null,
    rows: scanDocs.map(d => ({ scanId: d.SCAN_ID, at: d.SCANNED_AT, atLocal: V.loc(x, d.SCANNED_AT), workerId: d.WORKER_ID, name: d.WORKER_ID ? V.name(x, d.WORKER_ID) : d.LOGIN_ID, purpose: d.PURPOSE, result: d.RESULT,
      method: d.METHOD, code: d.CODE, stationId: d.STATION_ID, scannedUnitId: d.UNIT_ID, expectedUnitId: d.EXPECTED_UNIT_ID, taskId: d.TASK_ID })),
    note: 'The tank label is the tank serial. A scan records who confirmed which tank where; it never moves the tank along its route.',
  };
  return { ...base, scans, investigations: privileged ? base.investigations : base.investigations.map(i => ({ ...i, RESPONSIBLE: RESTRICTED, EVIDENCE: RESTRICTED })), sections, access,
    notRecordedNote: 'Empty fields mean the source data or session holds no record - shown as "Not recorded", never estimated.' };
}

module.exports = { full, nextAction, NEXT, ALIASES };
