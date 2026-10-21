'use strict';
/* Operator task, attendance, break, milestone and control commands. */
const { register } = require('../executor');
const H = require('../helpers');
const C = require('../catalog');
const E = require('../../lib/errors');

const PAUSE_REASONS = {
  PLANNED_BREAK: { activity: 'BREAK', category: 'BREAK', external: true },
  UNPLANNED_BREAK_PERSONAL: { activity: 'BREAK', category: 'BREAK', external: false },
  MATERIAL_SHORTAGE: { activity: 'WAITING', category: 'WAITING', external: true },
  EQUIPMENT_DOWN: { activity: 'WAITING', category: 'WAITING', external: true },
  WAITING_FOR_INSTRUCTION: { activity: 'WAITING', category: 'WAITING', external: true },
  SUPERVISOR_DIRECTED_TRANSFER: { activity: 'TRANSFER', category: 'TRANSFER', external: true },
  HELP_REQUESTED: { activity: 'WAITING', category: 'WAITING', external: true },
  SHIFT_END: { activity: 'OFF_SHIFT', category: null, external: true },
  HANDOVER_PENDING: { activity: 'AVAILABLE', category: 'WAITING', external: true },
  OTHER: { activity: 'WAITING', category: 'WAITING', external: false },
};

async function takeControlImplicit(tx, worker) {
  if (tx.actor.kind !== 'HUMAN' || tx.actor.workerId !== worker.WORKER_ID) return worker;
  // a HUMAN_ONLY person (admin-created / fresh factory) stays HUMAN_ONLY: a lease would expire and could hand them to an agent
  if (worker.CONTROL && worker.CONTROL.MODE === 'HUMAN_ONLY') return worker;
  if (worker.CONTROL && worker.CONTROL.MODE === 'HUMAN' && worker.CONTROL.LOGIN_ID === tx.actor.loginId) return worker;
  const doc = await tx.update('sim_workers', { WORKER_ID: worker.WORKER_ID }, { CONTROL: { MODE: 'HUMAN', LOGIN_ID: tx.actor.loginId, SINCE: tx.received, LEASE_EXPIRES_AT: new Date(Date.now() + 120000) } });
  await tx.event('HUMAN_CONTROL_TAKEN', 'WORKER', worker.WORKER_ID, { LOGIN_ID: tx.actor.loginId, IMPLICIT: true });
  return doc;
}

async function loadTaskCtx(tx, taskId) {
  const task = await tx.must('sim_tasks', { TASK_ID: taskId }, 'Task');
  H.assertOwner(tx, task.WORKER_ID);
  let worker = await tx.must('sim_workers', { WORKER_ID: task.WORKER_ID }, 'Worker');
  H.assertAgentMayAct(tx, worker);
  worker = await takeControlImplicit(tx, worker);
  const op = await tx.must('sim_operations', { OPERATION_INSTANCE_ID: task.OPERATION_INSTANCE_ID }, 'Operation');
  const unit = await tx.must('sim_units', { UNIT_ID: task.UNIT_ID }, 'Tank');
  return { task, worker, op, unit };
}

async function consumeMaterialIfFirstStart(tx, op, unit) {
  if (op.MATERIAL_CONSUMED || String(op.INSTANCE_TYPE || '').endsWith('REWORK') || op.OPERATION_KIND !== 'LABOR') return;
  const cat = await C.catalog();
  const reqs = cat.matReqs.filter(r => r.PRODUCT_ID === unit.PRODUCT_ID && r.CONSUMED_AT_OPERATION_ID === op.OPERATION_ID);
  for (const r of reqs) {
    const m = await tx.one('sim_materials', { MATERIAL_ID: r.MATERIAL_ID });
    if (!m && tx.session.FACTORY_SESSION) {
      await tx.update('sim_operations', { OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID }, { BLOCKED_REASON: 'MATERIAL_SHORTAGE', BLOCKED_MATERIAL_ID: r.MATERIAL_ID });
      throw E.conflict('MATERIAL_SHORTAGE', `No stock of ${r.MATERIAL_ID} has been received (inventory is never assumed). Receive stock first.`, { materialId: r.MATERIAL_ID, available: 0, needed: r.QTY_PER_UNIT });
    }
    if (!m) continue;
    const ownReservation = unit.RESERVED_MATERIAL === r.MATERIAL_ID ? Number(r.QTY_PER_UNIT || 0) : 0;
    const avail = Number(m.ON_HAND_QTY || 0) - Number(m.HOLD_QTY || 0) - Number(m.RESERVED_QTY || 0) + ownReservation;
    if (avail < Number(r.QTY_PER_UNIT || 0)) {
      await tx.update('sim_operations', { OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID }, { BLOCKED_REASON: 'MATERIAL_SHORTAGE', BLOCKED_MATERIAL_ID: r.MATERIAL_ID });
      throw E.conflict('MATERIAL_SHORTAGE', `Not enough ${m.MATERIAL_NAME || r.MATERIAL_ID} available (${avail} ${m.UOM || ''} usable, ${r.QTY_PER_UNIT} needed). The operation is blocked by material - not a performance issue.`, { materialId: r.MATERIAL_ID, available: avail, needed: r.QTY_PER_UNIT });
    }
    await tx.update('sim_materials', { MATERIAL_ID: r.MATERIAL_ID }, { ON_HAND_QTY: Math.round((Number(m.ON_HAND_QTY) - Number(r.QTY_PER_UNIT)) * 1000) / 1000, RESERVED_QTY: Math.max(0, Number(m.RESERVED_QTY || 0) - ownReservation) });
    await tx.event('MATERIAL_CONSUMED', 'MATERIAL', r.MATERIAL_ID, { QTY: -Number(r.QTY_PER_UNIT), UOM: r.UOM, UNIT_ID: unit.UNIT_ID, OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID, MOVEMENT_TYPE: 'ISSUE_TO_OPERATION' });
  }
  await tx.update('sim_operations', { OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID }, { MATERIAL_CONSUMED: true, BLOCKED_REASON: null });
}

