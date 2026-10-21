'use strict';
/* Dispatch, process, plan releases, equipment, materials, workforce transfers, absence/overtime/corrections, scenario seeds. */
const RS = require('../reworkStandards');
const { register } = require('../executor');
const H = require('../helpers');
const C = require('../catalog');
const E = require('../../lib/errors');
const { startWork, pauseTask } = require('./tasks');
const SIMCFG = require('../../../config/simulation.json');

const STATION_BUSY = ['READY', 'WORKING', 'PAUSED', 'WORK_COMPLETED_AWAITING_INSPECTION', 'INSPECTION_IN_PROGRESS', 'PASS_PENDING_RELEASE', 'INCOMPLETE_INSPECTION_HOLD', 'FAILED_INSPECTION',
  'QUALITY_HOLD', 'PENDING_REVIEW', 'AUTHORIZED_REWORK', 'QUEUED_FOR_REWORK', 'RECEIVED_AT_REWORK_STATION', 'REWORK_IN_PROGRESS', 'REWORK_COMPLETE_AWAITING_REINSPECTION', 'REINSPECTION_IN_PROGRESS', 'RELEASED_TO_NEXT_OPERATION'];

async function stationOccupant(tx, ws, exceptUnit) {
  const units = await tx.many('sim_units', { CURRENT_WORKSTATION_ID: ws, STATE: { $in: STATION_BUSY } });
  return units.find(u => u.UNIT_ID !== exceptUnit) || null;
}
async function attemptCount(tx, unitId, opId) {
  const s = await tx.many('sim_operations', { UNIT_ID: unitId, OPERATION_ID: opId });
  const h = await tx.db.collection('operation_instances').countDocuments({ RUN_ID: tx.session.SOURCE_RUN_ID, UNIT_ID: unitId, OPERATION_ID: opId, CREATED_AT: { $lte: new Date(tx.session.FORK_AT) } }, { session: tx.s });
  const last = s.sort((a, b) => new Date(b.CREATED_AT) - new Date(a.CREATED_AT))[0];
  return { n: s.filter(x => x.ORIGIN !== 'INHERITED_AT_FORK').length + h, last };
}

register('OPERATION_START', {
  perm: ['operational_supervision', 'operate_own_tasks'],
  handler: async (tx, p) => {
    const cat = await C.catalog();
    const unit = await tx.must('sim_units', { UNIT_ID: p.unitId }, 'Tank');
    const rework = ['QUEUED_FOR_REWORK', 'RECEIVED_AT_REWORK_STATION'].includes(unit.STATE);
    if (!rework && !['QUEUED', 'READY'].includes(unit.STATE)) throw E.conflict('NOT_DISPATCHABLE', `Tank ${unit.TANK_SERIAL_NO} is ${unit.STATE}; it cannot start a new operation (holds and pending inspections block downstream work)`);
    const opId = unit.ROUTE_STEP;
    // one open attempt per tank and step: a second start would duplicate the work (add people with TASK_ASSIGN / join instead)
    if (unit.CURRENT_OPERATION_INSTANCE_ID) {
      const cur = await tx.one('sim_operations', { OPERATION_INSTANCE_ID: unit.CURRENT_OPERATION_INSTANCE_ID });
      if (cur && cur.OPERATION_ID === opId && cur.OPERATION_KIND === 'LABOR' && ['CREATED', 'WORKING', 'PAUSED', 'BELOW_MIN_CREW'].includes(cur.STATE)) throw E.conflict('OPERATION_EXISTS', `${opId} is already open for tank ${unit.TANK_SERIAL_NO} (${cur.OPERATION_INSTANCE_ID}); assign more people to it instead`, { operationInstanceId: cur.OPERATION_INSTANCE_ID });
    }
    const def = C.opDef(cat, unit.PRODUCT_ID, opId);
    if (!def || def.OPERATION_KIND !== 'LABOR') throw E.conflict('NOT_A_LABOR_STEP', `Next route step ${opId} is not a labour operation`);
    const ws = cat.stations[p.workstationId];
    if (!ws || ws.WORK_CENTER_ID !== def.WORK_CENTER_ID) throw E.bad('INVALID_STATION', `Choose a ${def.WORK_CENTER_ID} workstation`);
    if (rework) {
      const pend = unit.REWORK_PENDING || {};
      if (pend.DEST_WORKSTATION_ID && p.workstationId !== pend.DEST_WORKSTATION_ID) throw E.conflict('REWORK_STATION_MISMATCH', `Authorised rework station is ${pend.DEST_WORKSTATION_ID} (same station again); an alternate needs a named quality approver`, { authorised: pend.DEST_WORKSTATION_ID });
    }
    const occ = await stationOccupant(tx, p.workstationId, unit.UNIT_ID);
    if (occ) throw E.conflict('STATION_OCCUPIED', `${p.workstationId} is occupied by tank ${occ.TANK_SERIAL_NO} (${occ.STATE})`);
    if (ws.EQUIPMENT_ID) { const eq = await tx.one('sim_equipment', { EQUIPMENT_ID: ws.EQUIPMENT_ID }); if (eq && eq.STATUS === 'DOWN') throw E.conflict('EQUIPMENT_DOWN', `${ws.EQUIPMENT_ID} is down`); }
    const crewIn = (p.crew || []).map(c => (typeof c === 'string' ? { workerId: c } : c));
    if (new Set(crewIn.map(c => c.workerId)).size !== crewIn.length) throw E.bad('DUPLICATE_CREW', 'A person appears twice in the crew');
    if (tx.session.FACTORY_SESSION && !crewIn.length) throw E.bad('CREW_REQUIRED', 'Assign at least one qualified person');
    if (def.MAX_CREW_SIZE && crewIn.length > def.MAX_CREW_SIZE) throw E.conflict('CREW_FULL', `${opId} allows at most ${def.MAX_CREW_SIZE} people`);
    if (tx.actor.kind === 'HUMAN' && !(tx.actor.permissions || []).includes('operational_supervision')) {
      if (crewIn.length !== 1 || crewIn[0].workerId !== tx.actor.workerId) throw E.forbidden('Operators can only start eligible queue work for themselves');
    }
    const pend = unit.REWORK_PENDING || {};
    const minCrew = rework ? (SIMCFG.agent.rework_min_crew || 1) : (def.MIN_CREW_SIZE || 1);
    const skill = def.REQUIRED_SKILL_ID;
    for (const c of crewIn) {
      const w = await tx.must('sim_workers', { WORKER_ID: c.workerId }, `Worker ${c.workerId}`);
      H.assertAgentMayAct(tx, w);
      if (skill && !C.qualified(cat, w.WORKER_ID, skill, tx.now)) throw E.forbidden(`${w.DISPLAY_NAME} is not qualified for ${skill} at this time`);
      // fresh factory: an admin may assign people before they clock in (they start after clocking in); starting needs attendance
      if (w.ATTENDANCE_STATE !== 'CLOCKED_IN' && (!tx.session.FACTORY_SESSION || p.autoStart)) throw E.conflict('NOT_CLOCKED_IN', `${w.DISPLAY_NAME} is not clocked in`);
      if (tx.session.FACTORY_SESSION && (await tx.many('sim_tasks', { OPERATION_INSTANCE_ID: { $exists: true }, UNIT_ID: unit.UNIT_ID, WORKER_ID: w.WORKER_ID, STATUS: { $in: ['ASSIGNED', 'ACCEPTED', 'WORKING', 'PAUSED'] } })).length) throw E.conflict('DUPLICATE_ASSIGNMENT', `${w.DISPLAY_NAME} already has an open task on this tank`);
      const busy = await tx.many('sim_tasks', { WORKER_ID: w.WORKER_ID, STATUS: 'WORKING' });
      if (busy.length) throw E.conflict('ALREADY_WORKING', `${w.DISPLAY_NAME} is already working on ${busy[0].TASK_ID}`);
    }
    if (p.autoStart && crewIn.length < minCrew) throw E.conflict('BELOW_MIN_CREW', `${opId} needs at least ${minCrew} qualified people (got ${crewIn.length})`);
    const { n, last } = await attemptCount(tx, unit.UNIT_ID, opId);
    const oid = await tx.nextId('OPI');
    const instr = C.instructionFor(cat, opId, unit.PRODUCT_ID, unit.DRAWING_REVISION, rework, tx.now);
    // rework: the labour standard and its provenance come from an APPROVED rework standard when one exists; otherwise the planning
    // value is recorded as PROVISIONAL (forecasting only - points.py awards no time points against it)
    const rstd = rework ? await RS.provenanceFor(tx.db, { productId: unit.PRODUCT_ID, operationId: opId, reworkType: pend.REWORK_TYPE || 'GATE_REWORK', at: tx.now, session: tx.s }) : null;
    const stdLabor = rework ? rstd.minutes : Number(def.STANDARD_LABOR_MIN || 0);
    const op = await tx.insert('sim_operations', { OPERATION_INSTANCE_ID: oid, UNIT_ID: unit.UNIT_ID, OPERATION_ID: opId, OPERATION_KIND: 'LABOR', PRODUCT_ID: unit.PRODUCT_ID, WORK_CENTER_ID: def.WORK_CENTER_ID,
      WORKSTATION_ID: ws.WORKSTATION_ID, EQUIPMENT_ID: ws.EQUIPMENT_ID || null, ATTEMPT_NO: n + 1, INSTANCE_TYPE: rework ? pend.REWORK_TYPE || 'GATE_REWORK' : 'NORMAL', REWORK_OF_OPERATION_INSTANCE_ID: rework ? pend.CORRECTED_OPERATION_INSTANCE_ID : null,
      PRIOR_ATTEMPT_OPERATION_INSTANCE_ID: last ? last.OPERATION_INSTANCE_ID : (rework ? pend.CORRECTED_OPERATION_INSTANCE_ID : null), INSTRUCTION_VERSION_ID: instr ? instr.INSTRUCTION_VERSION_ID : null,
      STATE: 'CREATED', PROGRESS_FRACTION: 0, CREW: [], MILESTONES_DONE: [], CREATED_AT: tx.now, STARTED_AT: null, STANDARD_ELAPSED_MIN: rework ? null : def.STANDARD_ELAPSED_MIN, STANDARD_LABOR_MIN: stdLabor,
      REWORK_STANDARD_LABOR_MIN: rework ? stdLabor : null, REWORK_STANDARD: rework ? rstd.provenance : null, MIN_CREW_SIZE: minCrew, STD_CREW_SIZE: rework ? Math.max(1, Math.min(2, def.STD_CREW_SIZE || 1)) : def.STD_CREW_SIZE, MAX_CREW_SIZE: def.MAX_CREW_SIZE, REQUIRED_SKILL_ID: skill,
      BATCH_ID: unit.BATCH_ID, ORDER_ID: unit.ORDER_ID, ORIGIN: 'BRANCH_NEW', DISPATCH_RULE_ID: 'DR-1.0', RETURN_ID: rework ? pend.RETURN_ID : null });
    await tx.event('OPERATION_CREATED', 'OPERATION', oid, { UNIT_ID: unit.UNIT_ID, OPERATION_ID: opId, WORKSTATION_ID: ws.WORKSTATION_ID, ATTEMPT_NO: n + 1, INSTANCE_TYPE: op.INSTANCE_TYPE, REWORK_OF: op.REWORK_OF_OPERATION_INSTANCE_ID, QUEUED_SINCE: unit.QUEUE_ENTERED_AT });
    let u2 = await H.moveUnit(tx, unit, 'READY', { CURRENT_OPERATION_INSTANCE_ID: oid, CURRENT_WORKSTATION_ID: ws.WORKSTATION_ID, CURRENT_WORK_CENTER_ID: def.WORK_CENTER_ID, QUEUE_EXITED_AT: tx.now }, { force: true });
    await tx.event('QUEUE_EXITED', 'UNIT', unit.UNIT_ID, { WORK_CENTER_ID: def.WORK_CENTER_ID, WAITED_MIN: unit.QUEUE_ENTERED_AT ? Math.max(0, (tx.now - new Date(unit.QUEUE_ENTERED_AT)) / 60000) : null, DISPATCHED_TO: ws.WORKSTATION_ID });
    if (rework && pend.RETURN_ID) await tx.update('sim_returns', { RETURN_ID: pend.RETURN_ID }, { REWORK_OPERATION_INSTANCE_ID: oid, LOOP_STATUS: 'REWORK_IN_PROGRESS', REWORK_CREW: crewIn.map(c => c.workerId), REWORK_INSTRUCTION_VERSION_ID: instr ? instr.INSTRUCTION_VERSION_ID : null });
    const tasks = [];
    for (const c of crewIn) {
      const tid = await tx.nextId('TSK');
      const t = await tx.insert('sim_tasks', { TASK_ID: tid, OPERATION_INSTANCE_ID: oid, UNIT_ID: unit.UNIT_ID, OPERATION_ID: opId, WORKER_ID: c.workerId, ROLE: c.role || 'CREW', STATUS: 'ASSIGNED', ASSIGNED_AT: tx.now,
        ASSIGNED_BY: tx.actor.workerId || tx.actor.loginId || 'DISPATCH', STATUS_SINCE: tx.now, PRIORITY_CLASS: unit.PRIORITY_CLASS || 3, ORIGIN: 'BRANCH_NEW' });
      await tx.event('TASK_ASSIGNED', 'TASK', tid, { WORKER_ID: c.workerId, OPERATION_INSTANCE_ID: oid, UNIT_ID: unit.UNIT_ID });
      tasks.push(t);
    }
    if (p.autoStart) {
      for (const t of tasks) {
        const w = await tx.must('sim_workers', { WORKER_ID: t.WORKER_ID });
        await startWork(tx, { task: t, worker: w, op: await tx.must('sim_operations', { OPERATION_INSTANCE_ID: oid }), unit: await tx.must('sim_units', { UNIT_ID: unit.UNIT_ID }) });
      }
      if (rework && pend.RETURN_ID) await tx.update('sim_returns', { RETURN_ID: pend.RETURN_ID }, { REWORK_STARTED_AT: tx.now });
    }
    return { operation: await tx.must('sim_operations', { OPERATION_INSTANCE_ID: oid }), tasks: tasks.map(t => t.TASK_ID) };
  },
});

