'use strict';
/* Prints the OpenAPI 3.1 document (generated from the route table + command registry) to stdout, or writes it to a file:
     node scripts/print-openapi.js                 -> stdout
     node scripts/print-openapi.js docs/openapi.json
   No database connection or secrets are needed. */
const fs = require('fs');
const path = require('path');
// load the command handlers so x-commands lists every registered command (they only register themselves)
for (const m of ['tasks', 'quality', 'flow', 'decisions', 'evidence', 'orders', 'factory', 'scan']) require(`../src/domain/commands/${m}`);
const doc = require('../src/openapi');
const out = JSON.stringify(doc, null, 2) + '\n';
const target = process.argv[2];
if (target) { fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true }); fs.writeFileSync(target, out); console.error(`wrote ${target} (${Object.keys(doc.paths || {}).length} paths)`); }
else process.stdout.write(out);