async function startWork(tx, ctx) {
  const { task, worker, op, unit } = ctx;
  const cat = await C.catalog();
  if (worker.ATTENDANCE_STATE !== 'CLOCKED_IN') throw E.conflict('NOT_CLOCKED_IN', 'Clock in before starting work (signing in to the app does not clock you in).');
  await require('./scan').assertTaskScanned(tx, task, worker);
  if (worker.ACTIVITY_STATE === 'BREAK') throw E.conflict('ON_BREAK', 'End your break before starting work.');
  if (worker.ACTIVITY_STATE === 'TRANSFER') throw E.conflict('IN_TRANSFER', 'You are in transfer; confirm arrival first.');
  const others = (await tx.many('sim_tasks', { WORKER_ID: worker.WORKER_ID, STATUS: 'WORKING' })).filter(t => t.TASK_ID !== task.TASK_ID);
  if (others.length) throw E.conflict('ALREADY_WORKING', `Already working on task ${others[0].TASK_ID} (tank ${others[0].UNIT_ID}). Pause or finish it first - one person cannot be productive at two stations.`, { activeTaskId: others[0].TASK_ID });
  if (['WORK_COMPLETED', 'CANCELLED'].includes(op.STATE)) throw E.conflict('OPERATION_CLOSED', `Operation ${op.OPERATION_INSTANCE_ID} is ${op.STATE}`);
  if (H.UNIT_HOLD.has(unit.STATE) || H.TERMINAL.has(unit.STATE)) throw E.conflict('UNIT_NOT_WORKABLE', `Tank ${unit.TANK_SERIAL_NO} is ${unit.STATE.replace(/_/g, ' ').toLowerCase()} - no work may start until an authorised release or disposition.`, { unitState: unit.STATE });
  if (['WORK_COMPLETED_AWAITING_INSPECTION', 'INSPECTION_IN_PROGRESS', 'PASS_PENDING_RELEASE', 'REWORK_COMPLETE_AWAITING_REINSPECTION', 'REINSPECTION_IN_PROGRESS'].includes(unit.STATE)) throw E.conflict('AWAITING_INSPECTION', 'Work is complete and the tank is awaiting inspection/release.');
  const def = C.opDef(cat, unit.PRODUCT_ID, op.OPERATION_ID) || {};
  const skill = op.REQUIRED_SKILL_ID || def.REQUIRED_SKILL_ID;
  if (skill && !C.qualified(cat, worker.WORKER_ID, skill, tx.now)) throw E.forbidden(`Not qualified for ${skill} at ${tx.now.toISOString()} (valid qualification required)`, { skill });
  if (op.EQUIPMENT_ID) {
    const eq = await tx.one('sim_equipment', { EQUIPMENT_ID: op.EQUIPMENT_ID });
    if (eq && eq.STATUS === 'DOWN') throw E.conflict('EQUIPMENT_DOWN', `${op.EQUIPMENT_ID} is down (${eq.REASON_CODE || 'breakdown'}); waiting is recorded as an external block, not a performance issue.`);
  }
  await consumeMaterialIfFirstStart(tx, op, unit);
  const rework = String(op.INSTANCE_TYPE || '').endsWith('REWORK');
  const t2 = await H.moveTask(tx, task, 'WORKING', { STARTED_AT: task.STARTED_AT || tx.now, ACCEPTED_AT: task.ACCEPTED_AT || tx.now, PAUSE_REASON: null });
  await H.segment(tx, worker.WORKER_ID, rework ? 'REWORK' : (op.OPERATION_KIND === 'INSPECTION' ? 'INSPECTING' : 'DIRECT'), { OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID, UNIT_ID: unit.UNIT_ID, WORKSTATION_ID: op.WORKSTATION_ID, WORK_CENTER_ID: op.WORK_CENTER_ID });
  await H.setWorker(tx, worker, { ACTIVITY_STATE: op.OPERATION_KIND === 'INSPECTION' ? 'INSPECTING' : 'WORKING', REASON_CODE: 'PRODUCTION', CURRENT_TASK_ID: task.TASK_ID, CURRENT_OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID, CURRENT_WORKSTATION_ID: op.WORKSTATION_ID, CURRENT_WORK_CENTER_ID: op.WORK_CENTER_ID }, 'WORKER_WORK_START');
  const op2 = await H.refreshOperation(tx, op.OPERATION_INSTANCE_ID);
  return { task: t2, operation: op2 };
}

register('TASK_ACCEPT', {
  perm: 'operate_own_tasks',
  handler: async (tx, p) => {
    const ctx = await loadTaskCtx(tx, p.taskId);
    if (p.expectedVersion !== undefined && p.expectedVersion !== ctx.task.VERSION) throw E.conflict('VERSION_CONFLICT', 'Task changed - reload', { current: ctx.task.VERSION });
    return { task: await H.moveTask(tx, ctx.task, 'ACCEPTED', { ACCEPTED_AT: tx.now }) };
  },
});

register('TASK_START', {
  perm: 'operate_own_tasks',
  handler: async (tx, p) => {
    const ctx = await loadTaskCtx(tx, p.taskId);
    if (p.expectedVersion !== undefined && p.expectedVersion !== ctx.task.VERSION) throw E.conflict('VERSION_CONFLICT', 'Task changed - reload', { current: ctx.task.VERSION, status: ctx.task.STATUS });
    if (ctx.task.STATUS === 'PAUSED') throw E.conflict('USE_RESUME', 'Task is paused - use resume');
    return startWork(tx, ctx);
  },
});