register('TASK_ASSIGN', {
  perm: 'operational_supervision',
  handler: async (tx, p) => {
    const cat = await C.catalog();
    const op = await tx.must('sim_operations', { OPERATION_INSTANCE_ID: p.operationInstanceId }, 'Operation');
    if (['WORK_COMPLETED', 'CANCELLED'].includes(op.STATE)) throw E.conflict('OPERATION_CLOSED', `Operation is ${op.STATE}`);
    const w = await tx.must('sim_workers', { WORKER_ID: p.workerId }, 'Worker');
    H.assertAgentMayAct(tx, w);
    if (op.REQUIRED_SKILL_ID && !C.qualified(cat, w.WORKER_ID, op.REQUIRED_SKILL_ID, tx.now)) throw E.forbidden(`${w.DISPLAY_NAME} is not qualified for ${op.REQUIRED_SKILL_ID}`);
    const existing = await tx.one('sim_tasks', { OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID, WORKER_ID: w.WORKER_ID, STATUS: { $in: ['ASSIGNED', 'ACCEPTED', 'WORKING', 'PAUSED'] } });
    let t = existing;
    if (!t) {
      const active = await tx.many('sim_tasks', { OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID, STATUS: { $in: ['ASSIGNED', 'ACCEPTED', 'WORKING', 'PAUSED'] } });
      if (op.MAX_CREW_SIZE && active.length >= op.MAX_CREW_SIZE) throw E.conflict('CREW_FULL', `Crew is at its maximum of ${op.MAX_CREW_SIZE}`);
      const tid = await tx.nextId('TSK');
      t = await tx.insert('sim_tasks', { TASK_ID: tid, OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID, UNIT_ID: op.UNIT_ID, OPERATION_ID: op.OPERATION_ID, WORKER_ID: w.WORKER_ID, ROLE: p.role || 'CREW', STATUS: 'ASSIGNED',
        ASSIGNED_AT: tx.now, ASSIGNED_BY: tx.actor.workerId || tx.actor.loginId || 'DISPATCH', STATUS_SINCE: tx.now, ORIGIN: 'BRANCH_NEW' });
      await tx.event('TASK_ASSIGNED', 'TASK', tid, { WORKER_ID: w.WORKER_ID, OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID, UNIT_ID: op.UNIT_ID });
    }
    if (p.autoStart && ['ASSIGNED', 'ACCEPTED', 'PAUSED'].includes(t.STATUS)) {
      return startWork(tx, { task: t, worker: w, op, unit: await tx.must('sim_units', { UNIT_ID: op.UNIT_ID }) });
    }
    return { task: t };
  },
});

