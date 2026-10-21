'use strict';
/* Operator-facing read models. Everything shown is as known at the session's simulated "now" (history frozen at the fork + session records). */
const V = require('./viewsCommon');
const C = require('../domain/catalog');
const E = require('../lib/errors');
const { addMin } = require('../lib/time');

const ACTIVE = ['ASSIGNED', 'ACCEPTED', 'WORKING', 'PAUSED'];

async function workerDoc(x, workerId) {
  const w = await V.simOne(x, 'sim_workers', { WORKER_ID: workerId });
  if (!w) throw E.notFound('Worker in this simulation (new workers appear after their first roster assignment is processed)');
  return w;
}

function shiftInfo(x, w) {
  const sh = x.cat.shifts[w.SHIFT_ID] || null;
  return {
    shiftId: w.SHIFT_ID, shiftCode: sh ? sh.SHIFT_CODE : null, shiftDate: sh ? sh.SHIFT_DATE : null, timezone: x.tz,
    plannedStartAt: w.PLANNED_START_AT, plannedEndAt: w.PLANNED_END_AT, plannedStartLocal: V.loc(x, w.PLANNED_START_AT), plannedEndLocal: V.loc(x, w.PLANNED_END_AT),
    rosterStatus: w.ROSTER_STATUS, attendance: w.ATTENDANCE_STATE, firstClockInAt: w.FIRST_CLOCK_IN_AT, firstClockInLocal: V.loc(x, w.FIRST_CLOCK_IN_AT),
    lastClockOutAt: w.LAST_CLOCK_OUT_AT || null, appSession: 'Signed in (application session - not attendance)', breakStartedAt: w.BREAK_STARTED_AT || null,
    elapsedShiftMin: w.PLANNED_START_AT ? Math.max(0, Math.round((x.now - new Date(w.PLANNED_START_AT)) / 60000)) : null,
    remainingShiftMin: w.PLANNED_END_AT ? Math.max(0, Math.round((new Date(w.PLANNED_END_AT) - x.now) / 60000)) : null,
    overtimeUntil: w.OVERTIME_UNTIL || null,
    nextShift: w.NEXT_SHIFT_ID ? { shiftId: w.NEXT_SHIFT_ID, plannedStartLocal: w.nextPlannedStartLocal || V.loc(x, w.NEXT_PLANNED_START_AT) } : null,
  };
}

async function milestoneView(x, op) {
  const type = String(op.INSTANCE_TYPE || '').endsWith('REWORK') ? 'REWORK' : 'STANDARD';
  const defs = C.milestonesFor(x.cat, op.OPERATION_ID, type);
  const done = new Set(op.MILESTONES_DONE || []);
  const events = await V.sim(x, 'sim_milestones', { OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID });
  const hist = await V.hist(x, 'operation_milestone_events', { OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID });
  const at = Object.fromEntries([...hist.map(m => [m.MILESTONE_ID, { at: m.EVENT_TIME, by: m.RECORDED_BY_WORKER_ID || null, basis: m.EVIDENCE_BASIS || 'HISTORY' }]), ...events.map(m => [m.MILESTONE_ID, { at: m.EVENT_TIME, by: m.RECORDED_BY_WORKER_ID, basis: m.EVIDENCE_BASIS }])]);
  for (const k of Object.keys(at)) done.add(k);
  const list = defs.map((m, i) => ({ milestoneId: m.MILESTONE_ID, seq: m.SEQUENCE_NO, name: m.MILESTONE_NAME, attended: m.ATTENDED !== 'N', final: i === defs.length - 1, done: done.has(m.MILESTONE_ID),
    doneAt: at[m.MILESTONE_ID] ? at[m.MILESTONE_ID].at : null, doneLocal: at[m.MILESTONE_ID] ? V.loc(x, at[m.MILESTONE_ID].at) : null, basis: at[m.MILESTONE_ID] ? at[m.MILESTONE_ID].basis : null, provenance: m.CONTENT_STATUS || 'SYNTHETIC_ILLUSTRATIVE' }));
  const total = list.length, doneN = list.filter(m => m.done).length;
  return { milestones: list, completed: doneN, total, progressPct: total ? Math.round(doneN / total * 100) : null,
    progressBasis: 'Milestones/checklist completed - not the timer. 100% only when the final "work complete" milestone is recorded by finishing the work.' };
}

