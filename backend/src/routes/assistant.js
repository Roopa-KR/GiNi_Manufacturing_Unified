'use strict';
/* /api/assistant - GiNi Assistant (Google Gemini). Signed-in users only; read-only; the API key never leaves the server. */
const express = require('express');
const A = require('../services/assistant');
const { requireAuth } = require('../middleware/auth');
const E = require('../lib/errors');

const r = express.Router();
r.use(requireAuth);
r.get('/status', (req, res) => res.json(A.status()));
r.post('/chat', E.asyncH(async (req, res) => res.json(await A.chat(req, req.body || {}))));

module.exports = r;
