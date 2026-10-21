'use strict';
/* LOCAL DEVELOPMENT EVIDENCE ADAPTER: receives raw image bytes for a single-use, short-lived token. Disabled when EVIDENCE_STORAGE_MODE=cloudinary. */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config/env');
const { getDb } = require('../lib/db');
const EV = require('../services/evidence');
const E = require('../lib/errors');

const r = express.Router({ mergeParams: true });
r.put('/:token', E.asyncH(async (req, res) => {
  const c = config();
  if (c.evidenceMode !== 'local') throw E.notFound('Local evidence adapter (disabled)');
  const db = await getDb();
  const ev = await db.collection('sim_evidence').findOne({ LOCAL_TOKEN_HASH: crypto.createHash('sha256').update(req.params.token).digest('hex'), UPLOAD_STATUS: 'PENDING_UPLOAD' });
  if (!ev || new Date(ev.TOKEN_EXPIRES_AT) < new Date()) throw E.forbidden('Upload token invalid or expired');
  const max = c.uploadMaxImageMb * 1048576;
  const chunks = []; let size = 0;
  await new Promise((resolve, reject) => {
    req.on('data', d => { size += d.length; if (size > max) { reject(new E.AppError(413, 'TOO_LARGE', 'File too large')); req.destroy(); } else chunks.push(d); });
    req.on('end', resolve); req.on('error', reject);
  });
  const buf = Buffer.concat(chunks);
  if (!EV.sniff(buf)) throw E.bad('NOT_AN_IMAGE', 'The uploaded file is not a recognised image');
  const file = EV.localPath(ev.PUBLIC_ID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  await db.collection('sim_evidence').updateOne({ _id: ev._id }, { $set: { UPLOAD_STATUS: 'UPLOADED_PENDING_VERIFICATION', LOCAL_TOKEN_HASH: null } });
  res.json({ ok: true, bytes: buf.length });
}));
module.exports = r;