async function taskDetail(x, task, me) {
  const op = await V.simOne(x, 'sim_operations', { OPERATION_INSTANCE_ID: task.OPERATION_INSTANCE_ID });
  const unit = await V.simOne(x, 'sim_units', { UNIT_ID: task.UNIT_ID });
  if (!op || !unit) return null;
  const crewTasks = await V.sim(x, 'sim_tasks', { OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID, STATUS: { $in: ACTIVE } });
  const crew = [];
  for (const t of crewTasks) {
    const w = await V.simOne(x, 'sim_workers', { WORKER_ID: t.WORKER_ID });
    crew.push({ workerId: t.WORKER_ID, name: V.name(x, t.WORKER_ID), role: t.ROLE, taskStatus: t.STATUS, activity: w ? w.ACTIVITY_STATE : null, isMe: t.WORKER_ID === me });
  }
  const line = await x.db.collection('order_lines').findOne({ RUN_ID: x.src, ORDER_LINE_ID: unit.ORDER_LINE_ID, $or: [{ SESSION_ID: null }, { SESSION_ID: x.sid }] }, { projection: { _seed: 0, _id: 0 } });
  const batch = unit.BATCH_ID ? await x.db.collection('production_batches').findOne({ RUN_ID: x.src, BATCH_ID: unit.BATCH_ID, $or: [{ SESSION_ID: null }, { SESSION_ID: x.sid }] }, { projection: { _seed: 0, _id: 0 } }) : null;
  const instr = op.INSTRUCTION_VERSION_ID ? x.cat.instructions[op.INSTRUCTION_VERSION_ID] : C.instructionFor(x.cat, op.OPERATION_ID, unit.PRODUCT_ID, unit.DRAWING_REVISION, String(op.INSTANCE_TYPE || '').endsWith('REWORK'), x.now);
  const steps = instr ? x.cat.steps.filter(s => s.INSTRUCTION_VERSION_ID === instr.INSTRUCTION_VERSION_ID).sort((a, b) => a.STEP_NO - b.STEP_NO) : [];
  const mats = x.cat.matReqs.filter(m => m.PRODUCT_ID === unit.PRODUCT_ID && m.CONSUMED_AT_OPERATION_ID === op.OPERATION_ID);
  const material = [];
  for (const m of mats) {
    const s = await V.simOne(x, 'sim_materials', { MATERIAL_ID: m.MATERIAL_ID });
    const avail = s ? Number(s.ON_HAND_QTY || 0) - Number(s.HOLD_QTY || 0) - Number(s.RESERVED_QTY || 0) : null;
    material.push({ materialId: m.MATERIAL_ID, name: (x.cat.materials[m.MATERIAL_ID] || {}).MATERIAL_NAME, qtyPerUnit: m.QTY_PER_UNIT, uom: m.UOM, available: avail, consumed: !!op.MATERIAL_CONSUMED || op.ORIGIN === 'INHERITED_AT_FORK',
      status: op.MATERIAL_CONSUMED || op.ORIGIN === 'INHERITED_AT_FORK' ? 'ISSUED' : (avail === null ? 'UNKNOWN' : avail >= Number(m.QTY_PER_UNIT || 0) ? 'AVAILABLE' : 'SHORT') });
  }
  const eq = op.EQUIPMENT_ID ? await V.simOne(x, 'sim_equipment', { EQUIPMENT_ID: op.EQUIPMENT_ID }) : null;
  const holds = await V.sim(x, 'sim_holds', { UNIT_ID: unit.UNIT_ID, RESOLUTION: { $in: ['OPEN', 'PENDING_REVIEW'] } });
  const elig = await V.eligibleMinutes(x, me, op.OPERATION_INSTANCE_ID);
  const crewCount = (op.CREW || []).length || crewTasks.filter(t => t.STATUS === 'WORKING').length;
  const target = op.OPERATION_KIND === 'LABOR' ? C.elapsedForCrew(x.cat, unit.PRODUCT_ID, op.OPERATION_ID, Math.max(crewCount, op.MIN_CREW_SIZE || 1)) : op.STANDARD_ELAPSED_MIN;
  const ms = await milestoneView(x, op);
  const proj = await V.projection(x, 'OPERATION_FORECAST', op.OPERATION_INSTANCE_ID);
  return {
    task: { taskId: task.TASK_ID, status: task.STATUS, role: task.ROLE, assignedAt: task.ASSIGNED_AT, acceptedAt: task.ACCEPTED_AT || null, startedAt: task.STARTED_AT || null, pauseReason: task.PAUSE_REASON || null, statusSince: task.STATUS_SINCE, version: task.VERSION, origin: task.ORIGIN },
    operation: V.mapOp(x, op), unit: V.mapUnit(x, unit),
    order: { orderId: unit.ORDER_ID, orderLineId: unit.ORDER_LINE_ID, requiredGoodQty: line ? line.REQUIRED_GOOD_QTY : null, dueAt: line ? line.DUE_AT : unit.DUE_AT, dueLocal: V.loc(x, line ? line.DUE_AT : unit.DUE_AT) },
    batch: batch ? { batchId: batch.BATCH_ID, plannedQty: batch.PLANNED_QTY, parentBatchId: batch.PARENT_BATCH_ID } : { batchId: unit.BATCH_ID },
    crew, instruction: instr ? { versionId: instr.INSTRUCTION_VERSION_ID, title: instr.TITLE, revision: instr.INSTRUCTION_VERSION, drawingRevision: unit.DRAWING_REVISION, tools: instr.TOOLS, ppe: instr.PPE,
      contentStatus: instr.CONTENT_STATUS, approvalStatus: instr.APPROVAL_STATUS, steps: steps.map(s => ({ stepNo: s.STEP_NO, text: s.STEP_TEXT, closesMilestoneId: s.CLOSES_MILESTONE_ID, ctq: s.CTQ_REFERENCE })) } : null,
    milestones: ms, material, equipment: eq ? { equipmentId: eq.EQUIPMENT_ID, status: eq.STATUS, reason: eq.REASON_CODE, estimatedRecoveryAt: eq.ESTIMATED_RECOVERY_AT } : null,
    holds: holds.map(h => ({ holdId: h.HOLD_ID, type: h.HOLD_TYPE, since: h.HOLD_STARTED_AT, resolution: h.RESOLUTION })),
    time: { eligibleElapsedMin: elig.totalMin, eligibleFromHistoryMin: elig.historyMin, eligibleInSessionMin: elig.sessionMin, targetElapsedMinForCrew: target, crewCountForTarget: Math.max(crewCount, op.MIN_CREW_SIZE || 1),
      basis: 'Eligible = your attended direct/rework labour on this attempt; breaks, external blocks, transfers and unattended cure are excluded' },
    forecast: proj ? { finishAt: proj.FORECAST_FINISH_AT, finishLocal: V.loc(x, proj.FORECAST_FINISH_AT), basis: proj.BASIS, computedAt: proj.COMPUTED_AT, kind: 'FORECAST' } : null,
    states: { workPerformed: op.STATE === 'WORK_COMPLETED' ? 'WORK_COMPLETE' : (op.STATE === 'WORKING' ? 'IN_PROGRESS' : op.STATE), inspection: unit.LAST_INSPECTION_RESULT || (['WORK_COMPLETED_AWAITING_INSPECTION', 'REWORK_COMPLETE_AWAITING_REINSPECTION'].includes(unit.STATE) ? 'AWAITING' : 'NOT_YET'),
      released: (unit.PASSED_GATES || []).includes(C.gateAfter(x.cat, unit.PRODUCT_ID, op.OPERATION_ID)) ? 'RELEASED' : 'NOT_RELEASED' },
  };
}