register('TASK_RESUME', {
  perm: 'operate_own_tasks',
  handler: async (tx, p) => {
    const ctx = await loadTaskCtx(tx, p.taskId);
    if (ctx.task.STATUS !== 'PAUSED') throw E.conflict('NOT_PAUSED', `Task is ${ctx.task.STATUS}`);
    return startWork(tx, ctx);
  },
});

async function pauseTask(tx, ctx, reason, note) {
  const rs = PAUSE_REASONS[reason];
  if (!rs) throw E.bad('INVALID_REASON', `Pause reason must be one of ${Object.keys(PAUSE_REASONS).join(', ')}`);
  const { task, worker, op } = ctx;
  const t2 = await H.moveTask(tx, task, 'PAUSED', { PAUSED_AT: tx.now, PAUSE_REASON: reason, PAUSE_NOTE: note || null, PAUSE_EXTERNAL: rs.external });
  await H.segment(tx, worker.WORKER_ID, rs.category, { REASON: reason, OPERATION_INSTANCE_ID: rs.category === 'WAITING' ? op.OPERATION_INSTANCE_ID : null, WORKSTATION_ID: op.WORKSTATION_ID, WORK_CENTER_ID: op.WORK_CENTER_ID });
  await H.setWorker(tx, worker, { ACTIVITY_STATE: rs.activity, REASON_CODE: reason, CURRENT_TASK_ID: task.TASK_ID, BREAK_STARTED_AT: rs.activity === 'BREAK' ? tx.now : worker.BREAK_STARTED_AT || null }, 'WORKER_TASK_PAUSED');
  const op2 = await H.refreshOperation(tx, op.OPERATION_INSTANCE_ID);
  return { task: t2, operation: op2 };
}

register('TASK_PAUSE', {
  perm: 'operate_own_tasks',
  handler: async (tx, p) => {
    const ctx = await loadTaskCtx(tx, p.taskId);
    if (ctx.task.STATUS !== 'WORKING') throw E.conflict('NOT_WORKING', `Task is ${ctx.task.STATUS}`);
    return pauseTask(tx, ctx, p.reason || 'OTHER', p.note);
  },
});

register('MILESTONE_COMPLETE', {
  perm: 'operate_own_tasks',
  handler: async (tx, p) => {
    const cat = await C.catalog();
    const op = await tx.must('sim_operations', { OPERATION_INSTANCE_ID: p.operationInstanceId }, 'Operation');
    const myTask = tx.actor.kind === 'HUMAN' ? (await tx.many('sim_tasks', { OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID, WORKER_ID: tx.actor.workerId, STATUS: 'WORKING' }))[0] : null;
    if (tx.actor.kind === 'HUMAN' && !myTask && !(tx.actor.permissions || []).includes('operational_supervision')) throw E.forbidden('Only a crew member who is working on this operation can record its milestones');
    if (op.STATE !== 'WORKING' && op.STATE !== 'BELOW_MIN_CREW') throw E.conflict('OPERATION_NOT_WORKING', `Operation is ${op.STATE}`);
    const ms = C.milestonesFor(cat, op.OPERATION_ID, String(op.INSTANCE_TYPE || '').endsWith('REWORK') ? 'REWORK' : 'STANDARD').filter(m => m.ATTENDED !== 'N');
    const m = ms.find(x => x.MILESTONE_ID === p.milestoneId);
    if (!m) throw E.bad('UNKNOWN_MILESTONE', `Milestone ${p.milestoneId} does not belong to ${op.OPERATION_ID}`);
    const done = new Set(op.MILESTONES_DONE || []);
    if (done.has(m.MILESTONE_ID)) return { operation: op, alreadyRecorded: true };
    const final = ms[ms.length - 1];
    if (final && m.MILESTONE_ID === final.MILESTONE_ID) throw E.conflict('USE_FINISH', 'The final milestone (work complete) is recorded by finishing the work');
    const missing = ms.filter(x => x.SEQUENCE_NO < m.SEQUENCE_NO && !done.has(x.MILESTONE_ID));
    if (missing.length) throw E.conflict('MILESTONE_ORDER', `Record earlier milestones first: ${missing.map(x => x.MILESTONE_NAME).join(', ')}`, { missing: missing.map(x => x.MILESTONE_ID) });
    const id = await tx.nextId('MSE');
    await tx.insert('sim_milestones', { MILESTONE_EVENT_ID: id, OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID, UNIT_ID: op.UNIT_ID, MILESTONE_ID: m.MILESTONE_ID, SEQUENCE_NO: m.SEQUENCE_NO, MILESTONE_NAME: m.MILESTONE_NAME,
      EVENT_TIME: tx.now, KNOWN_AT: tx.now, RECORDED_BY_WORKER_ID: tx.actor.workerId || (myTask && myTask.WORKER_ID), WORKSTATION_ID: op.WORKSTATION_ID, EVIDENCE_BASIS: tx.actor.kind === 'HUMAN' ? 'OPERATOR_CHECKLIST' : 'ENGINE_LABOR_PROGRESS' });
    const op2 = await tx.update('sim_operations', { OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID }, { LAST_MILESTONE_ID: m.MILESTONE_ID, LAST_MILESTONE_AT: tx.now }, { addToSet: { MILESTONES_DONE: m.MILESTONE_ID } });
    await tx.event('MILESTONE_REACHED', 'OPERATION', op.OPERATION_INSTANCE_ID, { MILESTONE_ID: m.MILESTONE_ID, SEQUENCE_NO: m.SEQUENCE_NO, UNIT_ID: op.UNIT_ID });
    return { operation: op2, milestone: id };
  },
});

