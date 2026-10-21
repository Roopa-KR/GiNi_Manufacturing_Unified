// Deployment gate for this Vercel project (runs as `prebuild`). vercel.json cannot read environment variables, so the API origin
// must be written into the /api rewrite with `npm run configure:vercel -- https://<api-project>.vercel.app` and committed.
// On Vercel (VERCEL=1) or with CHECK_DEPLOY=1 the build FAILS while the placeholder or a non-https origin remains; locally it warns.
import fs from 'node:fs';
const v = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const api = (v.rewrites || []).find(r => r.source === '/api/:path*');
const dest = api ? api.destination : '';
const problems = [];
if (!api) problems.push('vercel.json has no /api/:path* rewrite');
if (/YOUR-GINI-API/i.test(dest)) problems.push('the /api rewrite still points to the YOUR-GINI-API placeholder');
if (dest && !/^https:\/\/[a-z0-9.-]+\/api\/:path\*$/i.test(dest)) problems.push(`the /api rewrite destination is not an https origin + /api/:path* (${dest})`);
for (const k of Object.keys(process.env)) if (k.startsWith('VITE_') && /(SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE)/i.test(k)) problems.push(`${k} looks like a secret - VITE_ variables are public in the browser bundle`);
const strict = process.env.VERCEL === '1' || process.env.CHECK_DEPLOY === '1';
if (problems.length) {
  for (const p of problems) console.error(`${strict ? 'ERROR' : 'WARNING'}: ${p}`);
  console.error('Fix: npm run configure:vercel -- https://<your-api-project>.vercel.app  (then commit vercel.json)');
  if (strict) process.exit(1);
} else console.log(`deploy check OK: /api -> ${dest}`);
