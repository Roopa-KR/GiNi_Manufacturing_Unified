// Serves dist-local/ with SPA fallback and proxies /api to the Express API (same-origin, like the Vercel rewrite).
//   PORT=5173 API=http://localhost:5000 node scripts/serve-local.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', process.env.DIST || 'dist-local');
const port = Number(process.env.PORT || 5173);
const api = new URL(process.env.API || process.env.DEV_API_PROXY_TARGET || 'http://localhost:5000');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    const headers = { ...req.headers, host: api.host, 'x-forwarded-host': req.headers.host, 'x-forwarded-proto': 'http' };
    const p = http.request({ hostname: api.hostname, port: api.port, path: req.url, method: req.method, headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', () => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'API_UNREACHABLE', message: 'The GiNi API is not reachable from the local preview server' } })); });
    req.pipe(p);
    return;
  }
  let f = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream', 'cache-control': f.endsWith('index.html') ? 'no-store' : 'public, max-age=300' });
  fs.createReadStream(f).pipe(res);
}).listen(port, () => console.log(`local preview http://localhost:${port} -> API ${api.origin}`));
