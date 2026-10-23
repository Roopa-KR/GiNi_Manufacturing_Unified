'use strict';
/* GiNi Assistant (Gemini): the key stays server-side, the request has the Gemini REST shape, answers are parsed, errors are readable,
   and the route refuses anonymous users. Gemini and MongoDB are stubbed - no network, no database. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');

process.env.GEMINI_API_KEY = 'test-key-not-real';
process.env.GEMINI_MODEL = 'gemini-test-model';
process.env.ASSISTANT_RATE_PER_MIN = '100';

// stub the database module before the assistant loads it (only the display-name lookup touches it when no session is passed)
const dbPath = require.resolve(path.join(__dirname, '../../src/lib/db'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: async () => ({ collection: () => ({ findOne: async () => ({ DISPLAY_NAME: 'Test Supervisor' }) }) }) } };
require('../../src/config/env')._reset();
const A = require('../../src/services/assistant');

const auth = { loginId: 'sup1', workerId: 'W1', roles: ['SUPERVISOR'], permissions: ['operational_supervision'], datasetId: 'X' };
function stubFetch(status, body) {
  const calls = [];
  global.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: status < 400, status, json: async () => body }; };
  return calls;
}

test('status reports enabled and the model, never the key', () => {
  const s = A.status();
  assert.equal(s.enabled, true);
  assert.equal(s.model, 'gemini-test-model');
  assert.ok(!JSON.stringify(s).includes('test-key-not-real'));
});

test('chat sends a Gemini generateContent request and returns the reply', async () => {
  const calls = stubFetch(200, { candidates: [{ content: { parts: [{ text: 'Plant is **fine**.' }] }, finishReason: 'STOP' }] });
  const out = await A.chat({ auth, appKind: 'admin' }, { sessionId: null, page: '/', messages: [{ role: 'assistant', content: 'stray' }, { role: 'user', content: 'How is the plant?' }] });
  assert.equal(out.reply, 'Plant is **fine**.');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /models\/gemini-test-model:generateContent$/);
  assert.equal(calls[0].opts.headers['x-goog-api-key'], 'test-key-not-real');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.contents.length, 1, 'a leading assistant message is dropped (Gemini needs the user first)');
  assert.equal(body.contents[0].role, 'user');
  assert.match(body.systemInstruction.parts[0].text, /GiNi Assistant/);
  assert.match(body.systemInstruction.parts[0].text, /Test Supervisor/);
});

test('assistant turns are sent with the Gemini "model" role', async () => {
  const calls = stubFetch(200, { candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
  await A.chat({ auth, appKind: 'operator' }, { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] });
  assert.deepEqual(JSON.parse(calls[0].opts.body).contents.map(c => c.role), ['user', 'model', 'user']);
});

test('errors are mapped to readable messages', async () => {
  stubFetch(400, { error: { message: 'API key not valid. Please pass a valid API key.' } });
  await assert.rejects(A.chat({ auth, appKind: 'admin' }, { messages: [{ role: 'user', content: 'x' }] }), /GEMINI_API_KEY/);
  stubFetch(404, { error: { message: 'models/x is not found' } });
  await assert.rejects(A.chat({ auth, appKind: 'admin' }, { messages: [{ role: 'user', content: 'x' }] }), /GEMINI_MODEL/);
  await assert.rejects(A.chat({ auth, appKind: 'admin' }, { messages: [] }), /Type a question/);
});

test('route: anonymous users are refused, signed-in users get an answer', async () => {
  stubFetch(200, { candidates: [{ content: { parts: [{ text: 'hello' }] } }] });
  const express = require('express');
  const { errorHandler } = require('../../src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.appKind = 'admin'; req.auth = req.get('x-test-auth') ? auth : null; next(); });
  app.use('/api/assistant', require('../../src/routes/assistant'));
  app.use(errorHandler);
  const server = http.createServer(app).listen(0);
  const port = server.address().port;
  const send = (headers) => new Promise((resolve, reject) => {
    const data = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
    const req = http.request({ port, path: '/api/assistant/chat', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
    });
    req.on('error', reject); req.end(data);
  });
  try {
    assert.equal((await send({})).status, 401);
    const ok = await send({ 'x-test-auth': '1' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.reply, 'hello');
  } finally { server.close(); }
});
