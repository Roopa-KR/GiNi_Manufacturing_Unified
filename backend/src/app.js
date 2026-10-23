'use strict';
/* Express application (shared by the local server and the Vercel function entry). */
const express = require('express');
const { config, readiness } = require('./config/env');
const { headers, originGuard } = require('./middleware/security');
const { loadSession, csrfGuard } = require('./middleware/auth');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

// command handlers register themselves with the executor
require('./domain/commands/tasks');
require('./domain/commands/quality');
require('./domain/commands/flow');
require('./domain/commands/decisions');
require('./domain/commands/evidence');
require('./domain/commands/orders');
require('./domain/commands/factory');
require('./domain/commands/scan');

function createApp() {
  const c = config();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);                 // Vercel / local proxy forward the original protocol and client IP
  app.use(headers);
  app.use(express.json({ limit: '256kb' }));

  // internal server-to-server routes authenticate with the service token, not cookies
  app.use('/api/internal', require('./routes/internal'));
  // local evidence adapter receives raw image bytes (development only)
  app.use('/api/evidence-local', require('./routes/evidenceLocal'));

  app.use('/api', originGuard, loadSession, csrfGuard);
  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'gini-api', time: new Date().toISOString() }));
  app.get('/api/ready', async (req, res, next) => {
    try {
      const problems = readiness(c);
      let db = 'UNKNOWN';
      try { const { getDb, serverIdentity } = require('./lib/db'); const d = await getDb(); await d.command({ ping: 1 }); const id = await serverIdentity(); db = id.kind === 'MongoDB' ? `OK (MongoDB ${id.version}, replica set ${id.replicaSet || 'none'})` : `OK (${id.kind})`; } catch (e) { db = 'UNAVAILABLE: ' + e.message; problems.push('database unavailable'); }
      let factory = null;
      if (c.isFresh) { try { const F = require('./services/factory'); factory = (await F.session()) ? 'INITIALISED' : 'NOT_INITIALISED (run npm run factory:init)'; } catch (e) { factory = 'UNKNOWN'; } }
      res.status(problems.length ? 503 : 200).json({ ready: problems.length === 0, problems, database: db, environment: c.environment, factory, emailMode: c.email.mode, evidenceMode: c.evidenceMode, demoMode: c.demoMode });
    } catch (e) { next(e); }
  });
  // environment banner (non-secret: environment, factory, mode, operational date with timezone; database NAME only when signed in)
  app.get('/api/environment', async (req, res, next) => { try { res.json(await require('./services/factory').environment(req)); } catch (e) { next(e); } });
  app.use('/api/factory', require('./routes/factory'));
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/sessions', require('./routes/sessions'));
  app.use('/api/sessions/:sid/me', require('./routes/operator'));
  app.use('/api/sessions/:sid', require('./routes/views'));
  app.use('/api/sessions/:sid/evidence', require('./routes/evidence'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api/assistant', require('./routes/assistant'));   // GiNi Assistant (Gemini chatbot)
  app.get('/api/openapi.json', (req, res) => res.json(require('./openapi')));
  app.use('/api', notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
