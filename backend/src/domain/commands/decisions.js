'use strict';
/* Alert workflow (acknowledgement is not resolution) and recovery actions (preview is not execution). */
const { register } = require('../executor');
const E = require('../../lib/errors');
const { transferWorker } = require('./flow');

const WF = { ACK: 'ACKNOWLEDGED', START: 'IN_PROGRESS', CLOSE: 'CLOSED' };

register('ALERT_WORKFLOW', {
  perm: ['operational_supervision', 'quality_approval'], noRecalc: true,
  handler: async (tx, p) => {
    const a = await tx.must('sim_alerts', { ALERT_ID: p.alertId }, 'Alert');
    const to = WF[p.action];
    if (!to) throw E.bad('INVALID_ACTION', 'action must be ACK, START or CLOSE');
    if (to === 'CLOSED' && ['FIRING', 'PENDING'].includes(a.EVALUATION_STATE) && !p.force) throw E.conflict('CONDITION_ACTIVE', 'The condition is still active; closing the workflow does not resolve it. Use force with a note to close anyway.');
    const doc = await tx.update('sim_alerts', { ALERT_ID: a.ALERT_ID }, { WORKFLOW_STATE: to, OWNER_ID: p.ownerId || a.OWNER_ID || tx.actor.workerId || tx.actor.loginId, [`WORKFLOW_${to}_AT`]: tx.now });
    await tx.insert('sim_alert_transitions', { ALERT_ID: a.ALERT_ID, EPISODE_ID: a.EPISODE_ID, KIND: 'WORKFLOW', FROM_STATE: a.WORKFLOW_STATE, TO_STATE: to, AT: tx.now, ACTOR: tx.actor.workerId || tx.actor.loginId, NOTE: p.note || null });
    await tx.event('ALERT_' + to, 'ALERT', a.ALERT_ID, { EPISODE_ID: a.EPISODE_ID, NOTE: p.note || null, EVALUATION_STATE: a.EVALUATION_STATE });
    return { alert: doc };
  },
});

// ------------------------------------------------------------------ recovery actions
async function relevantVersions(tx, steps) {
  const v = {};
  for (const s of steps) {
    if (s.workerId) { const w = await tx.one('sim_workers', { WORKER_ID: s.workerId }); v[`W:${s.workerId}`] = w ? `${w.ACTIVITY_STATE}|${w.CURRENT_TASK_ID || ''}|${w.CURRENT_WORK_CENTER_ID || ''}` : null; }
    if (s.unitId) { const u = await tx.one('sim_units', { UNIT_ID: s.unitId }); v[`U:${s.unitId}`] = u ? u.STATE : null; }
  }
  return v;
}

register('ACTION_PROPOSE', {
  perm: ['operational_supervision', 'approve_transfers'],
  handler: async (tx, p) => {
    const fc = await tx.must('sim_forecasts', { FORECAST_ID: p.forecastId }, 'Recovery forecast');
    const opt = (fc.OPTIONS || []).find(o => o.OPTION_ID === p.optionId);
    if (!opt) throw E.notFound('Recovery option');
    if (!opt.FEASIBLE) throw E.conflict('INFEASIBLE_OPTION', `Option is infeasible: ${opt.REJECTION_REASON || 'see checks'}`);
    const id = await tx.nextId('ACT');
    const doc = await tx.insert('sim_actions', { ACTION_ID: id, FORECAST_ID: fc.FORECAST_ID, OPTION_ID: opt.OPTION_ID, ACTION_TYPE: opt.ACTION_TYPE, DESCRIPTION: opt.DESCRIPTION, STEPS: opt.STEPS || [],
      STATUS: 'PROPOSED', PROPOSED_AT: tx.now, PROPOSED_BY: tx.actor.workerId || tx.actor.loginId, BEFORE_FORECAST: fc.BASELINE, AFTER_FORECAST: opt.RESULT, ORDER_LINE_ID: fc.ORDER_LINE_ID,
      INPUT_WATERMARK: fc.INPUT_WATERMARK, VERSIONS_AT_PROPOSAL: await relevantVersions(tx, opt.STEPS || []), KNOWN_AT: tx.now });
    await tx.event('ACTION_PROPOSED', 'ACTION', id, { OPTION_ID: opt.OPTION_ID, FORECAST_ID: fc.FORECAST_ID });
    return { action: doc };
  },
});