function whyCannotStart(x, w, task, op, unit, eq, otherWorking) {
  const reasons = [];
  if (w.ATTENDANCE_STATE !== 'CLOCKED_IN') reasons.push('Clock in first (signing in does not clock you in)');
  if (w.ACTIVITY_STATE === 'BREAK') reasons.push('You are on break');
  if (w.ACTIVITY_STATE === 'TRANSFER') reasons.push('Confirm arrival from your transfer first');
  if (otherWorking) reasons.push(`You are already working on ${otherWorking.TASK_ID}`);
  if (unit && ['QUALITY_HOLD', 'FAILED_INSPECTION', 'PENDING_REVIEW', 'INCOMPLETE_INSPECTION_HOLD'].includes(unit.STATE)) reasons.push(`Tank is on ${unit.STATE.replace(/_/g, ' ').toLowerCase()}`);
  if (eq && eq.STATUS === 'DOWN') reasons.push(`${eq.EQUIPMENT_ID} is down`);
  if (op && op.BLOCKED_REASON) reasons.push(`Blocked: ${op.BLOCKED_REASON.replace(/_/g, ' ').toLowerCase()}`);
  if (op && op.REQUIRED_SKILL_ID && !C.qualified(x.cat, w.WORKER_ID, op.REQUIRED_SKILL_ID, x.now)) reasons.push(`No valid ${op.REQUIRED_SKILL_ID} qualification`);
  return reasons;
}

