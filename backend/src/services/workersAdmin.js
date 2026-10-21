'use strict';
/* Admin-only worker administration. New workers start with zero activity/points and no fabricated attendance;
   activation never clocks anyone in; deactivation blocks future access but keeps historical attribution.
   Every action is ONE transaction: the worker/account/qualification/roster/session-roster writes, the sign-in revocations and the
   audit record (before/after, secrets redacted) commit together or not at all (services/audit.adminTx). With an Idempotency-Key a
   retry returns the first result instead of creating a second worker. */
const { getDb } = require('../lib/db');
const { config } = require('../config/env');
const { hashPin } = require('../lib/pin');
const { localToUtc, localIso } = require('../lib/time');
const E = require('../lib/errors');
const PERMS = require('../../contracts/permissions.json');
const C = require('../domain/catalog');
const A = require('./audit');

const ROLES = Object.keys(PERMS.worker_role_map);

function validate(b, cat, shiftCodes) {
  const err = [];
  if (!b.firstName || !b.lastName) err.push('firstName and lastName are required');
  if (!ROLES.includes(b.workerRole)) err.push(`workerRole must be one of ${ROLES.join(', ')}`);
  if (!cat.wcs[b.homeWorkCenterId]) err.push('homeWorkCenterId is not a known work centre');
  else if (cat.wcs[b.homeWorkCenterId].ACTIVE_FLAG === 'N') err.push(`work centre ${b.homeWorkCenterId} is inactive`);
  if (!shiftCodes.includes(b.shiftCode)) err.push(shiftCodes.length ? `shiftCode must be one of ${shiftCodes.join(', ')}` : 'No shift is configured yet - add a shift (Setup > Shifts) before creating workers');
  if (b.startOption !== undefined && !['JOIN_CURRENT_SHIFT', 'NEXT_SHIFT', 'FUTURE_START'].includes(b.startOption)) err.push('startOption must be JOIN_CURRENT_SHIFT, NEXT_SHIFT or FUTURE_START');
  if (b.startOption === 'FUTURE_START' && !/^\d{4}-\d{2}-\d{2}$/.test(b.startDate || '')) err.push('FUTURE_START needs startDate (YYYY-MM-DD, plant local)');
  if (b.simulatedWorker && !(config().isFresh)) err.push('simulatedWorker is only used in the fresh factory');
  if (typeof b.initialPin !== 'string' || !/^\d{6,8}$/.test(b.initialPin)) err.push('initialPin must be 6-8 digits, given as text (leading zeros are kept)');
  if (b.loginId && !/^[A-Za-z0-9._-]{3,32}$/.test(b.loginId)) err.push('loginId: 3-32 letters, digits, . _ -');
  for (const q of b.qualifications || []) {
    if (!cat.skills[q.skillId]) err.push(`unknown skill ${q.skillId}`);
    if (q.validFrom && q.validTo && new Date(q.validTo) < new Date(q.validFrom)) err.push(`qualification ${q.skillId}: validTo before validFrom`);
  }
  if (err.length) throw E.bad('INVALID_WORKER', err.join('; '), { errors: err });
}

async function nextWorkerId(db, session) {
  const o = session ? { session } : {};
  const r = await db.collection('counters').findOneAndUpdate({ _id: 'WORKER_ID' }, { $inc: { n: 1 } }, { upsert: true, returnDocument: 'after', ...o });
  let n = r.n;
  const max = await db.collection('worker_master').find({}, { projection: { WORKER_ID: 1 }, ...o }).sort({ WORKER_ID: -1 }).limit(1).toArray();
  const maxN = max.length ? Number(String(max[0].WORKER_ID).replace(/\D/g, '')) : 0;
  if (n <= maxN) { await db.collection('counters').updateOne({ _id: 'WORKER_ID' }, { $set: { n: maxN + 1 } }, o); n = maxN + 1; }
  return 'W' + String(n).padStart(4, '0');
}

