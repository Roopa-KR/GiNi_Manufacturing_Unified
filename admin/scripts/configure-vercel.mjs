// Writes the backend origin into vercel.json's /api rewrite (Vercel does not interpolate environment variables in vercel.json).
//   npm run configure:vercel -- https://gini-api-yourteam.vercel.app
import fs from 'node:fs';
const origin = (process.argv[2] || process.env.GINI_API_ORIGIN || '').replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9.-]+$/i.test(origin)) { console.error('Usage: npm run configure:vercel -- https://<your-api-project>.vercel.app'); process.exit(1); }
const f = new URL('../vercel.json', import.meta.url);
const v = JSON.parse(fs.readFileSync(f, 'utf8'));
v.rewrites[0].destination = `${origin}/api/:path*`;
fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
console.log('vercel.json /api rewrite ->', v.rewrites[0].destination);
