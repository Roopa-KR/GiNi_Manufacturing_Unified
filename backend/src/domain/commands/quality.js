'use strict';
/* Mandatory post-task inspection, release, holds, dispositions, return-for-rework, investigations, scrap and replacement. */
const { register } = require('../executor');
const H = require('../helpers');
const C = require('../catalog');
const E = require('../../lib/errors');
const { evaluate } = require('../inspectionRules');

const INSPECTABLE = ['WORK_COMPLETED_AWAITING_INSPECTION', 'REWORK_COMPLETE_AWAITING_REINSPECTION', 'INCOMPLETE_INSPECTION_HOLD'];

function stripIds(o) { const { _id, _seed, ...rest } = o || {}; return rest; }

async function startInspection(tx, unit, inspectorId, kind) {
  const cat = await C.catalog();
  const gate = C.gateAfter(cat, unit.PRODUCT_ID, (await tx.one('sim_operations', { OPERATION_INSTANCE_ID: unit.LAST_LABOR_OPERATION_INSTANCE_ID }) || {}).OPERATION_ID || unit.ROUTE_STEP) || unit.ROUTE_STEP;
  const prior = await tx.many('sim_inspections', { UNIT_ID: unit.UNIT_ID, GATE_OPERATION_ID: gate, INSPECTION_KIND: kind, STATUS: 'SUBMITTED' }, { sort: { COMPLETED_AT: -1 } });
  const histPrior = kind === 'INDEPENDENT' ? await tx.db.collection('inspection_header').find({ RUN_ID: tx.session.SOURCE_RUN_ID, UNIT_ID: unit.UNIT_ID, GATE_OPERATION_ID: gate, KNOWN_AT: { $lte: new Date(tx.session.FORK_AT) } }, { session: tx.s }).sort({ COMPLETED_AT: -1 }).toArray() : [];
  const last = prior[0] || histPrior[0] || null;
  let trigger = 'INITIAL';
  if (last) trigger = last.RESULT === 'INCOMPLETE' ? 'REINSPECTION_AFTER_INCOMPLETE_EVIDENCE' : (unit.STATE === 'REWORK_COMPLETE_AWAITING_REINSPECTION' ? (unit.REWORK_PENDING && unit.REWORK_PENDING.REWORK_TYPE === 'DOWNSTREAM_REWORK' ? 'REINSPECTION_AFTER_DOWNSTREAM_RETURN_REWORK' : 'REINSPECTION_AFTER_REWORK') : 'REINSPECTION');
  const insId = await tx.nextId(kind === 'SELF_CHECK' ? 'SCK' : 'INS');
  let opId = null;
  if (kind === 'INDEPENDENT') {
    // the inspection is an operation attempt of the gate; the inspector's time is INSPECTING (not production labour)
    opId = await tx.nextId('OPI');
    const def = C.opDef(cat, unit.PRODUCT_ID, gate) || {};
    await tx.insert('sim_operations', { OPERATION_INSTANCE_ID: opId, UNIT_ID: unit.UNIT_ID, OPERATION_ID: gate, OPERATION_KIND: 'INSPECTION', PRODUCT_ID: unit.PRODUCT_ID, WORK_CENTER_ID: unit.CURRENT_WORK_CENTER_ID,
      WORKSTATION_ID: unit.CURRENT_WORKSTATION_ID, ATTEMPT_NO: prior.length + histPrior.length + 1, INSTANCE_TYPE: 'INSPECTION', STATE: 'WORKING', CREW: [inspectorId], CREATED_AT: tx.now, STARTED_AT: tx.now,
      STANDARD_ELAPSED_MIN: def.STANDARD_ELAPSED_MIN, MIN_CREW_SIZE: 1, REQUIRED_SKILL_ID: def.REQUIRED_SKILL_ID || (tx.session.FACTORY_SESSION ? null : 'SK-INSP'), MILESTONES_DONE: [], ORIGIN: 'BRANCH_NEW', INSPECTION_ID: insId });
    const tid = await tx.nextId('TSK');
    await tx.insert('sim_tasks', { TASK_ID: tid, OPERATION_INSTANCE_ID: opId, UNIT_ID: unit.UNIT_ID, OPERATION_ID: gate, WORKER_ID: inspectorId, ROLE: 'INSPECTOR', STATUS: 'WORKING', ASSIGNED_AT: tx.now, ACCEPTED_AT: tx.now, STARTED_AT: tx.now, STATUS_SINCE: tx.now, ORIGIN: 'BRANCH_NEW' });
    const w = await tx.must('sim_workers', { WORKER_ID: inspectorId });
    await H.segment(tx, inspectorId, 'INSPECTING', { OPERATION_INSTANCE_ID: opId, UNIT_ID: unit.UNIT_ID, WORKSTATION_ID: unit.CURRENT_WORKSTATION_ID, WORK_CENTER_ID: unit.CURRENT_WORK_CENTER_ID });
    await H.setWorker(tx, w, { ACTIVITY_STATE: 'INSPECTING', REASON_CODE: gate, CURRENT_TASK_ID: tid, CURRENT_OPERATION_INSTANCE_ID: opId, CURRENT_WORKSTATION_ID: unit.CURRENT_WORKSTATION_ID, CURRENT_WORK_CENTER_ID: unit.CURRENT_WORK_CENTER_ID }, 'WORKER_INSPECTION_START');
    await H.moveUnit(tx, unit, unit.STATE === 'REWORK_COMPLETE_AWAITING_REINSPECTION' ? 'REINSPECTION_IN_PROGRESS' : 'INSPECTION_IN_PROGRESS', { CURRENT_INSPECTION_ID: insId }, { force: unit.STATE === 'INCOMPLETE_INSPECTION_HOLD' });
  }
  // the checklist (questions and limits) is pinned to the inspection when it starts: a later checklist version never changes it
  const pinned = C.checklist(cat, gate, unit.PRODUCT_ID).map(({ check, specs }) => ({ check: stripIds(check), specs: specs.map(stripIds) }));
  const checklistVersion = pinned.length ? (pinned[0].check.CHECKLIST_VERSION || pinned[0].check.CHECK_VERSION || 'CTQ-1.0') : null;
  const doc = await tx.insert('sim_inspections', { CHECKLIST_SNAPSHOT: pinned, INSPECTION_ID: insId, UNIT_ID: unit.UNIT_ID, PRODUCT_ID: unit.PRODUCT_ID, OPERATION_INSTANCE_ID: opId, INSPECTED_OPERATION_INSTANCE_ID: unit.LAST_LABOR_OPERATION_INSTANCE_ID || null,
    GATE_OPERATION_ID: gate, WORK_CENTER_ID: unit.CURRENT_WORK_CENTER_ID, WORKSTATION_ID: unit.CURRENT_WORKSTATION_ID, INSPECTOR_ID: inspectorId, INSPECTION_KIND: kind, ATTEMPT_NO: prior.length + histPrior.length + 1,
    INSPECTION_TRIGGER: trigger, REINSPECTION_OF_INSPECTION_ID: last ? last.INSPECTION_ID : null, CHECKLIST_VERSION: tx.session.FACTORY_SESSION ? checklistVersion : 'CTQ-1.0', ROUTE_VERSION: unit.ROUTE_VERSION || null, STATUS: 'DRAFT', STARTED_AT: tx.now, DRAFT_ANSWERS: {}, DRAFT_SAVED_AT: null, ORIGIN: 'BRANCH_NEW' });
  if (kind === 'INDEPENDENT') await tx.update('sim_units', { UNIT_ID: unit.UNIT_ID }, { ASSIGNED_INSPECTOR_ID: null });
  await tx.event(kind === 'SELF_CHECK' ? 'SELF_CHECK_STARTED' : 'INSPECTION_STARTED', 'INSPECTION', insId, { UNIT_ID: unit.UNIT_ID, GATE_OPERATION_ID: gate, INSPECTOR_ID: inspectorId, TRIGGER: trigger });
  return doc;
}

register('INSPECTION_ASSIGN', {
  perm: ['operational_supervision', 'quality_disposition'], agentAllowed: false,
  handler: async (tx, p) => {
    const unit = await tx.must('sim_units', { UNIT_ID: p.unitId }, 'Tank');
    if (!INSPECTABLE.includes(unit.STATE)) throw E.conflict('NOT_AWAITING_INSPECTION', 'Assign an inspector after work is complete and before inspection starts');
    const inspector = await tx.must('sim_workers', { WORKER_ID: p.inspectorId }, 'Inspector');
    const cat = await C.catalog();
    const master = cat.workers[p.inspectorId];
    if (!master || master.ACTIVE_FLAG === 'N' || !['QUALITY_INSPECTOR', 'QUALITY_SUPERVISOR'].includes(master.WORKER_ROLE)) throw E.bad('INVALID_INSPECTOR', 'Choose an active quality inspector');
    const labor = await tx.one('sim_operations', { OPERATION_INSTANCE_ID: unit.LAST_LABOR_OPERATION_INSTANCE_ID });
    const gate = C.gateAfter(cat, unit.PRODUCT_ID, (labor || {}).OPERATION_ID || unit.ROUTE_STEP) || unit.ROUTE_STEP;
    const def = C.opDef(cat, unit.PRODUCT_ID, gate) || {};
    if (def.REQUIRED_SKILL_ID && !C.qualified(cat, inspector.WORKER_ID, def.REQUIRED_SKILL_ID, tx.now)) throw E.bad('INVALID_INSPECTOR', 'Inspector lacks the gate qualification');
    if (labor && await tx.one('sim_tasks', { OPERATION_INSTANCE_ID: labor.OPERATION_INSTANCE_ID, WORKER_ID: inspector.WORKER_ID })) throw E.forbidden('An inspector cannot approve work they performed');
    await tx.update('sim_units', { UNIT_ID: unit.UNIT_ID }, { ASSIGNED_INSPECTOR_ID: inspector.WORKER_ID, INSPECTOR_ASSIGNED_AT: tx.now, INSPECTOR_ASSIGNED_BY: tx.actor.loginId });
    await tx.event('INSPECTOR_ASSIGNED', 'UNIT', unit.UNIT_ID, { INSPECTOR_ID: inspector.WORKER_ID, PREVIOUS_INSPECTOR_ID: unit.ASSIGNED_INSPECTOR_ID || null, GATE_OPERATION_ID: gate });
    return { ok: true, inspectorId: inspector.WORKER_ID, unitId: unit.UNIT_ID };
  },
});

