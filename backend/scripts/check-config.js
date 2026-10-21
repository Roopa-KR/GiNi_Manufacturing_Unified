#!/usr/bin/env node
'use strict';
const { config, readiness } = require('../src/config/env');
const c = config();
const p = readiness(c);
console.log(JSON.stringify({ nodeEnv: c.nodeEnv, allowedOrigins: c.allowedOrigins, mongoDb: c.mongoDb, emailMode: c.email.mode, evidenceMode: c.evidenceMode, problems: p }, null, 2));
process.exit(p.length ? 1 : 0);