async function revalidate(tx, a) {
  const now = await relevantVersions(tx, a.STEPS || []);
  const changed = Object.keys(a.VERSIONS_AT_PROPOSAL || {}).filter(k => now[k] !== a.VERSIONS_AT_PROPOSAL[k]);
  if (changed.length) {
    await tx.update('sim_actions', { ACTION_ID: a.ACTION_ID }, { STATUS: 'STALE', STALE_AT: tx.now, STALE_REASON: `Changed since proposal: ${changed.join(', ')}` });
    await tx.event('ACTION_STALE', 'ACTION', a.ACTION_ID, { CHANGED: changed });
    return changed;
  }
  return null;
}

register('ACTION_APPROVE', {
  perm: 'approve_transfers',
  handler: async (tx, p) => {
    const a = await tx.must('sim_actions', { ACTION_ID: p.actionId }, 'Action');
    if (a.STATUS !== 'PROPOSED') throw E.conflict('NOT_PROPOSED', `Action is ${a.STATUS}`);
    const changed = await revalidate(tx, a);
    if (changed) return { stale: true, changed, message: 'The situation changed since the forecast; recalculate recovery options before approving' };
    const doc = await tx.update('sim_actions', { ACTION_ID: a.ACTION_ID }, { STATUS: 'APPROVED', APPROVED_AT: tx.now, APPROVED_BY: tx.actor.workerId || tx.actor.loginId });
    await tx.event('ACTION_APPROVED', 'ACTION', a.ACTION_ID, {});
    return { action: doc };
  },
});

register('ACTION_REJECT', {
  perm: 'approve_transfers',
  handler: async (tx, p) => {
    const a = await tx.must('sim_actions', { ACTION_ID: p.actionId }, 'Action');
    if (!['PROPOSED', 'APPROVED'].includes(a.STATUS)) throw E.conflict('NOT_OPEN', `Action is ${a.STATUS}`);
    const doc = await tx.update('sim_actions', { ACTION_ID: a.ACTION_ID }, { STATUS: p.cancel ? 'CANCELLED' : 'REJECTED', CLOSED_AT: tx.now, CLOSED_BY: tx.actor.workerId || tx.actor.loginId, NOTE: p.note || null });
    await tx.event(p.cancel ? 'ACTION_CANCELLED' : 'ACTION_REJECTED', 'ACTION', a.ACTION_ID, { NOTE: p.note || null });
    return { action: doc };
  },
});

