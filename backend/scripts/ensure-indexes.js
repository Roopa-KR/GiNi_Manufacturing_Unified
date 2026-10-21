#!/usr/bin/env node
'use strict';
/* Explicit command: create the application and history-query indexes (idempotent). Never run automatically at build. */
const { getDb } = require('../src/lib/db');
const SPEC = require('../contracts/indexes.json');
(async () => {
  const db = await getDb();
  let n = 0;
  for (const ix of SPEC.indexes) {
    const keys = Object.fromEntries(ix.k);
    const opts = { name: ix.name || ix.k.map(([f, d]) => `${f}_${d}`).join('_') };
    if (ix.unique) opts.unique = true;
    if (ix.partial) opts.partialFilterExpression = ix.partial;
    await db.collection(ix.c).createIndex(keys, opts);
    n++;
  }
  console.log(`ensured ${n} indexes`);
  process.exit(0);
})().catch(e => { console.error('index creation failed:', e.message); process.exit(1); });
