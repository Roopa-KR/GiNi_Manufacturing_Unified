'use strict';
/* Simulation sessions: server-authoritative shared clock (persisted anchors), creation (forked by the engine), reset. */
const crypto = require('crypto');
const { getDb, withTransaction } = require('../lib/db');
const { simNow } = require('../lib/time');
const E = require('../lib/errors');
const SIMCFG = require('../../config/simulation.json');
const { config } = require('../config/env');

const RESET_COLLS = ['sim_units', 'sim_operations', 'sim_tasks', 'sim_workers', 'sim_equipment', 'sim_materials', 'sim_inspections', 'sim_holds', 'sim_returns', 'sim_plan_releases',
  'sim_material_requests', 'sim_events', 'sim_participation', 'sim_readings', 'sim_evidence', 'sim_dispositions', 'sim_defects', 'sim_investigations', 'sim_points_ledger', 'sim_alerts',
  'sim_alert_transitions', 'sim_forecasts', 'sim_projections', 'sim_actions', 'sim_replacements', 'sim_milestones', 'sim_attendance', 'sim_support_requests', 'sim_handovers',
  'sim_transfers', 'sim_overtime', 'sim_attendance_corrections', 'sim_progress', 'sim_points_evaluations', 'sim_batch_membership', 'sim_batches', 'sim_scans'];
// sim_change_log is deliberately NOT reset: the before/after audit of a session survives a reset (stamped with RESET_GENERATION)

function publicSession(s) {
  if (!s) return null;
  const now = simNow(s);
  return {
    sessionId: s.SESSION_ID, runId: s.RUN_ID, name: s.NAME, mode: s.MODE,
    modeLabel: s.FACTORY_SESSION ? (s.OPERATING_MODE === 'SIMULATED_TEST' ? 'Fresh factory - simulated test' : 'Fresh factory - manual team test') : (s.MODE === 'REPLAY' ? 'Synthetic live replay' : 'Synthetic interactive demo'),
    factorySession: !!s.FACTORY_SESSION, operatingMode: s.OPERATING_MODE || null, scanRequired: { startWork: !!(s.SCAN_REQUIRED || {}).START_WORK, inspection: !!(s.SCAN_REQUIRED || {}).INSPECTION }, realTime: !!(s.CLOCK || {}).REAL_TIME, factoryName: s.FACTORY_NAME || null, siteId: s.SITE_ID || null,
    status: s.STATUS, sourceRunId: s.SOURCE_RUN_ID, checkpointId: s.CHECKPOINT_ID, forkAt: s.FORK_AT, horizonAt: s.HORIZON_AT, simNow: now,
    clock: { speed: (s.CLOCK || {}).SPEED, paused: !!(s.CLOCK || {}).PAUSED, controller: (s.CLOCK || {}).CONTROLLER_LOGIN_ID || null, updatedAt: (s.CLOCK || {}).UPDATED_AT },
    policyId: s.DISPOSITION_POLICY_ID, seed: s.SEED, eventSeq: s.EVENT_SEQ || 0, defaultFlag: !!s.DEFAULT_FLAG,
    engine: { simAt: (s.ENGINE || {}).SIM_AT || null, watermarkSeq: (s.ENGINE || {}).WATERMARK_SEQ || 0, heartbeatAt: (s.ENGINE || {}).HEARTBEAT_AT || null, projectionVersion: s.PROJECTION_VERSION || 0,
      leaseOwner: (s.ENGINE || {}).LEASE_OWNER || null, lagSeq: (s.EVENT_SEQ || 0) - ((s.ENGINE || {}).WATERMARK_SEQ || 0) },
    init: s.INIT ? { completedAt: s.INIT.COMPLETED_AT, summary: s.INIT.SUMMARY } : null, createdBy: s.CREATED_BY, createdAt: s.CREATED_AT, plantTimezone: s.PLANT_TIMEZONE,
  };
}