async function home(x, workerId) {
  const w = await workerDoc(x, workerId);
  const tasks = await V.sim(x, 'sim_tasks', { WORKER_ID: workerId, STATUS: { $in: ACTIVE } });
  tasks.sort((a, b) => (a.STATUS === 'WORKING' ? 0 : a.STATUS === 'PAUSED' ? 1 : 2) - (b.STATUS === 'WORKING' ? 0 : b.STATUS === 'PAUSED' ? 1 : 2) || new Date(b.STATUS_SINCE) - new Date(a.STATUS_SINCE));
  const current = tasks[0] ? await taskDetail(x, tasks[0], workerId) : null;
  if (current) {
    const op = await V.simOne(x, 'sim_operations', { OPERATION_INSTANCE_ID: tasks[0].OPERATION_INSTANCE_ID });
    const unit = await V.simOne(x, 'sim_units', { UNIT_ID: tasks[0].UNIT_ID });
    const eq = op && op.EQUIPMENT_ID ? await V.simOne(x, 'sim_equipment', { EQUIPMENT_ID: op.EQUIPMENT_ID }) : null;
    current.cannotStartReasons = ['ASSIGNED', 'ACCEPTED', 'PAUSED'].includes(tasks[0].STATUS) ? whyCannotStart(x, w, tasks[0], op, unit, eq, null) : [];
    // tank-label scan: confirmation of this task (or of this tank in the last hour) - required before starting when the factory switched it on
    const scanReq = !!(x.session.FACTORY_SESSION && (x.session.SCAN_REQUIRED || {}).START_WORK);
    const since = new Date(x.now.getTime() - 60 * 60000);
    const confirm = (await V.sim(x, 'sim_scans', { $or: [{ TASK_ID: tasks[0].TASK_ID, PURPOSE: 'CONFIRM_TASK', RESULT: 'MATCH' }, { EXPECTED_UNIT_ID: tasks[0].UNIT_ID, WORKER_ID: w.WORKER_ID, RESULT: 'MATCH', SCANNED_AT: { $gte: since } }] }, { sort: { SCANNED_AT: -1 }, limit: 1 }))[0] || null;
    current.scan = { required: scanReq, confirmed: !!confirm, confirmedAt: confirm ? confirm.SCANNED_AT : null, confirmedLocal: confirm ? V.loc(x, confirm.SCANNED_AT) : null };
  }
  const drafts = await V.sim(x, 'sim_inspections', { INSPECTOR_ID: workerId, STATUS: 'DRAFT' });
  const actions = await nextActions(x, w);
  const points = await V.pointsFor(x, workerId);
  // alerts that concern this person's own work: their operation, workstation, tank or work centre (no other workers' details)
  const scope = [tasks[0] && tasks[0].OPERATION_INSTANCE_ID, tasks[0] && tasks[0].UNIT_ID, w.CURRENT_WORKSTATION_ID, w.CURRENT_WORK_CENTER_ID || w.PLANNED_WORK_CENTER_ID, workerId].filter(Boolean);
  const myAlerts = scope.length ? await V.sim(x, 'sim_alerts', { EVALUATION_STATE: { $in: ['PENDING', 'FIRING', 'RECOVERING'] }, ENTITY_ID: { $in: scope } }, { sort: { UPDATED_AT: -1 }, limit: 5 }) : [];
  return { session: sessionHeader(x), worker: V.mapWorker(x, w), shift: shiftInfo(x, w), currentTask: current,
    alerts: myAlerts.map(a => ({ alertId: a.ALERT_ID, ruleId: a.RULE_ID, ruleName: a.RULE_NAME, evaluation: a.EVALUATION_STATE, workflow: a.WORKFLOW_STATE, severity: a.SEVERITY, entityId: a.ENTITY_ID, message: a.MESSAGE,
      note: 'Operational signal for your area - waiting caused by supply, equipment or material is not a performance finding' })), otherActiveTasks: tasks.slice(1).map(t => ({ taskId: t.TASK_ID, status: t.STATUS, unitId: t.UNIT_ID, operationId: t.OPERATION_ID })),
    draftInspections: drafts.map(d => ({ inspectionId: d.INSPECTION_ID, unitId: d.UNIT_ID, gate: d.GATE_OPERATION_ID, kind: d.INSPECTION_KIND, startedAt: d.STARTED_AT, savedAt: d.DRAFT_SAVED_AT, answered: Object.keys(d.DRAFT_ANSWERS || {}).length, version: d.VERSION })),
    nextActions: actions, points: { total: points.total, pendingNote: 'Points appear when the qualifying event is known; pending investigations never deduct' }, freshness: V.freshness(x) };
}

function sessionHeader(x) {
  return { sessionId: x.sid, mode: x.session.MODE, factorySession: !!x.session.FACTORY_SESSION, operatingMode: x.session.OPERATING_MODE || null, realTime: !!(x.session.CLOCK || {}).REAL_TIME, factoryName: x.session.FACTORY_NAME || null,
    modeLabel: x.session.FACTORY_SESSION ? (x.session.OPERATING_MODE === 'SIMULATED_TEST' ? 'Fresh factory - simulated test' : 'Fresh factory - manual team test') : (x.session.MODE === 'REPLAY' ? 'Synthetic live replay' : 'Synthetic interactive demo'), simNow: x.now, simNowLocal: V.loc(x, x.now), timezone: x.tz,
    status: x.session.STATUS, speed: (x.session.CLOCK || {}).SPEED, paused: !!(x.session.CLOCK || {}).PAUSED, readOnly: x.session.MODE === 'REPLAY' };
}