/** roster rows for a new worker: the shift code's dated shifts from the effective start date (no attendance is fabricated) */
function rosterRows(cat, workerId, shiftCode, startDate, homeWc, role) {
  const rows = [];
  for (const s of Object.values(cat.shifts)) {
    if (s.SHIFT_CODE !== shiftCode || !s.SHIFT_DATE) continue;
    const d = new Date(s.SHIFT_DATE).toISOString().slice(0, 10);
    if (d < startDate) continue;
    const start = localToUtc(d, s.START_AT_LOCAL);
    let end = localToUtc(d, s.END_AT_LOCAL); if (end <= start) end = new Date(end.getTime() + 86400000);
    rows.push({ ROSTER_ID: `ROS-APP-${workerId}-${s.SHIFT_ID}`, WORKER_ID: workerId, SHIFT_ID: s.SHIFT_ID, SHIFT_DATE: s.SHIFT_DATE, PLANNED_WORK_CENTER_ID: homeWc, PLANNED_ROLE: role,
      PLANNED_START_AT: start, PLANNED_END_AT: end, ROSTER_STATUS: s.DAY_TYPE === 'OFF' ? 'OFF' : 'SCHEDULED', ORIGIN: 'APP_ADMIN', _origin: 'APP', dataset_id: config().datasetId });
  }
  return rows;
}

