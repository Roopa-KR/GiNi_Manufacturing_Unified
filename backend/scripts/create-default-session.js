#!/usr/bin/env node
'use strict';
/* Explicit command: create the default interactive session from CK-20261015-1055 (or --checkpoint ID / --replay). Idempotent: reuses an existing default session unless --new. */
const S = require('../src/services/sessions');
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
(async () => {
  const existing = await S.getDefault();
  if (existing && !args.includes('--new')) { console.log(`default session already exists: ${existing.SESSION_ID} (${existing.STATUS})`); process.exit(0); }
  const s = await S.create({ mode: args.includes('--replay') ? 'REPLAY' : 'INTERACTIVE', checkpointId: opt('checkpoint') || undefined, name: opt('name') || 'Demo shift (default)', createdBy: 'cli', makeDefault: true });
  console.log(`created ${s.SESSION_ID} (${s.MODE}) fork ${s.FORK_AT.toISOString()} - the engine worker initialises it`);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
