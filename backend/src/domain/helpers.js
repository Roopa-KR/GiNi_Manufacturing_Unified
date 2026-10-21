'use strict';
/* Shared domain transitions used by every command handler (humans, agents, console). */
const SM = require('../../contracts/state_machines.json');
const E = require('../lib/errors');
const C = require('./catalog');

const UNIT_HOLD = new Set(SM.unit.on_hold);
const TERMINAL = new Set(SM.unit.terminal);
const ACTIVE_TASK = new Set(SM.task.active);

function assertUnitTransition(unit, to) {
  const allowed = SM.unit.transitions[unit.STATE] || [];
  if (unit.STATE === to) return;
  if (!allowed.includes(to)) throw E.conflict('INVALID_UNIT_TRANSITION', `Tank ${unit.TANK_SERIAL_NO || unit.UNIT_ID} cannot go from ${unit.STATE} to ${to}`, { unitId: unit.UNIT_ID, from: unit.STATE, to, allowed });
}
async function moveUnit(tx, unit, to, extra = {}, opts = {}) {
  if (!opts.force) assertUnitTransition(unit, to);
  const doc = await tx.update('sim_units', { UNIT_ID: unit.UNIT_ID }, { STATE: to, STATE_SINCE: tx.now, ...extra }, { expectVersion: opts.expectVersion ?? unit.VERSION, unset: opts.unset });
  await tx.event('UNIT_STATE_CHANGED', 'UNIT', unit.UNIT_ID, { FROM_STATE: unit.STATE, TO_STATE: to, ROUTE_STEP: doc.ROUTE_STEP, WORK_CENTER_ID: doc.CURRENT_WORK_CENTER_ID, WORKSTATION_ID: doc.CURRENT_WORKSTATION_ID, OPERATION_INSTANCE_ID: doc.CURRENT_OPERATION_INSTANCE_ID, REASON: opts.reason || null });
  return doc;
}
function assertTaskTransition(task, to) {
  const allowed = SM.task.transitions[task.STATUS] || [];
  if (task.STATUS === to) return;
  if (!allowed.includes(to)) throw E.conflict('INVALID_TASK_TRANSITION', `Task cannot go from ${task.STATUS} to ${to}`, { taskId: task.TASK_ID, from: task.STATUS, to });
}
async function moveTask(tx, task, to, extra = {}, opts = {}) {
  if (!opts.force) assertTaskTransition(task, to);
  const doc = await tx.update('sim_tasks', { TASK_ID: task.TASK_ID }, { STATUS: to, STATUS_SINCE: tx.now, ...extra }, { expectVersion: opts.expectVersion ?? task.VERSION });
  await tx.event('TASK_' + to, 'TASK', task.TASK_ID, { WORKER_ID: task.WORKER_ID, OPERATION_INSTANCE_ID: task.OPERATION_INSTANCE_ID, UNIT_ID: task.UNIT_ID, FROM_STATUS: task.STATUS, REASON_CODE: extra.PAUSE_REASON || extra.ENDED_REASON || opts.reason || null });
  return doc;
}

/** nonoverlapping participation: close the worker's open segment and (optionally) open a new one. Unique (SESSION_ID, WORKER_ID, OPEN) enforces one open segment. */
async function segment(tx, workerId, category, refs = {}) {
  const open = await tx.one('sim_participation', { WORKER_ID: workerId, OPEN: true });
  if (open) {
    if (open.CATEGORY === category && open.OPERATION_INSTANCE_ID === (refs.OPERATION_INSTANCE_ID || null) && (refs.REASON || null) === (open.REASON || null)) return open;
    await tx.update('sim_participation', { SEGMENT_ID: open.SEGMENT_ID }, { END_AT: tx.now, DURATION_MIN: Math.max(0, (tx.now - new Date(open.START_AT)) / 60000) }, { unset: ['OPEN'] });
  }
  if (!category) return null;
  const id = await tx.nextId('SEG');
  const eligible = ['DIRECT', 'REWORK'].includes(category) && !refs.REASON;
  return tx.insert('sim_participation', { SEGMENT_ID: id, WORKER_ID: workerId, CATEGORY: category, START_AT: tx.now, END_AT: null, OPEN: true, OPERATION_INSTANCE_ID: refs.OPERATION_INSTANCE_ID || null,
    UNIT_ID: refs.UNIT_ID || null, WORKSTATION_ID: refs.WORKSTATION_ID || null, WORK_CENTER_ID: refs.WORK_CENTER_ID || null, REASON: refs.REASON || null, TIME_POINTS_ELIGIBLE: eligible });
}