async function createWorker(b, actor, meta = {}) {
  const db = await getDb();
  const c = config();
  const cat = await C.catalog(true);
  // shift crews: the configured shift templates of a fresh factory, the A/B crews of the synthetic demo
  let shiftCodes = ['A', 'B'];
  let fst = null;
  if (c.isFresh) {
    const F = require('./factory');
    fst = await F.settings(db);
    shiftCodes = (await db.collection('shift_templates').find({ dataset_id: c.datasetId, ACTIVE_FLAG: { $ne: 'N' } }, { projection: { SHIFT_CODE: 1 } }).toArray()).map(t => t.SHIFT_CODE);
    await F.ensureCalendar(db, actor);
  }
  validate(b, cat, shiftCodes);
  if (b.simulatedWorker && (!fst || fst.OPERATING_MODE !== 'SIMULATED_TEST')) throw E.bad('INVALID_WORKER', 'Simulated workers can only be created when the factory runs in Simulated Test mode');
  const display = (b.displayName || `${b.firstName} ${b.lastName}`).trim();
  const appRole = PERMS.worker_role_map[b.workerRole];
  const now = new Date();
  const { simNow } = require('../lib/time');
  // default start: the plant-local date of the default simulation session (the demo runs on simulated dates, not today's date)
  const dsess = await db.collection('sim_sessions').findOne({ DEFAULT_FLAG: true, STATUS: { $in: ['READY', 'RUNNING', 'PAUSED'] } });
  const startDate = b.startDate || (dsess ? localIso(simNow(dsess), dsess.PLANT_TIMEZONE || 'America/Bogota').slice(0, 10) : now.toISOString().slice(0, 10));
  if (b.startOption === 'FUTURE_START' && startDate <= localIso(dsess ? simNow(dsess) : now, (dsess && dsess.PLANT_TIMEZONE) || undefined).slice(0, 10)) throw E.bad('INVALID_WORKER', 'FUTURE_START needs a startDate after today');
  const pinHash = await hashPin(b.initialPin);          // hashed before the transaction (CPU work); only the hash is stored
  const startOption = b.startOption || 'JOIN_CURRENT_SHIFT';
  const refNow = dsess ? simNow(dsess) : now;
  const request = { ...b, initialPin: undefined };
  const result = await A.adminTx({ actor, action: 'WORKER_CREATED', idempotencyKey: meta.idempotencyKey, request, requestId: meta.requestId }, async (s) => {
    if (b.employeeNumber && await db.collection('worker_master').findOne({ dataset_id: c.datasetId, EMPLOYEE_NUMBER: String(b.employeeNumber) }, { session: s })) throw E.conflict('DUPLICATE_EMPLOYEE_NUMBER', `Employee number ${b.employeeNumber} is already used`);
    const dup = await db.collection('worker_master').findOne({ dataset_id: c.datasetId, DISPLAY_NAME: display }, { session: s });
    if (dup && !b.allowDuplicateName) throw E.conflict('DUPLICATE_NAME', `${display} already exists (${dup.WORKER_ID}); use a distinct display name for readability or confirm allowDuplicateName`);
    const workerId = await nextWorkerId(db, s);
    const loginId = b.loginId || workerId;
    if (await db.collection('accounts').findOne({ dataset_id: c.datasetId, login_id: loginId }, { session: s })) throw E.conflict('LOGIN_TAKEN', `Login ID ${loginId} is already used`);
    let roster = rosterRows(cat, workerId, b.shiftCode, startDate, b.homeWorkCenterId, b.workerRole);
    // first shift: join the crew's shift that is running now in the default session, or start with the next one
    if (startOption === 'NEXT_SHIFT') roster = roster.filter(r => r.PLANNED_START_AT > refNow);
    if (startOption === 'FUTURE_START') roster = roster.filter(r => r.PLANNED_START_AT > refNow);
    const first = roster.filter(r => r.ROSTER_STATUS === 'SCHEDULED' && r.PLANNED_END_AT > refNow).sort((a, x) => a.PLANNED_START_AT - x.PLANNED_START_AT)[0] || null;
    const joinsCurrent = !!(first && first.PLANNED_START_AT <= refNow);
    const base = { dataset_id: c.datasetId, _origin: 'APP', CREATED_AT: now, CREATED_BY: actor };
    const worker = { ...base, WORKER_ID: workerId, EMPLOYEE_NUMBER: b.employeeNumber || workerId, FIRST_NAME: b.firstName, LAST_NAME: b.lastName, DISPLAY_NAME: display,
      WORKER_ROLE: b.workerRole, HOME_WORK_CENTER_ID: b.homeWorkCenterId, HOME_AREA_ID: (cat.wcs[b.homeWorkCenterId] || {}).AREA_ID || null, SUPERVISED_WORK_CENTERS: b.supervisedWorkCenters || null,
      SHIFT_CREW: b.shiftCode, EMPLOYMENT_STATUS: b.employmentStatus || 'ACTIVE', EMPLOYMENT_TYPE: b.employmentType || 'FULL_TIME', HIRE_DATE: new Date(startDate), ACTIVE_FLAG: 'Y', SITE_ID: b.siteId || (fst && fst.SITE_ID) || 'SITE-DEMO-01',
      TEAM: b.team || null, SUPERVISOR_ID: b.supervisorId || null, AUTHORIZED_AREAS: b.authorizedAreas || [], PREFERRED_LANGUAGE: b.preferredLanguage || 'en', TIMEZONE: b.timezone || (fst && fst.TIMEZONE) || 'America/Bogota', SIMULATED_WORKER: !!b.simulatedWorker,
      BADGE_ID: b.badgeId || null, CONTACT_EMAIL: b.contactEmail || null, NAME_CONVENTION: 'ADMIN_ENTERED', ORIGIN: 'APP_ADMIN' };
    await db.collection('worker_master').insertOne(worker, { session: s });
    await db.collection('app_users').insertOne({ ...base, USER_ID: `U-${workerId}`, WORKER_ID: workerId, DISPLAY_NAME: display, ROLE: appRole, EMAIL: b.contactEmail || null, NOTIFICATION_OPT_IN: 'N', ACTIVE_FLAG: 'Y', ORIGIN: 'APP_ADMIN' }, { session: s });
    for (const q of b.qualifications || []) {
      await db.collection('worker_qualifications').insertOne({ ...base, WORKER_ID: workerId, SKILL_ID: q.skillId, QUALIFICATION_LEVEL: q.level || 'QUALIFIED', QUALIFICATION_STATUS: 'VALID',
        VALID_FROM: q.validFrom ? (/^\d{4}-\d{2}-\d{2}$/.test(q.validFrom) ? localToUtc(q.validFrom, '00:00', (dsess && dsess.PLANT_TIMEZONE) || undefined) : new Date(q.validFrom)) : localToUtc(startDate, '00:00', (dsess && dsess.PLANT_TIMEZONE) || undefined), VALID_TO: q.validTo ? new Date(q.validTo) : null, CAN_WORK_INDEPENDENTLY: q.independent === false ? 'N' : 'Y',
        SUPERVISION_REQUIRED: q.independent === false ? 'Y' : 'N', QUALIFICATION_SOURCE: 'ADMIN_ENTERED', ORIGIN: 'APP_ADMIN' }, { session: s });
    }
    if (roster.length) await db.collection('app_shift_roster').insertMany(roster, { session: s });
    const account = { dataset_id: c.datasetId, login_id: loginId, worker_id: workerId, roles: [appRole], permissions: PERMS.roles[appRole], status: 'ACTIVE', pin_hash: pinHash,
      pin_must_change: !!b.pinMustChange, created_at: now, created_by: actor, _origin: 'SETUP_ADMIN' };
    await db.collection('accounts').insertOne(account, { session: s });
    const sessions = await addToSessions(db, workerId, display, b, roster, s);
    return {
      target: workerId,
      after: { worker, account, qualifications: (b.qualifications || []).map(q => q.skillId), rosterRows: roster.length, liveSessions: sessions },
      details: { loginId, role: b.workerRole, homeWorkCenterId: b.homeWorkCenterId, shiftCode: b.shiftCode, startOption, qualifications: (b.qualifications || []).map(q => q.skillId) },
      result: { workerId, loginId, displayName: display, appRole, rosterRows: roster.length, startOption, firstShift: first ? { shiftId: first.SHIFT_ID, plannedStartAt: first.PLANNED_START_AT, plannedEndAt: first.PLANNED_END_AT, joinsCurrent } : null,
        note: `New worker has zero activity and points; they must clock in to start work.${startOption === 'JOIN_CURRENT_SHIFT' && !joinsCurrent ? ' No shift of this crew is running now - the first shift is the next one.' : ''}` },
    };
  });
  C.invalidate();
  return result;
}