async function nextActions(x, w) {
  const out = [];
  const me = w.WORKER_ID;
  const perms = x.perms || [];
  // operator: tanks I worked on that await my self-check / inspection, rework returns assigned to my station, support requests
  const recentDone = await V.sim(x, 'sim_tasks', { WORKER_ID: me, STATUS: 'COMPLETED' }, { sort: { UPDATED_AT: -1 }, limit: 5 });
  for (const t of recentDone) {
    const u = await V.simOne(x, 'sim_units', { UNIT_ID: t.UNIT_ID });
    if (u && ['WORK_COMPLETED_AWAITING_INSPECTION', 'REWORK_COMPLETE_AWAITING_REINSPECTION'].includes(u.STATE) && u.LAST_LABOR_OPERATION_INSTANCE_ID === t.OPERATION_INSTANCE_ID) {
      const sc = await V.simOne(x, 'sim_inspections', { UNIT_ID: u.UNIT_ID, INSPECTION_KIND: 'SELF_CHECK', INSPECTED_OPERATION_INSTANCE_ID: t.OPERATION_INSTANCE_ID });
      out.push({ type: 'POST_TASK_INSPECTION', unitId: u.UNIT_ID, serial: u.TANK_SERIAL_NO, text: sc ? `Self-check ${sc.STATUS === 'DRAFT' ? 'draft saved' : 'submitted (' + sc.RESULT + ')'} - waiting for independent gate inspection` : `Work complete on ${u.TANK_SERIAL_NO}: record the post-task self-check, then the gate inspector releases it`, selfCheckId: sc ? sc.INSPECTION_ID : null, canStartSelfCheck: !sc });
    }
  }
  const myStations = [w.CURRENT_WORKSTATION_ID].filter(Boolean);
  if (myStations.length) {
    const rw = await V.sim(x, 'sim_units', { STATE: { $in: ['QUEUED_FOR_REWORK', 'RECEIVED_AT_REWORK_STATION'] }, CURRENT_WORKSTATION_ID: { $in: myStations } });
    for (const u of rw) out.push({ type: 'REWORK_RETURN', unitId: u.UNIT_ID, serial: u.TANK_SERIAL_NO, text: `Approved rework returned to your station: ${u.TANK_SERIAL_NO} (${(u.REWORK_PENDING || {}).ORIGIN_OPERATION_ID || ''})`, returnId: (u.REWORK_PENDING || {}).RETURN_ID });
  }
  if (perms.includes('perform_quality_inspection')) {
    const wc = w.CURRENT_WORK_CENTER_ID || w.PLANNED_WORK_CENTER_ID || w.HOME_WORK_CENTER_ID;
    const waiting = await V.sim(x, 'sim_units', { STATE: { $in: ['WORK_COMPLETED_AWAITING_INSPECTION', 'REWORK_COMPLETE_AWAITING_REINSPECTION', 'INCOMPLETE_INSPECTION_HOLD', 'PASS_PENDING_RELEASE'] }, ...(wc && wc !== 'QA' ? { $or: [{ CURRENT_WORK_CENTER_ID: wc, ASSIGNED_INSPECTOR_ID: null }, { ASSIGNED_INSPECTOR_ID: me }] } : { $or: [{ ASSIGNED_INSPECTOR_ID: null }, { ASSIGNED_INSPECTOR_ID: me }] }) }, { limit: 20 });
    for (const u of waiting) out.push({ type: u.STATE === 'PASS_PENDING_RELEASE' ? 'RELEASE' : 'GATE_INSPECTION', unitId: u.UNIT_ID, serial: u.TANK_SERIAL_NO, workCenterId: u.CURRENT_WORK_CENTER_ID, state: u.STATE,
      text: u.STATE === 'PASS_PENDING_RELEASE' ? `${u.TANK_SERIAL_NO} passed - release to the next operation` : `${u.TANK_SERIAL_NO} awaits ${u.STATE === 'REWORK_COMPLETE_AWAITING_REINSPECTION' ? 'reinspection' : u.STATE === 'INCOMPLETE_INSPECTION_HOLD' ? 'completion of an incomplete inspection' : 'gate inspection'} at ${u.CURRENT_WORKSTATION_ID || u.CURRENT_WORK_CENTER_ID}` });
  }
  const sup = await V.sim(x, 'sim_support_requests', { REQUESTED_BY: me, STATUS: 'OPEN' });
  for (const s of sup) out.push({ type: 'SUPPORT_OPEN', text: `Help requested ${V.loc(x, s.REQUESTED_AT).slice(11, 16)} - waiting for a supervisor`, supportRequestId: s.SUPPORT_REQUEST_ID });
  if (w.ACTIVITY_STATE === 'TRANSFER') out.push({ type: 'TRANSFER_ARRIVE', text: `Transfer to ${w.TRANSFER_TO_WORK_CENTER_ID} - confirm arrival when you are there (planned ${V.loc(x, w.TRANSFER_ARRIVE_AT).slice(11, 16)})` });
  return out;
}