/** finishing work completes the attempt's work (not inspection, not release) */
async function finishOperation(tx, op, finisherId) {
  const cat = await C.catalog();
  const ms = C.milestonesFor(cat, op.OPERATION_ID, String(op.INSTANCE_TYPE || '').endsWith('REWORK') ? 'REWORK' : 'STANDARD').filter(m => m.ATTENDED !== 'N');
  const done = new Set(op.MILESTONES_DONE || []);
  const final = ms[ms.length - 1];
  const missing = ms.filter(m => (!final || m.MILESTONE_ID !== final.MILESTONE_ID) && !done.has(m.MILESTONE_ID));
  if (missing.length) throw E.conflict('MILESTONES_INCOMPLETE', `Complete the checklist first: ${missing.map(m => m.MILESTONE_NAME).join('; ')}. Progress is based on milestones, not on the timer.`, { missing: missing.map(m => m.MILESTONE_ID) });
  if (final) {
    const id = await tx.nextId('MSE');
    await tx.insert('sim_milestones', { MILESTONE_EVENT_ID: id, OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID, UNIT_ID: op.UNIT_ID, MILESTONE_ID: final.MILESTONE_ID, SEQUENCE_NO: final.SEQUENCE_NO, MILESTONE_NAME: final.MILESTONE_NAME,
      EVENT_TIME: tx.now, KNOWN_AT: tx.now, RECORDED_BY_WORKER_ID: finisherId, WORKSTATION_ID: op.WORKSTATION_ID, EVIDENCE_BASIS: 'WORK_FINISHED' });
  }
  const op2 = await tx.update('sim_operations', { OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID }, { STATE: 'WORK_COMPLETED', WORK_COMPLETED_AT: tx.now, PROGRESS_FRACTION: 1, LAST_MILESTONE_ID: final ? final.MILESTONE_ID : op.LAST_MILESTONE_ID, CREW: [] }, final ? { addToSet: { MILESTONES_DONE: final.MILESTONE_ID } } : {});
  await tx.event('OPERATION_WORK_COMPLETED', 'OPERATION', op.OPERATION_INSTANCE_ID, { UNIT_ID: op.UNIT_ID, OPERATION_ID: op.OPERATION_ID, FINISHED_BY: finisherId, NOTE: 'Work complete is not an inspection pass or a release' });
  // tasks of the attempt
  const tasks = await tx.many('sim_tasks', { OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID, STATUS: { $in: ['ASSIGNED', 'ACCEPTED', 'WORKING', 'PAUSED'] } });
  for (const t of tasks) {
    if (t.STATUS === 'WORKING') await H.moveTask(tx, t, 'COMPLETED', { COMPLETED_AT: tx.now, ENDED_REASON: 'OPERATION_FINISHED' }, { force: true });
    else if (t.STATUS === 'PAUSED' || t.STARTED_AT) await H.moveTask(tx, t, 'ENDED_BEFORE_OPERATION_FINISH', { ENDED_AT: tx.now, ENDED_REASON: 'OPERATION_FINISHED_BY_OTHER_CREW' }, { force: true });
    else await H.moveTask(tx, t, 'CANCELLED', { CANCELLED_AT: tx.now, ENDED_REASON: 'OPERATION_FINISHED_BEFORE_START' }, { force: true });
    const w = await tx.one('sim_workers', { WORKER_ID: t.WORKER_ID });
    if (w && w.CURRENT_TASK_ID === t.TASK_ID) {
      if (t.STATUS === 'WORKING') await H.segment(tx, w.WORKER_ID, 'WAITING', { REASON: 'AWAITING_NEXT_TASK', WORKSTATION_ID: op.WORKSTATION_ID, WORK_CENTER_ID: op.WORK_CENTER_ID });
      const stillOff = ['OFF_SHIFT', 'ABSENT'].includes(w.ACTIVITY_STATE) || w.ATTENDANCE_STATE !== 'CLOCKED_IN';
      await H.setWorker(tx, w, { ACTIVITY_STATE: stillOff ? w.ACTIVITY_STATE : (w.ACTIVITY_STATE === 'BREAK' ? 'BREAK' : 'AVAILABLE'), REASON_CODE: stillOff ? w.REASON_CODE : 'AWAITING_NEXT_TASK', CURRENT_TASK_ID: null, CURRENT_OPERATION_INSTANCE_ID: null }, 'WORKER_TASK_COMPLETED');
    }
  }
  // unit: awaiting inspection at the gate, or unattended process (cure) first
  const unit = await tx.must('sim_units', { UNIT_ID: op.UNIT_ID }, 'Tank');
  const next = C.nextOp(cat, unit.PRODUCT_ID, op.OPERATION_ID);
  const nextDef = next && next !== 'ROUTE_END' ? C.opDef(cat, unit.PRODUCT_ID, next) : null;
  const rework = String(op.INSTANCE_TYPE || '').endsWith('REWORK');
  if (nextDef && nextDef.OPERATION_KIND === 'PROCESS' && !rework) {
    const pid = await tx.nextId('OPI');
    const cure = Object.values(cat.stations).find(s => s.WORK_CENTER_ID === op.WORK_CENTER_ID && s.WORKSTATION_TYPE === 'CURE_ZONE');
    await tx.insert('sim_operations', { OPERATION_INSTANCE_ID: pid, UNIT_ID: unit.UNIT_ID, OPERATION_ID: next, OPERATION_KIND: 'PROCESS', PRODUCT_ID: unit.PRODUCT_ID, WORK_CENTER_ID: op.WORK_CENTER_ID,
      WORKSTATION_ID: cure ? cure.WORKSTATION_ID : op.WORKSTATION_ID, EQUIPMENT_ID: cure ? cure.EQUIPMENT_ID : null, ATTEMPT_NO: 1, INSTANCE_TYPE: 'PROCESS', STATE: 'CURING', PROGRESS_FRACTION: 0, CREW: [],
      CREATED_AT: tx.now, STARTED_AT: tx.now, STANDARD_ELAPSED_MIN: nextDef.STANDARD_ELAPSED_MIN, BATCH_ID: unit.BATCH_ID, MILESTONES_DONE: [], ORIGIN: 'BRANCH_NEW', ATTENDED: false });
    await tx.event('PROCESS_STARTED', 'OPERATION', pid, { UNIT_ID: unit.UNIT_ID, OPERATION_ID: next, NOTE: 'Unattended cure - process time, never counted as worker idle or labour' });
    await H.moveUnit(tx, unit, 'CURING', { ROUTE_STEP: next, CURRENT_OPERATION_INSTANCE_ID: pid, CURRENT_WORKSTATION_ID: cure ? cure.WORKSTATION_ID : op.WORKSTATION_ID, LAST_LABOR_OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID, LAST_LABOR_WORKSTATION_ID: op.WORKSTATION_ID });
  } else {
    const gate = C.gateAfter(cat, unit.PRODUCT_ID, op.OPERATION_ID);
    await H.moveUnit(tx, unit, rework ? 'REWORK_COMPLETE_AWAITING_REINSPECTION' : 'WORK_COMPLETED_AWAITING_INSPECTION',
      { ROUTE_STEP: gate || next, LAST_LABOR_OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID, LAST_LABOR_WORKSTATION_ID: op.WORKSTATION_ID, AWAITING_INSPECTION_SINCE: tx.now }, { force: rework && !['REWORK_IN_PROGRESS', 'WORKING'].includes(unit.STATE) });
    await tx.event('INSPECTION_REQUESTED', 'UNIT', unit.UNIT_ID, { GATE_OPERATION_ID: gate, INSPECTED_OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID, WORKSTATION_ID: op.WORKSTATION_ID });
    if (rework) {
      const ret = await tx.one('sim_returns', { REWORK_OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID });
      if (ret) await tx.update('sim_returns', { RETURN_ID: ret.RETURN_ID }, { REWORK_FINISHED_AT: tx.now, LOOP_STATUS: 'REWORK_COMPLETE_AWAITING_REINSPECTION' });
    }
  }
  return op2;
}

