'use strict';
/*
 * Command bus: validate -> one MongoDB transaction (append immutable event(s), update immediate validated state with
 * optimistic versions, enqueue the dependent calculation job) -> idempotent response. Used by humans (HTTP), plant
 * agents (internal endpoint) and the scenario console alike, so all of them go through the same domain transitions.
 */
const crypto = require('crypto');
const { getDb, withTransaction } = require('../lib/db');
const { simNow } = require('../lib/time');
const E = require('../lib/errors');

const SIM_COLLS = new Set(['sim_units', 'sim_operations', 'sim_tasks', 'sim_workers', 'sim_equipment', 'sim_materials', 'sim_inspections', 'sim_holds', 'sim_returns',
  'sim_plan_releases', 'sim_material_requests', 'sim_events', 'sim_participation', 'sim_readings', 'sim_evidence', 'sim_dispositions', 'sim_defects', 'sim_investigations',
  'sim_points_ledger', 'sim_alerts', 'sim_alert_transitions', 'sim_forecasts', 'sim_projections', 'sim_actions', 'sim_replacements', 'sim_milestones', 'sim_attendance',
  'sim_support_requests', 'sim_handovers', 'sim_transfers', 'sim_overtime', 'sim_attendance_corrections', 'sim_progress', 'sim_change_log', 'sim_points_evaluations', 'sim_batch_membership', 'sim_batches', 'sim_scans']);

// audit: fields never copied into the change log (hashes, tokens, secrets) - the change is recorded as REDACTED
const SECRET_KEY = /(PIN|PASSWORD|TOKEN|SECRET|HASH|CREDENTIAL)/i;
function getPath(o, path) { return String(path).split('.').reduce((a, k) => (a == null ? undefined : a[k]), o); }
function auditValue(key, v) { return SECRET_KEY.test(key) ? (v === undefined ? undefined : '[REDACTED]') : v; }
function entityKey(filter) { const k = {}; for (const [f, v] of Object.entries(filter || {})) if (!['SESSION_ID', 'VERSION'].includes(f) && (typeof v !== 'object' || v === null)) k[f] = v; return k; }

const registry = {};
const FACTORY_TIMED = ['UNIT_ARRIVE', 'RETURN_ARRIVE', 'PROCESS_COMPLETE'];
function register(type, def) { registry[type] = def; }