register('INSPECTION_START', {
  perm: ['perform_quality_inspection', 'submit_self_check'],
  handler: async (tx, p) => {
    const kind = p.kind === 'SELF_CHECK' ? 'SELF_CHECK' : 'INDEPENDENT';
    const unit = await tx.must('sim_units', { UNIT_ID: p.unitId }, 'Tank');
    const inspectorId = p.inspectorId || tx.actor.workerId;
    H.assertOwner(tx, inspectorId);
    const w = await tx.must('sim_workers', { WORKER_ID: inspectorId }, 'Inspector');
    H.assertAgentMayAct(tx, w);
    const open = await tx.one('sim_inspections', { UNIT_ID: unit.UNIT_ID, INSPECTION_KIND: kind, STATUS: 'DRAFT' });
    if (open) {
      if (open.INSPECTOR_ID !== inspectorId && kind === 'INDEPENDENT') throw E.conflict('INSPECTION_IN_PROGRESS', `Inspection ${open.INSPECTION_ID} is already in progress by ${open.INSPECTOR_ID}`);
      return { inspection: open, resumed: true };
    }
    if (kind === 'INDEPENDENT') {
      if (!(tx.actor.permissions || []).includes('perform_quality_inspection')) throw E.forbidden('Independent gate inspections require quality inspection authority');
      if (!INSPECTABLE.includes(unit.STATE)) throw E.conflict('NOT_AWAITING_INSPECTION', `Tank is ${unit.STATE}; it can be inspected after its work is completed`);
      if (unit.ASSIGNED_INSPECTOR_ID && unit.ASSIGNED_INSPECTOR_ID !== inspectorId) throw E.conflict('INSPECTOR_ASSIGNED', `This tank is assigned to ${unit.ASSIGNED_INSPECTOR_ID}`);
      if (w.ATTENDANCE_STATE !== 'CLOCKED_IN') throw E.conflict('NOT_CLOCKED_IN', 'Clock in before inspecting');
      await require('./scan').assertInspectionScanned(tx, unit.UNIT_ID, inspectorId);
      const catq = await C.catalog();
      const gateId = C.gateAfter(catq, unit.PRODUCT_ID, ((await tx.one('sim_operations', { OPERATION_INSTANCE_ID: unit.LAST_LABOR_OPERATION_INSTANCE_ID })) || {}).OPERATION_ID || unit.ROUTE_STEP) || unit.ROUTE_STEP;
      const gdef = C.opDef(catq, unit.PRODUCT_ID, gateId) || {};
      if (gdef.REQUIRED_SKILL_ID && !C.qualified(catq, inspectorId, gdef.REQUIRED_SKILL_ID, tx.now)) throw E.forbidden(`No valid ${gdef.REQUIRED_SKILL_ID} qualification for the ${gateId} gate inspection`);
      const busy = await tx.many('sim_tasks', { WORKER_ID: inspectorId, STATUS: 'WORKING' });
      if (busy.length) throw E.conflict('ALREADY_WORKING', `Already working on ${busy[0].TASK_ID}`);
      const insp = unit.LAST_LABOR_OPERATION_INSTANCE_ID ? await tx.one('sim_operations', { OPERATION_INSTANCE_ID: unit.LAST_LABOR_OPERATION_INSTANCE_ID }) : null;
      const crewTasks = insp ? await tx.many('sim_tasks', { OPERATION_INSTANCE_ID: insp.OPERATION_INSTANCE_ID, WORKER_ID: inspectorId }) : [];
      if (crewTasks.length) throw E.forbidden('Independence: an inspector cannot release work they performed in the crew');
    } else {
      if (!['WORK_COMPLETED_AWAITING_INSPECTION', 'REWORK_COMPLETE_AWAITING_REINSPECTION'].includes(unit.STATE)) throw E.conflict('NOT_AWAITING_INSPECTION', `Self-check is done after completing work (tank is ${unit.STATE})`);
      const crew = unit.LAST_LABOR_OPERATION_INSTANCE_ID ? await tx.many('sim_tasks', { OPERATION_INSTANCE_ID: unit.LAST_LABOR_OPERATION_INSTANCE_ID, WORKER_ID: inspectorId }) : [];
      if (!crew.length && tx.actor.kind === 'HUMAN' && !(tx.actor.permissions || []).includes('operational_supervision')) throw E.forbidden('Only a crew member of the completed operation can submit its self-check');
    }
    return { inspection: await startInspection(tx, unit, inspectorId, kind) };
  },
});

register('INSPECTION_SAVE_DRAFT', {
  perm: ['perform_quality_inspection', 'submit_self_check'], noRecalc: true,
  handler: async (tx, p) => {
    const ins = await tx.must('sim_inspections', { INSPECTION_ID: p.inspectionId }, 'Inspection');
    H.assertOwner(tx, ins.INSPECTOR_ID);
    if (ins.STATUS !== 'DRAFT') throw E.conflict('INSPECTION_SUBMITTED', 'Inspection already submitted - answers are immutable');
    const doc = await tx.update('sim_inspections', { INSPECTION_ID: ins.INSPECTION_ID }, { DRAFT_ANSWERS: p.answers || {}, DRAFT_COMMENT: p.comment || null, DRAFT_SAVED_AT: tx.received, DRAFT_EVIDENCE_IDS: p.evidenceIds || ins.DRAFT_EVIDENCE_IDS || [] }, { expectVersion: p.expectedVersion });
    await tx.event('INSPECTION_DRAFT_SAVED', 'INSPECTION', ins.INSPECTION_ID, { ANSWERED: Object.keys(p.answers || {}).length });
    return { inspection: doc };
  },
});

async function openHold(tx, unit, holdType, extra) {
  const id = await tx.nextId('HLD');
  const doc = await tx.insert('sim_holds', { HOLD_ID: id, UNIT_ID: unit.UNIT_ID, HOLD_TYPE: holdType, HOLD_STARTED_AT: tx.now, KNOWN_AT: tx.now, DECISION: null, RESOLUTION: 'OPEN', ...extra, ORIGIN: 'BRANCH_NEW' });
  await tx.event('QUALITY_HOLD_OPENED', 'UNIT', unit.UNIT_ID, { HOLD_ID: id, HOLD_TYPE: holdType, ...extra });
  return doc;
}

async function closeInspectorWork(tx, ins) {
  if (!ins.OPERATION_INSTANCE_ID) return;
  const op = await tx.one('sim_operations', { OPERATION_INSTANCE_ID: ins.OPERATION_INSTANCE_ID });
  if (op && op.STATE !== 'WORK_COMPLETED') await tx.update('sim_operations', { OPERATION_INSTANCE_ID: op.OPERATION_INSTANCE_ID }, { STATE: 'WORK_COMPLETED', WORK_COMPLETED_AT: tx.now, CREW: [] });
  const tasks = await tx.many('sim_tasks', { OPERATION_INSTANCE_ID: ins.OPERATION_INSTANCE_ID, STATUS: { $in: ['WORKING', 'PAUSED', 'ACCEPTED', 'ASSIGNED'] } });
  for (const t of tasks) {
    await H.moveTask(tx, t, 'COMPLETED', { COMPLETED_AT: tx.now, ENDED_REASON: 'INSPECTION_SUBMITTED' }, { force: true });
    const w = await tx.one('sim_workers', { WORKER_ID: t.WORKER_ID });
    if (w) {
      await H.segment(tx, w.WORKER_ID, w.ATTENDANCE_STATE === 'CLOCKED_IN' ? 'WAITING' : null, { REASON: 'AWAITING_NEXT_TASK' });
      await H.setWorker(tx, w, { ACTIVITY_STATE: w.ATTENDANCE_STATE === 'CLOCKED_IN' ? 'AVAILABLE' : w.ACTIVITY_STATE, REASON_CODE: 'AWAITING_NEXT_TASK', CURRENT_TASK_ID: null, CURRENT_OPERATION_INSTANCE_ID: null });
    }
  }
}

