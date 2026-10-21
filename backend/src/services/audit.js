'use strict';
/* Audit records for administrative actions, and the transaction wrapper every multi-record admin action goes through.

   adminTx(): the business writes, the audit record (with before/after values, secrets redacted) and - when the request carried an
   Idempotency-Key - the stored result are committed in ONE transaction. Either everything is recorded or nothing is:
   a failed audit write rolls the worker/account/session changes back. A retry with the same Idempotency-Key and the same body
   returns the stored result without writing again; the same key with a different body is refused (409). */
const crypto = require('crypto');
const { getDb, withTransaction } = require('../lib/db');
const E = require('../lib/errors');

const SECRET_KEY = /(PIN|PASSWORD|TOKEN|SECRET|HASH|CREDENTIAL)/i;

/** deep copy with secret-looking fields replaced; never stores a plaintext PIN, password, token or hash */
function redact(v, key = '') {
  if (SECRET_KEY.test(key)) return v === undefined || v === null ? v : '[REDACTED]';
  if (v instanceof Date || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(x => redact(x));
  const out = {};
  for (const [k, x] of Object.entries(v)) { if (k === '_id' || k === '_seed') continue; out[k] = redact(x, k); }
  return out;
}

function auditId() { return `AUD-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }

/** one audit row; pass { session } to write it inside the caller's transaction */
async function audit(db, actor, action, target, details, opts = {}) {
  const doc = { AUDIT_ID: auditId(), AT: new Date(), ACTOR: actor || 'SYSTEM', ACTION: action, TARGET: target, DETAILS: redact(details || {}), _origin: 'APP' };
  if (opts.before !== undefined) doc.BEFORE = redact(opts.before);
  if (opts.after !== undefined) doc.AFTER = redact(opts.after);
  if (opts.idempotencyKey) doc.IDEMPOTENCY_KEY = opts.idempotencyKey;
  if (opts.requestId) doc.REQUEST_ID = opts.requestId;
  await db.collection('audit_log').insertOne(doc, opts.session ? { session: opts.session } : undefined);
  return doc;
}

const hashBody = b => crypto.createHash('sha256').update(JSON.stringify(b === undefined ? null : b)).digest('hex');

/**
 * Run an admin action atomically with its audit record.
 *   fn(session, db) -> { result, target?, before?, after?, details? }
 * meta: { actor, action, target, idempotencyKey, request (the body, for the replay check), requestId }
 */
async function adminTx(meta, fn) {
  const db = await getDb();
  const key = meta.idempotencyKey || null;
  const reqHash = hashBody(meta.request);
  const replay = async () => {
    const prior = await db.collection('admin_requests').findOne({ IDEMPOTENCY_KEY: key });
    if (!prior) return null;
    if (prior.ACTION !== meta.action || prior.REQUEST_HASH !== reqHash) throw E.conflict('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
    return { ...prior.RESULT, replayed: true };
  };
  if (key) { const r = await replay(); if (r) return r; }
  try {
    return await withTransaction(async (s) => {
      const out = await fn(s, db);
      const target = out.target || meta.target;
      await module.exports.audit(db, meta.actor, meta.action, target, out.details || {}, { session: s, before: out.before, after: out.after, idempotencyKey: key, requestId: meta.requestId });
      if (key) await db.collection('admin_requests').insertOne({ IDEMPOTENCY_KEY: key, ACTION: meta.action, ACTOR: meta.actor, TARGET: target, REQUEST_HASH: reqHash, RESULT: out.result, AT: new Date(), _origin: 'APP' }, { session: s });
      return out.result;
    });
  } catch (e) {
    // a concurrent duplicate with the same key lost the race on the unique index: return the winner's committed result
    if (key && (e.code === 11000 || /duplicate key/i.test(String(e.message)))) { const r = await replay(); if (r) return r; }
    throw e;
  }
}

module.exports = { audit, adminTx, redact };
