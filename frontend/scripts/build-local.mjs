// Offline local build (no Vite needed): bundles the same src/ with esbuild into dist-local/. Production uses `npm run build` (Vite).
// esbuild and React resolve from ./node_modules after `npm install`, or from GINI_TOOLS_NODE_MODULES (sandbox tool cache).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = process.env.GINI_TOOLS_NODE_MODULES || '/opt/npm-tools/node_modules';
const req = createRequire(path.join(root, 'package.json'));
let esbuild;
try { esbuild = req('esbuild'); } catch (e) { esbuild = createRequire(path.join(tools, 'noop.js'))('esbuild'); }
const env = {};
for (const f of ['.env', '.env.local']) {
  const p = path.join(root, f);
  if (fs.existsSync(p)) for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*(VITE_[A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, ''); }
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const kind = pkg.name.includes('admin') ? 'admin' : 'operator';
const defaults = { VITE_API_BASE_URL: '/api', VITE_APP_KIND: kind, VITE_POLL_INTERVAL_MS: '5000', VITE_SHOW_SYNTHETIC_BANNER: 'true' };
const all = { ...defaults, ...env, MODE: 'production', PROD: true, DEV: false };
const out = path.join(root, 'dist-local');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'src/main.jsx')], bundle: true, minify: true, sourcemap: false, format: 'esm', target: ['es2020'],
  outdir: path.join(out, 'assets'), entryNames: 'main', jsx: 'automatic', loader: { '.js': 'jsx', '.jsx': 'jsx', '.svg': 'file' },
  define: { 'import.meta.env': JSON.stringify(all), 'process.env.NODE_ENV': '"production"' },
  nodePaths: [path.join(root, 'node_modules'), tools], logLevel: 'warning',
});
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script type="module" src="\/src\/main.jsx"><\/script>/, '<script type="module" src="/assets/main.js"></script>');
if (fs.existsSync(path.join(out, 'assets/main.css'))) html = html.replace('</head>', '    <link rel="stylesheet" href="/assets/main.css" />\n  </head>');
fs.writeFileSync(path.join(out, 'index.html'), html);
for (const f of fs.readdirSync(path.join(root, 'public'))) fs.copyFileSync(path.join(root, 'public', f), path.join(out, f));
const size = fs.statSync(path.join(out, 'assets/main.js')).size;
console.log(`built ${kind} app -> dist-local (main.js ${(size / 1024).toFixed(0)} KB)`);