async function list() {
  const db = await getDb();
  const rows = await db.collection('sim_sessions').find({ STATUS: { $nin: ['ARCHIVED', 'PURGED'] } }).sort({ CREATED_AT: -1 }).limit(50).toArray();
  return rows.map(publicSession);
}
async function get(sessionId) {
  const db = await getDb();
  const s = await db.collection('sim_sessions').findOne({ SESSION_ID: sessionId });
  if (!s) throw E.notFound('Simulation session');
  return s;
}
async function getDefault() {
  const db = await getDb();
  return (await db.collection('sim_sessions').findOne({ DEFAULT_FLAG: true, STATUS: { $in: ['READY', 'RUNNING', 'PAUSED', 'INITIALIZING'] } }, { sort: { CREATED_AT: -1 } }))
    || (await db.collection('sim_sessions').findOne({ STATUS: { $in: ['READY', 'RUNNING', 'PAUSED'] } }, { sort: { CREATED_AT: -1 } }));
}

async function create({ mode = 'INTERACTIVE', checkpointId, sourceRunId, forkAt, name, createdBy, makeDefault = false, speed, policyId, notify }) {
  if (config().isFresh) throw E.conflict('FRESH_FACTORY', 'A fresh factory has one permanent session (S-FACTORY) created by "npm run factory:init"; synthetic demo sessions are not available in this environment');
  // optional per-session notification policy (scenario control): emails are suppressed at/above SUPPRESS_SPEED and inside COOLDOWN_SECONDS
  const N = {};
  if (notify && notify.suppressSpeed !== undefined) { const v = Number(notify.suppressSpeed); if (!(v >= 1 && v <= 240)) throw E.bad('INVALID_NOTIFY', 'notify.suppressSpeed must be 1-240'); N.SUPPRESS_SPEED = v; }
  if (notify && notify.cooldownSeconds !== undefined) { const v = Number(notify.cooldownSeconds); if (!(v >= 0 && v <= 86400)) throw E.bad('INVALID_NOTIFY', 'notify.cooldownSeconds must be 0-86400'); N.COOLDOWN_SECONDS = v; }
  const db = await getDb();
  const ds = config().datasetId;
  let fork = forkAt ? new Date(forkAt) : null;
  const src = sourceRunId || SIMCFG.default_source_run_id;
  const run = await db.collection('run_catalog').findOne({ dataset_id: ds, RUN_ID: src });
  if (!run) throw E.bad('UNKNOWN_RUN', `Run ${src} is not in RUN_CATALOG`);
  if (mode === 'INTERACTIVE' && run.STORAGE_MODE !== 'FULL') throw E.bad('FULL_RUN_REQUIRED', 'Interactive sessions fork from a FULL run (DELTA runs can be replayed)');
  const ck = checkpointId || (!fork ? SIMCFG.default_checkpoint_id : null);
  if (ck) {
    const c = await db.collection('checkpoints').findOne({ dataset_id: ds, CHECKPOINT_ID: ck });
    if (!c) throw E.bad('UNKNOWN_CHECKPOINT', `Checkpoint ${ck} not found`);
    if (!fork) fork = c.AS_OF_AT;
  }
  if (!fork) throw E.bad('FORK_REQUIRED', 'Provide a checkpoint or forkAt');
  const horizon = await db.collection('dataset_version').findOne({ dataset_id: ds, KEY: 'DATASET_VERSION_ID' });
  const short = crypto.randomBytes(3).toString('hex').toUpperCase();
  const sid = `S-${short}`;
  const now = new Date();
  const doc = {
    SESSION_ID: sid, SHORT_ID: short, RUN_ID: `SIM-${short}`, NAME: name || (mode === 'REPLAY' ? `Replay ${src}` : `Interactive from ${ck || fork.toISOString()}`), MODE: mode, STATUS: 'INITIALIZING',
    DATASET_ID: ds, DATASET_VERSION_ID: horizon ? horizon.VALUE : null, SOURCE_RUN_ID: src, CHECKPOINT_ID: ck || null, FORK_AT: fork,
    HORIZON_AT: mode === 'REPLAY' ? new Date('2026-10-16T04:00:00Z') : new Date(fork.getTime() + 3 * 24 * 3600000),
    DISPOSITION_POLICY_ID: mode === 'REPLAY' ? run.DISPOSITION_POLICY_ID : (policyId || SIMCFG.interactive_policy_id),
    POLICY_PARAMETERS: { invalidate_downstream_after_return: true, retain_at_station: true, escalate_after_fails: 2 },
    SEED: Number(process.env.SIMULATION_SEED || 42), PLANT_TIMEZONE: SIMCFG.plant_timezone,
    CLOCK: { ANCHOR_SIM_AT: fork, ANCHOR_WALL_AT: null, SPEED: speed || SIMCFG.default_speed, PAUSED: true, CONTROLLER_LOGIN_ID: createdBy, UPDATED_AT: now },
    EVENT_SEQ: 0, COUNTERS: {}, ENGINE: { SIM_AT: fork, WATERMARK_SEQ: 0, LEASE_OWNER: null, LEASE_EXPIRES_AT: null, FENCE: 0 }, PROJECTION_VERSION: 0,
    NOTIFY: Object.keys(N).length ? N : undefined, DEFAULT_FLAG: !!makeDefault, CREATED_BY: createdBy, CREATED_AT: now, UPDATED_AT: now, VERSION: 1, _origin: 'APP',
    NOTE: 'Synthetic data; not connected to any factory. Inherited history is frozen at FORK_AT; the branch future is generated in this session only.',
  };
  // the session, its first job and the audit record commit together
  await withTransaction(async (txs) => {
    if (makeDefault) await db.collection('sim_sessions').updateMany({ DEFAULT_FLAG: true }, { $set: { DEFAULT_FLAG: false } }, { session: txs });
    await db.collection('sim_sessions').insertOne(doc, { session: txs });
    await enqueueJob(db, sid, mode === 'REPLAY' ? 'REPLAY_REFRESH' : 'INIT_SESSION', {}, 1, null, txs);
    await audit(db, createdBy, 'SESSION_CREATED', sid, { mode, checkpointId: ck, forkAt: fork, sourceRunId: src }, { session: txs, after: { status: doc.STATUS, mode, forkAt: fork, makeDefault: !!makeDefault } });
  });
  return doc;
}