/** make the new person visible in every live session, with no fabricated attendance */
async function addToSessions(db, workerId, display, b, roster, txs) {
  const sessions = await db.collection('sim_sessions').find({ STATUS: { $in: ['READY', 'RUNNING', 'PAUSED'] } }, { session: txs }).toArray();
  const { simNow } = require('../lib/time');
  for (const s of sessions) {
    const now = simNow(s);
    const cur = roster.find(r => r.PLANNED_START_AT <= now && r.PLANNED_END_AT > now && r.ROSTER_STATUS === 'SCHEDULED');
    const next = roster.filter(r => r.PLANNED_START_AT > now && r.ROSTER_STATUS === 'SCHEDULED').sort((a, b2) => a.PLANNED_START_AT - b2.PLANNED_START_AT)[0];
    await db.collection('sim_workers').updateOne({ SESSION_ID: s.SESSION_ID, WORKER_ID: workerId }, { $setOnInsert: {
      SESSION_ID: s.SESSION_ID, RUN_ID: s.RUN_ID, DATASET_ID: s.DATASET_ID, WORKER_ID: workerId, DISPLAY_NAME: display, WORKER_ROLE: b.workerRole, HOME_WORK_CENTER_ID: b.homeWorkCenterId,
      SHIFT_ID: cur ? cur.SHIFT_ID : null, ROSTER_STATUS: cur ? 'SCHEDULED' : 'NOT_ROSTERED', PLANNED_WORK_CENTER_ID: cur ? b.homeWorkCenterId : null, PLANNED_START_AT: cur ? cur.PLANNED_START_AT : null, PLANNED_END_AT: cur ? cur.PLANNED_END_AT : null,
      NEXT_SHIFT_ID: next ? next.SHIFT_ID : null, NEXT_PLANNED_START_AT: next ? next.PLANNED_START_AT : null, NEXT_PLANNED_END_AT: next ? next.PLANNED_END_AT : null, NEXT_PLANNED_WORK_CENTER_ID: next ? b.homeWorkCenterId : null,
      ATTENDANCE_STATE: cur ? 'NOT_CLOCKED_IN' : 'OFF_SHIFT', ACTIVITY_STATE: cur ? 'NOT_STARTED' : 'OFF_SHIFT', REASON_CODE: null, CURRENT_TASK_ID: null, CURRENT_WORKSTATION_ID: null, CURRENT_WORK_CENTER_ID: null,
      FIRST_CLOCK_IN_AT: null, STATE_SINCE: now, ACTIVE_TASK_COUNT: 0, SIMULATED_WORKER: !!b.simulatedWorker,
      CONTROL: b.simulatedWorker ? { MODE: 'AGENT', NOTE: 'Designated simulated worker (Simulated Test mode only)' } : { MODE: 'HUMAN_ONLY', NOTE: 'Admin-created people are not driven by background agents' }, ORIGIN: 'APP_ADMIN', VERSION: 1, UPDATED_AT: new Date(), _origin: 'APP' } }, { upsert: true, session: txs });
  }
  if (sessions.length) await db.collection('sim_sessions').updateMany({ SESSION_ID: { $in: sessions.map(x => x.SESSION_ID) } }, { $inc: { ROSTER_VERSION: 1 } }, { session: txs });
  // forecasts and capacity depend on the people available: recalculate the live sessions (one deduplicated job each)
  for (const x of sessions) if (x.MODE === 'INTERACTIVE') await require('./sessions').enqueueJob(db, x.SESSION_ID, 'RECALC', { reason: 'WORKER_CREATED' }, 3, null, txs);
  return sessions.map(x => x.SESSION_ID);
}