register('PROCESS_COMPLETE', {
  perm: ['operational_supervision', 'scenario_control'],
  handler: async (tx, p) => {
    const cat = await C.catalog();
    const op = await tx.must('sim_operations', { OPERATION_INSTANCE_ID: p.operationInstanceId }, 'Process');
    if (op.OPERATION_KIND !== 'PROCESS' || op.STATE !== 'CURING') throw E.conflict('NOT_CURING', `Process is ${op.STATE}`);
    await tx.update('sim_operations', { OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID }, { STATE: 'WORK_COMPLETED', WORK_COMPLETED_AT: tx.now, PROGRESS_FRACTION: 1 });
    await tx.event('PROCESS_FINISHED', 'OPERATION', op.OPERATION_INSTANCE_ID, { UNIT_ID: op.UNIT_ID, OPERATION_ID: op.OPERATION_ID });
    const unit = await tx.must('sim_units', { UNIT_ID: op.UNIT_ID });
    const gate = C.gateAfter(cat, unit.PRODUCT_ID, op.OPERATION_ID);
    await H.moveUnit(tx, unit, 'WORK_COMPLETED_AWAITING_INSPECTION', { ROUTE_STEP: gate, AWAITING_INSPECTION_SINCE: tx.now });
    await tx.event('INSPECTION_REQUESTED', 'UNIT', unit.UNIT_ID, { GATE_OPERATION_ID: gate, INSPECTED_OPERATION_INSTANCE_ID: unit.LAST_LABOR_OPERATION_INSTANCE_ID });
    return {};
  },
});

register('BATCH_RELEASE', {
  perm: ['operational_supervision', 'scenario_control'],
  handler: async (tx, p) => {
    const cat = await C.catalog();
    const pr = await tx.must('sim_plan_releases', { BATCH_ID: p.batchId }, 'Planned release');
    if (pr.RELEASED) return { alreadyReleased: true, units: pr.UNIT_IDS || [] };
    if (tx.session.FACTORY_SESSION) return releaseFactoryBatch(tx, pr, cat);
    // physical identity is stable across scenarios: reuse the planned unit identities of the batch where the plan defines them
    const planned = await tx.db.collection('unit_master').find({ RUN_ID: tx.session.SOURCE_RUN_ID, INITIAL_BATCH_ID: pr.BATCH_ID, REPLACEMENT_FOR_UNIT_ID: null }, { session: tx.s, projection: { UNIT_ID: 1, TANK_SERIAL_NO: 1, DRAWING_REVISION: 1 } }).sort({ UNIT_ID: 1 }).limit(pr.PLANNED_QTY || 50).toArray();
    const first = C.route(cat, pr.PRODUCT_ID)[0];
    const fdef = C.opDef(cat, pr.PRODUCT_ID, first) || {};
    const line = await tx.db.collection('order_lines').findOne({ RUN_ID: tx.session.SOURCE_RUN_ID, ORDER_LINE_ID: pr.ORDER_LINE_ID, $or: [{ SESSION_ID: null }, { SESSION_ID: tx.sid }] }, { session: tx.s });
    const order = await tx.db.collection('production_orders').findOne({ RUN_ID: tx.session.SOURCE_RUN_ID, ORDER_ID: pr.ORDER_ID, $or: [{ SESSION_ID: null }, { SESSION_ID: tx.sid }] }, { session: tx.s });
    const units = [];
    for (let i = 0; i < (pr.PLANNED_QTY || 0); i++) {
      const pu = planned[i];
      const uid = pu ? pu.UNIT_ID : `TNK-${tx.session.SHORT_ID}-P${String(i + 1).padStart(3, '0')}-${pr.BATCH_ID.slice(-3)}`;
      if (await tx.one('sim_units', { UNIT_ID: uid })) continue;
      await tx.insert('sim_units', { UNIT_ID: uid, TANK_SERIAL_NO: pu ? pu.TANK_SERIAL_NO : `DEMO-TANK-${uid.slice(4)}`, PRODUCT_ID: pr.PRODUCT_ID, ORDER_ID: pr.ORDER_ID, ORDER_LINE_ID: pr.ORDER_LINE_ID, BATCH_ID: pr.BATCH_ID,
        REPLACEMENT_FOR_UNIT_ID: null, DRAWING_REVISION: pu ? pu.DRAWING_REVISION : null, STATE: 'QUEUED', ROUTE_STEP: first, CURRENT_WORK_CENTER_ID: fdef.WORK_CENTER_ID, QUEUE_ENTERED_AT: tx.now, STATE_SINCE: tx.now,
        PRIORITY_CLASS: order && order.PRIORITY === 'HIGH' ? 2 : 3, DUE_AT: line ? line.DUE_AT : (order || {}).DUE_AT, ORIGIN: 'PLAN_CONTINUATION', BATCH_MEMBERSHIP: { BATCH_ID: pr.BATCH_ID, VALID_FROM: tx.now, REASON: 'INITIAL_RELEASE' } });
      await H.openMembership(tx, uid, pr.BATCH_ID, 'INITIAL_RELEASE');
      units.push(uid);
    }
    await tx.update('sim_plan_releases', { BATCH_ID: pr.BATCH_ID }, { RELEASED: true, RELEASED_AT: tx.now, UNIT_IDS: units });
    await tx.event('BATCH_RELEASED', 'BATCH', pr.BATCH_ID, { UNIT_IDS: units, ORDER_LINE_ID: pr.ORDER_LINE_ID, CONTINUATION_RULE: 'PRODUCTION_PLAN known before the fork' });
    return { units };
  },
});

/** fresh factory: release creates the batch's tanks atomically with new identities, the pinned route version and full linkage */
async function releaseFactoryBatch(tx, pr, cat) {
  const M = require('../masterData');
  const { newTankIdentity } = require('../identity');
  const why = M.orderable(cat, pr.PRODUCT_ID);
  if (why) throw E.conflict('PRODUCT_NOT_RELEASABLE', `Cannot release ${pr.BATCH_ID}: ${why}`);
  const route = C.route(cat, pr.PRODUCT_ID);
  const first = route[0];
  const fdef = C.opDef(cat, pr.PRODUCT_ID, first);
  if (!fdef) throw E.conflict('NO_ROUTE', `Product ${pr.PRODUCT_ID} has no route`);
  const prod = cat.products[pr.PRODUCT_ID] || {};
  const line = await tx.db.collection('order_lines').findOne({ SESSION_ID: tx.sid, ORDER_LINE_ID: pr.ORDER_LINE_ID }, { session: tx.s });
  const order = await tx.db.collection('production_orders').findOne({ SESSION_ID: tx.sid, ORDER_ID: pr.ORDER_ID }, { session: tx.s });
  if (!line || !order) throw E.notFound('Order line of the batch');
  if (order.STATUS === 'CANCELLED') throw E.conflict('ORDER_CANCELLED', `${order.ORDER_ID} is cancelled`);
  const units = [];
  for (let i = 0; i < (pr.PLANNED_QTY || 0); i++) {
    const { unitId, serial } = await newTankIdentity(tx);
    await tx.insert('sim_units', { UNIT_ID: unitId, TANK_SERIAL_NO: serial, PRODUCT_ID: pr.PRODUCT_ID, ORDER_ID: pr.ORDER_ID, ORDER_LINE_ID: pr.ORDER_LINE_ID, BATCH_ID: pr.BATCH_ID, INITIAL_BATCH_ID: pr.BATCH_ID,
      REPLACEMENT_FOR_UNIT_ID: null, DRAWING_REF: prod.DRAWING_REF || null, DRAWING_REVISION: prod.DRAWING_REVISION || null, ROUTE_ID: prod.ROUTE_ID || null, ROUTE_VERSION: prod.ROUTE_VERSION || line.ROUTE_VERSION || null,
      SITE_ID: tx.session.SITE_ID || null, STATE: 'QUEUED', ROUTE_STEP: first, CURRENT_WORK_CENTER_ID: fdef.WORK_CENTER_ID, QUEUE_ENTERED_AT: tx.now, STATE_SINCE: tx.now,
      PRIORITY_CLASS: order.PRIORITY === 'HIGH' ? 2 : 3, DUE_AT: line.DUE_AT, ORIGIN: 'FACTORY_RELEASE', RELEASED_BY: tx.actor.loginId || tx.actor.workerId || 'SYSTEM', RELEASED_AT: tx.now,
      BATCH_MEMBERSHIP: { BATCH_ID: pr.BATCH_ID, VALID_FROM: tx.now, REASON: 'INITIAL_RELEASE' } });
    await H.openMembership(tx, unitId, pr.BATCH_ID, 'INITIAL_RELEASE');
    await tx.event('QUEUE_ENTERED', 'UNIT', unitId, { WORK_CENTER_ID: fdef.WORK_CENTER_ID, PRIORITY_CLASS: order.PRIORITY === 'HIGH' ? 2 : 3, TANK_SERIAL_NO: serial });
    units.push({ unitId, serial });
  }
  await tx.update('sim_plan_releases', { BATCH_ID: pr.BATCH_ID }, { RELEASED: true, RELEASED_AT: tx.now, UNIT_IDS: units.map(u => u.unitId), RELEASED_BY: tx.actor.loginId || null }, { expectVersion: pr.VERSION });
  await tx.db.collection('production_batches').updateOne({ SESSION_ID: tx.sid, BATCH_ID: pr.BATCH_ID }, { $set: { BATCH_STATUS: 'RELEASED', RELEASED_AT: tx.now, UNIT_IDS: units.map(u => u.unitId) } }, { session: tx.s });
  await tx.event('BATCH_RELEASED', 'BATCH', pr.BATCH_ID, { UNIT_IDS: units.map(u => u.unitId), SERIALS: units.map(u => u.serial), ORDER_LINE_ID: pr.ORDER_LINE_ID, ROUTE_VERSION: prod.ROUTE_VERSION || null });
  return { units: units.map(u => u.unitId), tanks: units, routeVersion: prod.ROUTE_VERSION || null, firstOperation: first, workCenterId: fdef.WORK_CENTER_ID };
}