async function setWorker(tx, worker, fields, reasonEvent) {
  const doc = await tx.update('sim_workers', { WORKER_ID: worker.WORKER_ID }, { ...fields, STATE_SINCE: fields.ACTIVITY_STATE && fields.ACTIVITY_STATE !== worker.ACTIVITY_STATE ? tx.now : worker.STATE_SINCE, LAST_ACTIVITY_AT: tx.now });
  if (reasonEvent) await tx.event(reasonEvent, 'WORKER', worker.WORKER_ID, { ACTIVITY_STATE: doc.ACTIVITY_STATE, ATTENDANCE_STATE: doc.ATTENDANCE_STATE, REASON_CODE: doc.REASON_CODE, WORKSTATION_ID: doc.CURRENT_WORKSTATION_ID, WORK_CENTER_ID: doc.CURRENT_WORK_CENTER_ID });
  return doc;
}

/** agents must not act for a worker controlled by a human tester */
function assertAgentMayAct(tx, worker) {
  if (tx.actor.kind !== 'AGENT' || !worker) return;
  // fresh factory: a real person is never acted for, whatever the control lease says; only designated simulated workers in Simulated Test
  if (tx.session && tx.session.FACTORY_SESSION && !(tx.session.OPERATING_MODE === 'SIMULATED_TEST' && worker.SIMULATED_WORKER)) throw E.conflict('HUMAN_CONTROLLED', `${worker.DISPLAY_NAME || worker.WORKER_ID} is a real person; background agents never act for them`);
  if (!worker.CONTROL || !['HUMAN', 'HUMAN_PAUSED', 'HUMAN_ONLY'].includes(worker.CONTROL.MODE)) return;
  if (worker.CONTROL.MODE === 'HUMAN_ONLY') throw E.conflict('HUMAN_CONTROLLED', 'Admin-created workers are operated only by people');
  if (worker.CONTROL.LEASE_EXPIRES_AT && new Date(worker.CONTROL.LEASE_EXPIRES_AT) < new Date()) return;   // stale human lease
  throw E.conflict('HUMAN_CONTROLLED', `${worker.DISPLAY_NAME || worker.WORKER_ID} is controlled by a human tester; background agents do not act for them`);
}
/** human operators may only act for themselves unless they hold operational_supervision */
function assertOwner(tx, workerId) {
  if (tx.actor.kind !== 'HUMAN') return;
  if (tx.actor.workerId === workerId) return;
  if ((tx.actor.permissions || []).includes('operational_supervision') || (tx.actor.permissions || []).includes('scenario_control')) { tx.meta.onBehalfOf = workerId; return; }
  throw E.forbidden('You can only act on your own tasks');
}