async function updateWorker(workerId, b, actor, meta = {}) {
  const c = config();
  if (b.workerRole && !ROLES.includes(b.workerRole)) throw E.bad('INVALID_ROLE', 'Unknown role');
  const cat = await C.catalog();
  if (b.homeWorkCenterId !== undefined && (!cat.wcs[b.homeWorkCenterId] || cat.wcs[b.homeWorkCenterId].ACTIVE_FLAG === 'N')) throw E.bad('INVALID_WORKER', 'Choose an active home work centre');
  if (b.displayName !== undefined && !String(b.displayName).trim()) throw E.bad('INVALID_WORKER', 'Display name cannot be empty');
  for (const q of b.addQualifications || []) if (!cat.skills[q.skillId]) throw E.bad('INVALID_WORKER', `unknown skill ${q.skillId}`);
  const res = await A.adminTx({ actor, action: 'WORKER_UPDATED', target: workerId, idempotencyKey: meta.idempotencyKey, request: { workerId, ...b }, requestId: meta.requestId }, async (s, db) => {
    const w = await db.collection('worker_master').findOne({ dataset_id: c.datasetId, WORKER_ID: workerId }, { session: s });
    if (!w) throw E.notFound('Worker');
    const set = {};
    for (const [k, f] of Object.entries({ displayName: 'DISPLAY_NAME', homeWorkCenterId: 'HOME_WORK_CENTER_ID', team: 'TEAM', supervisorId: 'SUPERVISOR_ID', preferredLanguage: 'PREFERRED_LANGUAGE', employmentStatus: 'EMPLOYMENT_STATUS', badgeId: 'BADGE_ID', authorizedAreas: 'AUTHORIZED_AREAS' })) if (b[k] !== undefined) set[f] = b[k];
    if (b.workerRole) set.WORKER_ROLE = b.workerRole;
    const before = { worker: Object.fromEntries(Object.keys(set).map(k => [k, w[k] === undefined ? null : w[k]])) };
    const after = { worker: { ...set } };
    set._app = { modified_at: new Date(), modified_by: actor };
    await db.collection('worker_master').updateOne({ _id: w._id }, { $set: set }, { session: s });
    if (b.workerRole) {
      const role = PERMS.worker_role_map[b.workerRole];
      const acct = await db.collection('accounts').findOne({ dataset_id: c.datasetId, worker_id: workerId }, { session: s, projection: { roles: 1, permissions: 1 } });
      before.account = acct ? { roles: acct.roles, permissions: acct.permissions } : null;
      after.account = { roles: [role], permissions: PERMS.roles[role] };
      await db.collection('accounts').updateOne({ dataset_id: c.datasetId, worker_id: workerId }, { $set: { roles: [role], permissions: PERMS.roles[role], _app: { modified_at: new Date(), modified_by: actor } } }, { session: s });
      // a role change takes effect now: open sign-ins carry the old permissions, so they are ended
      const accts = await db.collection('accounts').find({ dataset_id: c.datasetId, worker_id: workerId }, { session: s }).toArray();
      const rv = await db.collection('auth_sessions').updateMany({ LOGIN_ID: { $in: accts.map(a => a.login_id) }, REVOKED_AT: null }, { $set: { REVOKED_AT: new Date(), REVOKE_REASON: 'ROLE_CHANGED' } }, { session: s });
      after.revokedSignIns = rv.modifiedCount;
    }
    if (b.shiftCode && b.shiftCode !== w.SHIFT_CREW) {
      const codes = c.isFresh ? (await db.collection('shift_templates').find({ dataset_id: c.datasetId, ACTIVE_FLAG: { $ne: 'N' } }, { session: s, projection: { SHIFT_CODE: 1 } }).toArray()).map(t => t.SHIFT_CODE) : ['A', 'B'];
      if (!codes.includes(b.shiftCode)) throw E.bad('INVALID_WORKER', `shiftCode must be one of ${codes.join(', ')}`);
      // future planned shifts move to the new crew; past roster rows (and any attendance) are history and stay
      await db.collection('worker_master').updateOne({ _id: w._id }, { $set: { SHIFT_CREW: b.shiftCode } }, { session: s });
      const del = await db.collection('app_shift_roster').deleteMany({ WORKER_ID: workerId, PLANNED_START_AT: { $gt: new Date() } }, { session: s });
      const today = new Date().toISOString().slice(0, 10);
      const rows = rosterRows(cat, workerId, b.shiftCode, today, b.homeWorkCenterId || w.HOME_WORK_CENTER_ID, b.workerRole || w.WORKER_ROLE).filter(r => r.PLANNED_START_AT > new Date());
      if (rows.length) await db.collection('app_shift_roster').insertMany(rows, { session: s });
      before.shiftCode = w.SHIFT_CREW; after.shiftCode = b.shiftCode; after.rosterRowsReplaced = { removed: del.deletedCount, added: rows.length };
    }
    const revoked = [];
    for (const skillId of b.revokeQualifications || []) {
      const r = await db.collection('worker_qualifications').updateMany({ dataset_id: c.datasetId, WORKER_ID: workerId, SKILL_ID: skillId, QUALIFICATION_STATUS: { $in: ['VALID', null] } },
        { $set: { QUALIFICATION_STATUS: 'REVOKED', VALID_TO: new Date(), REVOKED_BY: actor, REVOKED_AT: new Date() } }, { session: s });
      if (r.modifiedCount) revoked.push(skillId);
    }
    after.revokedQualifications = revoked;
    const added = [];
    for (const q of b.addQualifications || []) {
      const doc = { dataset_id: c.datasetId, _origin: 'APP', WORKER_ID: workerId, SKILL_ID: q.skillId, QUALIFICATION_LEVEL: q.level || 'QUALIFIED', QUALIFICATION_STATUS: 'VALID',
        VALID_FROM: q.validFrom ? new Date(q.validFrom) : new Date(), VALID_TO: q.validTo ? new Date(q.validTo) : null, CAN_WORK_INDEPENDENTLY: q.independent === false ? 'N' : 'Y', SUPERVISION_REQUIRED: q.independent === false ? 'Y' : 'N', QUALIFICATION_SOURCE: 'ADMIN_ENTERED', CREATED_BY: actor, CREATED_AT: new Date() };
      await db.collection('worker_qualifications').insertOne(doc, { session: s });
      added.push(q.skillId);
    }
    after.addedQualifications = added;
    const live = {};
    for (const field of ['DISPLAY_NAME', 'HOME_WORK_CENTER_ID', 'WORKER_ROLE']) if (set[field] !== undefined) live[field] = set[field];
    if (Object.keys(live).length) await db.collection('sim_workers').updateMany({ DATASET_ID: c.datasetId, WORKER_ID: workerId }, { $set: live, $inc: { VERSION: 1 } }, { session: s });
    return { before, after, details: { fields: Object.keys(set).filter(k => k !== '_app'), addQualifications: added }, result: { ok: true } };
  });
  C.invalidate();
  return res;
}