/** fresh factory: an additional planned batch on an existing order line (planned quantity never exceeds the required good quantity) */
register('BATCH_CREATE', {
  perm: ['operational_supervision', 'scenario_control'], agentAllowed: false,
  handler: async (tx, p) => {
    if (!tx.session.FACTORY_SESSION) throw E.conflict('FACTORY_ONLY', 'Batches of the synthetic plan come from the imported production plan');
    const line = await tx.db.collection('order_lines').findOne({ SESSION_ID: tx.sid, ORDER_LINE_ID: p.orderLineId }, { session: tx.s });
    if (!line) throw E.notFound('Order line');
    const qty = Number(p.qty);
    if (!Number.isInteger(qty) || qty < 1) throw E.bad('INVALID_QTY', 'qty must be a positive whole number');
    const planned = await tx.many('sim_plan_releases', { ORDER_LINE_ID: line.ORDER_LINE_ID });
    const sum = planned.reduce((a, r) => a + Number(r.PLANNED_QTY || 0), 0);
    if (sum + qty > line.REQUIRED_GOOD_QTY) throw E.conflict('OVER_PLANNED', `Line ${line.ORDER_LINE_ID} needs ${line.REQUIRED_GOOD_QTY} good tanks and ${sum} are already planned; a scrapped tank is replaced through the replacement flow, which does not increase demand`, { required: line.REQUIRED_GOOD_QTY, planned: sum });
    const releaseAt = p.plannedReleaseAt ? new Date(p.plannedReleaseAt) : tx.now;
    if (isNaN(releaseAt) || releaseAt >= new Date(line.DUE_AT)) throw E.bad('INVALID_RELEASE_TIME', 'The planned release must be before the due time');
    const bid = `PB-${tx.session.SHORT_ID}-${(await tx.nextId('PB')).split('-').pop()}`;
    const tag = { SESSION_ID: tx.sid, RUN_ID: tx.session.SOURCE_RUN_ID, dataset_id: line.dataset_id, ORIGIN: 'APP_INPUT', _origin: 'APP', KNOWN_AT: tx.now, CREATED_AT: tx.received, CREATED_SIM_AT: tx.now, CREATED_BY: tx.actor.loginId || tx.actor.workerId };
    await tx.db.collection('production_batches').insertOne({ ...tag, BATCH_ID: bid, ORDER_ID: line.ORDER_ID, ORDER_LINE_ID: line.ORDER_LINE_ID, PRODUCT_ID: line.PRODUCT_ID, PLANNED_QTY: qty, BATCH_STATUS: 'PLANNED', PARENT_BATCH_ID: null,
      BATCH_TYPE: 'PRODUCTION_BATCH (not a material lot, equipment load or shipment)', RELEASE_AT: releaseAt, TARGET_FINISH_AT: line.DUE_AT }, { session: tx.s });
    await tx.db.collection('production_plan').insertOne({ ...tag, PLAN_ID: `PLN-${bid}`, BATCH_ID: bid, ORDER_LINE_ID: line.ORDER_LINE_ID, PLANNED_QTY: qty, PLANNED_START_AT: releaseAt, TARGET_FINISH_AT: line.DUE_AT, PLAN_STATUS: 'PLANNED' }, { session: tx.s });
    await tx.insert('sim_plan_releases', { BATCH_ID: bid, ORDER_LINE_ID: line.ORDER_LINE_ID, ORDER_ID: line.ORDER_ID, PRODUCT_ID: line.PRODUCT_ID, PLANNED_QTY: qty, PLANNED_RELEASE_AT: releaseAt, TARGET_FINISH_AT: line.DUE_AT, RELEASED: false, ORIGIN: 'APP_INPUT' });
    await tx.event('BATCH_CREATED', 'BATCH', bid, { ORDER_LINE_ID: line.ORDER_LINE_ID, QTY: qty });
    return { batchId: bid, plannedQty: qty, linePlanned: sum + qty, lineRequired: line.REQUIRED_GOOD_QTY };
  },
});

// ------------------------------------------------------------------ batch split (membership history; tanks move individually = partial transfers)
register('BATCH_SPLIT', {
  perm: ['operational_supervision', 'scenario_control'], agentAllowed: false,
  handler: async (tx, p) => {
    const ids = [...new Set((p.unitIds || []).map(String))];
    if (!p.batchId || !ids.length) throw E.bad('INVALID_SPLIT', 'batchId and at least one unitId are required');
    if (!p.reason || String(p.reason).trim().length < 3) throw E.bad('REASON_REQUIRED', 'A split needs a reason');
    const members = await tx.many('sim_units', { BATCH_ID: p.batchId });
    if (!members.length) throw E.notFound('Production batch');
    const moving = members.filter(u => ids.includes(u.UNIT_ID));
    if (moving.length !== ids.length) throw E.bad('NOT_IN_BATCH', `Only current members of ${p.batchId} can be split off (${ids.filter(i => !moving.some(u => u.UNIT_ID === i)).join(', ')})`);
    if (moving.length === members.length) throw E.bad('SPLIT_ALL', 'A split must leave at least one tank in the original batch');
    if (moving.some(u => ['ROUTE_COMPLETE', 'SCRAPPED'].includes(u.STATE))) throw E.conflict('TERMINAL_TANK', 'Completed or scrapped tanks keep their batch history and cannot be split off');
    const n = Number((((await tx.one('sim_sessions', { SESSION_ID: tx.sid })) || {}).COUNTERS || {})[`SPLIT_${p.batchId}`] || 0) + 1;
    await tx.db.collection('sim_sessions').updateOne({ SESSION_ID: tx.sid }, { $inc: { [`COUNTERS.SPLIT_${p.batchId}`]: 1 } }, { session: tx.s });
    const child = `${p.batchId}-S${n}`;
    const first = members[0];
    await tx.insert('sim_batches', { BATCH_ID: child, PARENT_BATCH_ID: p.batchId, ORDER_ID: first.ORDER_ID, ORDER_LINE_ID: first.ORDER_LINE_ID, PRODUCT_ID: first.PRODUCT_ID, PLANNED_QTY: moving.length,
      SPLIT_REASON: p.reason, SPLIT_BY: tx.actor.workerId || tx.actor.loginId, CREATED_AT_SIM: tx.now, KNOWN_AT: tx.now, NOTE: 'Production batch (not a material lot, paint load or shipment); demand stays on the order line' });
    for (const u of moving) {
      // a tank inherited from history has no session membership row yet: record its history membership as closed now
      if (!(await tx.one('sim_batch_membership', { UNIT_ID: u.UNIT_ID, OPEN_KEY: u.UNIT_ID }))) await H.openMembership(tx, u.UNIT_ID, p.batchId, 'CARRIED_FROM_HISTORY');
      await H.closeMembership(tx, u.UNIT_ID, `SPLIT_TO_${child}`);
      await H.openMembership(tx, u.UNIT_ID, child, 'SPLIT', p.batchId);
      await tx.update('sim_units', { UNIT_ID: u.UNIT_ID }, { BATCH_ID: child });
      await tx.event('BATCH_MEMBERSHIP_CHANGED', 'UNIT', u.UNIT_ID, { FROM_BATCH_ID: p.batchId, TO_BATCH_ID: child, REASON: p.reason });
    }
    await tx.event('BATCH_SPLIT', 'BATCH', p.batchId, { CHILD_BATCH_ID: child, UNIT_IDS: ids, REASON: p.reason });
    return { childBatchId: child, moved: ids, remaining: members.length - ids.length };
  },
});

