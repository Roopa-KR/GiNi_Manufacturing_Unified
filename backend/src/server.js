'use strict';
/* Local / container entry point. On Vercel the same app is exported from api/index.js. */
const { createApp } = require('./app');
const { config, readiness } = require('./config/env');

const c = config();
const problems = readiness(c);
if (problems.length) {
  console.warn('[api] configuration readiness problems (the API starts, /api/ready reports 503):');
  for (const p of problems) console.warn('   - ' + p);
}
const app = createApp();
app.listen(c.port, () => console.log(`[api] GiNi API listening on http://localhost:${c.port} (${c.nodeEnv}); allowed origins: ${c.allowedOrigins.join(', ')}`));