register('TASK_FINISH', {
  perm: 'operate_own_tasks',
  handler: async (tx, p) => {
    const ctx = await loadTaskCtx(tx, p.taskId);
    if (ctx.task.STATUS !== 'WORKING') throw E.conflict('NOT_WORKING', `Only a task in progress can be finished (task is ${ctx.task.STATUS})`);
    if (ctx.op.OPERATION_KIND !== 'LABOR') throw E.conflict('NOT_LABOR', 'Inspections are completed by submitting the inspection');
    if (ctx.op.STATE === 'BELOW_MIN_CREW') throw E.conflict('BELOW_MIN_CREW', 'The crew is below the minimum for this operation; work cannot be completed until the minimum crew is present');
    const op2 = await finishOperation(tx, ctx.op, ctx.worker.WORKER_ID);
    return { operation: op2 };
  },
});

register('TASK_JOIN', {
  perm: 'operate_own_tasks',
  handler: async (tx, p) => {
    const cat = await C.catalog();
    const workerId = p.workerId || tx.actor.workerId;
    H.assertOwner(tx, workerId);
    const worker = await tx.must('sim_workers', { WORKER_ID: workerId }, 'Worker');
    H.assertAgentMayAct(tx, worker);
    const op = await tx.must('sim_operations', { OPERATION_INSTANCE_ID: p.operationInstanceId }, 'Operation');
    if (['WORK_COMPLETED', 'CANCELLED', 'CURING'].includes(op.STATE) || op.OPERATION_KIND !== 'LABOR') throw E.conflict('OPERATION_NOT_JOINABLE', `Operation is ${op.STATE}`);
    const existing = await tx.one('sim_tasks', { OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID, WORKER_ID: workerId, STATUS: { $in: ['ASSIGNED', 'ACCEPTED', 'WORKING', 'PAUSED'] } });
    if (existing) return { task: existing, alreadyAssigned: true };
    const active = await tx.many('sim_tasks', { OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID, STATUS: { $in: ['ASSIGNED', 'ACCEPTED', 'WORKING', 'PAUSED'] } });
    if (op.MAX_CREW_SIZE && active.length >= op.MAX_CREW_SIZE) throw E.conflict('CREW_FULL', `Crew is at its maximum of ${op.MAX_CREW_SIZE}`);
    const skill = op.REQUIRED_SKILL_ID;
    if (skill && !C.qualified(cat, workerId, skill, tx.now)) throw E.forbidden(`Not qualified for ${skill}`);
    const id = await tx.nextId('TSK');
    const t = await tx.insert('sim_tasks', { TASK_ID: id, OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID, UNIT_ID: op.UNIT_ID, OPERATION_ID: op.OPERATION_ID, WORKER_ID: workerId, ROLE: p.role || 'CREW',
      STATUS: 'ACCEPTED', ASSIGNED_AT: tx.now, ASSIGNED_BY: tx.actor.workerId || 'SELF_JOIN', ACCEPTED_AT: tx.now, STATUS_SINCE: tx.now, ORIGIN: 'BRANCH_NEW' });
    await tx.event('TASK_ASSIGNED', 'TASK', id, { WORKER_ID: workerId, OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID, UNIT_ID: op.UNIT_ID, MODE: 'JOIN' });
    if (p.start) return startWork(tx, { task: t, worker, op, unit: await tx.must('sim_units', { UNIT_ID: op.UNIT_ID }) });
    return { task: t };
  },
});