// ------------------------------------------------------------------ equipment
register('EQUIPMENT_BREAKDOWN', {
  perm: ['equipment_status', 'scenario_control', 'operational_supervision'],
  handler: async (tx, p) => {
    const eq = await tx.must('sim_equipment', { EQUIPMENT_ID: p.equipmentId }, 'Equipment');
    if (eq.STATUS === 'DOWN') return { equipment: eq, alreadyDown: true };
    const est = p.estimatedRecoveryMin ? new Date(tx.now.getTime() + Number(p.estimatedRecoveryMin) * 60000) : null;
    const doc = await tx.update('sim_equipment', { EQUIPMENT_ID: eq.EQUIPMENT_ID }, { STATUS: 'DOWN', SINCE: tx.now, REASON_CODE: p.reasonCode || 'BREAKDOWN', ESTIMATED_RECOVERY_AT: est });
    await tx.event('EQUIPMENT_BREAKDOWN', 'EQUIPMENT', eq.EQUIPMENT_ID, { WORKSTATION_ID: eq.WORKSTATION_ID, REASON_CODE: p.reasonCode || 'BREAKDOWN', ESTIMATED_RECOVERY_AT: est });
    // work at the station pauses with an external (no-fault) reason
    const ops = await tx.many('sim_operations', { EQUIPMENT_ID: eq.EQUIPMENT_ID, STATE: { $in: ['WORKING', 'BELOW_MIN_CREW'] } });
    for (const op of ops) {
      const tasks = await tx.many('sim_tasks', { OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID, STATUS: 'WORKING' });
      for (const t of tasks) await pauseTask(tx, { task: t, worker: await tx.must('sim_workers', { WORKER_ID: t.WORKER_ID }), op }, 'EQUIPMENT_DOWN', `${eq.EQUIPMENT_ID} breakdown`);
      await H.refreshOperation(tx, op.OPERATION_INSTANCE_ID);
    }
    return { equipment: doc, pausedOperations: ops.map(o => o.OPERATION_INSTANCE_ID) };
  },
});

register('EQUIPMENT_REPAIRED', {
  perm: ['equipment_status', 'scenario_control', 'operational_supervision'],
  handler: async (tx, p) => {
    const eq = await tx.must('sim_equipment', { EQUIPMENT_ID: p.equipmentId }, 'Equipment');
    if (eq.STATUS !== 'DOWN') return { equipment: eq, alreadyUp: true };
    const doc = await tx.update('sim_equipment', { EQUIPMENT_ID: eq.EQUIPMENT_ID }, { STATUS: 'UP', SINCE: tx.now, REASON_CODE: null, ESTIMATED_RECOVERY_AT: null, LAST_DOWNTIME_MIN: (tx.now - new Date(eq.SINCE)) / 60000 });
    await tx.event('EQUIPMENT_RECOVERED', 'EQUIPMENT', eq.EQUIPMENT_ID, { WORKSTATION_ID: eq.WORKSTATION_ID, DOWNTIME_MIN: doc.LAST_DOWNTIME_MIN });
    return { equipment: doc };
  },
});

// ------------------------------------------------------------------ materials
register('MATERIAL_SHORTAGE', {
  perm: ['material_movements', 'scenario_control'],
  handler: async (tx, p) => {
    const m = await tx.must('sim_materials', { MATERIAL_ID: p.materialId }, 'Material');
    const set = {};
    if (p.setOnHandQty !== undefined) set.ON_HAND_QTY = Math.max(0, Number(p.setOnHandQty));
    if (p.holdQty !== undefined) set.HOLD_QTY = Math.max(0, Number(p.holdQty));
    // optional supply interruption: the supplier cannot deliver before SUPPLY_AVAILABLE_AT (open requests are re-promised, new ones respect it)
    let supplyAt = null;
    if (p.supplyDelayMin !== undefined && p.supplyDelayMin !== null && p.supplyDelayMin !== '') {
      const d = Number(p.supplyDelayMin);
      if (!(d >= 0 && d <= 7 * 24 * 60)) throw E.bad('INVALID_SUPPLY_DELAY', 'supplyDelayMin must be between 0 and 10080 minutes');
      supplyAt = d > 0 ? new Date(tx.now.getTime() + d * 60000) : null;
      set.SUPPLY_AVAILABLE_AT = supplyAt;
    }
    const doc = await tx.update('sim_materials', { MATERIAL_ID: m.MATERIAL_ID }, { ...set, SHORTAGE_REASON: p.reason || 'STOCK_DISCREPANCY' });
    await tx.event('MATERIAL_SHORTAGE_RECORDED', 'MATERIAL', m.MATERIAL_ID, { BEFORE_ON_HAND: m.ON_HAND_QTY, AFTER_ON_HAND: doc.ON_HAND_QTY, HOLD_QTY: doc.HOLD_QTY, REASON: p.reason || 'STOCK_DISCREPANCY', MOVEMENT_TYPE: 'ADJUSTMENT', SUPPLY_AVAILABLE_AT: supplyAt });
    const repromised = [];
    if (supplyAt) {
      for (const r of await tx.many('sim_material_requests', { MATERIAL_ID: m.MATERIAL_ID, STATUS: { $in: ['OPEN', 'PARTIAL'] } })) {
        if (r.PROMISED_AT && new Date(r.PROMISED_AT) >= supplyAt) continue;
        await tx.update('sim_material_requests', { REQUEST_ID: r.REQUEST_ID }, { PROMISED_AT: supplyAt, ORIGINAL_PROMISED_AT: r.ORIGINAL_PROMISED_AT || r.PROMISED_AT || null });
        await tx.event('MATERIAL_REQUEST_REPROMISED', 'MATERIAL', m.MATERIAL_ID, { REQUEST_ID: r.REQUEST_ID, FROM: r.PROMISED_AT || null, TO: supplyAt, REASON: 'SUPPLY_INTERRUPTION' });
        repromised.push(r.REQUEST_ID);
      }
    }
    return { material: doc, repromised };
  },
});

register('MATERIAL_REQUEST', {
  perm: ['material_movements', 'operational_supervision', 'scenario_control'],
  handler: async (tx, p) => {
    const id = await tx.nextId('MR');
    const needBy = p.needByAt ? new Date(p.needByAt) : new Date(tx.now.getTime() + Number(p.needByMin || 60) * 60000);
    let promised = p.promisedMin !== undefined ? new Date(tx.now.getTime() + Number(p.promisedMin) * 60000) : needBy;
    const mat = await tx.must('sim_materials', { MATERIAL_ID: p.materialId }, 'Material');
    if (!(Number(p.qty) > 0)) throw E.bad('INVALID_QTY', 'Requested quantity must be positive');
    if (mat.SUPPLY_AVAILABLE_AT && new Date(mat.SUPPLY_AVAILABLE_AT) > promised) promised = new Date(mat.SUPPLY_AVAILABLE_AT);   // supplier interruption
    const doc = await tx.insert('sim_material_requests', { REQUEST_ID: id, MATERIAL_ID: p.materialId, QTY: Number(p.qty), DELIVERED_QTY: 0, NEED_BY_AT: needBy, PROMISED_AT: promised, REQUESTED_AT: tx.now, KNOWN_AT: tx.now,
      REQUEST_TYPE: p.expedite ? 'EXPEDITED' : 'REPLENISHMENT', STATUS: 'OPEN', RELATED_OPERATION_INSTANCE_ID: p.operationInstanceId || null });
    await tx.event('MATERIAL_REQUESTED', 'MATERIAL', p.materialId, { REQUEST_ID: id, QTY: Number(p.qty), NEED_BY_AT: needBy, PROMISED_AT: promised });
    return { request: doc };
  },
});

