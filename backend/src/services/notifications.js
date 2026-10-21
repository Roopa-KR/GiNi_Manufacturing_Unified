'use strict';
/*
 * Durable notification outbox dispatch (Nodemailer). The engine enqueues FIRING / ESCALATED / RESOLVED transitions with a stable
 * dedup key; this module atomically claims items, sends them (SMTP) or captures them (capture mode), and records the outcome.
 * SMTP cannot guarantee exactly-once delivery after an ambiguous acceptance: an item whose claim expired mid-send is marked
 * UNCERTAIN and is not resent automatically; the stable Message-ID lets mail systems de-duplicate a manual resend.
 */
const nodemailer = require('nodemailer');
const { getDb } = require('../lib/db');
const { config } = require('../config/env');

let transport = null;
function getTransport() {
  const c = config().email;
  if (!transport) transport = nodemailer.createTransport({ host: c.host, port: c.port, secure: c.secure, auth: c.user ? { user: c.user, pass: c.pass } : undefined, connectionTimeout: c.timeoutMs, greetingTimeout: c.timeoutMs, socketTimeout: c.timeoutMs });
  return transport;
}
let capture = null;
function captureTransport() { if (!capture) capture = nodemailer.createTransport({ jsonTransport: true }); return capture; }
function mailFor(c, n, to) {
  return { from: c.email.from, replyTo: c.email.replyTo || undefined, to: to.join(', '), subject: n.SUBJECT, text: n.BODY, messageId: n.MESSAGE_ID, headers: { 'X-GiNi-Dedup-Key': n.DEDUP_KEY, 'X-GiNi-Synthetic': 'true' } };
}
function _resetTransport() { transport = null; capture = null; }

function recipients() {
  const c = config().email;
  const allow = new Set(c.allowlist);
  return c.recipients.filter(r => allow.has(r));
}

async function claimOne(db, owner) {
  const now = new Date();
  // expired claims: delivery outcome unknown -> UNCERTAIN (never silently resent)
  await db.collection('notifications').updateMany({ STATUS: 'CLAIMED', CLAIM_EXPIRES_AT: { $lt: now } }, { $set: { STATUS: 'UNCERTAIN', UPDATED_AT: now, LAST_ERROR: 'Claim expired during send - delivery outcome unknown' } });
  return db.collection('notifications').findOneAndUpdate({ STATUS: { $in: ['PENDING', 'RETRY'] }, NEXT_ATTEMPT_AT: { $lte: now } },
    { $set: { STATUS: 'CLAIMED', CLAIMED_BY: owner, CLAIMED_AT: now, CLAIM_EXPIRES_AT: new Date(now.getTime() + 2 * config().email.timeoutMs + 5000), UPDATED_AT: now }, $inc: { ATTEMPTS: 1 } },
    { sort: { CREATED_AT: 1 }, returnDocument: 'after' });
}

async function dispatch(limit = 20, owner = 'api') {
  const c = config();
  const db = await getDb();
  const out = { claimed: 0, sent: 0, captured: 0, failed: 0, retry: 0, suppressed: 0 };
  for (let i = 0; i < limit; i++) {
    const n = await claimOne(db, owner);
    if (!n) break;
    out.claimed++;
    const fin = async (set) => db.collection('notifications').updateOne({ _id: n._id, STATUS: 'CLAIMED', CLAIMED_BY: owner }, { $set: { ...set, UPDATED_AT: new Date() } });
    if (c.email.mode === 'disabled') { await fin({ STATUS: 'SUPPRESSED', SUPPRESSED_REASON: 'EMAIL_MODE=disabled' }); out.suppressed++; continue; }
    if (c.email.mode === 'capture') {
      // the real Nodemailer pipeline builds the message (headers, Message-ID, encoding) into a JSON capture - nothing leaves the process
      const info = await captureTransport().sendMail(mailFor(c, n, recipients().length ? recipients() : ['capture-only@example.invalid']));
      const msg = JSON.parse(info.message);
      await fin({ STATUS: 'CAPTURED', SENT_AT: new Date(), PROVIDER_MESSAGE_ID: info.messageId || n.MESSAGE_ID, TRANSPORT: 'nodemailer jsonTransport (capture)',
        CAPTURED: { to: (msg.to || []).map(a => a.address), subject: msg.subject, text: msg.text, messageId: msg.messageId, headers: msg.headers } });
      out.captured++; continue;
    }
    const to = recipients();
    if (!to.length) { await fin({ STATUS: 'SUPPRESSED', SUPPRESSED_REASON: 'No allowlisted recipient (ALERT_EMAIL_RECIPIENTS must also be in ALERT_EMAIL_ALLOWLIST)' }); out.suppressed++; continue; }
    try {
      const info = await getTransport().sendMail(mailFor(c, n, to));
      await fin({ STATUS: 'SENT', SENT_AT: new Date(), PROVIDER_MESSAGE_ID: info.messageId || n.MESSAGE_ID, PROVIDER_RESPONSE: String(info.response || '').slice(0, 300), ACCEPTED: info.accepted, REJECTED: info.rejected });
      out.sent++;
    } catch (e) {
      const attempts = n.ATTEMPTS;
      const permanent = e.responseCode && e.responseCode >= 500 && e.responseCode < 600 && e.responseCode !== 554;
      if (attempts >= 5 || permanent) { await fin({ STATUS: 'FAILED', LAST_ERROR: String(e.message).slice(0, 300) }); out.failed++; }
      else { await fin({ STATUS: 'RETRY', LAST_ERROR: String(e.message).slice(0, 300), NEXT_ATTEMPT_AT: new Date(Date.now() + Math.min(600, 15 * 2 ** attempts) * 1000) }); out.retry++; }
    }
  }
  return out;
}

module.exports = { dispatch, recipients, _resetTransport };