register('TASK_HANDOVER', {
  perm: 'operate_own_tasks',
  handler: async (tx, p) => {
    const cat = await C.catalog();
    const ctx = await loadTaskCtx(tx, p.taskId);
    const to = await tx.must('sim_workers', { WORKER_ID: p.toWorkerId }, 'Receiving worker');
    if (to.WORKER_ID === ctx.worker.WORKER_ID) throw E.bad('SAME_WORKER', 'Choose another person');
    if (ctx.op.REQUIRED_SKILL_ID && !C.qualified(cat, to.WORKER_ID, ctx.op.REQUIRED_SKILL_ID, tx.now)) throw E.forbidden(`${to.DISPLAY_NAME} is not qualified for ${ctx.op.REQUIRED_SKILL_ID}`);
    let task = ctx.task;
    if (task.STATUS === 'WORKING') task = (await pauseTask(tx, ctx, 'HANDOVER_PENDING', p.note)).task;
    await H.moveTask(tx, task, 'HANDED_OVER', { ENDED_REASON: 'HANDOVER', HANDED_OVER_TO: to.WORKER_ID }, { force: true });
    const id = await tx.nextId('TSK');
    const nt = await tx.insert('sim_tasks', { TASK_ID: id, OPERATION_INSTANCE_ID: task.OPERATION_INSTANCE_ID, UNIT_ID: task.UNIT_ID, OPERATION_ID: task.OPERATION_ID, WORKER_ID: to.WORKER_ID, ROLE: task.ROLE,
      STATUS: 'ASSIGNED', ASSIGNED_AT: tx.now, ASSIGNED_BY: ctx.worker.WORKER_ID, HANDOVER_FROM_TASK_ID: task.TASK_ID, STATUS_SINCE: tx.now, ORIGIN: 'BRANCH_NEW' });
    const hid = await tx.nextId('HND');
    await tx.insert('sim_handovers', { HANDOVER_ID: hid, OPERATION_INSTANCE_ID: task.OPERATION_INSTANCE_ID, UNIT_ID: task.UNIT_ID, HANDED_OVER_BY: ctx.worker.WORKER_ID, RECEIVED_BY: to.WORKER_ID,
      HANDOVER_AT: tx.now, PROGRESS_PCT_AT_HANDOVER: Math.round((ctx.op.PROGRESS_FRACTION || 0) * 1000) / 10, MILESTONES_DONE: ctx.op.MILESTONES_DONE || [], NOTE: p.note || null });
    await tx.event('TASK_HANDED_OVER', 'TASK', task.TASK_ID, { TO_WORKER_ID: to.WORKER_ID, NEW_TASK_ID: id, HANDOVER_ID: hid });
    await H.setWorker(tx, await tx.must('sim_workers', { WORKER_ID: ctx.worker.WORKER_ID }), { CURRENT_TASK_ID: null, ACTIVITY_STATE: 'AVAILABLE', REASON_CODE: 'HANDOVER_COMPLETE' });
    return { handoverId: hid, newTask: nt };
  },
});

register('HELP_REQUEST', {
  perm: 'operate_own_tasks',
  handler: async (tx, p) => {
    const workerId = tx.actor.workerId || p.workerId;
    const w = await tx.must('sim_workers', { WORKER_ID: workerId }, 'Worker');
    const id = await tx.nextId('SUP');
    const doc = await tx.insert('sim_support_requests', { SUPPORT_REQUEST_ID: id, REQUESTED_BY: workerId, REQUESTED_AT: tx.now, KNOWN_AT: tx.now, REQUEST_TYPE: p.requestType || 'SUPERVISOR_SUPPORT',
      REASON: p.reason || null, NOTE: p.note || null, TASK_ID: p.taskId || w.CURRENT_TASK_ID || null, WORKSTATION_ID: w.CURRENT_WORKSTATION_ID, WORK_CENTER_ID: w.CURRENT_WORK_CENTER_ID, STATUS: 'OPEN' });
    await tx.event('HELP_REQUESTED', 'WORKER', workerId, { SUPPORT_REQUEST_ID: id, REASON: p.reason, TASK_ID: doc.TASK_ID });
    return { supportRequest: doc };
  },
});

register('SUPPORT_RESOLVE', {
  perm: ['operational_supervision', 'equipment_status'],
  handler: async (tx, p) => {
    const r = await tx.must('sim_support_requests', { SUPPORT_REQUEST_ID: p.supportRequestId }, 'Support request');
    const doc = await tx.update('sim_support_requests', { SUPPORT_REQUEST_ID: r.SUPPORT_REQUEST_ID }, { STATUS: 'CLOSED', CLOSED_AT: tx.now, ACCEPTED_BY: tx.actor.workerId || tx.actor.loginId, RESOLUTION_NOTE: p.note || null });
    await tx.event('HELP_RESOLVED', 'SUPPORT_REQUEST', r.SUPPORT_REQUEST_ID, { NOTE: p.note || null });
    return { supportRequest: doc };
  },
});

// ------------------------------------------------------------------ attendance and breaks
register('CLOCK_IN', {
  perm: ['operate_own_tasks', 'perform_quality_inspection', 'operational_supervision'],
  handler: async (tx, p) => {
    const workerId = p.workerId || tx.actor.workerId;
    H.assertOwner(tx, workerId);
    let w = await tx.must('sim_workers', { WORKER_ID: workerId }, 'Worker');
    H.assertAgentMayAct(tx, w);
    w = await takeControlImplicit(tx, w);
    if (w.ATTENDANCE_STATE === 'CLOCKED_IN') return { worker: w, alreadyClockedIn: true };
    if (w.ATTENDANCE_STATE === 'ABSENT') throw E.conflict('ABSENCE_CONFIRMED', 'An absence was confirmed for this shift; a supervisor must correct it first');
    const lateMin = w.PLANNED_START_AT ? Math.max(0, Math.round((tx.now - new Date(w.PLANNED_START_AT)) / 60000)) : null;
    const id = await tx.nextId('ATT');
    await tx.insert('sim_attendance', { EVENT_ID: id, WORKER_ID: workerId, EVENT_TYPE: 'CLOCK_IN', EVENT_TIME: tx.now, KNOWN_AT: tx.now, SHIFT_ID: w.SHIFT_ID, DEVICE_ID: p.deviceId || 'APP', LATE_ARRIVAL_MIN: lateMin });
    const doc = await H.setWorker(tx, w, { ATTENDANCE_STATE: 'CLOCKED_IN', ACTIVITY_STATE: w.CURRENT_TASK_ID ? 'PAUSED' : 'AVAILABLE', REASON_CODE: 'CLOCKED_IN', FIRST_CLOCK_IN_AT: w.FIRST_CLOCK_IN_AT || tx.now, LAST_CLOCK_OUT_AT: null }, 'ATTENDANCE_CLOCK_IN');
    await H.segment(tx, workerId, 'WAITING', { REASON: 'AWAITING_TASK' });
    return { worker: doc, lateArrivalMin: lateMin };
  },
});