async function enqueueJob(db, sid, type, payload = {}, priority = 5, dedupSuffix = null, txs = null) {
  const now = new Date();
  await db.collection('jobs').updateOne({ DEDUP_KEY: `${type}:${sid}${dedupSuffix ? ':' + dedupSuffix : ''}`, DEDUP_OPEN: true },
    { $setOnInsert: { JOB_ID: `JOB-${crypto.randomBytes(8).toString('hex').toUpperCase()}`, SESSION_ID: sid, TYPE: type, STATUS: 'PENDING', PRIORITY: priority, AVAILABLE_AT: now, ATTEMPTS: 0, MAX_ATTEMPTS: 5, FENCE: 0, PAYLOAD: payload, CREATED_AT: now, UPDATED_AT: now, _origin: 'APP' } },
    txs ? { upsert: true, session: txs } : { upsert: true });
}

/** clock control: play / pause / speed / seek (seek only for replay). Re-anchors so every viewer computes the same time. */
async function setClock(sessionId, { action, speed, seekTo }, actor) {
  const db = await getDb();
  const s = await get(sessionId);
  if ((s.CLOCK || {}).REAL_TIME || (s.FACTORY_SESSION && s.OPERATING_MODE !== 'SIMULATED_TEST')) throw E.conflict('REAL_TIME_CLOCK', 'Manual Team Test runs on real time: the clock cannot be paused, sped up or rewound (switch the factory to Simulated Test for a controllable clock)');
  if (!['READY', 'RUNNING', 'PAUSED'].includes(s.STATUS)) throw E.conflict('SESSION_NOT_READY', `Session is ${s.STATUS}`);
  const nowWall = new Date();
  const current = simNow(s, nowWall);
  const c = { ...(s.CLOCK || {}) };
  let status = s.STATUS;
  if (action === 'PLAY') { c.ANCHOR_SIM_AT = current; c.ANCHOR_WALL_AT = nowWall; c.PAUSED = false; status = 'RUNNING'; }
  else if (action === 'PAUSE') { c.ANCHOR_SIM_AT = current; c.ANCHOR_WALL_AT = null; c.PAUSED = true; status = 'PAUSED'; }
  else if (action === 'SPEED') {
    const sp = Number(speed);
    if (!SIMCFG.speeds.includes(sp) || sp <= 0) throw E.bad('INVALID_SPEED', `Speed must be one of ${SIMCFG.speeds.filter(x => x > 0).join(', ')}`);
    c.ANCHOR_SIM_AT = current; c.ANCHOR_WALL_AT = c.PAUSED ? null : nowWall; c.SPEED = sp;
  } else if (action === 'SEEK') {
    if (s.MODE !== 'REPLAY') throw E.conflict('SEEK_REPLAY_ONLY', 'Seeking is only available in replay mode (interactive time only moves forward)');
    const t = new Date(seekTo);
    if (!(t >= new Date('2026-09-14T05:00:00Z') && t <= new Date(s.HORIZON_AT))) throw E.bad('INVALID_SEEK', 'Seek time outside the dataset history');
    c.ANCHOR_SIM_AT = t; c.ANCHOR_WALL_AT = c.PAUSED ? null : nowWall;
  } else throw E.bad('INVALID_ACTION', 'action must be PLAY, PAUSE, SPEED or SEEK');
  c.CONTROLLER_LOGIN_ID = actor; c.UPDATED_AT = nowWall;
  // the clock change and its sequenced event commit together, so the event log has no gaps and no unsequenced entries
  const r = await withTransaction(async (txs) => {
    const u = await db.collection('sim_sessions').findOneAndUpdate({ SESSION_ID: sessionId, VERSION: s.VERSION }, { $set: { CLOCK: c, STATUS: status, UPDATED_AT: nowWall }, $inc: { VERSION: 1, EVENT_SEQ: 1 } }, { returnDocument: 'after', session: txs });
    if (!u) throw E.conflict('CLOCK_CHANGED', 'Another viewer changed the clock at the same moment - reload and retry');
    const seq = u.EVENT_SEQ;
    await db.collection('sim_events').insertOne({ EVENT_ID: `EV-${s.SHORT_ID}-${String(seq).padStart(7, '0')}`, EVENT_SEQ: seq, SESSION_ID: sessionId, RUN_ID: s.RUN_ID, DATASET_ID: s.DATASET_ID, EVENT_TYPE: `CLOCK_${action}`, ENTITY_TYPE: 'SESSION', ENTITY_ID: sessionId,
      EVENT_TIME: current, KNOWN_AT: current, RECEIVED_AT: nowWall, ACTOR_ID: actor, ACTOR_LOGIN: actor, ACTOR_TYPE: 'HUMAN', SOURCE: 'UI', SCHEMA_VERSION: '1.0', COMMAND_TYPE: 'CLOCK', PAYLOAD: { speed: c.SPEED, paused: c.PAUSED, seekTo: seekTo || null }, _origin: 'APP' }, { session: txs });
    return u;
  });
  if (s.MODE === 'REPLAY') await enqueueJob(db, sessionId, 'REPLAY_REFRESH', {}, 2);
  return r;
}