register('INSPECTION_SUBMIT', {
  perm: ['perform_quality_inspection', 'submit_self_check'],
  handler: async (tx, p) => {
    const cat = await C.catalog();
    const ins = await tx.must('sim_inspections', { INSPECTION_ID: p.inspectionId }, 'Inspection');
    H.assertOwner(tx, ins.INSPECTOR_ID);
    const w = await tx.must('sim_workers', { WORKER_ID: ins.INSPECTOR_ID });
    H.assertAgentMayAct(tx, w);
    if (ins.STATUS !== 'DRAFT') throw E.conflict('INSPECTION_SUBMITTED', 'Inspection already submitted', { result: ins.RESULT });
    if (p.expectedVersion !== undefined && p.expectedVersion !== ins.VERSION) throw E.conflict('VERSION_CONFLICT', 'The inspection changed while you were offline or in another window - review the current answers', { current: ins.VERSION, serverAnswers: ins.DRAFT_ANSWERS });
    let unit = await tx.must('sim_units', { UNIT_ID: ins.UNIT_ID }, 'Tank');
    const answers = p.answers || ins.DRAFT_ANSWERS || {};
    // evidence must be verified uploads linked to this inspection (pending uploads cannot support a submission)
    const evIds = [...new Set([...(p.evidenceIds || ins.DRAFT_EVIDENCE_IDS || []), ...Object.values(answers).flatMap(a => a.evidenceIds || [])])];
    const ev = evIds.length ? await tx.many('sim_evidence', { EVIDENCE_ID: { $in: evIds } }) : [];
    const pending = ev.filter(e => e.UPLOAD_STATUS !== 'VERIFIED');
    if (pending.length) throw E.conflict('EVIDENCE_PENDING', `${pending.length} photo(s) are not verified yet (pending upload); submit after they finish or remove them`, { pending: pending.map(e => e.EVIDENCE_ID) });
    const list = ins.CHECKLIST_SNAPSHOT && ins.CHECKLIST_SNAPSHOT.length ? ins.CHECKLIST_SNAPSHOT : C.checklist(cat, ins.GATE_OPERATION_ID, ins.PRODUCT_ID);
    if (!list.length) throw E.unprocessable('NO_CHECKLIST', `No CTQ checklist for ${ins.GATE_OPERATION_ID}`);
    const supplied = [...new Set([...evIds, ...Object.values(answers).flatMap(a => a.evidenceIds || [])])];
    const photos = supplied.length ? await tx.many('sim_evidence', { EVIDENCE_ID: { $in: supplied } }) : [];
    if (photos.length !== supplied.length || photos.some(e => e.UPLOAD_STATUS !== 'VERIFIED' || e.DRAFT_INSPECTION_ID !== ins.INSPECTION_ID || e.UNIT_ID !== ins.UNIT_ID || e.SUPERSEDED_BY)) throw E.bad('INVALID_EVIDENCE', 'Use verified, current photographs belonging to this tank and inspection');
    const missingPhotos = list.filter(({ check }) => (check.PHOTO_REQUIRED === true || ['PHOTO', 'Y'].includes(check.EVIDENCE_REQUIRED)) && !photos.some(e => e.CHECK_ID === check.CHECK_ID));
    if (missingPhotos.length) throw E.conflict('EVIDENCE_REQUIRED', 'Upload the required photographs before submitting', { checkIds: missingPhotos.map(x => x.check.CHECK_ID) });
    const evalr = evaluate(list, answers);
    // fresh factory: a question configured "photo required when the answer fails" needs a photo of the failure before submission
    if (tx.session.FACTORY_SESSION) {
      const failNoPhoto = evalr.results.filter(r => r.result === 'FAIL' && ((list.find(x => x.check.CHECK_ID === r.checkId) || {}).check || {}).EVIDENCE_REQUIRED === 'ON_FAILURE_ANSWER' && !photos.some(e => e.CHECK_ID === r.checkId));
      if (failNoPhoto.length) throw E.conflict('EVIDENCE_REQUIRED', 'Take a photo of each failed point before submitting', { checkIds: failNoPhoto.map(r => r.checkId) });
    }
    // readings (immutable once submitted; failed readings are preserved)
    let n = 0;
    for (const r of evalr.results) {
      for (const rd of r.readings) {
        n++;
        await tx.insert('sim_readings', { READING_ID: `${ins.INSPECTION_ID}-R${String(n).padStart(3, '0')}`, INSPECTION_ID: ins.INSPECTION_ID, UNIT_ID: ins.UNIT_ID, CHECK_ID: r.checkId, CHECK_VERSION: ((list.find(x => x.check.CHECK_ID === r.checkId) || {}).check || cat.ctq[r.checkId] || {}).CHECK_VERSION || '1.0',
          SPEC_ID: rd.specId, MEASUREMENT_POSITION: rd.position, SAMPLE_NO: rd.sampleNo, NUMERIC_VALUE: rd.value === undefined ? null : rd.value, TEXT_ANSWER: rd.text || null, MEASUREMENT_UNIT: rd.unit || null,
          LOWER_LIMIT: rd.lower ?? null, UPPER_LIMIT: rd.upper ?? null, CHECK_RESULT: rd.result, READING_STATUS: rd.result === 'MISSING' ? 'MISSING' : 'RECORDED', MEASURED_AT: tx.now, KNOWN_AT: tx.now,
          COMMENT: (answers[r.checkId] || {}).comment || null, EVIDENCE_IDS: (answers[r.checkId] || {}).evidenceIds || [] });
      }
    }
    const result = evalr.overall;
    // late entry: the inspection decision may have been made earlier than it is entered (KNOWN_AT stays the entry time)
    let decidedAt = tx.now;
    if (p.decidedAt) {
      const d = new Date(p.decidedAt);
      if (!(d >= new Date(ins.STARTED_AT) && d <= tx.now)) throw E.bad('INVALID_DECIDED_AT', 'The decision time must lie between the inspection start and now');
      decidedAt = d;
    } else if (tx.actor.kind === 'AGENT' && tx.session.AGENT_SETTINGS && tx.session.AGENT_SETTINGS.NEXT_INSPECTION_ENTRY_LAG_MIN) {
      decidedAt = new Date(Math.max(new Date(ins.STARTED_AT).getTime(), tx.now.getTime() - tx.session.AGENT_SETTINGS.NEXT_INSPECTION_ENTRY_LAG_MIN * 60000));
      await tx.db.collection('sim_sessions').updateOne({ SESSION_ID: tx.sid }, { $unset: { 'AGENT_SETTINGS.NEXT_INSPECTION_ENTRY_LAG_MIN': '' } }, { session: tx.s });
    }
    const entryLag = Math.round((tx.now - decidedAt) / 6000) / 10;
    const insDoc = await tx.update('sim_inspections', { INSPECTION_ID: ins.INSPECTION_ID }, { STATUS: 'SUBMITTED', RESULT: result, COMPLETED_AT: decidedAt, KNOWN_AT: tx.now, ENTRY_LAG_MIN: entryLag, ANSWERS: answers, CHECK_RESULTS: evalr.results.map(r => ({ CHECK_ID: r.checkId, RESULT: r.result, REASON: r.reason })),
      MANDATORY_READINGS_MISSING: evalr.mandatoryMissing, COMMENT: p.comment || ins.DRAFT_COMMENT || null, EVIDENCE_IDS: evIds, PHOTO_EVIDENCE_STATUS: evIds.length ? 'VERIFIED_ATTACHED' : 'NONE' });
    for (const e of ev) await tx.update('sim_evidence', { EVIDENCE_ID: e.EVIDENCE_ID }, { INSPECTION_ID: ins.INSPECTION_ID, LINKED_AT: tx.now });
    await tx.event(ins.INSPECTION_KIND === 'SELF_CHECK' ? 'SELF_CHECK_SUBMITTED' : 'INSPECTION_COMPLETED', 'INSPECTION', ins.INSPECTION_ID, { UNIT_ID: ins.UNIT_ID, RESULT: result, GATE_OPERATION_ID: ins.GATE_OPERATION_ID, FAILED_CHECKS: evalr.results.filter(r => r.result === 'FAIL').map(r => r.checkId), ENTRY_LAG_MIN: entryLag }, { eventTime: decidedAt, knownAt: tx.now });
    await closeInspectorWork(tx, ins);
    unit = await tx.must('sim_units', { UNIT_ID: ins.UNIT_ID });
    const out = { inspection: insDoc, result, checkResults: evalr.results };
    if (result === 'FAIL') {
      // defects per failed check; investigation opened with UNKNOWN cause (detection is not blame)
      const defectIds = [];
      for (const r of evalr.results.filter(x => x.result === 'FAIL')) {
        const did = await tx.nextId('DEF');
        const origin = ins.INSPECTED_OPERATION_INSTANCE_ID ? await tx.one('sim_operations', { OPERATION_INSTANCE_ID: ins.INSPECTED_OPERATION_INSTANCE_ID }) : null;
        await tx.insert('sim_defects', { DEFECT_ID: did, UNIT_ID: ins.UNIT_ID, CHECK_ID: r.checkId, DEFECT_CODE: r.defectCode, DESCRIPTION: r.reason, DETECTED_AT: decidedAt, KNOWN_AT: tx.now, DETECTED_BY: ins.INSPECTOR_ID,
          DETECTION_STAGE: ins.INSPECTION_KIND === 'SELF_CHECK' ? 'SELF_CHECK_AT_ORIGIN' : 'GATE', DETECTED_AT_WORK_CENTER_ID: ins.WORK_CENTER_ID, DETECTED_AT_WORKSTATION_ID: ins.WORKSTATION_ID, INSPECTION_ID: ins.INSPECTION_ID,
          ORIGIN_OPERATION_INSTANCE_ID: ins.INSPECTED_OPERATION_INSTANCE_ID, SUSPECTED_ORIGIN_OPERATION_ID: origin ? origin.OPERATION_ID : null, DOWNSTREAM_FLAG: 'N', SEVERITY: unit.SEEDED_DEFECT && unit.SEEDED_DEFECT.SEVERITY || 'UNRATED', EVIDENCE_IDS: (answers[r.checkId] || {}).evidenceIds || [] });
        const iid = await tx.nextId('INV');
        await tx.insert('sim_investigations', { INVESTIGATION_ID: iid, DEFECT_ID: did, UNIT_ID: ins.UNIT_ID, STATUS: 'OPEN_UNKNOWN', CAUSE_CATEGORY: 'UNKNOWN', OPENED_AT: tx.now, KNOWN_AT: tx.now, RESPONSIBLE: [],
          SUSPECTED_ORIGIN_OPERATION_INSTANCE_ID: ins.INSPECTED_OPERATION_INSTANCE_ID, DOWNSTREAM_FLAG: 'N', NOTE: 'Defect reported; cause not yet known. Detection and participation are not fault.' });
        await tx.update('sim_defects', { DEFECT_ID: did }, { INVESTIGATION_ID: iid });
        defectIds.push(did);
      }
      await H.moveUnit(tx, unit, 'FAILED_INSPECTION', { LAST_INSPECTION_ID: ins.INSPECTION_ID, LAST_INSPECTION_RESULT: 'FAIL' }, { force: true });
      unit = await tx.must('sim_units', { UNIT_ID: ins.UNIT_ID });
      const retained = true;  // gate inspections happen at the station that performed the work
      const hold = await openHold(tx, unit, ins.INSPECTION_KIND === 'SELF_CHECK' ? 'SELF_CHECK_FAIL' : 'GATE_FAIL', { INSPECTION_ID: ins.INSPECTION_ID, DEFECT_IDS: defectIds, GATE_OPERATION_ID: ins.GATE_OPERATION_ID,
        HOLD_LOCATION: retained ? `RETAINED_AT_STATION ${ins.WORKSTATION_ID}` : 'WS-QA-HOLD', HOLD_LOCATION_TYPE: retained ? 'RETAINED_AT_STATION' : 'QA_HOLD_AREA', DETECTION_POINT: ins.INSPECTION_KIND === 'SELF_CHECK' ? ins.GATE_OPERATION_ID : ins.GATE_OPERATION_ID });
      await H.moveUnit(tx, unit, 'QUALITY_HOLD', { HOLD_ID: hold.HOLD_ID });
      await tx.insert('sim_dispositions', { DISPOSITION_ID: await tx.nextId('DSP'), INSPECTION_ID: ins.INSPECTION_ID, UNIT_ID: ins.UNIT_ID, DISPOSITION: 'HOLD', DISPOSITION_STAGE: 'GATE', RESULT: 'FAIL', DECIDED_BY: ins.INSPECTOR_ID, DECIDED_AT: tx.now, KNOWN_AT: tx.now, REASON_CODE: 'CHECK_FAILED', GATE_OPERATION_ID: ins.GATE_OPERATION_ID });
      out.holdId = hold.HOLD_ID; out.defectIds = defectIds;
    } else if (result === 'INCOMPLETE') {
      if (ins.INSPECTION_KIND === 'INDEPENDENT') {
        await H.moveUnit(tx, unit, 'INCOMPLETE_INSPECTION_HOLD', { LAST_INSPECTION_ID: ins.INSPECTION_ID, LAST_INSPECTION_RESULT: 'INCOMPLETE' }, { force: true });
        await tx.insert('sim_dispositions', { DISPOSITION_ID: await tx.nextId('DSP'), INSPECTION_ID: ins.INSPECTION_ID, UNIT_ID: ins.UNIT_ID, DISPOSITION: 'HOLD', DISPOSITION_STAGE: 'GATE', RESULT: 'INCOMPLETE', DECIDED_BY: ins.INSPECTOR_ID, DECIDED_AT: tx.now, KNOWN_AT: tx.now, REASON_CODE: 'MANDATORY_EVIDENCE_MISSING', GATE_OPERATION_ID: ins.GATE_OPERATION_ID });
      }
      out.note = 'Incomplete is not a failure and cannot release the tank; complete the missing readings in a new inspection.';
    } else if (ins.INSPECTION_KIND === 'INDEPENDENT') {
      await H.moveUnit(tx, unit, 'PASS_PENDING_RELEASE', { LAST_INSPECTION_ID: ins.INSPECTION_ID, LAST_INSPECTION_RESULT: 'PASS' }, { force: unit.STATE === 'INCOMPLETE_INSPECTION_HOLD' });
      if (p.release) {
        if (!(tx.actor.permissions || []).includes('release_gate')) throw E.forbidden('Release requires gate release authority');
        out.release = await releaseUnit(tx, await tx.must('sim_units', { UNIT_ID: ins.UNIT_ID }), insDoc);
      }
    } else {
      out.note = 'Self-check passed. The tank still needs the independent gate inspection before release.';
    }
    return out;
  },
});