async function setActive(workerId, active, actor, meta = {}) {
  const c = config();
  const res = await A.adminTx({ actor, action: active ? 'WORKER_ACTIVATED' : 'WORKER_DEACTIVATED', target: workerId, idempotencyKey: meta.idempotencyKey, request: { workerId, active }, requestId: meta.requestId }, async (s, db) => {
    const w = await db.collection('worker_master').findOne({ dataset_id: c.datasetId, WORKER_ID: workerId }, { session: s });
    if (!w) throw E.notFound('Worker');
    if (!active && await db.collection('sim_workers').findOne({ DATASET_ID: c.datasetId, WORKER_ID: workerId, ATTENDANCE_STATE: 'CLOCKED_IN' }, { session: s })) throw E.conflict('WORKER_ON_SHIFT', 'Hand over or finish active work and clock the worker out before deactivation');
    const accts = await db.collection('accounts').find({ dataset_id: c.datasetId, worker_id: workerId }, { session: s }).toArray();
    await db.collection('worker_master').updateOne({ _id: w._id }, { $set: { ACTIVE_FLAG: active ? 'Y' : 'N', EMPLOYMENT_STATUS: active ? 'ACTIVE' : 'INACTIVE', _app: { modified_at: new Date(), modified_by: actor } } }, { session: s });
    await db.collection('accounts').updateMany({ dataset_id: c.datasetId, worker_id: workerId }, { $set: { status: active ? 'ACTIVE' : 'INACTIVE', _app: { modified_at: new Date(), modified_by: actor } } }, { session: s });
    let revoked = 0;
    if (!active) {
      const r = await db.collection('auth_sessions').updateMany({ LOGIN_ID: { $in: accts.map(a => a.login_id) }, REVOKED_AT: null }, { $set: { REVOKED_AT: new Date(), REVOKE_REASON: 'DEACTIVATED' } }, { session: s });
      revoked = r.modifiedCount;
    }
    // history (tasks, labour, points, inspections, attribution) is never touched: deactivation only blocks future access
    return { before: { activeFlag: w.ACTIVE_FLAG, employmentStatus: w.EMPLOYMENT_STATUS, accounts: accts.map(a => ({ loginId: a.login_id, status: a.status })) },
      after: { activeFlag: active ? 'Y' : 'N', employmentStatus: active ? 'ACTIVE' : 'INACTIVE', accounts: accts.map(a => ({ loginId: a.login_id, status: active ? 'ACTIVE' : 'INACTIVE' })), revokedSignIns: revoked },
      details: { revokedSignIns: revoked },
      result: { ok: true, revokedSignIns: revoked, note: active ? 'Activation does not clock the person in.' : 'History and attribution are kept; future sign-in is blocked.' } };
  });
  C.invalidate();
  return res;
}