/** reset to the checkpoint, in three steps that are each safe to repeat:
    1. one transaction marks the session RESETTING (engines stop touching it) and audits the start;
    2. the session's own documents are deleted (only SESSION_ID = this session; repeating it deletes nothing more);
    3. one transaction re-initialises the session, enqueues the fork job and audits the completion with the removed counts.
    If the API stops between steps, the session stays RESETTING and calling reset again finishes the same reset. */
async function reset(sessionId, confirmText, actor) {
  const db = await getDb();
  const s = await get(sessionId);
  if (s.MODE !== 'INTERACTIVE') throw E.conflict('INTERACTIVE_ONLY', 'Only interactive sessions can be reset');
  if (s.FACTORY_SESSION) throw E.conflict('USE_FACTORY_RESET', 'The fresh-factory session has no checkpoint; use the guarded factory reset (Administration > Factory reset), which is disabled unless ALLOW_FACTORY_RESET=true');
  if (confirmText !== `RESET ${s.SESSION_ID}`) throw E.bad('CONFIRMATION_REQUIRED', `Type "RESET ${s.SESSION_ID}" to confirm; this deletes only this session's activity`);
  if (!['READY', 'RUNNING', 'PAUSED', 'INITIALIZING', 'RESETTING'].includes(s.STATUS)) throw E.conflict('SESSION_NOT_RESETTABLE', `Session is ${s.STATUS}`);
  const generation = s.STATUS === 'RESETTING' && s.RESET_REQUEST ? s.RESET_REQUEST.GENERATION : (s.RESET_GENERATION || 0) + 1;
  if (s.STATUS !== 'RESETTING') {
    await withTransaction(async (txs) => {
      const u = await db.collection('sim_sessions').findOneAndUpdate({ SESSION_ID: sessionId, VERSION: s.VERSION },
        { $set: { STATUS: 'RESETTING', RESET_REQUEST: { AT: new Date(), BY: actor, GENERATION: generation, PREVIOUS_STATUS: s.STATUS } }, $inc: { VERSION: 1 } }, { returnDocument: 'after', session: txs });
      if (!u) throw E.conflict('SESSION_CHANGED', 'The session changed at the same moment - reload and retry');
      await audit(db, actor, 'SESSION_RESET_STARTED', sessionId, { checkpointId: s.CHECKPOINT_ID, resetGeneration: generation }, { session: txs, before: { status: s.STATUS, eventSeq: s.EVENT_SEQ }, after: { status: 'RESETTING' } });
    });
  }
  const removed = {};
  for (const c of RESET_COLLS) { const r = await db.collection(c).deleteMany({ SESSION_ID: sessionId }); if (r.deletedCount) removed[c] = r.deletedCount; }
  await db.collection('jobs').deleteMany({ SESSION_ID: sessionId, STATUS: { $in: ['PENDING', 'LEASED'] } });
  await withTransaction(async (txs) => {
    const u = await db.collection('sim_sessions').findOneAndUpdate({ SESSION_ID: sessionId, STATUS: 'RESETTING' }, { $set: { STATUS: 'INITIALIZING', EVENT_SEQ: 0, COUNTERS: {}, 'ENGINE.SIM_AT': s.FORK_AT, 'ENGINE.WATERMARK_SEQ': 0, PROJECTION_VERSION: 0,
      CLOCK: { ANCHOR_SIM_AT: s.FORK_AT, ANCHOR_WALL_AT: null, SPEED: (s.CLOCK || {}).SPEED || 1, PAUSED: true, CONTROLLER_LOGIN_ID: actor, UPDATED_AT: new Date() }, RESET_AT: new Date(), RESET_BY: actor, RESET_GENERATION: generation },
      $unset: { INIT: '', AGENT_SETTINGS: '', LAST_EVENT_SIM_AT: '', RESET_REQUEST: '', 'ENGINE.NEXT_BOUNDARY_SIM_AT': '', 'ENGINE.NEXT_BOUNDARIES': '', 'ENGINE.LAST_CALC_SIM_AT': '' }, $inc: { VERSION: 1 } }, { returnDocument: 'after', session: txs });
    if (!u) throw E.conflict('SESSION_CHANGED', 'The session is no longer being reset');
    await enqueueJob(db, sessionId, 'INIT_SESSION', {}, 1, null, txs);
    await audit(db, actor, 'SESSION_RESET_TO_CHECKPOINT', sessionId, { checkpointId: s.CHECKPOINT_ID, removedDocuments: removed, resetGeneration: generation }, { session: txs, after: { status: 'INITIALIZING', resetGeneration: generation } });
  });
  return get(sessionId);
}

