'use strict';
/*
 * Inspection evaluation (pure). Answers are judged against the versioned CTQ checklist and the product's
 * specifications (synthetic limits, SPEC_SOURCE = SYNTHETIC_ASSUMPTION - not Siemens tolerances).
 *   NUMERIC: every required reading present and within [LOWER_LIMIT, UPPER_LIMIT] -> PASS; any outside -> FAIL.
 *   YES_NO : answer equal to FAILURE_ANSWER (original CTQ polarity preserved) -> FAIL, the other answer -> PASS.
 *   Missing mandatory answers/readings -> INCOMPLETE (never a fail, never a pass; cannot release).
 * Overall: any FAIL -> FAIL; else any INCOMPLETE -> INCOMPLETE; else PASS.
 */
function evaluate(checklist, answers = {}) {
  const results = [];
  for (const { check, specs } of checklist) {
    const a = answers[check.CHECK_ID] || {};
    const mandatory = (check.MANDATORY_FLAG || 'Y') === 'Y';
    if (check.ANSWER_TYPE === 'YES_NO') {
      const ans = typeof a.answer === 'string' ? a.answer.trim() : null;
      if (!ans || !['Yes', 'No'].includes(ans)) { results.push({ checkId: check.CHECK_ID, result: mandatory ? 'INCOMPLETE' : 'NOT_ANSWERED', readings: [], reason: 'Answer missing' }); continue; }
      const fail = check.FAILURE_ANSWER && ans === check.FAILURE_ANSWER;
      results.push({ checkId: check.CHECK_ID, result: fail ? 'FAIL' : 'PASS', readings: [{ position: null, sampleNo: 1, text: ans, result: fail ? 'FAIL' : 'PASS', specId: (specs[0] || {}).SPEC_ID || null, unit: null }],
        reason: fail ? `Answer "${ans}" is the failure answer for this question` : null, defectCode: fail ? 'FAILED_VISUAL_CHECK' : null });
      continue;
    }
    // NUMERIC: one entry per specification position, each with REQUIRED_READING_COUNT readings
    const vals = a.values || {};       // { MEASUREMENT_POSITION: [numbers] }
    const readings = []; let anyFail = false; let missing = false; const reasons = [];
    const posSpecs = specs.length ? specs : [];
    if (!posSpecs.length) { results.push({ checkId: check.CHECK_ID, result: 'INCOMPLETE', readings: [], reason: 'No specification for this product - cannot judge (provisional data gap)' }); continue; }
    for (const s of posSpecs) {
      const need = Number(s.REQUIRED_READING_COUNT || 1);
      const got = (Array.isArray(vals[s.MEASUREMENT_POSITION]) ? vals[s.MEASUREMENT_POSITION] : (vals[s.MEASUREMENT_POSITION] !== undefined ? [vals[s.MEASUREMENT_POSITION]] : []))
        .map(v => (v === '' || v === null || v === undefined ? NaN : Number(v)));
      for (let i = 0; i < need; i++) {
        const v = got[i];
        if (!Number.isFinite(v)) { missing = true; readings.push({ position: s.MEASUREMENT_POSITION, sampleNo: i + 1, value: null, result: 'MISSING', specId: s.SPEC_ID, unit: s.MEASUREMENT_UNIT }); continue; }
        const lo = s.LOWER_LIMIT, hi = s.UPPER_LIMIT;
        const ok = (lo === null || lo === undefined || v >= lo) && (hi === null || hi === undefined || v <= hi);
        if (!ok) { anyFail = true; reasons.push(`${s.MEASUREMENT_POSITION} ${v} ${s.MEASUREMENT_UNIT || ''} outside ${lo}..${hi}`); }
        readings.push({ position: s.MEASUREMENT_POSITION, sampleNo: i + 1, value: v, result: ok ? 'PASS' : 'FAIL', specId: s.SPEC_ID, unit: s.MEASUREMENT_UNIT, lower: lo, upper: hi, nominal: s.NOMINAL_VALUE });
      }
    }
    const result = anyFail ? 'FAIL' : (missing ? (mandatory ? 'INCOMPLETE' : 'NOT_ANSWERED') : 'PASS');
    results.push({ checkId: check.CHECK_ID, result, readings, reason: anyFail ? reasons.join('; ') : (missing ? 'Required readings missing' : null), defectCode: anyFail ? 'OUT_OF_TOLERANCE' : null });
  }
  const overall = results.some(r => r.result === 'FAIL') ? 'FAIL' : (results.some(r => r.result === 'INCOMPLETE') ? 'INCOMPLETE' : 'PASS');
  return { overall, results, mandatoryMissing: results.filter(r => r.result === 'INCOMPLETE').length };
}

module.exports = { evaluate };
