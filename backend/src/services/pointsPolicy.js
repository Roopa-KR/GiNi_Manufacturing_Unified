'use strict';
/* Versioned points policy (points_policy_versions). The shipped config/points_policy.json is the client's formula with the two
   attempt adjustments OFF. Changing the policy creates a new version that names the person who confirmed it and their
   confirmation statement; it is effective from a date (application time, like rule settings). The engine records the policy
   version on every evaluation and ledger row, and a policy change re-evaluates every subject (python_engine/gini_engine/points.py). */
const crypto = require('crypto');
const { getDb } = require('../lib/db');
const E = require('../lib/errors');
const A = require('./audit');
const SHIPPED = require('../../config/points_policy.json');

const ADJ = ['withdraw_positive_time_on_confirmed_workmanship_defect', 'waive_negative_time_on_confirmed_equipment_cause'];
// '$'-prefixed keys ($comment) are documentation only and are not stored as field names
const strip = v => (Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' && !(v instanceof Date) ? Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('$')).map(([k, x]) => [k, strip(x)])) : v);
const hash = p => crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 16);

async function versions() {
  const db = await getDb();
  const rows = await db.collection('points_policy_versions').find({}, { projection: { _id: 0 } }).sort({ VERSION_NO: -1 }).limit(20).toArray();
  const now = new Date();
  const effective = rows.find(r => r.STATUS !== 'WITHDRAWN' && new Date(r.EFFECTIVE_FROM) <= now) || null;
  return {
    effective: effective ? { source: 'CONFIRMED_VERSION', version: effective.VERSION_NO, key: `P${effective.VERSION_NO}`, confirmedBy: effective.CONFIRMED_BY, confirmedAt: effective.CONFIRMED_AT, statement: effective.CONFIRMATION_STATEMENT, policy: effective.POLICY }
      : { source: 'SHIPPED_DEFAULT', version: null, key: `config-${SHIPPED.version}`, confirmedBy: null, policy: SHIPPED, note: 'Client formula; attempt adjustments OFF; not yet confirmed by a business owner' },
    adjustments: ADJ,
    versions: rows.map(r => ({ version: r.VERSION_NO, effectiveFrom: r.EFFECTIVE_FROM, confirmedBy: r.CONFIRMED_BY, confirmedAt: r.CONFIRMED_AT, statement: r.CONFIRMATION_STATEMENT,
      adjustments: (r.POLICY || {}).attempt_adjustments || {}, status: r === effective ? 'EFFECTIVE' : (new Date(r.EFFECTIVE_FROM) > now ? 'SCHEDULED' : (r.STATUS === 'WITHDRAWN' ? 'WITHDRAWN' : 'SUPERSEDED')), hash: r.POLICY_HASH })),
  };
}

/** body: { attemptAdjustments: { <name>: boolean }, confirmationStatement, effectiveFrom? } */
async function confirm(body, actor, meta = {}) {
  const p = [];
  const adj = body.attemptAdjustments || {};
  for (const k of Object.keys(adj)) if (!ADJ.includes(k)) p.push(`unknown adjustment ${k}`);
  for (const k of ADJ) if (adj[k] !== undefined && typeof adj[k] !== 'boolean') p.push(`${k} must be true or false`);
  const statement = String(body.confirmationStatement || '').trim();
  if (statement.length < 20) p.push('confirmationStatement is required (at least 20 characters): who agreed this policy and where it is recorded');
  const effective = body.effectiveFrom ? new Date(body.effectiveFrom) : new Date();
  if (isNaN(effective)) p.push('effectiveFrom is not a date');
  if (p.length) throw E.bad('INVALID_POINTS_POLICY', p.join('; '), { problems: p });
  const cur = (await versions()).effective;
  const base = strip(cur.policy || {});
  const policy = { ...base, attempt_adjustments: { ...(base.attempt_adjustments || {}), ...adj } };
  return A.adminTx({ actor, action: 'POINTS_POLICY_CONFIRMED', idempotencyKey: meta.idempotencyKey, request: body, requestId: meta.requestId }, async (s, db) => {
    const last = await db.collection('points_policy_versions').find({}, { session: s }).sort({ VERSION_NO: -1 }).limit(1).toArray();
    const next = last.length ? last[0].VERSION_NO + 1 : 1;
    const doc = { VERSION_NO: next, STATUS: 'CONFIRMED', EFFECTIVE_FROM: effective, POLICY: policy, POLICY_HASH: hash(policy), CONFIRMED_BY: actor, CONFIRMED_AT: new Date(),
      CONFIRMATION_STATEMENT: statement, SUPERSEDES: last.length ? last[0].VERSION_NO : null, BASED_ON: cur.key, _origin: 'APP' };
    await db.collection('points_policy_versions').insertOne(doc, { session: s });
    return { target: `P${next}`, before: { key: cur.key, attemptAdjustments: (cur.policy || {}).attempt_adjustments || {} }, after: { key: `P${next}`, attemptAdjustments: policy.attempt_adjustments, effectiveFrom: effective },
      details: { statement }, result: { version: next, key: `P${next}`, effectiveFrom: effective, attemptAdjustments: policy.attempt_adjustments, note: 'Every session re-evaluates its points under this version on its next calculation pass; changes are posted as linked reversals and new rows.' } };
  });
}

module.exports = { versions, confirm, ADJ };
