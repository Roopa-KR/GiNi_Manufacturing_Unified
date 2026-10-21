'use strict';
/* Notification outbox with the REAL Nodemailer library against a LOCAL fake SMTP server (127.0.0.1, nothing leaves the machine):
   accepted -> SENT with the stable Message-ID and dedup header; 451 -> RETRY with back-off; 550 -> FAILED; server down -> RETRY;
   non-allowlisted recipients -> SUPPRESSED; capture mode -> CAPTURED through Nodemailer's jsonTransport.
   Needs a disposable database: GINI_TEST_MONGODB_URI (skipped and reported as skipped when unset). */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');

const URI = process.env.GINI_TEST_MONGODB_URI;

function fakeSmtp() {
  const state = { mode: 'ok', messages: [] };
  const server = net.createServer(sock => {
    let data = false, buf = '', msg = '';
    sock.write('220 fake-smtp.local ESMTP test server\r\n');
    sock.on('data', chunk => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) {
          if (line === '.') { data = false; state.messages.push(msg); msg = ''; sock.write(state.mode === 'temp-data' ? '451 4.3.0 try later\r\n' : '250 2.0.0 queued as FAKE1\r\n'); } else msg += line + '\n';
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-fake-smtp.local\r\n250 8BITMIME\r\n');
        else if (cmd === 'MAIL') sock.write(state.mode === 'perm' ? '550 5.7.1 rejected\r\n' : '250 2.1.0 ok\r\n');
        else if (cmd === 'RCPT') sock.write(state.mode === 'temp' ? '451 4.4.1 try later\r\n' : '250 2.1.5 ok\r\n');
        else if (cmd === 'DATA') { data = true; sock.write('354 go ahead\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else if (cmd === 'RSET' || cmd === 'NOOP') sock.write('250 ok\r\n');
        else sock.write('502 unsupported\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise(res => server.listen(0, '127.0.0.1', () => res({ server, state, port: server.address().port })));
}

test('nodemailer outbox against a local SMTP server and capture transport', { skip: !URI && 'GINI_TEST_MONGODB_URI not set' }, async (t) => {
  const smtp = await fakeSmtp();
  const dbName = `gini_test_notify_${Date.now().toString(36)}`;
  Object.assign(process.env, { MONGODB_URI: URI, MONGODB_DB_NAME: dbName, EMAIL_MODE: 'smtp', EMAIL_HOST: '127.0.0.1', EMAIL_PORT: String(smtp.port), EMAIL_SECURE: 'false',
    EMAIL_USER: '', EMAIL_PASS: '', EMAIL_TIMEOUT_MS: '3000', ALERT_EMAIL_ALLOWLIST: 'supervisor@example.test', ALERT_EMAIL_RECIPIENTS: 'supervisor@example.test', EMAIL_FROM: 'GiNi Test <no-reply@example.test>' });
  const env = require('../../src/config/env');
  env._reset();
  const { getDb } = require('../../src/lib/db');
  const N = require('../../src/services/notifications');
  const db = await getDb();
  await db.collection('notifications').createIndex({ DEDUP_KEY: 1 }, { unique: true });
  let k = 0;
  const enqueue = async () => {
    k += 1;
    const doc = { NOTIFICATION_ID: `NTF-T${k}`, DEDUP_KEY: `S-T|AL-F6-MR-${k}|E1|FIRING`, SESSION_ID: 'S-T', ALERT_ID: `AL-F6-MR-${k}`, TRANSITION: 'FIRING', SUBJECT: `[GiNi synthetic demo] FIRING F6 test ${k}`,
      BODY: 'SYNTHETIC DEMONSTRATION DATA - test', MESSAGE_ID: `<t${k}.${Date.now()}@gini-demo.local>`, STATUS: 'PENDING', ATTEMPTS: 0, NEXT_ATTEMPT_AT: new Date(Date.now() - 1000), CREATED_AT: new Date() };
    await db.collection('notifications').insertOne(doc);
    return doc;
  };
  const status = async (doc) => db.collection('notifications').findOne({ NOTIFICATION_ID: doc.NOTIFICATION_ID });
  try {
    await t.test('accepted by SMTP -> SENT with stable Message-ID and dedup header', async () => {
      const d = await enqueue();
      smtp.state.mode = 'ok';
      const r = await N.dispatch(5, 'test');
      assert.equal(r.sent, 1, JSON.stringify(r));
      const s = await status(d);
      assert.equal(s.STATUS, 'SENT');
      const raw = smtp.state.messages[smtp.state.messages.length - 1];
      assert.match(raw, new RegExp(`Message-ID: ${d.MESSAGE_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'));
      assert.match(raw, /X-GiNi-Dedup-Key: S-T\|AL-F6-MR-1\|E1\|FIRING/i);
      assert.match(raw, /To: supervisor@example\.test/);
    });
    await t.test('a duplicate outbox item for the same transition is refused by the dedup key', async () => {
      await assert.rejects(db.collection('notifications').insertOne({ DEDUP_KEY: 'S-T|AL-F6-MR-1|E1|FIRING', STATUS: 'PENDING' }), e => e.code === 11000);
    });
    await t.test('temporary SMTP failure (451) -> RETRY with back-off, not sent twice', async () => {
      const d = await enqueue();
      smtp.state.mode = 'temp';
      const r = await N.dispatch(5, 'test');
      assert.equal(r.retry, 1, JSON.stringify(r));
      const s = await status(d);
      assert.equal(s.STATUS, 'RETRY');
      assert.ok(new Date(s.NEXT_ATTEMPT_AT) > new Date(), 'next attempt is in the future');
      assert.equal(s.ATTEMPTS, 1);
      const again = await N.dispatch(5, 'test');
      assert.equal(again.claimed, 0, 'not retried before its back-off');
    });
    await t.test('permanent rejection (550) -> FAILED', async () => {
      const d = await enqueue();
      smtp.state.mode = 'perm';
      const r = await N.dispatch(5, 'test');
      assert.equal(r.failed, 1, JSON.stringify(r));
      assert.equal((await status(d)).STATUS, 'FAILED');
    });
    await t.test('SMTP server down -> RETRY', async () => {
      const d = await enqueue();
      await new Promise(res => smtp.server.close(res));
      N._resetTransport();
      const r = await N.dispatch(5, 'test');
      assert.equal(r.retry, 1, JSON.stringify(r));
      assert.match((await status(d)).LAST_ERROR, /ECONNREFUSED|connect|Connection/i);
    });
    await t.test('recipients outside the allowlist are never emailed', async () => {
      process.env.ALERT_EMAIL_RECIPIENTS = 'someone@example.invalid'; env._reset(); N._resetTransport();
      const d = await enqueue();
      const r = await N.dispatch(5, 'test');
      assert.equal(r.suppressed, 1, JSON.stringify(r));
      assert.equal((await status(d)).STATUS, 'SUPPRESSED');
    });
    await t.test('capture mode builds the message with Nodemailer (jsonTransport) and sends nothing', async () => {
      process.env.EMAIL_MODE = 'capture'; process.env.ALERT_EMAIL_RECIPIENTS = 'supervisor@example.test'; env._reset(); N._resetTransport();
      const d = await enqueue();
      const r = await N.dispatch(5, 'test');
      assert.equal(r.captured, 1, JSON.stringify(r));
      const s = await status(d);
      assert.equal(s.STATUS, 'CAPTURED');
      assert.equal(s.TRANSPORT, 'nodemailer jsonTransport (capture)');
      assert.deepEqual(s.CAPTURED.to, ['supervisor@example.test']);
      const hk = Object.keys(s.CAPTURED.headers || {}).find(h => h.toLowerCase() === 'x-gini-dedup-key');
      assert.equal(hk && s.CAPTURED.headers[hk], d.DEDUP_KEY);
    });
  } finally {
    await db.dropDatabase();
    try { smtp.server.close(); } catch (e) { /* closed */ }
    await db.__client.close();
  }
});