async function resetPin(workerId, pin, actor, meta = {}) {
  if (typeof pin !== 'string' || !/^\d{6,8}$/.test(pin)) throw E.bad('INVALID_PIN', 'PIN must be 6-8 digits, given as text');
  const c = config();
  const pinHash = await hashPin(pin);
  // the PIN itself is never part of the stored request fingerprint, the audit record or the stored result
  return A.adminTx({ actor, action: 'PIN_RESET', target: workerId, idempotencyKey: meta.idempotencyKey, request: { workerId, pinReset: true }, requestId: meta.requestId }, async (s, db) => {
    const r = await db.collection('accounts').updateOne({ dataset_id: c.datasetId, worker_id: workerId }, { $set: { pin_hash: pinHash, pin_must_change: true, _app: { modified_at: new Date(), modified_by: actor } } }, { session: s });
    if (!r.matchedCount) throw E.notFound('Account');
    const accts = await db.collection('accounts').find({ dataset_id: c.datasetId, worker_id: workerId }, { session: s }).toArray();
    await db.collection('auth_sessions').updateMany({ LOGIN_ID: { $in: accts.map(a => a.login_id) }, REVOKED_AT: null }, { $set: { REVOKED_AT: new Date(), REVOKE_REASON: 'PIN_RESET' } }, { session: s });
    return { before: { pin_hash: 'previous' }, after: { pin_hash: 'new', pin_must_change: true }, details: {}, result: { ok: true } };
  });
}

async function list(q) {
  const db = await getDb();
  const c = config();
  const f = { dataset_id: c.datasetId };
  if (q.role) f.WORKER_ROLE = q.role;
  if (q.workCenterId) f.HOME_WORK_CENTER_ID = q.workCenterId;
  let rows = await db.collection('worker_master').find(f, { projection: { _seed: 0, _id: 0 } }).sort({ WORKER_ID: 1 }).toArray();
  if (q.q) { const s = String(q.q).toLowerCase(); rows = rows.filter(w => (w.DISPLAY_NAME || '').toLowerCase().includes(s) || w.WORKER_ID.toLowerCase().includes(s)); }
  const accts = await db.collection('accounts').find({ dataset_id: c.datasetId }, { projection: { pin_hash: 0 } }).toArray();
  const aBy = Object.fromEntries(accts.filter(a => a.worker_id).map(a => [a.worker_id, a]));
  const quals = await db.collection('worker_qualifications').find({ dataset_id: c.datasetId }, { projection: { WORKER_ID: 1, SKILL_ID: 1, VALID_TO: 1, QUALIFICATION_LEVEL: 1 } }).toArray();
  const qBy = {};
  for (const x of quals) (qBy[x.WORKER_ID] = qBy[x.WORKER_ID] || []).push(x);
  const counts = {};
  for (const w of rows) counts[w.WORKER_ROLE] = (counts[w.WORKER_ROLE] || 0) + 1;
  return { total: rows.length, roleCounts: counts, workers: rows.map(w => ({ workerId: w.WORKER_ID, name: w.DISPLAY_NAME, role: w.WORKER_ROLE, homeWorkCenterId: w.HOME_WORK_CENTER_ID, shiftCrew: w.SHIFT_CREW, active: w.ACTIVE_FLAG === 'Y',
    employmentStatus: w.EMPLOYMENT_STATUS, origin: w._origin === 'APP' ? 'ADMIN_CREATED' : 'SEEDED', loginId: (aBy[w.WORKER_ID] || {}).login_id || null, accountStatus: (aBy[w.WORKER_ID] || {}).status || 'NO_ACCOUNT',
    appRoles: (aBy[w.WORKER_ID] || {}).roles || [], qualifications: (qBy[w.WORKER_ID] || []).map(x => ({ skillId: x.SKILL_ID, level: x.QUALIFICATION_LEVEL, validTo: x.VALID_TO })) })) };
}


