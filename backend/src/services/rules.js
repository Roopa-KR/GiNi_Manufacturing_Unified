'use strict';
/* Versioned, effective-dated rule settings. Defaults come from config/rules.json (non-secret); every edit creates a new version. */
const { getDb, withTransaction } = require('../lib/db');
const E = require('../lib/errors');
const DEFAULT = require('../../config/rules.json');
const POINTS = require('../../config/points_policy.json');
const { audit } = require('./sessions');

async function ensureDefault(db) {
  const n = await db.collection('rule_settings').countDocuments({});
  if (n) {
    // a newer shipped configuration becomes a new version automatically only while nobody has edited the rules in the app;
    // otherwise it is reported (Administration -> Rule settings) and applied by a person
    const latest = (await db.collection('rule_settings').find({}).sort({ VERSION_NO: -1 }).limit(1).toArray())[0];
    const shipped = await db.collection('rule_settings').findOne({ 'RULES.version': DEFAULT.version, CREATED_BY: 'config/rules.json' });
    if (!shipped && latest && latest.CREATED_BY === 'config/rules.json') {
      await withTransaction(async (txs) => {
        const r = await db.collection('rule_settings').updateOne({ VERSION_NO: latest.VERSION_NO + 1 }, { $setOnInsert: { VERSION_NO: latest.VERSION_NO + 1, STATUS: 'ACTIVE', EFFECTIVE_FROM: new Date(), RULES: DEFAULT, POINTS_POLICY: POINTS,
          CREATED_AT: new Date(), CREATED_BY: 'config/rules.json', SUPERSEDES: latest.VERSION_NO, NOTE: `Shipped configuration ${DEFAULT.version}`, _origin: 'APP' } }, { upsert: true, session: txs });
        if (r.upsertedCount) await audit(db, 'SYSTEM', 'RULES_VERSION_CREATED', `v${latest.VERSION_NO + 1}`, { supersedes: latest.VERSION_NO, note: `Shipped configuration ${DEFAULT.version}` }, { session: txs, after: { version: latest.VERSION_NO + 1, configVersion: DEFAULT.version } });
      });
    }
    return;
  }
  await db.collection('rule_settings').updateOne({ VERSION_NO: 1 }, { $setOnInsert: { VERSION_NO: 1, STATUS: 'ACTIVE', EFFECTIVE_FROM: new Date(DEFAULT.effective_from), RULES: DEFAULT, POINTS_POLICY: POINTS,
    CREATED_AT: new Date(), CREATED_BY: 'config/rules.json', NOTE: 'Provisional demo defaults - not Siemens-approved', _origin: 'APP' } }, { upsert: true });
}

async function listVersions() {
  const db = await getDb();
  await ensureDefault(db);
  const rows = await db.collection('rule_settings').find({}).sort({ VERSION_NO: -1 }).limit(20).toArray();
  const now = new Date();
  // the effective version = newest whose EFFECTIVE_FROM has passed (application time); later ones are SCHEDULED
  const active = rows.find(r => r.STATUS !== 'WITHDRAWN' && new Date(r.EFFECTIVE_FROM) <= now) || rows[rows.length - 1];
  const status = r => (r.STATUS === 'WITHDRAWN' ? 'WITHDRAWN' : r === active ? 'ACTIVE' : new Date(r.EFFECTIVE_FROM) > now ? 'SCHEDULED' : 'SUPERSEDED');
  const shippedApplied = rows.some(r => r.RULES && r.RULES.version === DEFAULT.version);
  return { active, latest: rows[0], shippedConfigVersion: DEFAULT.version, shippedConfigApplied: shippedApplied, versions: rows.map(r => ({ version: r.VERSION_NO, status: status(r), effectiveFrom: r.EFFECTIVE_FROM, createdAt: r.CREATED_AT, createdBy: r.CREATED_BY, note: r.NOTE })) };
}

const NUM = ['window_min', 'warmup_min', 'persistence', 'recovery', 'hysteresis', 'cooldown_min'];
function validateRules(rules) {
  if (!Array.isArray(rules) || !rules.length) throw E.bad('INVALID_RULES', 'rules must be a non-empty array');
  const ids = new Set();
  for (const r of rules) {
    if (!r.rule_id || ids.has(r.rule_id)) throw E.bad('INVALID_RULES', `missing or duplicate rule_id ${r.rule_id}`);
    ids.add(r.rule_id);
    for (const k of NUM) if (r[k] !== undefined && !(typeof r[k] === 'number' && r[k] >= 0)) throw E.bad('INVALID_RULES', `${r.rule_id}.${k} must be a non-negative number`);
    if (r.enabled !== undefined && typeof r.enabled !== 'boolean') throw E.bad('INVALID_RULES', `${r.rule_id}.enabled must be boolean`);
  }
}

async function saveVersion(body, actor) {
  const db = await getDb();
  await ensureDefault(db);
  const cur = (await listVersions()).latest;      // edits build on the newest version (including a scheduled one)
  const rules = body.rules || cur.RULES.rules;
  validateRules(rules);
  const effective = body.effectiveFrom ? new Date(body.effectiveFrom) : new Date();
  if (isNaN(effective)) throw E.bad('INVALID_DATE', 'effectiveFrom is not a date');
  const next = cur.VERSION_NO + 1;
  const doc = { VERSION_NO: next, STATUS: effective > new Date() ? 'SCHEDULED' : 'ACTIVE', EFFECTIVE_FROM: effective, RULES: { ...cur.RULES, rules, version: body.configVersion || cur.RULES.version, cutoff: { ...cur.RULES.cutoff, ...(body.cutoff || {}) } }, POINTS_POLICY: cur.POINTS_POLICY,
    CREATED_AT: new Date(), CREATED_BY: actor, NOTE: body.note || null, SUPERSEDES: cur.VERSION_NO, _origin: 'APP' };
  // stored STATUS is informational; the effective version is always derived from EFFECTIVE_FROM (see listVersions / calc.active_rules).
  // The version and its audit record commit together; a concurrent save of the same version number loses on the unique index.
  await withTransaction(async (txs) => {
    await db.collection('rule_settings').insertOne(doc, { session: txs });
    await audit(db, actor, 'RULES_VERSION_CREATED', `v${next}`, { supersedes: cur.VERSION_NO, note: body.note || null }, { session: txs, before: { version: cur.VERSION_NO, rules: cur.RULES.rules }, after: { version: next, effectiveFrom: effective, rules } });
  });
  return { version: next, effectiveFrom: effective };
}

module.exports = { listVersions, saveVersion, ensureDefault, validateRules };