async function releaseUnit(tx, unit, ins) {
  const cat = await C.catalog();
  if (unit.STATE !== 'PASS_PENDING_RELEASE') throw E.conflict('NOT_RELEASABLE', `Tank is ${unit.STATE}; only a tank that passed its independent inspection can be released`);
  const lastIns = ins || await tx.one('sim_inspections', { INSPECTION_ID: unit.LAST_INSPECTION_ID });
  if (!lastIns || lastIns.RESULT !== 'PASS' || lastIns.INSPECTION_KIND !== 'INDEPENDENT') throw E.conflict('NO_PASSING_INSPECTION', 'No passing independent inspection on record for this gate');
  await tx.insert('sim_dispositions', { DISPOSITION_ID: await tx.nextId('DSP'), INSPECTION_ID: lastIns.INSPECTION_ID, UNIT_ID: unit.UNIT_ID, DISPOSITION: 'RELEASE', DISPOSITION_STAGE: 'GATE', RESULT: 'PASS', DECIDED_BY: tx.actor.workerId || tx.actor.loginId, DECIDED_AT: tx.now, KNOWN_AT: tx.now, REASON_CODE: 'ALL_CHECKS_PASS', GATE_OPERATION_ID: lastIns.GATE_OPERATION_ID });
  const gate = lastIns.GATE_OPERATION_ID;
  // return loop bookkeeping
  const openRet = await tx.one('sim_returns', { UNIT_ID: unit.UNIT_ID, LOOP_STATUS: { $in: ['REWORK_COMPLETE_AWAITING_REINSPECTION', 'REWORK_IN_PROGRESS', 'AWAITING_REWORK'] } });
  let next = C.nextOp(cat, unit.PRODUCT_ID, gate);
  if (openRet) {
    if (openRet.RESUME_AT_OPERATION_ID && !openRet.INVALIDATE_DOWNSTREAM) next = openRet.RESUME_AT_OPERATION_ID;
    await tx.update('sim_returns', { RETURN_ID: openRet.RETURN_ID }, { REINSPECTION_ID: lastIns.INSPECTION_ID, REINSPECTION_RESULT: 'PASS', RELEASED_AT: tx.now, ROUTE_RESUMED_OPERATION_ID: next, LOOP_STATUS: 'RELEASED_ROUTE_RESUMED', ROW_COMPLETE_KNOWN_AT: tx.now });
  }
  const passedGates = [...new Set([...(unit.PASSED_GATES || []), gate])];
  if (next === 'ROUTE_END' || !next) {
    const doc = await H.moveUnit(tx, unit, 'ROUTE_COMPLETE', { ROUTE_COMPLETED_AT: tx.now, TERMINAL_IN_SESSION: true, ROUTE_STEP: 'ROUTE_END', CURRENT_WORKSTATION_ID: null, PASSED_GATES: passedGates, REWORK_PENDING: null });
    await tx.event('ROUTE_COMPLETED', 'UNIT', unit.UNIT_ID, { ORDER_LINE_ID: unit.ORDER_LINE_ID, ORDER_ID: unit.ORDER_ID, NOTE: 'Tank route complete - not a finished transformer or shipment' });
    return { unit: doc, routeComplete: true };
  }
  const nd = C.opDef(cat, unit.PRODUCT_ID, next) || {};
  const tmin = C.transferMin(cat, gate, next);
  let doc = await H.moveUnit(tx, unit, 'RELEASED_TO_NEXT_OPERATION', { ROUTE_STEP: next, PASSED_GATES: passedGates, REWORK_PENDING: null, HOLD_ID: null });
  if (tmin > 0) {
    doc = await H.moveUnit(tx, doc, 'IN_TRANSFER', { TRANSFER_TO_WORK_CENTER_ID: nd.WORK_CENTER_ID, TRANSFER_FROM_WORK_CENTER_ID: unit.CURRENT_WORK_CENTER_ID, ARRIVE_AT: new Date(tx.now.getTime() + tmin * 60000), CURRENT_WORKSTATION_ID: null });
    await tx.event('TRANSFER_STARTED', 'UNIT', unit.UNIT_ID, { TO_WORK_CENTER_ID: nd.WORK_CENTER_ID, TRANSFER_MIN: tmin });
  } else {
    doc = await H.moveUnit(tx, doc, 'QUEUED', { CURRENT_WORK_CENTER_ID: nd.WORK_CENTER_ID, CURRENT_WORKSTATION_ID: null, QUEUE_ENTERED_AT: tx.now });
  }
  return { unit: doc, nextOperationId: next, transferMin: tmin };
}

register('UNIT_RELEASE', {
  perm: 'release_gate',
  handler: async (tx, p) => {
    const unit = await tx.must('sim_units', { UNIT_ID: p.unitId }, 'Tank');
    return releaseUnit(tx, unit, null);
  },
});