class Tx {
  constructor(db, txs, session, actor, meta) {
    this.db = db; this.s = txs; this.session = session; this.actor = actor; this.meta = meta;
    this.sid = session.SESSION_ID; this.runId = session.RUN_ID; this.ds = session.DATASET_ID;
    // the session's event timeline is monotonic: an action never gets a simulated time before the last recorded event
    const base = meta.at || simNow(session);
    const last = session.LAST_EVENT_SIM_AT ? new Date(session.LAST_EVENT_SIM_AT) : null;
    this.now = last && last > base ? last : base;
    this.received = new Date();
    this.events = [];
    this.changes = [];
    this.result = {};
  }
  scope(coll, filter) { return SIM_COLLS.has(coll) ? { SESSION_ID: this.sid, ...filter } : filter; }
  async one(coll, filter, opts = {}) { return this.db.collection(coll).findOne(this.scope(coll, filter), { ...opts, session: this.s }); }
  async many(coll, filter, opts = {}) {
    let cur = this.db.collection(coll).find(this.scope(coll, filter), { session: this.s, projection: opts.projection });
    if (opts.sort) cur = cur.sort(opts.sort);
    if (opts.limit) cur = cur.limit(opts.limit);
    return cur.toArray();
  }
  async must(coll, filter, what) { const d = await this.one(coll, filter); if (!d) throw E.notFound(what || coll); return d; }
  /** optimistic update: VERSION must match when expectVersion is given; always increments VERSION */
  async update(coll, filter, set, opts = {}) {
    const f = this.scope(coll, { ...filter });
    if (opts.expectVersion !== undefined && opts.expectVersion !== null) f.VERSION = opts.expectVersion;
    const upd = { $set: { ...set, UPDATED_AT: this.received, UPDATED_SIM_AT: this.now }, $inc: { VERSION: 1 } };
    if (opts.unset) upd.$unset = Object.fromEntries(opts.unset.map(k => [k, '']));
    if (opts.push) upd.$push = opts.push;
    if (opts.addToSet) upd.$addToSet = opts.addToSet;
    if (opts.pull) upd.$pull = opts.pull;
    const before = await this.db.collection(coll).findOne(f, { session: this.s });
    const doc = before && await this.db.collection(coll).findOneAndUpdate({ _id: before._id, VERSION: before.VERSION }, upd, { session: this.s, returnDocument: 'after' });
    if (doc) {
      const keys = new Set([...Object.keys(upd.$set), ...(opts.unset || []), ...Object.keys(opts.push || {}), ...Object.keys(opts.addToSet || {}), ...Object.keys(opts.pull || {})]);
      keys.delete('UPDATED_AT'); keys.delete('UPDATED_SIM_AT');
      const b = {}; const a = {};
      for (const k of keys) {
        const bv = getPath(before, k); const av = getPath(doc, k);
        if (JSON.stringify(bv) === JSON.stringify(av)) continue;
        b[k] = auditValue(k, bv === undefined ? null : bv); a[k] = auditValue(k, av === undefined ? null : av);
      }
      this.changes.push({ COLLECTION: coll, OPERATION: 'UPDATE', ENTITY_KEY: entityKey(filter), RECORD_ID: String(before._id), VERSION_BEFORE: before.VERSION ?? null, VERSION_AFTER: doc.VERSION, BEFORE: b, AFTER: a });
    }
    if (!doc) {
      const cur = await this.db.collection(coll).findOne(this.scope(coll, filter), { session: this.s });
      if (!cur) throw E.notFound(coll);
      throw E.conflict('VERSION_CONFLICT', `The ${coll.replace('sim_', '')} record changed since you loaded it - reload and retry`, { expected: opts.expectVersion, current: cur.VERSION, state: cur.STATE || cur.STATUS });
    }
    return doc;
  }
  async insert(coll, doc) {
    const d = { ...doc };
    if (SIM_COLLS.has(coll)) Object.assign(d, { SESSION_ID: this.sid, RUN_ID: this.runId, DATASET_ID: this.ds });
    Object.assign(d, { VERSION: 1, CREATED_AT: this.received, CREATED_SIM_AT: this.now, _origin: 'APP' });
    await this.db.collection(coll).insertOne(d, { session: this.s });
    if (coll !== 'sim_events') {
      const after = {}; for (const [k, v] of Object.entries(d)) if (k !== '_id') after[k] = auditValue(k, v);
      this.changes.push({ COLLECTION: coll, OPERATION: 'INSERT', ENTITY_KEY: null, RECORD_ID: String(d._id), VERSION_BEFORE: null, VERSION_AFTER: 1, BEFORE: null, AFTER: after });
    }
    return d;
  }
  async nextId(prefix) {
    const s = await this.db.collection('sim_sessions').findOneAndUpdate({ SESSION_ID: this.sid }, { $inc: { [`COUNTERS.${prefix}`]: 1 } }, { session: this.s, returnDocument: 'after' });
    const n = s.COUNTERS[prefix];
    return `${prefix}-${this.session.SHORT_ID}-${String(n).padStart(5, '0')}`;
  }
  /** immutable event envelope (sim_events) */
  async event(type, entityType, entityId, payload = {}, opts = {}) {
    const s = await this.db.collection('sim_sessions').findOneAndUpdate({ SESSION_ID: this.sid }, { $inc: { EVENT_SEQ: 1 }, $max: { LAST_EVENT_SIM_AT: opts.eventTime && opts.eventTime > this.now ? opts.eventTime : this.now } }, { session: this.s, returnDocument: 'after' });
    const seq = s.EVENT_SEQ;
    const ev = {
      EVENT_ID: `EV-${this.session.SHORT_ID}-${String(seq).padStart(7, '0')}`, EVENT_SEQ: seq, DATASET_ID: this.ds, RUN_ID: this.runId, SESSION_ID: this.sid,
      EVENT_TYPE: type, ENTITY_TYPE: entityType, ENTITY_ID: entityId, EVENT_TIME: opts.eventTime || this.now, KNOWN_AT: opts.knownAt || opts.eventTime || this.now,
      RECEIVED_AT: this.received, ACTOR_ID: this.actor.workerId || this.actor.loginId || 'SYSTEM', ACTOR_LOGIN: this.actor.loginId || null, ACTOR_TYPE: this.actor.kind,
      ON_BEHALF_OF: this.meta.onBehalfOf || null, SOURCE: this.meta.source, SCHEMA_VERSION: '1.0', COMMAND_TYPE: this.meta.type,
      CORRELATION_ID: this.meta.correlationId, CAUSATION_ID: this.meta.causationId || null, IDEMPOTENCY_KEY: this.meta.idempotencyKey || null,
      PAYLOAD: payload, _origin: 'APP',
    };
    await this.db.collection('sim_events').insertOne(ev, { session: this.s });
    this.events.push({ EVENT_ID: ev.EVENT_ID, EVENT_SEQ: seq, EVENT_TYPE: type, ENTITY_ID: entityId });
    return ev;
  }
  async enqueueJob(type, payload = {}, dedup = true, delaySec = 0) {
    const now = new Date();
    const key = dedup ? `${type}:${this.sid}` : `${type}:${this.sid}:${crypto.randomUUID()}`;
    await this.db.collection('jobs').updateOne({ DEDUP_KEY: key, DEDUP_OPEN: true },
      { $setOnInsert: { JOB_ID: `JOB-${crypto.randomBytes(8).toString('hex').toUpperCase()}`, SESSION_ID: this.sid, TYPE: type, STATUS: 'PENDING', PRIORITY: 5, AVAILABLE_AT: new Date(now.getTime() + delaySec * 1000), ATTEMPTS: 0, MAX_ATTEMPTS: 5, FENCE: 0, PAYLOAD: payload, CREATED_AT: now, UPDATED_AT: now, _origin: 'APP' } },
      { upsert: true, session: this.s });
  }
}