async function queue(x, workerId) {
  const w = await workerDoc(x, workerId);
  const mine = await V.sim(x, 'sim_tasks', { WORKER_ID: workerId, STATUS: { $in: ACTIVE } });
  const working = mine.find(t => t.STATUS === 'WORKING');
  const assigned = [];
  for (const t of mine) {
    const op = await V.simOne(x, 'sim_operations', { OPERATION_INSTANCE_ID: t.OPERATION_INSTANCE_ID });
    const unit = await V.simOne(x, 'sim_units', { UNIT_ID: t.UNIT_ID });
    const eq = op && op.EQUIPMENT_ID ? await V.simOne(x, 'sim_equipment', { EQUIPMENT_ID: op.EQUIPMENT_ID }) : null;
    const reasons = t.STATUS === 'WORKING' ? [] : whyCannotStart(x, w, t, op, unit, eq, working && working.TASK_ID !== t.TASK_ID ? working : null);
    assigned.push({ kind: 'ASSIGNED', taskId: t.TASK_ID, status: t.STATUS, version: t.VERSION, unitId: t.UNIT_ID, serial: unit && unit.TANK_SERIAL_NO, operationId: t.OPERATION_ID, operationInstanceId: t.OPERATION_INSTANCE_ID,
      workstationId: op && op.WORKSTATION_ID, priorityClass: unit && unit.PRIORITY_CLASS, dueAt: unit && unit.DUE_AT, ready: reasons.length === 0, blockedReasons: reasons, pauseReason: t.PAUSE_REASON || null });
  }
  // planned (forward plan rows known at the fork, not history)
  const plans = await x.db.collection('worker_task_plan').find({ RUN_ID: x.src, WORKER_ID: workerId, PLAN_SOURCE: 'CHECKPOINT_DISPATCH_PLAN', KNOWN_AT: { $lte: x.histCut } }, { projection: { _seed: 0, _id: 0 } }).sort({ PLANNED_START_AT: 1 }).toArray();
  const planned = plans.map(p => ({ kind: 'PLANNED', planId: p.PLAN_ID, unitId: p.UNIT_ID, operationId: p.OPERATION_ID, workstationId: p.WORKSTATION_ID, plannedStartLocal: V.loc(x, p.PLANNED_START_AT), plannedEndLocal: V.loc(x, p.PLANNED_END_AT),
    sequence: p.SEQUENCE_NO, priority: p.PRIORITY_CLASS || p.PRIORITY, dependsOn: p.DEPENDS_ON_EVENT_ID || null, note: 'Planned at the checkpoint - not yet assigned; dispatch decides the actual assignment' }));
  // eligible queue work at work centres where the worker holds a valid qualification for the next operation
  const queued = await V.sim(x, 'sim_units', { STATE: { $in: ['QUEUED', 'QUEUED_FOR_REWORK', 'RECEIVED_AT_REWORK_STATION'] } });
  const eligible = [];
  for (const u of queued) {
    const def = C.opDef(x.cat, u.PRODUCT_ID, u.ROUTE_STEP);
    if (!def || def.OPERATION_KIND !== 'LABOR') continue;
    const qual = C.qualified(x.cat, workerId, def.REQUIRED_SKILL_ID, x.now);
    if (!qual) continue;
    const stations = C.stationsOf(x.cat, def.WORK_CENTER_ID);
    const free = [];
    for (const s of stations) {
      if (u.REWORK_PENDING && u.REWORK_PENDING.DEST_WORKSTATION_ID && s.WORKSTATION_ID !== u.REWORK_PENDING.DEST_WORKSTATION_ID) continue;
      const occ = await x.db.collection('sim_units').findOne({ SESSION_ID: x.sid, CURRENT_WORKSTATION_ID: s.WORKSTATION_ID, UNIT_ID: { $ne: u.UNIT_ID }, STATE: { $nin: ['QUEUED', 'IN_TRANSFER', 'ROUTE_COMPLETE', 'SCRAPPED', 'RETURN_REQUESTED', 'IN_RETURN_TRANSFER', 'CURING'] } });
      const eq = s.EQUIPMENT_ID ? await V.simOne(x, 'sim_equipment', { EQUIPMENT_ID: s.EQUIPMENT_ID }) : null;
      if (!occ && !(eq && eq.STATUS === 'DOWN')) free.push(s.WORKSTATION_ID);
    }
    const reasons = [];
    if (!free.length) reasons.push(u.REWORK_PENDING ? `Authorised rework station ${u.REWORK_PENDING.DEST_WORKSTATION_ID} is occupied or down` : 'No free workstation');
    if (w.ATTENDANCE_STATE !== 'CLOCKED_IN') reasons.push('Clock in first');
    if (working) reasons.push('Finish or pause your current task first');
    eligible.push({ kind: u.STATE === 'QUEUED' ? 'QUEUE' : 'REWORK_QUEUE', unitId: u.UNIT_ID, serial: u.TANK_SERIAL_NO, operationId: u.ROUTE_STEP, workCenterId: def.WORK_CENTER_ID, priorityClass: u.PRIORITY_CLASS,
      dueAt: u.DUE_AT, dueLocal: V.loc(x, u.DUE_AT), queuedSince: u.QUEUE_ENTERED_AT, waitedMin: u.QUEUE_ENTERED_AT ? Math.max(0, Math.round((x.now - new Date(u.QUEUE_ENTERED_AT)) / 60000)) : null, timingNote: u.TIMING_NOTE || null,
      freeWorkstations: free, minCrew: u.REWORK_PENDING ? 1 : def.MIN_CREW_SIZE, ready: reasons.length === 0, blockedReasons: reasons, rework: !!u.REWORK_PENDING });
  }
  eligible.sort((a, b) => (a.priorityClass || 3) - (b.priorityClass || 3) || (new Date(a.dueAt || 8.64e15) - new Date(b.dueAt || 8.64e15)) || (new Date(a.queuedSince || 0) - new Date(b.queuedSince || 0)));
  // joinable operations at my work centre (crew below standard)
  const wc = w.CURRENT_WORK_CENTER_ID || w.PLANNED_WORK_CENTER_ID || w.HOME_WORK_CENTER_ID;
  const ops = await V.sim(x, 'sim_operations', { WORK_CENTER_ID: wc, OPERATION_KIND: 'LABOR', STATE: { $in: ['WORKING', 'BELOW_MIN_CREW', 'PAUSED', 'CREATED'] } });
  const joinable = [];
  for (const o of ops) {
    if (mine.some(t => t.OPERATION_INSTANCE_ID === o.OPERATION_INSTANCE_ID)) continue;
    const active = await V.sim(x, 'sim_tasks', { OPERATION_INSTANCE_ID: o.OPERATION_INSTANCE_ID, STATUS: { $in: ACTIVE } });
    if (o.MAX_CREW_SIZE && active.length >= o.MAX_CREW_SIZE) continue;
    if (!C.qualified(x.cat, workerId, o.REQUIRED_SKILL_ID, x.now)) continue;
    const ju = await V.simOne(x, 'sim_units', { UNIT_ID: o.UNIT_ID });
    joinable.push({ kind: 'JOIN', operationInstanceId: o.OPERATION_INSTANCE_ID, unitId: o.UNIT_ID, serial: ju ? ju.TANK_SERIAL_NO || null : null, operationId: o.OPERATION_ID, workstationId: o.WORKSTATION_ID, state: o.STATE, crew: active.length, minCrew: o.MIN_CREW_SIZE, stdCrew: o.STD_CREW_SIZE, maxCrew: o.MAX_CREW_SIZE });
  }
  return { session: sessionHeader(x), worker: V.mapWorker(x, w), assigned, joinable, eligibleQueue: eligible.slice(0, 30), planned,
    ordering: 'DR-1.0: priority class (1 = rework/replacement, 2 = high-priority order, 3 = normal), then due time, then time in queue' };
}