register('MATERIAL_DELIVERY', {
  perm: ['material_movements', 'scenario_control', 'operational_supervision'],
  handler: async (tx, p) => {
    const m = await tx.must('sim_materials', { MATERIAL_ID: p.materialId }, 'Material');
    const qty = Number(p.qty);
    if (!(qty > 0)) throw E.bad('INVALID_QTY', 'Delivered quantity must be positive');
    const doc = await tx.update('sim_materials', { MATERIAL_ID: m.MATERIAL_ID }, { ON_HAND_QTY: Math.round((Number(m.ON_HAND_QTY || 0) + qty) * 1000) / 1000 });
    let req = null;
    if (p.requestId) {
      const r = await tx.must('sim_material_requests', { REQUEST_ID: p.requestId }, 'Material request');
      const delivered = Number(r.DELIVERED_QTY || 0) + qty;
      req = await tx.update('sim_material_requests', { REQUEST_ID: r.REQUEST_ID }, { DELIVERED_QTY: delivered, STATUS: delivered >= Number(r.QTY) ? 'DELIVERED' : 'PARTIALLY_DELIVERED', DELIVERED_AT: delivered >= Number(r.QTY) ? tx.now : null, LAST_DELIVERY_AT: tx.now });
    }
    await tx.event('MATERIAL_RECEIVED', 'MATERIAL', m.MATERIAL_ID, { QTY: qty, REQUEST_ID: p.requestId || null, MOVEMENT_TYPE: 'RECEIPT' });
    return { material: doc, request: req };
  },
});

// manual issue outside the routing kit (re-kitting, damaged parts) and the reversal of an issue recorded by mistake (double scan);
// both are material movements with their own events, so the F3 material-velocity rule sees net issues
register('MATERIAL_ISSUE', {
  perm: ['material_movements', 'scenario_control'],
  handler: async (tx, p) => {
    const m = await tx.must('sim_materials', { MATERIAL_ID: p.materialId }, 'Material');
    const qty = Number(p.qty || 1);
    if (!(qty > 0)) throw E.bad('INVALID_QTY', 'Issued quantity must be positive');
    if (!p.reason) throw E.bad('REASON_REQUIRED', 'A manual issue needs a reason (e.g. REKIT_DAMAGED_PART)');
    const avail = Number(m.ON_HAND_QTY || 0) - Number(m.HOLD_QTY || 0);
    if (avail < qty) throw E.conflict('INSUFFICIENT_STOCK', `Only ${avail} ${m.MATERIAL_ID} available`);
    const doc = await tx.update('sim_materials', { MATERIAL_ID: m.MATERIAL_ID }, { ON_HAND_QTY: Math.round((Number(m.ON_HAND_QTY || 0) - qty) * 1000) / 1000 });
    const ev = await tx.event('MATERIAL_CONSUMED', 'MATERIAL', m.MATERIAL_ID, { QTY: -qty, UNIT_ID: p.unitId || null, MOVEMENT_TYPE: 'MANUAL_ISSUE', REASON: p.reason });
    return { material: doc, eventId: ev.EVENT_ID };
  },
});
register('MATERIAL_ISSUE_REVERSE', {
  perm: ['material_movements', 'scenario_control'],
  handler: async (tx, p) => {
    const ev = await tx.must('sim_events', { EVENT_ID: p.eventId, EVENT_TYPE: 'MATERIAL_CONSUMED' }, 'Material issue event');
    if (await tx.one('sim_events', { EVENT_TYPE: 'MATERIAL_ISSUE_REVERSED', 'PAYLOAD.REVERSES_EVENT_ID': ev.EVENT_ID })) throw E.conflict('ALREADY_REVERSED', `${ev.EVENT_ID} was already reversed`);
    const m = await tx.must('sim_materials', { MATERIAL_ID: ev.ENTITY_ID }, 'Material');
    const qty = Math.abs(Number((ev.PAYLOAD || {}).QTY || 0));
    const doc = await tx.update('sim_materials', { MATERIAL_ID: m.MATERIAL_ID }, { ON_HAND_QTY: Math.round((Number(m.ON_HAND_QTY || 0) + qty) * 1000) / 1000 });
    await tx.event('MATERIAL_ISSUE_REVERSED', 'MATERIAL', m.MATERIAL_ID, { REVERSES_EVENT_ID: ev.EVENT_ID, QTY: qty, REASON: p.reason || 'RECORDED_IN_ERROR', ISSUE_EVENT_TIME: ev.EVENT_TIME });
    return { material: doc };
  },
});

register('MATERIAL_REQUEST_CANCEL', {
  perm: ['material_movements', 'operational_supervision'],
  handler: async (tx, p) => {
    const r = await tx.must('sim_material_requests', { REQUEST_ID: p.requestId }, 'Material request');
    const doc = await tx.update('sim_material_requests', { REQUEST_ID: r.REQUEST_ID }, { STATUS: 'CANCELLED', CANCELLED_AT: tx.now });
    await tx.event('MATERIAL_REQUEST_CANCELLED', 'MATERIAL', r.MATERIAL_ID, { REQUEST_ID: r.REQUEST_ID });
    return { request: doc };
  },
});

// ------------------------------------------------------------------ workforce movement (area moves need qualification + handover; never instantaneous)
async function transferWorker(tx, p) {
  const cat = await C.catalog();
  const w = await tx.must('sim_workers', { WORKER_ID: p.workerId }, 'Worker');
  H.assertAgentMayAct(tx, w);
  if (w.ATTENDANCE_STATE !== 'CLOCKED_IN') throw E.conflict('NOT_CLOCKED_IN', `${w.DISPLAY_NAME} is not clocked in`);
  if (w.ACTIVITY_STATE === 'BREAK') throw E.conflict('ON_BREAK', `${w.DISPLAY_NAME} is on a break - transfer after the break`);
  if (w.ACTIVITY_STATE === 'TRANSFER') throw E.conflict('IN_TRANSFER', `${w.DISPLAY_NAME} is already in transfer`);
  const from = w.TEMP_WORK_CENTER_ID || w.CURRENT_WORK_CENTER_ID || w.HOME_WORK_CENTER_ID;
  const to = p.toWorkCenterId;
  if (!cat.wcs[to]) throw E.bad('INVALID_WORK_CENTER', 'Unknown destination work centre');
  if (from === to) throw E.bad('SAME_WORK_CENTER', 'Already at that work centre');
  const rule = C.transferRule(cat, from, to);
  const skills = rule && rule.REQUIRED_SKILL_ID ? String(rule.REQUIRED_SKILL_ID).split('|') : cat.routing.filter(r => r.WORK_CENTER_ID === to && r.REQUIRED_SKILL_ID && r.OPERATION_KIND === 'LABOR').map(r => r.REQUIRED_SKILL_ID);
  if (skills.length && !skills.some(s => C.qualified(cat, w.WORKER_ID, s, tx.now))) throw E.forbidden(`${w.DISPLAY_NAME} has no valid qualification for ${to} (${skills.join(' / ')})`);
  // donor protection: the source operation must keep its minimum crew
  const working = await tx.many('sim_tasks', { WORKER_ID: w.WORKER_ID, STATUS: 'WORKING' });
  for (const t of working) {
    const op = await tx.must('sim_operations', { OPERATION_INSTANCE_ID: t.OPERATION_INSTANCE_ID });
    const crew = await tx.many('sim_tasks', { OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID, STATUS: 'WORKING' });
    if (crew.length - 1 < (op.MIN_CREW_SIZE || 1) && !p.allowSourceBelowMin) throw E.conflict('SOURCE_BELOW_MIN_CREW', `Moving ${w.DISPLAY_NAME} would leave ${op.OPERATION_ID} at ${op.WORKSTATION_ID} with ${crew.length - 1} (minimum ${op.MIN_CREW_SIZE}) - transfer rejected to protect the donor station`, { operationInstanceId: op.OPERATION_INSTANCE_ID });
    await pauseTask(tx, { task: t, worker: w, op }, 'SUPERVISOR_DIRECTED_TRANSFER', `Transfer to ${to}`);
    await H.moveTask(tx, await tx.must('sim_tasks', { TASK_ID: t.TASK_ID }), 'ENDED_BEFORE_OPERATION_FINISH', { ENDED_REASON: 'SUPERVISOR_DIRECTED_TRANSFER' }, { force: true });
  }
  const travel = rule ? Number(rule.TRAVEL_MIN || 0) : 5;
  const handover = rule ? Number(rule.HANDOVER_MIN || 0) : 10;
  const arrive = new Date(tx.now.getTime() + (travel + handover) * 60000);
  const id = await tx.nextId('TRF');
  await tx.insert('sim_transfers', { TRANSFER_ID: id, WORKER_ID: w.WORKER_ID, FROM_WORK_CENTER_ID: from, TO_WORK_CENTER_ID: to, REASON_CODE: p.reason || 'SUPERVISOR_DIRECTED_TRANSFER', ACTION_ID: p.actionId || null,
    APPROVED_BY: tx.actor.workerId || tx.actor.loginId, DEPARTED_AT: tx.now, PLANNED_TRAVEL_MIN: travel, PLANNED_HANDOVER_MIN: handover, PLANNED_ARRIVAL_AT: arrive, PLANNED_RETURN_AT: p.plannedReturnAt ? new Date(p.plannedReturnAt) : null,
    STATUS: 'IN_TRANSIT', KNOWN_AT: tx.now });
  await H.segment(tx, w.WORKER_ID, 'TRANSFER', { REASON: 'SUPERVISOR_DIRECTED_TRANSFER', WORK_CENTER_ID: to });
  const doc = await H.setWorker(tx, await tx.must('sim_workers', { WORKER_ID: w.WORKER_ID }), { ACTIVITY_STATE: 'TRANSFER', REASON_CODE: 'SUPERVISOR_DIRECTED_TRANSFER', TRANSFER_ID: id, TRANSFER_TO_WORK_CENTER_ID: to, TRANSFER_ARRIVE_AT: arrive, CURRENT_TASK_ID: null }, 'WORKER_TRANSFER_STARTED');
  return { transferId: id, worker: doc, plannedArrivalAt: arrive };
}
register('WORKER_TRANSFER', { perm: 'approve_transfers', handler: async (tx, p) => transferWorker(tx, p) });