function requestHash(type, payload) { return crypto.createHash('sha256').update(JSON.stringify([type, payload || {}])).digest('hex'); }

async function loadSession(db, sessionId) {
  const s = await db.collection('sim_sessions').findOne({ SESSION_ID: sessionId });
  if (!s) throw E.notFound('Simulation session');
  return s;
}

/**
 * @param {object} p {sessionId, actor:{kind,loginId,workerId,permissions,roles}, type, payload, idempotencyKey, source, at, correlationId, causationId, onBehalfOf}
 */
async function execute(p) {
  const def = registry[p.type];
  if (!def) throw E.bad('UNKNOWN_COMMAND', `Unknown command ${p.type}`);
  const db = await getDb();
  const session = await loadSession(db, p.sessionId);
  if (session.MODE !== 'INTERACTIVE' && !def.anyMode) throw E.conflict('READ_ONLY_REPLAY', 'Synthetic live replay is read-only; create an interactive session to enter new activity');
  if (!['READY', 'RUNNING', 'PAUSED'].includes(session.STATUS) && !def.anyStatus) throw E.conflict('SESSION_NOT_ACTIVE', `Session is ${session.STATUS}`);
  if (p.actor.kind === 'HUMAN' && !p.idempotencyKey && !def.noIdempotency) throw E.bad('IDEMPOTENCY_KEY_REQUIRED', 'Write commands require an Idempotency-Key header');
  // permission
  const perms = p.actor.permissions || [];
  if (def.trustedOnly && !p.trusted) throw E.forbidden(`Command ${p.type} is issued by the server only`);
  if (def.perm && !(Array.isArray(def.perm) ? def.perm : [def.perm]).some(x => perms.includes(x))) throw E.forbidden(`Command ${p.type} requires ${[].concat(def.perm).join(' or ')}`);
  if (p.actor.kind === 'AGENT' && def.agentAllowed === false) throw E.forbidden(`Command ${p.type} is not available to simulated agents`);
  // fresh factory: in Manual Team Test mode no background agent completes human work - only timed, unattended process steps
  // (cure completion, transfer arrival) advance by rule. Simulated Test mode additionally lets DESIGNATED simulated workers act.
  if (session.FACTORY_SESSION && p.actor.kind !== 'HUMAN') {
    if (!FACTORY_TIMED.includes(p.type)) {
      if (session.OPERATING_MODE !== 'SIMULATED_TEST') throw E.forbidden(`Manual Team Test: ${p.type} is done by people only (background agents only advance timed process steps)`);
      const w = p.actor.workerId ? await db.collection('sim_workers').findOne({ SESSION_ID: session.SESSION_ID, WORKER_ID: p.actor.workerId }) : null;
      if (!w || !w.SIMULATED_WORKER) throw E.forbidden(`Simulated Test: only designated simulated workers are driven by agents (${p.actor.workerId || 'no worker'} is not one)`);
    }
  }
  if (p.at && p.actor.kind === 'HUMAN') delete p.at;      // humans always act at the shared simulation time
  if (p.at) {
    const now = simNow(session); const at = new Date(p.at);
    const tol = 5000 * Math.max(1, (session.CLOCK || {}).SPEED || 1);
    if (at > new Date(now.getTime() + tol) || at < new Date(session.FORK_AT)) throw E.bad('INVALID_EVENT_TIME', 'Agent event time outside the processed simulation window');
  }
  const idemKey = p.idempotencyKey ? `${p.sessionId}|${p.actor.loginId || p.actor.workerId || 'system'}|${p.idempotencyKey}` : null;
  const rh = requestHash(p.type, p.payload);
  if (idemKey) {
    const prev = await db.collection('idempotency_keys').findOne({ KEY: idemKey });
    if (prev) {
      if (prev.REQUEST_HASH !== rh) throw E.conflict('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
      return { ...prev.RESPONSE, replayed: true };
    }
  }
  const correlationId = p.correlationId || crypto.randomUUID();
  await require('./catalog').catalog();   // warm master data outside the transaction
  let response;
  try {
    response = await runTxn();
  } catch (e) {
    // a concurrent duplicate of the same idempotent request lost the race on the unique KEY index: return the winner's response
    if (idemKey && e && e.code === 11000 && e.keyPattern && e.keyPattern.KEY) {
      const prev = await db.collection('idempotency_keys').findOne({ KEY: idemKey });
      if (prev && prev.REQUEST_HASH === rh) return { ...prev.RESPONSE, replayed: true };
    }
    throw e;
  }
  return response;

  async function runTxn() { return withTransaction(async (txs) => {
    // a concurrent duplicate that is retried after a write conflict sees the winner's committed key here and replays it
    if (idemKey) {
      const prev = await db.collection('idempotency_keys').findOne({ KEY: idemKey }, { session: txs });
      if (prev) {
        if (prev.REQUEST_HASH !== rh) throw E.conflict('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
        return { ...prev.RESPONSE, replayed: true };
      }
    }
    const fresh = await db.collection('sim_sessions').findOne({ SESSION_ID: p.sessionId }, { session: txs });
    const tx = new Tx(db, txs, fresh, p.actor, { type: p.type, source: p.source || (p.actor.kind === 'HUMAN' ? 'UI' : p.actor.kind), idempotencyKey: p.idempotencyKey, correlationId, causationId: p.causationId, at: p.at ? new Date(p.at) : null, onBehalfOf: p.onBehalfOf });
    const result = await def.handler(tx, p.payload || {}, p);
    if (tx.events.length && !def.noRecalc) await tx.enqueueJob('RECALC');
    const out = { ok: true, command: p.type, sessionId: p.sessionId, simTime: tx.now, correlationId, events: tx.events, result: result || {} };
    if (tx.changes.length) {
      // before/after audit of every record this command changed, committed atomically with the change itself
      await db.collection('sim_change_log').insertOne({ CHANGE_SET_ID: `CHG-${crypto.randomUUID()}`, SESSION_ID: tx.sid, RUN_ID: tx.runId, DATASET_ID: tx.ds, COMMAND_TYPE: p.type, RESET_GENERATION: fresh.RESET_GENERATION || 0,
        ACTOR_ID: p.actor.workerId || p.actor.loginId || 'SYSTEM', ACTOR_LOGIN: p.actor.loginId || null, ACTOR_TYPE: p.actor.kind, ON_BEHALF_OF: p.onBehalfOf || null, SOURCE: tx.meta.source,
        REASON: (p.payload && (p.payload.reason || p.payload.reasonCode || p.payload.note)) || null, CORRELATION_ID: correlationId, CAUSATION_ID: p.causationId || null,
        IDEMPOTENCY_KEY: p.idempotencyKey || null, EVENT_IDS: tx.events.map(e => e.EVENT_ID), EVENT_TIME: tx.now, KNOWN_AT: tx.now, RECEIVED_AT: tx.received,
        CHANGES: tx.changes, _origin: 'APP' }, { session: txs });
    }
    if (idemKey) await db.collection('idempotency_keys').insertOne({ KEY: idemKey, SESSION_ID: p.sessionId, COMMAND: p.type, REQUEST_HASH: rh, RESPONSE: out, CREATED_AT: new Date(), _origin: 'APP' }, { session: txs });
    return out;
  }); }
}

module.exports = { execute, register, registry, Tx, loadSession, SIM_COLLS };