async function progress(x, workerId) {
  const w = await workerDoc(x, workerId);
  // labour categories for the current shift: history (worker events up to the fork, this shift) + session participation segments
  const cats = {};
  const add = (k, m) => { cats[k] = Math.round(((cats[k] || 0) + m) * 10) / 10; };
  if (w.SHIFT_ID) {
    const ev = await x.db.collection('worker_events').find({ RUN_ID: x.src, WORKER_ID: workerId, SHIFT_ID: w.SHIFT_ID, EVENT_TIME: { $lte: x.histCut }, KNOWN_AT: { $lte: x.histCut } }, { projection: { EVENT_TIME: 1, STATE_AFTER: 1, REASON_CODE: 1, EVENT_ID: 1 } }).sort({ EVENT_TIME: 1, EVENT_ID: 1 }).toArray();
    for (let i = 0; i < ev.length; i++) {
      const end = i + 1 < ev.length ? new Date(ev[i + 1].EVENT_TIME) : x.histCut;
      const m = Math.max(0, (end - new Date(ev[i].EVENT_TIME)) / 60000);
      const st = ev[i].STATE_AFTER;
      const k = st === 'WORKING' ? (ev[i].REASON_CODE === 'REWORK' ? 'REWORK' : 'DIRECT') : st === 'AVAILABLE_WAITING' ? 'WAITING' : st;
      if (!['OFF_SHIFT'].includes(k)) add(k, m);
    }
  }
  const segs = x.session.MODE === 'INTERACTIVE' ? await V.sim(x, 'sim_participation', { WORKER_ID: workerId }) : [];
  for (const s of segs) add(s.CATEGORY, Math.max(0, ((s.END_AT ? new Date(s.END_AT) : x.now) - new Date(s.START_AT)) / 60000));
  const done = await V.sim(x, 'sim_tasks', { WORKER_ID: workerId, STATUS: { $in: ['COMPLETED', 'ENDED_BEFORE_OPERATION_FINISH', 'HANDED_OVER'] }, ORIGIN: { $ne: 'INHERITED_AT_FORK' } });
  const histDone = w.SHIFT_ID ? await x.db.collection('task_events').find({ RUN_ID: x.src, WORKER_ID: workerId, EVENT_TYPE: 'COMPLETED', EVENT_TIME: { $lte: x.histCut, $gte: w.PLANNED_START_AT ? new Date(new Date(w.PLANNED_START_AT).getTime() - 3600000) : x.histCut }, KNOWN_AT: { $lte: x.histCut } }, { projection: { TASK_ID: 1, OPERATION_INSTANCE_ID: 1, EVENT_TIME: 1 } }).toArray() : [];
  const ms = await V.sim(x, 'sim_milestones', { RECORDED_BY_WORKER_ID: workerId });
  // crew shares of accepted (released) operations
  const shares = [];
  const opIds = [...new Set([...done.map(t => t.OPERATION_INSTANCE_ID), ...histDone.map(t => t.OPERATION_INSTANCE_ID)])];
  for (const oid of opIds.slice(0, 40)) {
    const op = await V.simOne(x, 'sim_operations', { OPERATION_INSTANCE_ID: oid }) || await x.db.collection('operation_instances').findOne({ RUN_ID: x.src, OPERATION_INSTANCE_ID: oid }, { projection: { _seed: 0 } });
    if (!op || op.OPERATION_KIND !== 'LABOR') continue;
    const unit = await V.simOne(x, 'sim_units', { UNIT_ID: op.UNIT_ID });
    const gate = C.gateAfter(x.cat, op.PRODUCT_ID, op.OPERATION_ID);
    const released = unit ? ((unit.PASSED_GATES || []).includes(gate) || ['ROUTE_COMPLETE'].includes(unit.STATE) || (C.route(x.cat, unit.PRODUCT_ID).indexOf(unit.ROUTE_STEP) > C.route(x.cat, unit.PRODUCT_ID).indexOf(gate))) : null;
    const mine = await V.eligibleMinutes(x, workerId, oid);
    const crewIds = [...new Set([...(await V.sim(x, 'sim_tasks', { OPERATION_INSTANCE_ID: oid })).map(t => t.WORKER_ID)])];
    let total = 0;
    for (const cw of crewIds) total += (await V.eligibleMinutes(x, cw, oid)).totalMin;
    if (total <= mine.totalMin) total = Math.max(total, mine.totalMin);
    shares.push({ operationInstanceId: oid, unitId: op.UNIT_ID, operationId: op.OPERATION_ID, myEligibleMin: mine.totalMin, crewEligibleMin: total, share: total ? Math.round(mine.totalMin / total * 1000) / 1000 : null, accepted: released ? 'RELEASED' : 'NOT_YET_RELEASED' });
  }
  const pts = await V.pointsFor(x, workerId);
  const ledgerH = await x.db.collection('points_ledger').find({ RUN_ID: x.src, WORKER_ID: workerId, KNOWN_AT: { $lte: x.histCut } }, { projection: { _seed: 0, _id: 0 } }).sort({ KNOWN_AT: -1 }).limit(30).toArray();
  const ledgerS = await V.sim(x, 'sim_points_ledger', { WORKER_ID: workerId, KNOWN_AT: { $lte: x.now } }, { sort: { KNOWN_AT: -1 }, limit: 50 });
  const inv = await V.sim(x, 'sim_investigations', { STATUS: { $in: ['OPEN_UNKNOWN', 'SUSPECTED'] } });
  const pendingInv = [];
  for (const i of inv) {
    const crew = i.SUSPECTED_ORIGIN_OPERATION_INSTANCE_ID ? await V.sim(x, 'sim_tasks', { OPERATION_INSTANCE_ID: i.SUSPECTED_ORIGIN_OPERATION_INSTANCE_ID, WORKER_ID: workerId }) : [];
    if (crew.length) pendingInv.push({ investigationId: i.INVESTIGATION_ID, defectId: i.DEFECT_ID, unitId: i.UNIT_ID, status: i.STATUS, note: 'You worked on the operation linked to this defect. Involvement is not fault - no points change unless a reviewer confirms responsibility.' });
  }
  // provisional points: evaluations that are not final yet (re-evaluated every pass; nothing is booked for them until they are)
  const pend = x.session.MODE === 'INTERACTIVE' ? await V.sim(x, 'sim_points_evaluations', { STATUS: 'PENDING', $or: [{ [`EVIDENCE.eligibleMinByWorker.${workerId}`]: { $exists: true } }, { [`EVIDENCE.contributionMin.${workerId}`]: { $exists: true } }] }) : [];
  const pendingPoints = pend.map(e => ({ subject: e.SUBJECT_KEY, rule: e.RULE_ID, status: e.STATUS, reason: e.REASON, unitId: e.UNIT_ID || null, orderId: e.ORDER_ID || null,
    operationInstanceId: e.OPERATION_INSTANCE_ID || null, myEligibleMin: ((e.EVIDENCE || {}).eligibleMinByWorker || {})[workerId] ?? null, evaluatedAt: e.AS_OF, calculationId: e.CALCULATION_ID }));
  const mine = await V.sim(x, 'sim_tasks', { WORKER_ID: workerId, STATUS: { $in: ACTIVE } });
  return { session: sessionHeader(x), worker: V.mapWorker(x, w), shift: shiftInfo(x, w), laborCategoriesMin: cats,
    categoriesBasis: 'Current shift: recorded history up to the fork plus this session\'s participation segments; categories are mutually exclusive',
    tasksCompleted: { session: done.length, historyThisShift: histDone.length }, milestonesRecorded: ms.length, crewShares: shares, remainingAssigned: mine.length,
    points: pts, ledger: [...ledgerS.map(l => ({ ...l, scope: 'SESSION' })), ...ledgerH.map(l => ({ ...l, scope: 'HISTORY' }))], pendingInvestigations: pendingInv,
    pendingPoints, pointsBasis: 'Session rows use rule version 2.0 (time points to 2 decimals, re-evaluated with linked reversals); history rows keep the source workbook values' };
}

module.exports = { home, queue, progress, taskDetail, milestoneView, sessionHeader, shiftInfo };
