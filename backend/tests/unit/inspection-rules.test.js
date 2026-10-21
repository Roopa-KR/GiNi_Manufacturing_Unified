'use strict';
/* Inspection evaluation: NUMERIC within limits -> PASS, outside -> FAIL, missing mandatory -> INCOMPLETE (never fail, never pass);
   YES_NO polarity follows the original CTQ FAILURE_ANSWER. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../../src/domain/inspectionRules');

const list = [
  { check: { CHECK_ID: 'C-NUM', ANSWER_TYPE: 'NUMERIC', MANDATORY_FLAG: 'Y' }, specs: [{ SPEC_ID: 'S1', MEASUREMENT_POSITION: 'A', REQUIRED_READING_COUNT: 2, LOWER_LIMIT: 10, UPPER_LIMIT: 12, MEASUREMENT_UNIT: 'mm' }] },
  { check: { CHECK_ID: 'C-YN', ANSWER_TYPE: 'YES_NO', FAILURE_ANSWER: 'No', MANDATORY_FLAG: 'Y' }, specs: [] },
  { check: { CHECK_ID: 'C-OPT', ANSWER_TYPE: 'YES_NO', FAILURE_ANSWER: 'Yes', MANDATORY_FLAG: 'N' }, specs: [] },
];

test('all within limits -> PASS (boundaries inclusive)', () => {
  const r = evaluate(list, { 'C-NUM': { values: { A: [10, 12] } }, 'C-YN': { answer: 'Yes' } });
  assert.equal(r.overall, 'PASS');
});
test('one reading outside -> FAIL with defect code and preserved readings', () => {
  const r = evaluate(list, { 'C-NUM': { values: { A: [11, 12.01] } }, 'C-YN': { answer: 'Yes' } });
  assert.equal(r.overall, 'FAIL');
  const c = r.results.find(x => x.checkId === 'C-NUM');
  assert.equal(c.defectCode, 'OUT_OF_TOLERANCE');
  assert.deepEqual(c.readings.map(x => x.result), ['PASS', 'FAIL']);
});
test('failure answer polarity', () => {
  assert.equal(evaluate(list, { 'C-NUM': { values: { A: [11, 11] } }, 'C-YN': { answer: 'No' } }).overall, 'FAIL');
  assert.equal(evaluate(list, { 'C-NUM': { values: { A: [11, 11] } }, 'C-YN': { answer: 'Yes' }, 'C-OPT': { answer: 'Yes' } }).overall, 'FAIL');
});
test('missing mandatory reading -> INCOMPLETE, not FAIL', () => {
  const r = evaluate(list, { 'C-NUM': { values: { A: [11] } }, 'C-YN': { answer: 'Yes' } });
  assert.equal(r.overall, 'INCOMPLETE');
  assert.equal(r.mandatoryMissing, 1);
});
test('an incomplete answer set with a failing reading is FAIL (a known failure is not hidden)', () => {
  assert.equal(evaluate(list, { 'C-NUM': { values: { A: [9] } } }).overall, 'FAIL');
});