register('UNIT_ARRIVE', {
  perm: ['material_movements', 'operational_supervision', 'release_gate'],
  handler: async (tx, p) => {
    const cat = await C.catalog();
    const unit = await tx.must('sim_units', { UNIT_ID: p.unitId }, 'Tank');
    if (unit.STATE === 'IN_RETURN_TRANSFER') return arriveForRework(tx, unit);
    if (unit.STATE !== 'IN_TRANSFER') throw E.conflict('NOT_IN_TRANSFER', `Tank is ${unit.STATE}`);
    const wc = unit.TRANSFER_TO_WORK_CENTER_ID;
    const cap = (cat.wcs[wc] || {}).QUEUE_CAPACITY_UNITS;
    const queued = await tx.many('sim_units', { CURRENT_WORK_CENTER_ID: wc, STATE: { $in: ['QUEUED', 'QUEUED_FOR_REWORK'] } });
    if (cap && queued.length >= cap) {
      await tx.update('sim_units', { UNIT_ID: unit.UNIT_ID }, { BLOCKED_ARRIVAL: true, BLOCKED_SINCE: unit.BLOCKED_SINCE || tx.now });
      await tx.event('ARRIVAL_BLOCKED_QUEUE_FULL', 'UNIT', unit.UNIT_ID, { WORK_CENTER_ID: wc, QUEUE_CAPACITY_UNITS: cap, QUEUED: queued.length });
      return { blocked: true, queueCapacity: cap, queued: queued.length };
    }
    const doc = await H.moveUnit(tx, unit, 'QUEUED', { CURRENT_WORK_CENTER_ID: wc, CURRENT_WORKSTATION_ID: null, QUEUE_ENTERED_AT: tx.now, BLOCKED_ARRIVAL: false, ARRIVE_AT: null }, { unset: ['BLOCKED_SINCE'] });
    await tx.event('QUEUE_ENTERED', 'UNIT', unit.UNIT_ID, { WORK_CENTER_ID: wc, UNITS_AHEAD: queued.length });
    return { unit: doc };
  },
});

// ------------------------------------------------------------------ downstream detection (no automatic blame)
register('INCOMING_DEFECT_REPORT', {
  perm: 'report_incoming_defect',
  handler: async (tx, p) => {
    const cat = await C.catalog();
    const unit = await tx.must('sim_units', { UNIT_ID: p.unitId }, 'Tank');
    if (!['QUEUED', 'READY', 'WORKING', 'PAUSED'].includes(unit.STATE)) throw E.conflict('NOT_RECEIVED', `Incoming defects are reported on a received tank (tank is ${unit.STATE})`);
    const seq = C.route(cat, unit.PRODUCT_ID);
    const originOpId = p.suspectedOriginOperationId;
    if (!originOpId || seq.indexOf(originOpId) < 0 || seq.indexOf(originOpId) >= seq.indexOf(unit.ROUTE_STEP)) throw E.bad('INVALID_ORIGIN', 'Choose a prior operation on this tank\'s route as the suspected origin');
    // the correct prior operation attempt: latest attempt of that operation in this session, else from history at the fork
    let originAttempt = (await tx.many('sim_operations', { UNIT_ID: unit.UNIT_ID, OPERATION_ID: originOpId }, { sort: { CREATED_AT: -1 }, limit: 1 }))[0];
    if (!originAttempt) originAttempt = await tx.db.collection('operation_instances').findOne({ RUN_ID: tx.session.SOURCE_RUN_ID, UNIT_ID: unit.UNIT_ID, OPERATION_ID: originOpId, CREATED_AT: { $lte: new Date(tx.session.FORK_AT) } }, { session: tx.s, sort: { CREATED_AT: -1 } });
    if (!originAttempt) throw E.unprocessable('ORIGIN_NOT_FOUND', `No ${originOpId} attempt found for this tank`);
    // pause any work on the tank: no further work while held
    const active = await tx.many('sim_tasks', { UNIT_ID: unit.UNIT_ID, STATUS: 'WORKING' });
    for (const t of active) {
      const op = await tx.must('sim_operations', { OPERATION_INSTANCE_ID: t.OPERATION_INSTANCE_ID });
      const w = await tx.must('sim_workers', { WORKER_ID: t.WORKER_ID });
      await require('./tasks').pauseTask(tx, { task: t, worker: w, op }, 'WAITING_FOR_INSTRUCTION', 'Incoming defect reported - tank held');
    }
    const did = await tx.nextId('DEF');
    await tx.insert('sim_defects', { DEFECT_ID: did, UNIT_ID: unit.UNIT_ID, CHECK_ID: p.checkId || null, DEFECT_CODE: p.defectCode || 'UNCLASSIFIED', DESCRIPTION: p.description || 'Incoming defect reported at receiving',
      DETECTED_AT: tx.now, KNOWN_AT: tx.now, DETECTED_BY: tx.actor.workerId, DETECTION_STAGE: 'DOWNSTREAM_RECEIVING', DETECTED_AT_WORK_CENTER_ID: unit.CURRENT_WORK_CENTER_ID, DETECTED_AT_WORKSTATION_ID: unit.CURRENT_WORKSTATION_ID,
      ORIGIN_OPERATION_INSTANCE_ID: originAttempt.OPERATION_INSTANCE_ID, SUSPECTED_ORIGIN_OPERATION_ID: originOpId, DOWNSTREAM_FLAG: 'Y', SEVERITY: p.severity || 'UNRATED', EVIDENCE_IDS: p.evidenceIds || [],
      ATTRIBUTION_NOTE: 'Reported against the prior operation; detector and crew are not presumed at fault' });
    const iid = await tx.nextId('INV');
    await tx.insert('sim_investigations', { INVESTIGATION_ID: iid, DEFECT_ID: did, UNIT_ID: unit.UNIT_ID, STATUS: 'OPEN_UNKNOWN', CAUSE_CATEGORY: 'UNKNOWN', OPENED_AT: tx.now, KNOWN_AT: tx.now, RESPONSIBLE: [],
      SUSPECTED_ORIGIN_OPERATION_INSTANCE_ID: originAttempt.OPERATION_INSTANCE_ID, DOWNSTREAM_FLAG: 'Y', NOTE: 'Downstream defect reported; responsibility only after a named reviewer confirms with evidence' });
    await tx.update('sim_defects', { DEFECT_ID: did }, { INVESTIGATION_ID: iid });
    const u2 = await tx.must('sim_units', { UNIT_ID: unit.UNIT_ID });
    const hold = await openHold(tx, u2, 'DOWNSTREAM_DEFECT', { DEFECT_IDS: [did], DETECTION_POINT: 'DOWNSTREAM_RECEIVING', HOLD_LOCATION: 'WS-QA-HOLD', HOLD_LOCATION_TYPE: 'QA_HOLD_AREA',
      ORIGIN_OPERATION_INSTANCE_ID: originAttempt.OPERATION_INSTANCE_ID, ORIGIN_OPERATION_ID: originOpId, DETECTED_AT_WORK_CENTER_ID: unit.CURRENT_WORK_CENTER_ID, DETECTED_ROUTE_STEP: unit.ROUTE_STEP });
    await H.moveUnit(tx, u2, 'QUALITY_HOLD', { HOLD_ID: hold.HOLD_ID, CURRENT_WORKSTATION_ID: 'WS-QA-HOLD', DETECTED_DOWNSTREAM_AT_STEP: unit.ROUTE_STEP }, { force: true });
    await tx.event('INCOMING_DEFECT_REPORTED', 'UNIT', unit.UNIT_ID, { DEFECT_ID: did, ORIGIN_OPERATION_INSTANCE_ID: originAttempt.OPERATION_INSTANCE_ID, DETECTED_AT_WORK_CENTER_ID: unit.CURRENT_WORK_CENTER_ID });
    return { defectId: did, investigationId: iid, holdId: hold.HOLD_ID };
  },
});

