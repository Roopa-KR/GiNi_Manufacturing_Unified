'use strict';
/* Environment validation. Fails fast with readable readiness errors; never logs secret values. */
const path = require('path');

function loadDotEnv(file) {
  // minimal .env loader (no dependency); real deployments set variables in the Vercel / Render dashboards
  const fs = require('fs');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

/** key=value pairs of a .env file without touching process.env (used for the API/engine consistency check) */
function readDotEnv(file) {
  const fs = require('fs');
  const out = {};
  if (!fs.existsSync(file)) return null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function bool(v, d) { if (v === undefined || v === '') return d; return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()); }
function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function list(v) { return String(v || '').split(',').map(s => s.trim()).filter(Boolean); }

let cached = null;
function config() {
  if (cached) return cached;
  if (process.env.NODE_ENV !== 'production') loadDotEnv(path.join(__dirname, '..', '..', '.env'));
  const e = process.env;
  const c = {
    nodeEnv: e.NODE_ENV || 'development',
    isProd: e.NODE_ENV === 'production',
    port: int(e.PORT, 5000),
    frontendUrl: e.FRONTEND_URL || 'http://localhost:5173',
    adminUrl: e.ADMIN_URL || 'http://localhost:5174',
    extraOrigins: list(e.EXTRA_ALLOWED_ORIGINS),
    mongoUri: e.MONGODB_URI || '',
    mongoDb: e.MONGODB_DB_NAME || 'gini_demo_dev',
    mongoPool: int(e.MONGODB_MAX_POOL_SIZE, 5),
    mongoTimeout: int(e.MONGODB_SERVER_SELECTION_TIMEOUT_MS, 10000),
    sessionSecret: e.SESSION_SECRET || '',
    sessionIdleMin: int(e.SESSION_IDLE_MINUTES, 120),
    sessionAbsoluteH: int(e.SESSION_ABSOLUTE_HOURS, 12),
    demoMode: bool(e.DEMO_MODE, true),
    // environment: FRESH_FACTORY (empty factory for team testing; no workbook import) or SYNTHETIC_DEMO (the imported Final dataset)
    environment: (e.GINI_ENVIRONMENT || 'SYNTHETIC_DEMO').toUpperCase(),
    environmentName: e.ENVIRONMENT_NAME || ((e.GINI_ENVIRONMENT || '').toUpperCase() === 'FRESH_FACTORY' ? 'Fresh factory - team test' : 'Synthetic demonstration'),
    datasetId: e.DATASET_ID || ((e.GINI_ENVIRONMENT || '').toUpperCase() === 'FRESH_FACTORY' ? 'GINI-FRESH-FACTORY' : 'GINI-SYN-TANKS'),
    allowFactoryReset: bool(e.ALLOW_FACTORY_RESET, false),
    cloudinary: { cloudName: e.CLOUDINARY_CLOUD_NAME || '', apiKey: e.CLOUDINARY_API_KEY || '', apiSecret: e.CLOUDINARY_API_SECRET || '' },
    evidenceMode: (e.EVIDENCE_STORAGE_MODE || 'local').toLowerCase(),
    evidenceLocalDir: e.EVIDENCE_LOCAL_DIR || path.join(__dirname, '..', '..', '..', '.local', 'evidence'),
    uploadMaxImageMb: int(e.UPLOAD_MAX_IMAGE_MB, 8),
    uploadMaxFiles: int(e.UPLOAD_MAX_FILES, 10),
    uploadMaxMegapixels: int(e.UPLOAD_MAX_MEGAPIXELS, 40),
    email: {
      mode: (e.EMAIL_MODE || 'capture').toLowerCase(),
      host: e.EMAIL_HOST || '', port: int(e.EMAIL_PORT, 587), secure: bool(e.EMAIL_SECURE, false),
      user: e.EMAIL_USER || '', pass: e.EMAIL_PASS || '', from: e.EMAIL_FROM || 'GiNi Demo <no-reply@example.com>', replyTo: e.EMAIL_REPLY_TO || '',
      allowlist: list(e.ALERT_EMAIL_ALLOWLIST).map(s => s.toLowerCase()), recipients: list(e.ALERT_EMAIL_RECIPIENTS).map(s => s.toLowerCase()),
      cooldownSec: int(e.EMAIL_COOLDOWN_SECONDS, 900), timeoutMs: int(e.EMAIL_TIMEOUT_MS, 15000),
    },
    internalToken: e.INTERNAL_SERVICE_TOKEN || '',
    loginRateMax: int(e.LOGIN_RATE_MAX, 10),
    loginRateWindowMin: int(e.LOGIN_RATE_WINDOW_MIN, 15),
    publicAdminBaseUrl: e.ADMIN_URL || 'http://localhost:5174',
    // GiNi Assistant (Google Gemini). Server-side only - never exposed to the browser bundles.
    gemini: {
      apiKey: (e.GEMINI_API_KEY || '').trim(),
      model: (e.GEMINI_MODEL || 'gemini-2.5-flash').trim(),
      temperature: Number.isFinite(parseFloat(e.GEMINI_TEMPERATURE)) ? parseFloat(e.GEMINI_TEMPERATURE) : 0.3,
      timeoutMs: int(e.GEMINI_TIMEOUT_MS, 25000),
      ratePerMin: int(e.ASSISTANT_RATE_PER_MIN, 20),
    },
  };
  c.allowedOrigins = [c.frontendUrl, c.adminUrl, ...c.extraOrigins].map(o => o.replace(/\/+$/, ''));
  c.isFresh = c.environment === 'FRESH_FACTORY';
  cached = c;
  return c;
}

function readiness(c = config()) {
  const problems = [];
  if (!c.mongoUri) problems.push('MONGODB_URI is not set');
  if (!c.sessionSecret || c.sessionSecret.length < 32 || /GENERATE/i.test(c.sessionSecret)) problems.push('SESSION_SECRET must be a random value of at least 32 characters');
  if (!c.internalToken || c.internalToken.length < 32 || /GENERATE/i.test(c.internalToken)) problems.push('INTERNAL_SERVICE_TOKEN must be a random value of at least 32 characters');
  if (c.isProd) {
    for (const o of c.allowedOrigins) if (!o.startsWith('https://')) problems.push(`allowed origin must be HTTPS in production: ${o}`);
    if (c.allowedOrigins.some(o => o.includes('*'))) problems.push('wildcard origins are not allowed');
    if (c.evidenceMode !== 'cloudinary') problems.push('EVIDENCE_STORAGE_MODE must be cloudinary in production (local disk is not persistent on Vercel)');
  }
  if (c.evidenceMode === 'cloudinary' && (!c.cloudinary.cloudName || !c.cloudinary.apiKey || !c.cloudinary.apiSecret)) problems.push('Cloudinary credentials missing for EVIDENCE_STORAGE_MODE=cloudinary');
  if (!['capture', 'smtp', 'disabled'].includes(c.email.mode)) problems.push('EMAIL_MODE must be capture, smtp or disabled');
  if (c.email.mode === 'smtp') {
    if (!c.email.host) problems.push('EMAIL_HOST missing for EMAIL_MODE=smtp');
    if (!c.email.allowlist.length) problems.push('ALERT_EMAIL_ALLOWLIST is required for EMAIL_MODE=smtp (fabricated worker addresses are never emailed)');
  }
  if (!['FRESH_FACTORY', 'SYNTHETIC_DEMO'].includes(c.environment)) problems.push('GINI_ENVIRONMENT must be FRESH_FACTORY or SYNTHETIC_DEMO');
  if (c.isProd && c.allowFactoryReset) problems.push('ALLOW_FACTORY_RESET must be false in production');
  for (const p of engineEnvMismatch(c)) problems.push(p);
  return problems;
}

/** local runs: the API and the Python engine must use the same database, dataset and environment. Compares backend/.env (already
    loaded) with backend/python_engine/.env when that file exists; values are compared, never printed (the URI may hold a password). */
function engineEnvMismatch(c = config()) {
  if (c.isProd) return [];
  const eng = readDotEnv(path.join(__dirname, '..', '..', 'python_engine', '.env'));
  if (!eng) return [];
  const out = [];
  if (eng.MONGODB_URI && eng.MONGODB_URI !== c.mongoUri) out.push('backend/python_engine/.env has a different MONGODB_URI than the API - both services must use the same database server');
  if ((eng.MONGODB_DB_NAME || 'gini_demo_dev') !== c.mongoDb) out.push(`backend/python_engine/.env uses database "${eng.MONGODB_DB_NAME || 'gini_demo_dev'}" but the API uses "${c.mongoDb}" - set the same MONGODB_DB_NAME in both files`);
  if ((eng.GINI_ENVIRONMENT || 'SYNTHETIC_DEMO').toUpperCase() !== c.environment) out.push(`backend/python_engine/.env has GINI_ENVIRONMENT=${eng.GINI_ENVIRONMENT || '(not set = SYNTHETIC_DEMO)'} but the API runs ${c.environment}`);
  const engDs = eng.DATASET_ID || ((eng.GINI_ENVIRONMENT || '').toUpperCase() === 'FRESH_FACTORY' ? 'GINI-FRESH-FACTORY' : 'GINI-SYN-TANKS');
  if (engDs !== c.datasetId) out.push(`backend/python_engine/.env uses DATASET_ID ${engDs} but the API uses ${c.datasetId}`);
  return out;
}

module.exports = { config, readiness, engineEnvMismatch, readDotEnv, _reset: () => { cached = null; } };
