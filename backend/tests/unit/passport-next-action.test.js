'use strict';
/* The tank passport explains what happens next for EVERY unit state in the shared state contract (repair review finding:
   WORKING, PAUSED, WORK_COMPLETED_AWAITING_INSPECTION, QUALITY_HOLD, REWORK_IN_PROGRESS and CURING returned nothing). */
const test = require('node:test');
const assert = require('node:assert/strict');
const SM = require('../../contracts/state_machines.json');
const { nextAction, NEXT, ALIASES } = require('../../src/services/passport');

test('every unit state in contracts/state_machines.json has next-action guidance', () => {
  const missing = SM.unit.states.filter(st => !NEXT[st]);
  assert.deepEqual(missing, [], `states without guidance: ${missing.join(', ')}`);
  for (const st of SM.unit.states) {
    const a = nextAction({ STATE: st, ROUTE_STEP: 'OP30' }, { gate: 'OP40', nextStep: 'OP50' });
    assert.equal(typeof a, 'string', st);
    assert.ok(a.length > 10 && !/^No guidance/.test(a), `${st}: ${a}`);
  }
});

test('the states named in the review get specific guidance', () => {
  const c = { gate: 'OP40', nextStep: 'OP50' };
  assert.match(nextAction({ STATE: 'WORKING', ROUTE_STEP: 'OP30' }, c), /OP30.*Finish work.*not a pass/);
  assert.match(nextAction({ STATE: 'PAUSED', ROUTE_STEP: 'OP30' }, c), /Resume OP30/);
  assert.match(nextAction({ STATE: 'WORK_COMPLETED_AWAITING_INSPECTION', ROUTE_STEP: 'OP30' }, c), /inspects at OP40/);
  assert.match(nextAction({ STATE: 'QUALITY_HOLD' }, { holdType: 'FAILED_INSPECTION' }), /disposition.*FAILED_INSPECTION/);
  assert.match(nextAction({ STATE: 'REWORK_IN_PROGRESS' }, c), /reinspection/);
  assert.match(nextAction({ STATE: 'CURING' }, { cureUntil: '2026-10-15 11:40' }), /cure.*11:40/);
  assert.match(nextAction({ STATE: 'PASS_PENDING_RELEASE' }, { nextStep: null }), /Final release/);
  assert.match(nextAction({ STATE: 'IN_RETURN_TRANSFER' }, { reworkDest: 'WS-WC1-03', arriveAt: '11:05' }), /WS-WC1-03.*11:05/);
});

test('history-only and older state names are handled, unknown states are reported, never silent', () => {
  assert.match(nextAction(null), /history only/);
  for (const [old, cur] of Object.entries(ALIASES)) assert.equal(nextAction({ STATE: old, ROUTE_STEP: 'OP30' }, { gate: 'OP40' }), nextAction({ STATE: cur, ROUTE_STEP: 'OP30' }, { gate: 'OP40' }));
  assert.match(nextAction({ STATE: 'SOMETHING_NEW' }), /No guidance for state SOMETHING_NEW/);
});