// ------------------------------------------------------------------ disposition (independent of blame)
register('DISPOSITION_DECIDE', {
  perm: 'quality_approval',
  handler: async (tx, p) => {
    const cat = await C.catalog();
    const hold = await tx.must('sim_holds', { HOLD_ID: p.holdId }, 'Hold');
    if (hold.RESOLUTION !== 'OPEN' && hold.RESOLUTION !== 'PENDING_REVIEW') throw E.conflict('HOLD_CLOSED', `Hold is ${hold.RESOLUTION}`);
    const unit = await tx.must('sim_units', { UNIT_ID: hold.UNIT_ID }, 'Tank');
    if (!['QUALITY_HOLD', 'PENDING_REVIEW'].includes(unit.STATE)) throw E.conflict('UNIT_NOT_HELD', `Tank is ${unit.STATE}`);
    const decision = p.decision;
    if (!['REWORK', 'SCRAP', 'PENDING_REVIEW'].includes(decision)) throw E.bad('INVALID_DECISION', 'decision must be REWORK, SCRAP or PENDING_REVIEW');
    const defects = hold.DEFECT_IDS && hold.DEFECT_IDS.length ? await tx.many('sim_defects', { DEFECT_ID: { $in: hold.DEFECT_IDS } }) : [];
    const defectCode = (defects[0] || {}).DEFECT_CODE || 'UNCLASSIFIED';
    const policyId = tx.session.DISPOSITION_POLICY_ID;
    const rule = C.dispositionRule(cat, policyId, hold.DETECTION_POINT, defectCode);
    const ruleDisp = rule ? rule.DISPOSITION : null;
    // policy enforcement: a SCRAP-only rule forbids rework; unknown cases stay on hold unless a named approver decides with a reason
    if (decision === 'REWORK' && ruleDisp === 'SCRAP') throw E.conflict('POLICY_FORBIDS_REWORK', `${policyId} requires scrap for ${hold.DETECTION_POINT}/${defectCode}`);
    if (decision !== 'PENDING_REVIEW' && (!rule || ruleDisp === 'PENDING_REVIEW')) {
      if (tx.actor.kind === 'AGENT') throw E.conflict('NO_MATRIX_ENTRY', 'No disposition-matrix entry: the case stays on hold for a human approver');
      if (!p.reasonCode) throw E.bad('REASON_REQUIRED', 'No matrix entry for this defect - a named approver must state the reason');
    }
    if (decision === 'SCRAP' && ruleDisp === 'REPAIRABLE_RETURN' && !p.reasonCode) throw E.bad('REASON_REQUIRED', 'Scrapping a repairable case requires a reason (e.g. NON_REPAIRABLE_SEVERITY)');
    // repeated reinspection failure -> escalation (never a forced pass)
    const fails = (await tx.many('sim_inspections', { UNIT_ID: unit.UNIT_ID, GATE_OPERATION_ID: hold.GATE_OPERATION_ID || '__none__', RESULT: 'FAIL', INSPECTION_KIND: 'INDEPENDENT' })).length;
    const escAfter = rule && rule.ESCALATE_AFTER_FAILED_REINSPECTIONS ? Number(rule.ESCALATE_AFTER_FAILED_REINSPECTIONS) : 2;
    const escalated = fails >= escAfter;
    if (escalated && !(tx.actor.roles || []).some(r => ['QUALITY_SUPERVISOR', 'ADMIN'].includes(r))) throw E.forbidden(`Escalated case (${fails} failed inspections) - a quality supervisor must decide`);
    const did = await tx.nextId('DSP');
    const base = { DISPOSITION_ID: did, UNIT_ID: unit.UNIT_ID, INSPECTION_ID: hold.INSPECTION_ID || null, DISPOSITION_STAGE: 'HOLD_REVIEW', DECIDED_BY: tx.actor.workerId || tx.actor.loginId, DECIDED_AT: tx.now, KNOWN_AT: tx.now,
      POLICY_ID: policyId, MATRIX_DISPOSITION: ruleDisp || 'NO_MATRIX_ENTRY', REASON_CODE: p.reasonCode || (rule ? 'PER_DISPOSITION_MATRIX' : null), NOTE: p.note || null, ESCALATED: escalated, FAILED_INSPECTIONS: fails, RESULT: 'FAIL' };
    if (decision === 'PENDING_REVIEW') {
      await tx.insert('sim_dispositions', { ...base, DISPOSITION: 'PENDING_REVIEW' });
      await tx.update('sim_holds', { HOLD_ID: hold.HOLD_ID }, { DECISION: 'PENDING_REVIEW', RESOLUTION: 'PENDING_REVIEW', DECIDED_BY: base.DECIDED_BY });
      if (unit.STATE !== 'PENDING_REVIEW') await H.moveUnit(tx, unit, 'PENDING_REVIEW');
      return { disposition: did, decision };
    }
    if (decision === 'SCRAP') {
      await tx.insert('sim_dispositions', { ...base, DISPOSITION: 'SCRAP' });
      await tx.update('sim_holds', { HOLD_ID: hold.HOLD_ID }, { DECISION: 'SCRAP', RESOLUTION: 'SCRAPPED', RESOLVED_AT: tx.now, DECIDED_BY: base.DECIDED_BY, ROW_COMPLETE_KNOWN_AT: tx.now });
      const doc = await H.moveUnit(tx, unit, 'SCRAPPED', { SCRAPPED_AT: tx.now, TERMINAL_IN_SESSION: true, CURRENT_WORKSTATION_ID: null, SCRAP_REASON: p.reasonCode || ruleDisp }, { force: true });
      await tx.event('UNIT_SCRAPPED', 'UNIT', unit.UNIT_ID, { ORDER_LINE_ID: unit.ORDER_LINE_ID, POLICY_ID: policyId, NOTE: 'Scrap is permanent; history retained; a replacement needs a new UNIT_ID' });
      return { disposition: did, decision, unit: doc };
    }
    // REWORK: same station again by default; retained at station when inspected there; downstream detection returns to the earlier origin station
    const originOpi = hold.ORIGIN_OPERATION_INSTANCE_ID || (defects[0] || {}).ORIGIN_OPERATION_INSTANCE_ID || unit.LAST_LABOR_OPERATION_INSTANCE_ID;
    let origin = originOpi ? await tx.one('sim_operations', { OPERATION_INSTANCE_ID: originOpi }) : null;
    if (!origin && originOpi) origin = await tx.db.collection('operation_instances').findOne({ RUN_ID: tx.session.SOURCE_RUN_ID, OPERATION_INSTANCE_ID: originOpi }, { session: tx.s });
    if (!origin && hold.GATE_OPERATION_ID) {
      // inherited tank: the latest completed attempt of the labour operation this gate inspects (session first, then history known at the fork)
      const catx = await C.catalog();
      const laborOp = C.laborOpOfGate ? C.laborOpOfGate(catx, unit.PRODUCT_ID, hold.GATE_OPERATION_ID) : null;
      if (laborOp) {
        origin = (await tx.many('sim_operations', { UNIT_ID: unit.UNIT_ID, OPERATION_ID: laborOp, STATE: 'WORK_COMPLETED' }, { sort: { WORK_COMPLETED_AT: -1 }, limit: 1 }))[0] || null;
        if (!origin) origin = (await tx.db.collection('operation_instances').find({ RUN_ID: tx.session.SOURCE_RUN_ID, UNIT_ID: unit.UNIT_ID, OPERATION_ID: laborOp, FINISHED_AT: { $lte: new Date(tx.session.FORK_AT) } }, { session: tx.s }).sort({ FINISHED_AT: -1 }).limit(1).toArray())[0] || null;
      }
    }
    if (!origin) throw E.unprocessable('ORIGIN_UNKNOWN', 'Cannot determine the operation that requires correction');
    const originWs = origin.WORKSTATION_ID, originWc = origin.WORK_CENTER_ID;
    let destWs = originWs, basis = 'SAME_STATION', altReason = null, altBy = null;
    if (p.alternateWorkstationId && p.alternateWorkstationId !== originWs) {
      const alt = cat.stations[p.alternateWorkstationId];
      if (!alt || alt.WORK_CENTER_ID !== originWc) throw E.bad('INVALID_ALTERNATE', 'An alternate rework station must be in the origin work centre');
      if (!['ORIGIN_EQUIPMENT_DOWN', 'ORIGIN_STATION_OCCUPIED', 'OTHER_APPROVED'].includes(p.alternateReason)) throw E.bad('ALTERNATE_REASON_REQUIRED', 'State why the origin station cannot be used (ORIGIN_EQUIPMENT_DOWN, ORIGIN_STATION_OCCUPIED, OTHER_APPROVED)');
      destWs = alt.WORKSTATION_ID; basis = 'ALTERNATE_STATION_SAME_WORK_CENTER'; altReason = p.alternateReason; altBy = tx.actor.workerId || tx.actor.loginId;
    }
    const downstream = hold.DETECTION_POINT === 'DOWNSTREAM_RECEIVING';
    const retained = !downstream && basis === 'SAME_STATION' && (unit.CURRENT_WORKSTATION_ID === originWs || String(hold.HOLD_LOCATION || '').includes(originWs));
    const reworkType = downstream ? 'DOWNSTREAM_REWORK' : 'GATE_REWORK';
    const rid = await tx.nextId('RET');
    // invalidated downstream checks: passed gates after the origin's gate up to the detection point
    const seq = C.route(cat, unit.PRODUCT_ID);
    const originGate = C.gateAfter(cat, unit.PRODUCT_ID, origin.OPERATION_ID);
    const policyParams = tx.session.POLICY_PARAMETERS || {};
    const invalidate = policyParams.invalidate_downstream_after_return !== false;
    const invalidated = downstream ? (unit.PASSED_GATES || []).filter(g => seq.indexOf(g) > seq.indexOf(originGate)) : [];
    await tx.insert('sim_dispositions', { ...base, DISPOSITION: 'AUTHORIZED_REWORK', RETURN_ID: rid, AUTHORIZED_DESTINATION_WORKSTATION_ID: destWs, DESTINATION_BASIS: basis, ALTERNATE_STATION_REASON: altReason, ALTERNATE_APPROVED_BY: altBy });
    await tx.insert('sim_returns', { RETURN_ID: rid, UNIT_ID: unit.UNIT_ID, REWORK_TYPE: reworkType, CORRECTED_OPERATION_INSTANCE_ID: origin.OPERATION_INSTANCE_ID, ORIGIN_OPERATION_ID: origin.OPERATION_ID,
      ORIGIN_WORK_CENTER_ID: originWc, ORIGIN_WORKSTATION_ID: originWs, DETECTION_TYPE: downstream ? 'DOWNSTREAM_RECEIVING' : 'GATE_FAIL', DETECTION_INSPECTION_ID: hold.INSPECTION_ID || null, DETECTION_DEFECT_IDS: hold.DEFECT_IDS || [],
      DETECTED_AT: hold.HOLD_STARTED_AT, DETECTED_AT_WORK_CENTER_ID: hold.DETECTED_AT_WORK_CENTER_ID || unit.CURRENT_WORK_CENTER_ID, HOLD_LOCATION: hold.HOLD_LOCATION, DISPOSITION_ID: did, AUTHORIZED_BY: base.DECIDED_BY,
      AUTHORIZED_AT: tx.now, AUTHORIZATION_KNOWN_AT: tx.now, AUTHORIZED_DESTINATION_WORK_CENTER_ID: originWc, AUTHORIZED_DESTINATION_WORKSTATION_ID: destWs, DESTINATION_BASIS: basis, ALTERNATE_STATION_REASON: altReason,
      ALTERNATE_APPROVED_BY: altBy, MOVEMENT_TYPE: retained ? 'RETAINED_AT_STATION_NO_TRANSPORT' : 'HOLD_AREA_THEN_RETURN_TRANSFER', INVALIDATED_INSPECTION_GATES: invalidate ? invalidated : [],
      RETAINED_DOWNSTREAM_GATES: invalidate ? [] : invalidated, INVALIDATE_DOWNSTREAM: invalidate, RESUME_AT_OPERATION_ID: downstream && !invalidate ? hold.DETECTED_ROUTE_STEP : null,
      ESCALATED: escalated, LOOP_STATUS: 'AWAITING_REWORK', ATTRIBUTION_NOTE: 'Returning to the origin station is not a finding of who caused the defect; see the investigation', KNOWN_AT: tx.now, ORIGIN: 'BRANCH_NEW' });
    await tx.update('sim_holds', { HOLD_ID: hold.HOLD_ID }, { DECISION: 'AUTHORIZED_REWORK', RESOLUTION: 'AUTHORIZED_REWORK', RESOLVED_AT: tx.now, DECIDED_BY: base.DECIDED_BY, RETURN_ID: rid, ROW_COMPLETE_KNOWN_AT: tx.now });
    const pending = { RETURN_ID: rid, REWORK_TYPE: reworkType, CORRECTED_OPERATION_INSTANCE_ID: origin.OPERATION_INSTANCE_ID, ORIGIN_OPERATION_ID: origin.OPERATION_ID, DEST_WORKSTATION_ID: destWs, DEST_WORK_CENTER_ID: originWc, ESCALATED: escalated };
    let doc = await H.moveUnit(tx, unit, 'AUTHORIZED_REWORK', { REWORK_PENDING: pending, ROUTE_STEP: origin.OPERATION_ID, HOLD_ID: null, PASSED_GATES: invalidate ? (unit.PASSED_GATES || []).filter(g => seq.indexOf(g) < seq.indexOf(originGate)) : unit.PASSED_GATES });
    await tx.event('REWORK_AUTHORIZED', 'UNIT', unit.UNIT_ID, { RETURN_ID: rid, DESTINATION_WORKSTATION_ID: destWs, DESTINATION_BASIS: basis, RETAINED_AT_STATION: retained, ESCALATED: escalated });
    if (retained) {
      doc = await H.moveUnit(tx, doc, 'QUEUED_FOR_REWORK', { CURRENT_WORK_CENTER_ID: originWc, CURRENT_WORKSTATION_ID: destWs, QUEUE_ENTERED_AT: tx.now, PRIORITY_CLASS: 1 });
      await tx.update('sim_returns', { RETURN_ID: rid }, { QUEUED_FOR_REWORK_AT: tx.now });
    } else {
      doc = await H.moveUnit(tx, doc, 'RETURN_REQUESTED', { PRIORITY_CLASS: 1 });
    }
    return { disposition: did, decision, returnId: rid, retainedAtStation: retained, destinationWorkstationId: destWs, unit: doc };
  },
});