register('CLOCK_OUT', {
  perm: ['operate_own_tasks', 'perform_quality_inspection', 'operational_supervision'],
  handler: async (tx, p) => {
    const workerId = p.workerId || tx.actor.workerId;
    H.assertOwner(tx, workerId);
    let w = await tx.must('sim_workers', { WORKER_ID: workerId }, 'Worker');
    H.assertAgentMayAct(tx, w);
    if (w.ATTENDANCE_STATE !== 'CLOCKED_IN') throw E.conflict('NOT_CLOCKED_IN', 'Not clocked in');
    const working = await tx.many('sim_tasks', { WORKER_ID: workerId, STATUS: 'WORKING' });
    if (working.length && !p.pauseActiveTasks) throw E.conflict('ACTIVE_TASK', 'Pause or hand over your active task before clocking out (or confirm pausing it for shift end)', { activeTaskId: working[0].TASK_ID });
    for (const t of working) {
      const op = await tx.must('sim_operations', { OPERATION_INSTANCE_ID: t.OPERATION_INSTANCE_ID });
      await pauseTask(tx, { task: t, worker: w, op, unit: null }, 'SHIFT_END', 'Clock-out');
      w = await tx.must('sim_workers', { WORKER_ID: workerId });
    }
    const earlyMin = w.PLANNED_END_AT ? Math.max(0, Math.round((new Date(w.PLANNED_END_AT) - tx.now) / 60000)) : null;
    const id = await tx.nextId('ATT');
    await tx.insert('sim_attendance', { EVENT_ID: id, WORKER_ID: workerId, EVENT_TYPE: 'CLOCK_OUT', EVENT_TIME: tx.now, KNOWN_AT: tx.now, SHIFT_ID: w.SHIFT_ID, DEVICE_ID: p.deviceId || 'APP', EARLY_DEPARTURE_MIN: earlyMin, REASON_CODE: p.reason || null });
    await H.segment(tx, workerId, null);
    const doc = await H.setWorker(tx, w, { ATTENDANCE_STATE: 'CLOCKED_OUT', ACTIVITY_STATE: 'OFF_SHIFT', REASON_CODE: 'CLOCKED_OUT', LAST_CLOCK_OUT_AT: tx.now, CURRENT_TASK_ID: null }, 'ATTENDANCE_CLOCK_OUT');
    return { worker: doc, earlyDepartureMin: earlyMin };
  },
});

register('BREAK_START', {
  perm: ['operate_own_tasks', 'perform_quality_inspection'],
  handler: async (tx, p) => {
    const workerId = p.workerId || tx.actor.workerId;
    H.assertOwner(tx, workerId);
    let w = await tx.must('sim_workers', { WORKER_ID: workerId }, 'Worker');
    H.assertAgentMayAct(tx, w);
    w = await takeControlImplicit(tx, w);
    if (w.ATTENDANCE_STATE !== 'CLOCKED_IN') throw E.conflict('NOT_CLOCKED_IN', 'Not clocked in');
    if (w.ACTIVITY_STATE === 'BREAK') return { worker: w, alreadyOnBreak: true };
    // a person in transit finishes departure -> travel/handover -> arrival first; the break follows the arrival
    if (w.ACTIVITY_STATE === 'TRANSFER') throw E.conflict('IN_TRANSFER', `${w.DISPLAY_NAME || workerId} is in transfer to ${w.TRANSFER_TO_WORK_CENTER_ID}; the break starts after arrival`);
    const reason = p.planned === false ? 'UNPLANNED_BREAK_PERSONAL' : 'PLANNED_BREAK';
    const working = await tx.many('sim_tasks', { WORKER_ID: workerId, STATUS: 'WORKING' });
    for (const t of working) {
      const op = await tx.must('sim_operations', { OPERATION_INSTANCE_ID: t.OPERATION_INSTANCE_ID });
      await pauseTask(tx, { task: t, worker: w, op }, reason, null);
      w = await tx.must('sim_workers', { WORKER_ID: workerId });
    }
    if (!working.length) {
      await H.segment(tx, workerId, 'BREAK', { REASON: reason });
      w = await H.setWorker(tx, w, { ACTIVITY_STATE: 'BREAK', REASON_CODE: reason, BREAK_STARTED_AT: tx.now }, 'WORKER_BREAK_START');
    }
    return { worker: w, pausedTasks: working.map(t => t.TASK_ID) };
  },
});