// relief worker: an off-shift, qualified person is called in for one work centre (a session-scoped roster row; the person clocks in
// on arrival like any rostered shift - login never clocks anyone in)
async function reliefCallIn(tx, p) {
  const cat = await C.catalog();
  const w = await tx.must('sim_workers', { WORKER_ID: p.workerId }, 'Worker');
  if (w.CONTROL && w.CONTROL.MODE && w.CONTROL.MODE !== 'AGENT') throw E.conflict('HUMAN_CONTROLLED', `${w.DISPLAY_NAME} is controlled by a person`);
  if (!['OFF_SHIFT', 'NOT_CLOCKED_IN', 'CLOCKED_OUT', 'NOT_RECORDED'].includes(w.ATTENDANCE_STATE)) throw E.conflict('NOT_OFF_SHIFT', `${w.DISPLAY_NAME} is ${w.ATTENDANCE_STATE} - a relief call-in is for people off shift (absent people are not called in)`);
  const wc = p.toWorkCenterId;
  if (!cat.wcs[wc]) throw E.bad('INVALID_WORK_CENTER', 'Unknown work centre');
  const skills = cat.routing.filter(r => r.WORK_CENTER_ID === wc && r.REQUIRED_SKILL_ID && r.OPERATION_KIND === 'LABOR').map(r => r.REQUIRED_SKILL_ID);
  if (skills.length && !skills.some(sk => C.qualified(cat, w.WORKER_ID, sk, tx.now))) throw E.forbidden(`${w.DISPLAY_NAME} has no valid qualification for ${wc}`);
  const arrive = p.plannedArrivalAt ? new Date(p.plannedArrivalAt) : new Date(tx.now.getTime() + 30 * 60000);
  const until = p.until ? new Date(p.until) : new Date(arrive.getTime() + 4 * 3600000);
  if (!(until > arrive) || arrive < tx.now) throw E.bad('INVALID_WINDOW', 'The call-in window must start now or later and end after it starts');
  const id = await tx.nextId('RLF');
  await tx.db.collection('app_shift_roster').insertOne({ ROSTER_ID: `ROS-${tx.sid}-${id}`, SESSION_ID: tx.sid, WORKER_ID: w.WORKER_ID, SHIFT_ID: `CALLIN-${id}`, PLANNED_START_AT: arrive, PLANNED_END_AT: until, PLANNED_WORK_CENTER_ID: wc,
    ROSTER_STATUS: 'SCHEDULED', ORIGIN: 'RELIEF_CALL_IN', ACTION_ID: p.actionId || null, KNOWN_AT: tx.now, CREATED_AT: tx.received, _origin: 'APP' }, { session: tx.s });
  await tx.insert('sim_overtime', { OVERTIME_ID: id, TYPE: 'RELIEF_CALL_IN', WORKER_ID: w.WORKER_ID, WORK_CENTER_ID: wc, PLANNED_START_AT: arrive, PLANNED_END_AT: until, APPROVED_BY: tx.actor.workerId || tx.actor.loginId,
    ACTION_ID: p.actionId || null, REASON: p.reason || 'ORDER_RECOVERY', KNOWN_AT: tx.now });
  await tx.db.collection('sim_sessions').updateOne({ SESSION_ID: tx.sid }, { $inc: { ROSTER_VERSION: 1 } }, { session: tx.s });
  await tx.event('RELIEF_CALLED_IN', 'WORKER', w.WORKER_ID, { CALL_IN_ID: id, WORK_CENTER_ID: wc, PLANNED_ARRIVAL_AT: arrive, UNTIL: until });
  return { callInId: id, plannedArrivalAt: arrive, until };
}
register('RELIEF_CALL_IN', { perm: ['approve_transfers', 'operational_supervision'], handler: async (tx, p) => reliefCallIn(tx, p) });

register('TRANSFER_ARRIVE', {
  perm: ['approve_transfers', 'operate_own_tasks'],
  handler: async (tx, p) => {
    const workerId = p.workerId || tx.actor.workerId;
    if (tx.actor.kind === 'HUMAN' && workerId !== tx.actor.workerId && !(tx.actor.permissions || []).includes('approve_transfers')) throw E.forbidden('Only the transferred worker or a supervisor confirms arrival');
    const w = await tx.must('sim_workers', { WORKER_ID: workerId }, 'Worker');
    H.assertAgentMayAct(tx, w);
    if (w.ACTIVITY_STATE !== 'TRANSFER' || !w.TRANSFER_ID) throw E.conflict('NOT_IN_TRANSFER', 'Worker is not in transfer');
    const tr = await tx.must('sim_transfers', { TRANSFER_ID: w.TRANSFER_ID });
    const actualMin = (tx.now - new Date(tr.DEPARTED_AT)) / 60000;
    await tx.update('sim_transfers', { TRANSFER_ID: tr.TRANSFER_ID }, { ARRIVED_AT: tx.now, ACTUAL_TRAVEL_AND_HANDOVER_MIN: Math.round(actualMin * 10) / 10, STATUS: 'ARRIVED' });
    await H.segment(tx, workerId, 'WAITING', { REASON: 'AFTER_TRANSFER', WORK_CENTER_ID: tr.TO_WORK_CENTER_ID });
    const home = (await C.catalog()).workers[workerId] || {};
    const doc = await H.setWorker(tx, w, { ACTIVITY_STATE: 'AVAILABLE', REASON_CODE: 'TRANSFER_ARRIVED', CURRENT_WORK_CENTER_ID: tr.TO_WORK_CENTER_ID, CURRENT_WORKSTATION_ID: null,
      TEMP_WORK_CENTER_ID: tr.TO_WORK_CENTER_ID === home.HOME_WORK_CENTER_ID ? null : tr.TO_WORK_CENTER_ID, TRANSFER_ID: null, TRANSFER_ARRIVE_AT: null }, 'WORKER_TRANSFER_ARRIVED');
    return { worker: doc, actualTravelAndHandoverMin: Math.round(actualMin * 10) / 10, plannedMin: tr.PLANNED_TRAVEL_MIN + tr.PLANNED_HANDOVER_MIN };
  },
});