async function deleteWorker(workerId, body, actor, meta = {}) {
  const c = config();
  if (!c.isFresh) throw E.conflict('FRESH_ONLY', 'Seeded history cannot be deleted individually');
  if (body.confirmWorkerId !== workerId) throw E.bad('CONFIRMATION_REQUIRED', 'Type the worker ID to confirm deletion');
  const out = await A.adminTx({ actor, action: 'UNUSED_WORKER_DELETED', target: workerId, request: { workerId, ...body }, ...meta }, async (s, db) => {
    const w = await db.collection('worker_master').findOne({ dataset_id: c.datasetId, WORKER_ID: workerId }, { session: s });
    if (!w) throw E.notFound('Worker');
    const refs = ['sim_tasks', 'sim_participation', 'sim_attendance', 'sim_points_ledger', 'sim_transfers', 'sim_support_requests'];
    for (const name of refs) if (await db.collection(name).findOne({ WORKER_ID: workerId }, { session: s })) throw E.conflict('WORKER_HAS_HISTORY', 'This worker has operational history. Deactivate them, or use the guarded full test-factory reset.');
    if (await db.collection('sim_inspections').findOne({ INSPECTOR_ID: workerId }, { session: s }) || await db.collection('sim_units').findOne({ ASSIGNED_INSPECTOR_ID: workerId }, { session: s }) || await db.collection('sim_events').findOne({ ACTOR_ID: workerId }, { session: s })) throw E.conflict('WORKER_HAS_HISTORY', 'Worker is referenced by operational records; deactivate instead');
    if (await db.collection('sim_investigations').findOne({ $or: [{ 'RESPONSIBLE.WORKER_ID': workerId }, { 'RESPONSIBLE.workerId': workerId }, { REVIEWER_ID: workerId }] }, { session: s }) || await db.collection('worker_master').findOne({ dataset_id: c.datasetId, SUPERVISOR_ID: workerId }, { session: s })) throw E.conflict('WORKER_REFERENCED', 'Worker is referenced by an investigation or a team; deactivate or reassign first');
    const accounts = await db.collection('accounts').find({ dataset_id: c.datasetId, worker_id: workerId }, { session: s }).toArray();
    if (accounts.some(a => (a.roles || []).includes('ADMIN'))) throw E.forbidden('Administrator accounts cannot be deleted here');
    await db.collection('auth_sessions').deleteMany({ LOGIN_ID: { $in: accounts.map(a => a.login_id) } }, { session: s });
    await db.collection('accounts').deleteMany({ dataset_id: c.datasetId, worker_id: workerId }, { session: s });
    for (const name of ['worker_master', 'worker_qualifications', 'app_users', 'app_shift_roster']) await db.collection(name).deleteMany({ dataset_id: c.datasetId, WORKER_ID: workerId }, { session: s });
    await db.collection('sim_workers').deleteMany({ DATASET_ID: c.datasetId, WORKER_ID: workerId }, { session: s });
    return { before: { workerId, name: w.DISPLAY_NAME }, after: null, result: { ok: true, deleted: true, workerId } };
  });
  C.invalidate();
  return out;
}

module.exports = { deleteWorker, createWorker, updateWorker, setActive, resetPin, list, rosterRows, ROLES, nextWorkerId };