async function archive(sessionId, actor) {
  const db = await getDb();
  if (sessionId === 'S-FACTORY') throw E.conflict('PERMANENT_SESSION', 'The fresh-factory session is permanent and cannot be archived');
  await withTransaction(async (txs) => {
    const s = await db.collection('sim_sessions').findOne({ SESSION_ID: sessionId }, { session: txs });
    if (!s) throw E.notFound('Simulation session');
    await db.collection('sim_sessions').updateOne({ SESSION_ID: sessionId }, { $set: { STATUS: 'ARCHIVED', DEFAULT_FLAG: false, ARCHIVED_AT: new Date(), ARCHIVED_BY: actor } }, { session: txs });
    await audit(db, actor, 'SESSION_ARCHIVED', sessionId, {}, { session: txs, before: { status: s.STATUS, defaultFlag: !!s.DEFAULT_FLAG }, after: { status: 'ARCHIVED', defaultFlag: false } });
  });
}

/** kept for existing callers; the implementation (redaction, before/after, transaction session) is services/audit.js */
function audit(db, actor, action, target, details, opts) { return require('./audit').audit(db, actor, action, target, details, opts); }

module.exports = { list, get, getDefault, create, setClock, reset, archive, publicSession, enqueueJob, audit, RESET_COLLS };