// ------------------------------------------------------------------ attendance supervision
register('ABSENCE_CONFIRM', {
  perm: ['operational_supervision', 'scenario_control'],
  handler: async (tx, p) => {
    const w = await tx.must('sim_workers', { WORKER_ID: p.workerId }, 'Worker');
    if (w.ATTENDANCE_STATE === 'ABSENT') return { worker: w, alreadyAbsent: true };
    if (w.ATTENDANCE_STATE === 'CLOCKED_IN' && !p.midShiftExit) throw E.conflict('CLOCKED_IN', `${w.DISPLAY_NAME} is clocked in; record a mid-shift exit instead`);
    const tasks = await tx.many('sim_tasks', { WORKER_ID: w.WORKER_ID, STATUS: { $in: ['ASSIGNED', 'ACCEPTED', 'WORKING', 'PAUSED'] } });
    for (const t of tasks) {
      if (t.STATUS === 'WORKING') await pauseTask(tx, { task: t, worker: w, op: await tx.must('sim_operations', { OPERATION_INSTANCE_ID: t.OPERATION_INSTANCE_ID }) }, 'OTHER', 'Mid-shift exit');
      await H.moveTask(tx, await tx.must('sim_tasks', { TASK_ID: t.TASK_ID }), t.STARTED_AT ? 'ENDED_BEFORE_OPERATION_FINISH' : 'CANCELLED', { ENDED_REASON: 'WORKER_ABSENT' }, { force: true });
      await H.refreshOperation(tx, t.OPERATION_INSTANCE_ID);
    }
    const id = await tx.nextId('ATT');
    await tx.insert('sim_attendance', { EVENT_ID: id, WORKER_ID: w.WORKER_ID, EVENT_TYPE: p.midShiftExit ? 'MID_SHIFT_EXIT_APPROVED' : 'ABSENCE_CONFIRMED', EVENT_TIME: tx.now, KNOWN_AT: tx.now, SHIFT_ID: w.SHIFT_ID, REASON_CODE: p.reason || 'CONFIRMED_ABSENCE', CONFIRMED_BY: tx.actor.workerId || tx.actor.loginId });
    await H.segment(tx, w.WORKER_ID, null);
    const doc = await H.setWorker(tx, await tx.must('sim_workers', { WORKER_ID: w.WORKER_ID }), { ATTENDANCE_STATE: p.midShiftExit ? 'CLOCKED_OUT' : 'ABSENT', ACTIVITY_STATE: p.midShiftExit ? 'OFF_SHIFT' : 'ABSENT', REASON_CODE: p.reason || 'CONFIRMED_ABSENCE', CURRENT_TASK_ID: null, LAST_CLOCK_OUT_AT: p.midShiftExit ? tx.now : w.LAST_CLOCK_OUT_AT }, 'ATTENDANCE_ABSENCE_CONFIRMED');
    return { worker: doc, endedTasks: tasks.map(t => t.TASK_ID) };
  },
});

register('OVERTIME_APPROVE', {
  perm: ['operational_supervision', 'approve_transfers'],
  handler: async (tx, p) => {
    const w = await tx.must('sim_workers', { WORKER_ID: p.workerId }, 'Worker');
    const start = p.startAt ? new Date(p.startAt) : (w.PLANNED_END_AT ? new Date(w.PLANNED_END_AT) : tx.now);
    const end = p.endAt ? new Date(p.endAt) : new Date(start.getTime() + Number(p.minutes || 60) * 60000);
    if (end <= start) throw E.bad('INVALID_INTERVAL', 'Overtime end must be after start');
    const id = await tx.nextId('OT');
    const doc = await tx.insert('sim_overtime', { OVERTIME_ID: id, WORKER_ID: w.WORKER_ID, SHIFT_ID: w.SHIFT_ID, APPROVED_START_AT: start, APPROVED_END_AT: end, APPROVED_AT: tx.now, APPROVED_BY: tx.actor.workerId || tx.actor.loginId, REASON_CODE: p.reason || 'ORDER_RECOVERY', KNOWN_AT: tx.now, ACTION_ID: p.actionId || null,
      NOTE: 'Overtime extends attendance, never the customer due date' });
    await tx.update('sim_workers', { WORKER_ID: w.WORKER_ID }, { OVERTIME_UNTIL: end });
    await tx.event('OVERTIME_APPROVED', 'WORKER', w.WORKER_ID, { OVERTIME_ID: id, START: start, END: end });
    return { overtime: doc };
  },
});

register('ATTENDANCE_CORRECTION', {
  perm: 'operational_supervision',
  handler: async (tx, p) => {
    const w = await tx.must('sim_workers', { WORKER_ID: p.workerId }, 'Worker');
    if (!['ADD_MISSING_CLOCK_IN', 'ADD_MISSING_CLOCK_OUT', 'VOID_PUNCH'].includes(p.correctionType)) throw E.bad('INVALID_CORRECTION', 'correctionType must be ADD_MISSING_CLOCK_IN, ADD_MISSING_CLOCK_OUT or VOID_PUNCH');
    if (!p.reason) throw E.bad('REASON_REQUIRED', 'A correction needs a reason');
    const t = new Date(p.correctedTime || tx.now);
    if (t > tx.now) throw E.bad('FUTURE_TIME', 'Corrected time cannot be in the future');
    const id = await tx.nextId('COR');
    const doc = await tx.insert('sim_attendance_corrections', { CORRECTION_ID: id, WORKER_ID: w.WORKER_ID, SHIFT_ID: w.SHIFT_ID, CORRECTION_TYPE: p.correctionType, CORRECTED_EVENT_TIME: t, ORIGINAL_EVENT_ID: p.originalEventId || null,
      REASON_CODE: p.reason, ENTERED_BY: tx.actor.workerId || tx.actor.loginId, ENTERED_AT: tx.now, KNOWN_AT: tx.now, APPROVED_BY: tx.actor.workerId || tx.actor.loginId, NOTE: 'Correction appended; the original record is kept' });
    const set = {};
    if (p.correctionType === 'ADD_MISSING_CLOCK_IN' && w.ATTENDANCE_STATE !== 'CLOCKED_IN') Object.assign(set, { ATTENDANCE_STATE: 'CLOCKED_IN', FIRST_CLOCK_IN_AT: w.FIRST_CLOCK_IN_AT || t, ACTIVITY_STATE: w.ACTIVITY_STATE === 'NOT_STARTED' ? 'AVAILABLE' : w.ACTIVITY_STATE });
    if (p.correctionType === 'ADD_MISSING_CLOCK_OUT' && w.ATTENDANCE_STATE === 'CLOCKED_IN') Object.assign(set, { ATTENDANCE_STATE: 'CLOCKED_OUT', LAST_CLOCK_OUT_AT: t, ACTIVITY_STATE: 'OFF_SHIFT' });
    if (Object.keys(set).length) await H.setWorker(tx, w, set, 'ATTENDANCE_CORRECTED');
    await tx.event('ATTENDANCE_CORRECTION_APPENDED', 'WORKER', w.WORKER_ID, { CORRECTION_ID: id, CORRECTION_TYPE: p.correctionType, CORRECTED_EVENT_TIME: t });
    return { correction: doc };
  },
});

// ------------------------------------------------------------------ scenario console causes (never set a flag or a total directly)
register('SEED_DEFECT', {
  perm: 'scenario_control', agentAllowed: false,
  handler: async (tx, p) => {
    const unit = await tx.must('sim_units', { UNIT_ID: p.unitId }, 'Tank');
    if (H.TERMINAL.has(unit.STATE)) throw E.conflict('UNIT_TERMINAL', `Tank is ${unit.STATE}`);
    const seed = { GATE_OPERATION_ID: p.gateOperationId || null, CHECK_ID: p.checkId || null, SEVERITY: p.severity || 'REPAIRABLE', CREATED_AT: tx.now, CREATED_BY: tx.actor.loginId, REMAINING: Number(p.failCount || 1) };
    const doc = await tx.update('sim_units', { UNIT_ID: unit.UNIT_ID }, { SEEDED_DEFECT: seed });
    await tx.event('CONSOLE_DEFECT_SEEDED', 'UNIT', unit.UNIT_ID, { ...seed, NOTE: 'A physical defect exists on the tank (synthetic cause); inspections must detect it - no result is pre-set' });
    return { unit: doc };
  },
});

register('SET_ENTRY_LAG', {
  perm: 'scenario_control', agentAllowed: false,
  handler: async (tx, p) => {
    await tx.db.collection('sim_sessions').updateOne({ SESSION_ID: tx.sid }, { $set: { 'AGENT_SETTINGS.NEXT_INSPECTION_ENTRY_LAG_MIN': Number(p.minutes || 8) } }, { session: tx.s });
    await tx.event('CONSOLE_ENTRY_LAG_SET', 'SESSION', tx.sid, { MINUTES: Number(p.minutes || 8), NOTE: 'The next agent inspection result is entered late (KNOWN_AT after EVENT_TIME)' });
    return { minutes: Number(p.minutes || 8) };
  },
});

module.exports = { transferWorker, stationOccupant, STATION_BUSY };