/** recompute the operation's crew state from WORKING tasks and propagate to the unit */
async function refreshOperation(tx, opId) {
  const cat = await C.catalog();
  const op = await tx.must('sim_operations', { OPERATION_INSTANCE_ID: opId }, 'Operation');
  if (['WORK_COMPLETED', 'CANCELLED', 'CURING'].includes(op.STATE) || op.OPERATION_KIND === 'PROCESS') return op;
  const working = await tx.many('sim_tasks', { OPERATION_INSTANCE_ID: opId, STATUS: 'WORKING' });
  const crew = [...new Set(working.map(t => t.WORKER_ID))].sort();
  const minCrew = op.OPERATION_KIND === 'INSPECTION' ? 1 : (String(op.INSTANCE_TYPE || '').endsWith('REWORK') ? 1 : (op.MIN_CREW_SIZE || 1));
  let state = op.STATE;
  if (op.STATE !== 'CREATED' || crew.length) {
    const eq = op.EQUIPMENT_ID ? await tx.one('sim_equipment', { EQUIPMENT_ID: op.EQUIPMENT_ID }) : null;
    if (eq && eq.STATUS === 'DOWN') state = 'PAUSED';
    else if (crew.length === 0) state = 'PAUSED';
    else if (crew.length < minCrew) state = 'BELOW_MIN_CREW';
    else state = 'WORKING';
  }
  const fields = { CREW: crew, STATE: state };
  if (state === 'WORKING' && !op.STARTED_AT) fields.STARTED_AT = tx.now;
  const doc = await tx.update('sim_operations', { OPERATION_INSTANCE_ID: opId }, fields);
  if (state !== op.STATE) await tx.event('OPERATION_' + state, 'OPERATION', opId, { UNIT_ID: op.UNIT_ID, CREW: crew, FROM_STATE: op.STATE, OPERATION_ID: op.OPERATION_ID });
  // a crew below its minimum cannot progress the work: their time is external waiting (not eligible for time points), and
  // becomes direct/rework labour again as soon as the minimum crew is present
  if (state !== op.STATE && op.OPERATION_KIND === 'LABOR' && (state === 'BELOW_MIN_CREW' || (op.STATE === 'BELOW_MIN_CREW' && state === 'WORKING'))) {
    const rework = String(op.INSTANCE_TYPE || '').endsWith('REWORK');
    for (const wid of crew) {
      await segment(tx, wid, state === 'BELOW_MIN_CREW' ? 'WAITING' : (rework ? 'REWORK' : 'DIRECT'), { OPERATION_INSTANCE_ID: opId, UNIT_ID: op.UNIT_ID, WORKSTATION_ID: op.WORKSTATION_ID, WORK_CENTER_ID: op.WORK_CENTER_ID,
        REASON: state === 'BELOW_MIN_CREW' ? 'BELOW_MIN_CREW' : undefined });
    }
  }
  // unit follows the operation (labour operations only)
  if (op.OPERATION_KIND === 'LABOR') {
    const unit = await tx.must('sim_units', { UNIT_ID: op.UNIT_ID }, 'Tank');
    const rework = String(op.INSTANCE_TYPE || '').endsWith('REWORK');
    const target = state === 'WORKING' ? (rework ? 'REWORK_IN_PROGRESS' : 'WORKING') : 'PAUSED';
    if (unit.STATE !== target && !TERMINAL.has(unit.STATE) && !UNIT_HOLD.has(unit.STATE) && (state !== 'CREATED')) {
      if ((SM.unit.transitions[unit.STATE] || []).includes(target)) await moveUnit(tx, unit, target, { CURRENT_OPERATION_INSTANCE_ID: opId, CURRENT_WORKSTATION_ID: op.WORKSTATION_ID, CURRENT_WORK_CENTER_ID: op.WORK_CENTER_ID });
      else if (['QUEUED', 'READY', 'QUEUED_FOR_REWORK', 'RECEIVED_AT_REWORK_STATION', 'PAUSED'].includes(unit.STATE) && state === 'WORKING') await moveUnit(tx, unit, target, { CURRENT_OPERATION_INSTANCE_ID: opId, CURRENT_WORKSTATION_ID: op.WORKSTATION_ID, CURRENT_WORK_CENTER_ID: op.WORK_CENTER_ID, QUEUE_ENTERED_AT: null }, { force: true });
    }
  }
  return doc;
}

async function workerLocationFields(tx, op) {
  return { CURRENT_WORKSTATION_ID: op.WORKSTATION_ID, CURRENT_WORK_CENTER_ID: op.WORK_CENTER_ID };
}

module.exports = { moveUnit, moveTask, segment, setWorker, assertAgentMayAct, assertOwner, refreshOperation, assertUnitTransition, workerLocationFields, UNIT_HOLD, TERMINAL, ACTIVE_TASK };

/* ------------------------------------------------------------------ production batch membership (one open membership per tank) */
async function openMembership(tx, unitId, batchId, reason, parentBatchId = null) {
  const open = await tx.one('sim_batch_membership', { UNIT_ID: unitId, OPEN_KEY: unitId });
  if (open) {
    if (open.BATCH_ID === batchId) return open;
    const err = new Error(`Tank ${unitId} is still an active member of ${open.BATCH_ID}`); err.status = 409; err.code = 'MEMBERSHIP_OVERLAP'; throw err;
  }
  const id = await tx.nextId('MEM');
  return tx.insert('sim_batch_membership', { MEMBERSHIP_ID: id, UNIT_ID: unitId, BATCH_ID: batchId, PARENT_BATCH_ID: parentBatchId, VALID_FROM: tx.now, VALID_TO: null, MEMBERSHIP_REASON: reason, OPEN_KEY: unitId, KNOWN_AT: tx.now });
}
async function closeMembership(tx, unitId, reason) {
  const open = await tx.one('sim_batch_membership', { UNIT_ID: unitId, OPEN_KEY: unitId });
  if (!open) return null;
  return tx.update('sim_batch_membership', { MEMBERSHIP_ID: open.MEMBERSHIP_ID }, { VALID_TO: tx.now, OPEN_KEY: `${unitId}|closed|${open.MEMBERSHIP_ID}`, CLOSE_REASON: reason });
}
module.exports.openMembership = openMembership;
module.exports.closeMembership = closeMembership;
