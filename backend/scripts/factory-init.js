#!/usr/bin/env node
'use strict';
/*
 * EXPLICIT bootstrap of a fresh, EMPTY factory database (never run at start-up, never run automatically).
 *
 *   npm run factory:init                       (uses backend/.env: GINI_ENVIRONMENT=FRESH_FACTORY, MONGODB_URI, MONGODB_DB_NAME)
 *   options: --factory-name "Plant 1" --site-id PLANT-01 --timezone Europe/Berlin --mode MANUAL_TEAM_TEST|SIMULATED_TEST --serial-prefix TT
 *
 * What it does (idempotent - running it again changes nothing that exists):
 *   1. refuses unless GINI_ENVIRONMENT=FRESH_FACTORY, and refuses a database that holds the synthetic demonstration (run_catalog /
 *      unit_master / checkpoints / demo sessions) so the existing demo database can never be modified by mistake;
 *   2. creates the indexes (application + fresh-factory uniqueness);
 *   3. creates the bootstrap ADMIN account only if it does not exist: login from ADMIN_LOGIN, password from ADMIN_PASSWORD or typed
 *      at the prompt (>= 15 characters, stored only as a scrypt hash, never printed). An existing admin is NEVER reset;
 *   4. saves the factory settings when given on the command line and none exist yet (otherwise set them in Admin > Setup);
 *   5. creates the permanent operational session S-FACTORY (no checkpoint, no history, real-time clock) if it does not exist.
 * It never imports workbooks, never seeds workers, orders or history, and never deletes anything.
 */
const readline = require('readline');
const { config } = require('../src/config/env');

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };

function askHidden(q) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.stdoutMuted = true;
    rl._writeToOutput = function (s) { if (!rl.stdoutMuted || s.includes(q)) rl.output.write(s); else rl.output.write('*'); };
    rl.question(q, a => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

(async () => {
  const c = config();
  if (!c.isFresh) { console.error('Refused: GINI_ENVIRONMENT is not FRESH_FACTORY in backend/.env. The fresh factory is initialised only in its own environment.'); process.exit(2); }
  if (!c.mongoUri) { console.error('Refused: MONGODB_URI is not set.'); process.exit(2); }
  const { getDb } = require('../src/lib/db');
  const db = await getDb();
  console.log(`Target database: "${c.mongoDb}"   dataset: ${c.datasetId}   environment: ${c.environmentName}`);
  // 1. never touch a database that holds the synthetic demonstration
  const synthetic = { run_catalog: await db.collection('run_catalog').countDocuments({}, { limit: 1 }), unit_master: await db.collection('unit_master').countDocuments({}, { limit: 1 }),
    checkpoints: await db.collection('checkpoints').countDocuments({}, { limit: 1 }), demoSessions: await db.collection('sim_sessions').countDocuments({ SESSION_ID: { $ne: 'S-FACTORY' } }, { limit: 1 }) };
  if (Object.values(synthetic).some(n => n > 0)) {
    console.error(`Refused: database "${c.mongoDb}" contains synthetic demonstration data (${Object.entries(synthetic).filter(([, n]) => n).map(([k]) => k).join(', ')}).`);
    console.error('Use a NEW database name for the fresh factory (MONGODB_DB_NAME in backend/.env and backend/python_engine/.env). Nothing was changed.');
    process.exit(3);
  }
  // 2. indexes
  let n = 0;
  for (const file of ['../contracts/indexes.json', '../contracts/factory_indexes.json']) {
    for (const ix of require(file).indexes) {
      const o = { name: ix.name || ix.k.map(([f, d]) => `${f}_${d}`).join('_') };
      if (ix.unique) o.unique = true;
      if (ix.partial) o.partialFilterExpression = ix.partial;
      if (ix.ttl !== undefined && ix.ttl !== null) o.expireAfterSeconds = ix.ttl;
      try { await db.collection(ix.c).createIndex(Object.fromEntries(ix.k), o); n++; } catch (e) { console.warn(`  index ${ix.c} ${o.name} not created: ${e.message}`); }
    }
  }
  console.log(`Indexes ensured: ${n}`);
  // 3. bootstrap admin (never reset)
  const login = (process.env.ADMIN_LOGIN || 'admin').trim();
  const existing = await db.collection('accounts').findOne({ dataset_id: c.datasetId, login_id: login });
  if (existing) console.log(`Admin "${login}" already exists - left unchanged (its password is NOT reset).`);
  else {
    let pw = process.env.ADMIN_PASSWORD || '';
    if (!pw && process.stdin.isTTY) {
      pw = await askHidden(`Choose a password for admin "${login}" (at least 15 characters, not shown): `);
      const again = await askHidden('Type it again: ');
      if (pw !== again) { console.error('The two passwords differ - nothing was created. Run the command again.'); process.exit(4); }
    }
    if (!pw || pw.length < 15) { console.error('Refused: the admin password must be at least 15 characters (ADMIN_PASSWORD, or type it when asked). There is no default password.'); process.exit(4); }
    const { hashPin } = require('../src/lib/pin');
    const PERMS = require('../contracts/permissions.json');
    await db.collection('accounts').insertOne({ dataset_id: c.datasetId, login_id: login, worker_id: null, display_name: 'Factory administrator', roles: ['ADMIN'], permissions: PERMS.roles.ADMIN, status: 'ACTIVE',
      // a password that came from a file must be changed after the first sign-in (the admin app shows a reminder)
      pin_hash: await hashPin(pw), pin_must_change: !!process.env.ADMIN_PASSWORD, created_at: new Date(), created_by: 'factory-init', _origin: 'SETUP' });
    await require('../src/services/audit').audit(db, 'factory-init', 'ADMIN_BOOTSTRAPPED', login, { note: 'Bootstrap admin account (worker_id null - an admin is not a worker)' });
    console.log(`Admin "${login}" created (password stored as a hash only). It is an administrator account, not a worker.`);
  }
  // 4. factory settings from the command line (optional)
  const F = require('../src/services/factory');
  let st = await F.settings(db);
  if (!st && opt('factory-name') && opt('site-id') && opt('timezone')) {
    await F.saveSettings({ factoryName: opt('factory-name'), siteId: opt('site-id'), timezone: opt('timezone'), operatingMode: opt('mode') || 'MANUAL_TEAM_TEST', serialPrefix: opt('serial-prefix') || 'TANK' }, 'factory-init', {});
    st = await F.settings(db);
    console.log(`Factory settings saved: ${st.FACTORY_NAME} / ${st.SITE_ID} / ${st.TIMEZONE} / ${st.OPERATING_MODE}`);
  } else if (!st) console.log('Factory settings: not set yet - the admin sets them in Admin > Setup > Factory (step 1).');
  // 5. permanent operational session
  const sess = await F.session(db);
  if (sess) console.log(`Session S-FACTORY already exists (${sess.STATUS}) - left unchanged.`);
  else {
    await db.collection('sim_sessions').insertOne(F.sessionDoc(st, 'factory-init'));
    await require('../src/services/audit').audit(db, 'factory-init', 'FACTORY_SESSION_CREATED', 'S-FACTORY', { mode: (st && st.OPERATING_MODE) || 'MANUAL_TEAM_TEST', note: 'Empty session - no checkpoint, no history' });
    console.log('Session S-FACTORY created (empty, real-time clock).');
  }
  const people = await F.addWorkersToSession(db);
  const counts = {};
  for (const coll of ['worker_master', 'production_orders', 'sim_units', 'sim_events']) counts[coll] = await db.collection(coll).countDocuments({});
  console.log(`Operational records now: ${JSON.stringify(counts)}  (workers synced to the session: ${people})`);
  console.log('Done. Start the API, the engine and the admin app, sign in as the admin and follow Setup (ADMIN_FIRST_RUN_GUIDE.md).');
  process.exit(0);
})().catch(e => { console.error('factory:init failed:', e.message); process.exit(1); });