register('RETURN_DISPATCH', {
  perm: ['material_movements', 'operational_supervision', 'quality_approval'],
  handler: async (tx, p) => {
    const cat = await C.catalog();
    const unit = await tx.must('sim_units', { UNIT_ID: p.unitId }, 'Tank');
    if (unit.STATE !== 'RETURN_REQUESTED') throw E.conflict('NOT_RETURN_REQUESTED', `Tank is ${unit.STATE}`);
    const pend = unit.REWORK_PENDING || {};
    const tr = C.transferRule(cat, unit.CURRENT_WORK_CENTER_ID, pend.DEST_WORK_CENTER_ID);
    const tmin = tr ? Number(tr.TRAVEL_MIN || 5) : 10;
    const doc = await H.moveUnit(tx, unit, 'IN_RETURN_TRANSFER', { ARRIVE_AT: new Date(tx.now.getTime() + tmin * 60000), CURRENT_WORKSTATION_ID: null, TRANSFER_TO_WORK_CENTER_ID: pend.DEST_WORK_CENTER_ID });
    await tx.update('sim_returns', { RETURN_ID: pend.RETURN_ID }, { RETURN_DISPATCHED_AT: tx.now });
    await tx.event('RETURN_TRANSFER_STARTED', 'UNIT', unit.UNIT_ID, { RETURN_ID: pend.RETURN_ID, TO_WORKSTATION_ID: pend.DEST_WORKSTATION_ID, TRAVEL_MIN: tmin });
    return { unit: doc, travelMin: tmin };
  },
});

async function arriveForRework(tx, unit) {
  const pend = unit.REWORK_PENDING || {};
  let doc = await H.moveUnit(tx, unit, 'RECEIVED_AT_REWORK_STATION', { CURRENT_WORK_CENTER_ID: pend.DEST_WORK_CENTER_ID, CURRENT_WORKSTATION_ID: pend.DEST_WORKSTATION_ID, ARRIVE_AT: null });
  await tx.update('sim_returns', { RETURN_ID: pend.RETURN_ID }, { RETURN_ARRIVED_AT: tx.now });
  doc = await H.moveUnit(tx, doc, 'QUEUED_FOR_REWORK', { QUEUE_ENTERED_AT: tx.now });
  await tx.update('sim_returns', { RETURN_ID: pend.RETURN_ID }, { QUEUED_FOR_REWORK_AT: tx.now });
  return { unit: doc };
}
register('RETURN_ARRIVE', {
  perm: ['material_movements', 'operational_supervision', 'quality_approval'],
  handler: async (tx, p) => {
    const unit = await tx.must('sim_units', { UNIT_ID: p.unitId }, 'Tank');
    if (unit.STATE !== 'IN_RETURN_TRANSFER') throw E.conflict('NOT_IN_RETURN_TRANSFER', `Tank is ${unit.STATE}`);
    return arriveForRework(tx, unit);
  },
});

register('INVESTIGATION_UPDATE', {
  perm: 'quality_approval', agentAllowed: true,
  handler: async (tx, p) => {
    const inv = await tx.must('sim_investigations', { INVESTIGATION_ID: p.investigationId }, 'Investigation');
    const status = p.status;
    if (!['SUSPECTED', 'CONFIRMED', 'CLOSED_UNRESOLVED', 'OPEN_UNKNOWN'].includes(status)) throw E.bad('INVALID_STATUS', 'status must be OPEN_UNKNOWN, SUSPECTED, CONFIRMED or CLOSED_UNRESOLVED');
    const cause = p.causeCategory || inv.CAUSE_CATEGORY || 'UNKNOWN';
    if (!['UNKNOWN', 'WORKER', 'EQUIPMENT', 'MATERIAL', 'SUPPLIER', 'PROCESS'].includes(cause)) throw E.bad('INVALID_CAUSE', 'Unknown cause category');
    let responsible = [];
    let suspected = [];
    const parseParties = (list) => (list || []).map(r => ({ PARTY_TYPE: 'WORKER', PARTY_ID: String(r.partyId || r.workerId || '').trim(), SHARE: Number(r.share) }));
    const checkWorkers = async (parties, label) => {
      const ids = parties.map(r => r.PARTY_ID);
      if (ids.some(id => !id)) throw E.bad('RESPONSIBLE_INVALID', `Every ${label} entry needs a worker ID`);
      const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
      if (dup.length) throw E.bad('RESPONSIBLE_DUPLICATE', `Worker ${dup[0]} is listed more than once`);
      // the worker must exist in this session's roster (inactive or departed people stay valid: history is not rewritten)
      const found = await tx.many('sim_workers', { WORKER_ID: { $in: ids } }, { projection: { WORKER_ID: 1 } });
      const missing = ids.filter(id => !found.some(w => w.WORKER_ID === id));
      if (missing.length) throw E.bad('RESPONSIBLE_UNKNOWN_WORKER', `Unknown worker ${missing.join(', ')} in this session`);
      return ids;
    };
    if ((p.responsible || []).length && cause !== 'WORKER') throw E.bad('RESPONSIBLE_NOT_ALLOWED', `A ${cause.toLowerCase()} cause names no responsible worker - no worker deduction can follow from it`);
    if (status === 'SUSPECTED' && cause === 'WORKER' && (p.responsible || []).length) {
      // a suspicion is recorded for the reviewer but is never responsibility: points stay pending
      suspected = parseParties(p.responsible).map(r => ({ PARTY_TYPE: 'WORKER', PARTY_ID: r.PARTY_ID }));
      await checkWorkers(suspected, 'suspected');
    }
    if (status === 'CONFIRMED') {
      if (tx.actor.kind !== 'HUMAN' || !(tx.actor.workerId || tx.actor.loginId)) throw E.forbidden('Only a named, signed-in reviewer can confirm a cause');
      if (!p.evidenceNote || String(p.evidenceNote).trim().length < 10) throw E.bad('EVIDENCE_REQUIRED', 'Confirmation requires a named reviewer (you) and an evidence note');
      if (cause === 'UNKNOWN') throw E.bad('CAUSE_REQUIRED', 'A confirmed investigation needs a cause category; otherwise keep it suspected or close it unresolved');
      if (cause === 'WORKER') {
        responsible = parseParties(p.responsible);
        if (!responsible.length) throw E.bad('RESPONSIBLE_REQUIRED', 'Name the confirmed responsible worker(s)');
        if (responsible.some(r => !Number.isFinite(r.SHARE) || r.SHARE <= 0 || r.SHARE > 1)) throw E.bad('SHARES_INVALID', 'Responsibility shares must be positive numbers no greater than 1');
        const sum = responsible.reduce((a, r) => a + r.SHARE, 0);
        if (Math.abs(sum - 1) > 0.0001) throw E.bad('SHARES_INVALID', `Responsibility shares must total 1 (got ${Math.round(sum * 10000) / 10000})`);
        const ids = await checkWorkers(responsible, 'responsible');
        const reviewer = tx.actor.workerId || null;
        if (reviewer && ids.includes(reviewer)) throw E.forbidden('A reviewer cannot confirm responsibility that names themselves');
        // detection is not responsibility: naming the person who found the defect needs an explicit statement from the reviewer
        const defect = await tx.one('sim_defects', { DEFECT_ID: inv.DEFECT_ID });
        if (defect && defect.DETECTED_BY && ids.includes(defect.DETECTED_BY) && !p.detectorAlsoResponsible) {
          throw E.bad('DETECTOR_NAMED', `${defect.DETECTED_BY} detected this defect; detection is not fault. Set detectorAlsoResponsible with evidence if they also caused it`);
        }
      } else {
        responsible = [{ PARTY_TYPE: cause, PARTY_ID: p.partyId || null, SHARE: 1 }];
      }
    }
    const doc = await tx.update('sim_investigations', { INVESTIGATION_ID: inv.INVESTIGATION_ID }, { STATUS: status, CAUSE_CATEGORY: status === 'CONFIRMED' ? cause : (status === 'SUSPECTED' ? cause : inv.CAUSE_CATEGORY), RESPONSIBLE: responsible, SUSPECTED_PARTIES: suspected,
      REVIEWED_BY: tx.actor.workerId || tx.actor.loginId, EVIDENCE_IDS: p.evidenceIds || inv.EVIDENCE_IDS || [], CONFIRMED_AT: status === 'CONFIRMED' ? tx.now : null, KNOWN_AT_STATUS: tx.now, CAUSE_DESCRIPTION: p.description || inv.CAUSE_DESCRIPTION || null },
      { push: { EVIDENCE: { AT: tx.now, BY: tx.actor.workerId || tx.actor.loginId, NOTE: p.evidenceNote || p.note || null, STATUS_AFTER: status } } });
    await tx.event('INVESTIGATION_' + status, 'INVESTIGATION', inv.INVESTIGATION_ID, { DEFECT_ID: inv.DEFECT_ID, CAUSE_CATEGORY: cause, RESPONSIBLE: responsible });
    return { investigation: doc };
  },
});

