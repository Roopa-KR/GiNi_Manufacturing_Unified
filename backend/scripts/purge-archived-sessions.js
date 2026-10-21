#!/usr/bin/env node
'use strict';
/* Explicit maintenance command: delete the simulation records of ARCHIVED sessions to reclaim storage.
     node scripts/purge-archived-sessions.js                      -> dry run: lists what would be deleted
     node scripts/purge-archived-sessions.js --older-than-days 7 --yes
   Keeps the sim_sessions document (status PURGED, counts recorded) and the audit log, so the history of what existed remains.
   Never touches seeded collections, accounts, active sessions or the default session. */
const { getDb } = require('../src/lib/db');
const { RESET_COLLS, audit } = require('../src/services/sessions');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const days = Number(opt('older-than-days', 0));
const apply = args.includes('--yes');
(async () => {
  const db = await getDb();
  const cut = new Date(Date.now() - days * 86400000);
  const sessions = await db.collection('sim_sessions').find({ STATUS: 'ARCHIVED', DEFAULT_FLAG: { $ne: true }, ARCHIVED_AT: { $lte: cut } }).toArray();
  if (!sessions.length) { console.log('no archived session to purge'); process.exit(0); }
  const colls = [...RESET_COLLS, 'jobs', 'notifications', 'idempotency_keys'];
  let total = 0;
  for (const s of sessions) {
    const counts = {};
    for (const c of colls) {
      const n = await db.collection(c).countDocuments({ SESSION_ID: s.SESSION_ID });
      if (n) { counts[c] = n; total += n; if (apply) await db.collection(c).deleteMany({ SESSION_ID: s.SESSION_ID }); }
    }
    console.log(`${apply ? 'purged' : 'would purge'} ${s.SESSION_ID} (${s.NAME || ''}, archived ${s.ARCHIVED_AT && s.ARCHIVED_AT.toISOString()}): ${Object.values(counts).reduce((a, b) => a + b, 0)} documents`);
    if (apply) {
      await db.collection('sim_sessions').updateOne({ SESSION_ID: s.SESSION_ID }, { $set: { STATUS: 'PURGED', PURGED_AT: new Date(), PURGED_COUNTS: counts } });
      await audit(db, 'cli', 'SESSION_PURGED', s.SESSION_ID, { counts });
    }
  }
  console.log(`${apply ? 'deleted' : 'dry run:'} ${total} documents from ${sessions.length} archived sessions${apply ? '' : ' - add --yes to delete'}`);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