register('BREAK_END', {
  perm: ['operate_own_tasks', 'perform_quality_inspection'],
  handler: async (tx, p) => {
    const workerId = p.workerId || tx.actor.workerId;
    H.assertOwner(tx, workerId);
    let w = await tx.must('sim_workers', { WORKER_ID: workerId }, 'Worker');
    H.assertAgentMayAct(tx, w);
    w = await takeControlImplicit(tx, w);
    if (w.ACTIVITY_STATE !== 'BREAK') return { worker: w, notOnBreak: true };
    await H.segment(tx, workerId, 'WAITING', { REASON: 'AFTER_BREAK' });
    w = await H.setWorker(tx, w, { ACTIVITY_STATE: w.CURRENT_TASK_ID ? 'PAUSED' : 'AVAILABLE', REASON_CODE: 'BREAK_ENDED', BREAK_STARTED_AT: null }, 'WORKER_BREAK_END');
    let resumed = null;
    if (p.resume && w.CURRENT_TASK_ID) {
      const ctx = await loadTaskCtx(tx, w.CURRENT_TASK_ID);
      // startWork validates everything before it writes, so a blocked resume (equipment down, hold, ...) leaves the break ended
      // and the task paused with its blocking reason instead of rejecting the end of the break
      if (ctx.task.STATUS === 'PAUSED') {
        try { resumed = await startWork(tx, ctx); } catch (e) { if (!(e instanceof E.AppError) || e.status >= 500) throw e; resumed = { blocked: true, code: e.code, message: e.message }; }
      }
    }
    return { worker: w, resumed };
  },
});

// ------------------------------------------------------------------ human control lease
register('TAKE_CONTROL', {
  perm: ['operate_own_tasks', 'perform_quality_inspection', 'scenario_control'],
  agentAllowed: false, noRecalc: true,
  handler: async (tx, p) => {
    const workerId = p.workerId || tx.actor.workerId;
    H.assertOwner(tx, workerId);
    const w = await tx.must('sim_workers', { WORKER_ID: workerId }, 'Worker');
    if (w.CONTROL && w.CONTROL.MODE === 'HUMAN_ONLY') return { worker: w, humanOnly: true };
    if (w.CONTROL && w.CONTROL.MODE === 'HUMAN' && w.CONTROL.LOGIN_ID !== tx.actor.loginId && new Date(w.CONTROL.LEASE_EXPIRES_AT) > new Date() && !p.force)
      throw E.conflict('CONTROLLED_BY_OTHER', `Another tester (${w.CONTROL.LOGIN_ID}) controls this worker`);
    const doc = await tx.update('sim_workers', { WORKER_ID: workerId }, { CONTROL: { MODE: 'HUMAN', LOGIN_ID: tx.actor.loginId, SINCE: tx.received, LEASE_EXPIRES_AT: new Date(Date.now() + 120000) } });
    await tx.event('HUMAN_CONTROL_TAKEN', 'WORKER', workerId, { LOGIN_ID: tx.actor.loginId });
    return { worker: doc };
  },
});

register('CONTROL_HEARTBEAT', {
  perm: ['operate_own_tasks', 'perform_quality_inspection', 'scenario_control'],
  agentAllowed: false, noRecalc: true, noIdempotency: true,
  handler: async (tx, p) => {
    const workerId = p.workerId || tx.actor.workerId;
    const w = await tx.must('sim_workers', { WORKER_ID: workerId }, 'Worker');
    if (!w.CONTROL || w.CONTROL.MODE !== 'HUMAN' || w.CONTROL.LOGIN_ID !== tx.actor.loginId) return { controlled: false };
    await tx.db.collection('sim_workers').updateOne({ SESSION_ID: tx.sid, WORKER_ID: workerId }, { $set: { 'CONTROL.LEASE_EXPIRES_AT': new Date(Date.now() + 120000) } }, { session: tx.s });
    return { controlled: true };
  },
});

register('RELEASE_CONTROL', {
  perm: ['operate_own_tasks', 'perform_quality_inspection', 'scenario_control'],
  agentAllowed: false,
  handler: async (tx, p) => {
    const workerId = p.workerId || tx.actor.workerId;
    H.assertOwner(tx, workerId);
    let w = await tx.must('sim_workers', { WORKER_ID: workerId }, 'Worker');
    // a real person (HUMAN_ONLY, fresh factory) is never handed to a simulation agent: logging out keeps their work as it is
    if ((w.CONTROL && w.CONTROL.MODE === 'HUMAN_ONLY') || tx.session.FACTORY_SESSION) return { worker: w, policy: 'HUMAN_ONLY_UNCHANGED', note: 'Real people stay in control of their own work; nothing is handed to an agent.' };
    const policy = p.policy || 'RETURN_TO_SIMULATION';
    if (!['RETURN_TO_SIMULATION', 'KEEP_TASK_PAUSED'].includes(policy)) throw E.bad('INVALID_POLICY', 'policy must be RETURN_TO_SIMULATION or KEEP_TASK_PAUSED');
    if (policy === 'KEEP_TASK_PAUSED') {
      const working = await tx.many('sim_tasks', { WORKER_ID: workerId, STATUS: 'WORKING' });
      for (const t of working) {
        const op = await tx.must('sim_operations', { OPERATION_INSTANCE_ID: t.OPERATION_INSTANCE_ID });
        await pauseTask(tx, { task: t, worker: w, op }, 'HANDOVER_PENDING', 'Tester logged out - task kept paused for handover');
        w = await tx.must('sim_workers', { WORKER_ID: workerId });
      }
    }
    const doc = await tx.update('sim_workers', { WORKER_ID: workerId }, { CONTROL: policy === 'KEEP_TASK_PAUSED' ? { MODE: 'HUMAN_PAUSED', LOGIN_ID: tx.actor.loginId, SINCE: tx.received, LEASE_EXPIRES_AT: new Date(Date.now() + 8 * 3600000) } : { MODE: 'AGENT', SINCE: tx.received } });
    await tx.event('HUMAN_CONTROL_RELEASED', 'WORKER', workerId, { POLICY: policy });
    return { worker: doc, policy };
  },
});

module.exports = { startWork, pauseTask, finishOperation, loadTaskCtx, PAUSE_REASONS };