register('REPLACEMENT_REQUEST', {
  perm: ['operational_supervision', 'quality_approval'],
  handler: async (tx, p) => {
    const unit = await tx.must('sim_units', { UNIT_ID: p.scrappedUnitId }, 'Scrapped tank');
    if (unit.STATE !== 'SCRAPPED') throw E.conflict('NOT_SCRAPPED', 'A replacement can only be requested for a scrapped tank');
    const existing = await tx.one('sim_replacements', { SCRAPPED_UNIT_ID: unit.UNIT_ID, STATUS: { $in: ['REQUESTED', 'APPROVED', 'NEW_UNIT_RELEASED'] } });
    if (existing) return { replacement: existing, existing: true };
    const id = await tx.nextId('RPL');
    const doc = await tx.insert('sim_replacements', { REQUEST_ID: id, SCRAPPED_UNIT_ID: unit.UNIT_ID, ORDER_LINE_ID: unit.ORDER_LINE_ID, BATCH_ID: unit.BATCH_ID, PRODUCT_ID: unit.PRODUCT_ID, REQUESTED_AT: tx.now, REQUESTED_BY: tx.actor.workerId || tx.actor.loginId, STATUS: 'REQUESTED', KNOWN_AT: tx.now });
    await tx.event('REPLACEMENT_REQUESTED', 'UNIT', unit.UNIT_ID, { REQUEST_ID: id });
    return { replacement: doc };
  },
});

register('REPLACEMENT_APPROVE', {
  perm: ['operational_supervision', 'approve_transfers'],
  handler: async (tx, p) => {
    const cat = await C.catalog();
    const r = await tx.must('sim_replacements', { REQUEST_ID: p.requestId }, 'Replacement request');
    if (r.STATUS !== 'REQUESTED') throw E.conflict('NOT_REQUESTED', `Request is ${r.STATUS}`);
    const old = await tx.must('sim_units', { UNIT_ID: r.SCRAPPED_UNIT_ID });
    // material feasibility: a kit must be available (reserved for the replacement)
    const req = cat.matReqs.find(m => m.PRODUCT_ID === r.PRODUCT_ID && m.CONSUMED_AT_OPERATION_ID === C.route(cat, r.PRODUCT_ID)[0]);
    if (req) {
      const m = await tx.one('sim_materials', { MATERIAL_ID: req.MATERIAL_ID });
      const avail = m ? Number(m.ON_HAND_QTY || 0) - Number(m.HOLD_QTY || 0) - Number(m.RESERVED_QTY || 0) : 0;
      if (avail < Number(req.QTY_PER_UNIT || 1)) {
        await tx.update('sim_replacements', { REQUEST_ID: r.REQUEST_ID }, { STATUS: 'BLOCKED', BLOCK_REASON: 'REPLACEMENT_MATERIAL_MISSING', MATERIAL_CHECK: 'FAIL' });
        await tx.event('REPLACEMENT_BLOCKED', 'UNIT', r.SCRAPPED_UNIT_ID, { REQUEST_ID: r.REQUEST_ID, MATERIAL_ID: req.MATERIAL_ID, AVAILABLE: avail });
        return { blocked: true, reason: 'REPLACEMENT_MATERIAL_MISSING', materialId: req.MATERIAL_ID, available: avail };
      }
      await tx.update('sim_materials', { MATERIAL_ID: req.MATERIAL_ID }, { RESERVED_QTY: Number(m.RESERVED_QTY || 0) + Number(req.QTY_PER_UNIT || 1) });
    }
    let newId, serial;
    if (tx.session.FACTORY_SESSION) ({ unitId: newId, serial } = await require('../identity').newTankIdentity(tx));
    else {
      const n = await tx.nextId('RU');
      newId = `TNK-${tx.session.SHORT_ID}-${n.split('-').pop()}`;
      serial = `DEMO-TANK-${tx.session.SHORT_ID}-${n.split('-').pop()}`;
    }
    const first = C.route(cat, r.PRODUCT_ID)[0];
    const firstDef = C.opDef(cat, r.PRODUCT_ID, first) || {};
    const nu = await tx.insert('sim_units', { UNIT_ID: newId, TANK_SERIAL_NO: serial, PRODUCT_ID: r.PRODUCT_ID, ORDER_ID: old.ORDER_ID, ORDER_LINE_ID: r.ORDER_LINE_ID, BATCH_ID: r.BATCH_ID, REPLACEMENT_FOR_UNIT_ID: old.UNIT_ID,
      ROUTE_ID: old.ROUTE_ID || null, ROUTE_VERSION: (cat.products[r.PRODUCT_ID] || {}).ROUTE_VERSION || old.ROUTE_VERSION || null, SITE_ID: old.SITE_ID || null, DRAWING_REF: old.DRAWING_REF || null,
      DRAWING_REVISION: old.DRAWING_REVISION, STATE: 'QUEUED', ROUTE_STEP: first, CURRENT_WORK_CENTER_ID: firstDef.WORK_CENTER_ID, QUEUE_ENTERED_AT: tx.now, PRIORITY_CLASS: 1, DUE_AT: old.DUE_AT, STATE_SINCE: tx.now,
      ORIGIN: 'BRANCH_NEW', RESERVED_MATERIAL: req ? req.MATERIAL_ID : null, BATCH_MEMBERSHIP: { BATCH_ID: r.BATCH_ID, VALID_FROM: tx.now, REASON: 'REPLACEMENT' } });
    await H.openMembership(tx, newId, r.BATCH_ID, 'REPLACEMENT');
    await tx.update('sim_units', { UNIT_ID: old.UNIT_ID }, { REPLACED_BY_UNIT_ID: newId });
    await tx.update('sim_replacements', { REQUEST_ID: r.REQUEST_ID }, { STATUS: 'NEW_UNIT_RELEASED', APPROVED_AT: tx.now, APPROVED_BY: tx.actor.workerId || tx.actor.loginId, NEW_UNIT_ID: newId, MATERIAL_CHECK: req ? 'RESERVED' : 'NOT_REQUIRED' });
    await tx.event('REPLACEMENT_APPROVED', 'UNIT', newId, { REQUEST_ID: r.REQUEST_ID, REPLACEMENT_FOR_UNIT_ID: old.UNIT_ID, ORDER_LINE_ID: r.ORDER_LINE_ID, NOTE: 'Satisfies existing demand; does not increase demand' });
    await tx.event('QUEUE_ENTERED', 'UNIT', newId, { WORK_CENTER_ID: firstDef.WORK_CENTER_ID, PRIORITY_CLASS: 1 });
    return { newUnit: nu };
  },
});

module.exports = { releaseUnit, startInspection, openHold };