register('ACTION_START', {
  perm: 'approve_transfers',
  handler: async (tx, p) => {
    const a = await tx.must('sim_actions', { ACTION_ID: p.actionId }, 'Action');
    if (a.STATUS !== 'APPROVED') throw E.conflict('NOT_APPROVED', `Action is ${a.STATUS}; approve it first`);
    const changed = await revalidate(tx, a);
    if (changed) return { stale: true, changed };
    const { registry } = require('../executor');
    const results = [];
    for (const s of a.STEPS || []) {
      if (s.type === 'TRANSFER') results.push({ step: s, result: await transferWorker(tx, { workerId: s.workerId, toWorkCenterId: s.toWorkCenterId, reason: 'RECOVERY_ACTION', actionId: a.ACTION_ID, plannedReturnAt: s.plannedReturnAt }) });
      else if (s.type === 'REPLACEMENT') {
        const req = await registry.REPLACEMENT_REQUEST.handler(tx, { scrappedUnitId: s.scrappedUnitId });
        results.push({ step: s, result: await registry.REPLACEMENT_APPROVE.handler(tx, { requestId: req.replacement.REQUEST_ID }) });
      } else if (s.type === 'OVERTIME') results.push({ step: s, result: await registry.OVERTIME_APPROVE.handler(tx, { workerId: s.workerId, minutes: s.minutes, reason: 'ORDER_RECOVERY', actionId: a.ACTION_ID }) });
      else if (s.type === 'RESEQUENCE') {
        const u = await tx.must('sim_units', { UNIT_ID: s.unitId });
        await tx.update('sim_units', { UNIT_ID: u.UNIT_ID }, { PRIORITY_CLASS: s.priorityClass || 2, RESEQUENCED_BY_ACTION: a.ACTION_ID });
        await tx.event('UNIT_RESEQUENCED', 'UNIT', u.UNIT_ID, { PRIORITY_CLASS: s.priorityClass || 2, ACTION_ID: a.ACTION_ID });
        results.push({ step: s, result: { resequenced: true } });
      } else if (s.type === 'RELIEF_CALL_IN') results.push({ step: s, result: await registry.RELIEF_CALL_IN.handler(tx, { workerId: s.workerId, toWorkCenterId: s.toWorkCenterId, plannedArrivalAt: s.plannedArrivalAt && new Date(s.plannedArrivalAt) < tx.now ? null : s.plannedArrivalAt, until: s.until, actionId: a.ACTION_ID, reason: 'RECOVERY_ACTION' }) });
      else if (s.type === 'MATERIAL_EXPEDITE') results.push({ step: s, result: await registry.MATERIAL_REQUEST.handler(tx, { materialId: s.materialId, qty: s.qty, needByMin: s.needByMin || 30, promisedMin: s.promisedMin, expedite: true }) });
      else results.push({ step: s, result: { skipped: true, reason: 'Step type has no executable command in the demo' } });
    }
    const doc = await tx.update('sim_actions', { ACTION_ID: a.ACTION_ID }, { STATUS: 'STARTED', STARTED_AT: tx.now, STARTED_BY: tx.actor.workerId || tx.actor.loginId, EXECUTION: results.map(r => ({ type: r.step.type, ok: !r.result.skipped, ref: r.result.transferId || r.result.callInId || (r.result.newUnit && r.result.newUnit.UNIT_ID) || (r.result.overtime && r.result.overtime.OVERTIME_ID) || null })) });
    await tx.event('ACTION_STARTED', 'ACTION', a.ACTION_ID, { STEPS: (a.STEPS || []).length });
    return { action: doc, results };
  },
});

register('ACTION_COMPLETE', {
  perm: 'approve_transfers',
  handler: async (tx, p) => {
    const a = await tx.must('sim_actions', { ACTION_ID: p.actionId }, 'Action');
    if (a.STATUS !== 'STARTED') throw E.conflict('NOT_STARTED', `Action is ${a.STATUS}`);
    const transfers = await tx.many('sim_transfers', { ACTION_ID: a.ACTION_ID });
    const actual = transfers.map(t => ({ TRANSFER_ID: t.TRANSFER_ID, WORKER_ID: t.WORKER_ID, PLANNED_MIN: (t.PLANNED_TRAVEL_MIN || 0) + (t.PLANNED_HANDOVER_MIN || 0), ACTUAL_MIN: t.ACTUAL_TRAVEL_AND_HANDOVER_MIN ?? null }));
    const doc = await tx.update('sim_actions', { ACTION_ID: a.ACTION_ID }, { STATUS: 'COMPLETED', COMPLETED_AT: tx.now, COMPLETED_BY: tx.actor.workerId || tx.actor.loginId, ACTUAL_TRANSFERS: actual, NOTE: p.note || null });
    await tx.event('ACTION_COMPLETED', 'ACTION', a.ACTION_ID, { ACTUAL_TRANSFERS: actual });
    return { action: doc };
  },
});

module.exports = {};
