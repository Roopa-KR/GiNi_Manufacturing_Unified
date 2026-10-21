'use strict';
/*
 * Inspection evidence: backend-signed direct uploads (Cloudinary) or the local development adapter.
 * Photos never pass through the Vercel API body in Cloudinary mode. The client is not trusted: after the upload the API
 * verifies the stored asset (existence, type, size, dimensions) before the evidence can support an inspection.
 * Delivery uses the "authenticated" asset type with signed URLs; ordinary public URLs are not used for access control.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { config } = require('../config/env');
const E = require('../lib/errors');
const SIMCFG = require('../../config/simulation.json');

const MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };

function cloudinarySign(params, secret) {
  const s = Object.keys(params).filter(k => params[k] !== undefined && params[k] !== '' && !['file', 'api_key', 'resource_type', 'cloud_name'].includes(k)).sort().map(k => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(s + secret).digest('hex');
}

function deliverySignature(toSign, secret) {
  return 's--' + crypto.createHash('sha1').update(toSign + secret).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').slice(0, 8) + '--';
}

function validateRequest(b) {
  const c = config();
  if (!MIME[b.mime]) throw E.bad('UNSUPPORTED_TYPE', `Allowed image types: ${Object.keys(MIME).join(', ')}`);
  const max = c.uploadMaxImageMb * 1024 * 1024;
  if (!(Number(b.bytes) > 0) || Number(b.bytes) > max) throw E.bad('TOO_LARGE', `Images must be between 1 byte and ${c.uploadMaxImageMb} MB`);
  if (b.width && b.height && (Number(b.width) * Number(b.height)) / 1e6 > c.uploadMaxMegapixels) throw E.bad('TOO_MANY_PIXELS', `Images must be at most ${c.uploadMaxMegapixels} megapixels`);
}

function signUpload(evidenceId, sessionId, mime) {
  const c = config();
  if (c.evidenceMode === 'cloudinary') {
    const timestamp = Math.floor(Date.now() / 1000);
    const params = { folder: `${SIMCFG.evidence.folder}/${sessionId}`, public_id: evidenceId, timestamp, type: 'authenticated', overwrite: 'false', context: `evidence_id=${evidenceId}|session=${sessionId}`, allowed_formats: SIMCFG.evidence.allowed_formats.join(',') };
    const signature = cloudinarySign(params, c.cloudinary.apiSecret);
    return { mode: 'cloudinary', method: 'POST', uploadUrl: `https://api.cloudinary.com/v1_1/${c.cloudinary.cloudName}/image/upload`, fields: { ...params, api_key: c.cloudinary.apiKey, signature }, publicId: `${params.folder}/${evidenceId}` };
  }
  const token = crypto.randomBytes(24).toString('base64url');
  return { mode: 'local', method: 'PUT', uploadUrl: `/api/evidence-local/${token}`, token, contentType: mime, publicId: `${sessionId}/${evidenceId}`, note: 'Local development adapter - files on this computer only; not Vercel persistence' };
}

function httpsJson(url, auth) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Authorization: 'Basic ' + Buffer.from(auth).toString('base64') }, timeout: 10000 }, res => {
      const chunks = []; res.on('data', d => chunks.push(d));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('Cloudinary verification timed out')));
    req.on('error', reject);
  });
}

/** inspect magic bytes + dimensions for PNG/JPEG/WebP (local adapter) */
function sniff(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1], len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { mime: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    return { mime: 'image/jpeg', width: null, height: null };
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', width: null, height: null };
  return null;
}

async function verify(ev) {
  const c = config();
  if (ev.STORAGE_MODE === 'cloudinary') {
    if (!c.cloudinary.apiKey) throw E.unavailable('CLOUDINARY_NOT_CONFIGURED', 'Cloudinary credentials are not configured on the API');
    const url = `https://api.cloudinary.com/v1_1/${c.cloudinary.cloudName}/resources/image/authenticated/${encodeURIComponent(ev.PUBLIC_ID).replace(/%2F/g, '/')}`;
    let r;
    try { r = await httpsJson(url, `${c.cloudinary.apiKey}:${c.cloudinary.apiSecret}`); } catch (e) { throw E.unavailable('VERIFY_FAILED', 'Could not reach Cloudinary to verify the upload - the photo stays pending; retry'); }
    if (r.status === 404) return { ok: false, reason: 'Upload not found at Cloudinary - retake or retry the upload' };
    if (r.status !== 200) throw E.unavailable('VERIFY_FAILED', `Cloudinary verification returned ${r.status}`);
    const b = r.body;
    if (!SIMCFG.evidence.allowed_formats.includes(String(b.format).toLowerCase())) return { ok: false, reason: `Unexpected format ${b.format}` };
    if (b.bytes > c.uploadMaxImageMb * 1048576) return { ok: false, reason: 'File too large' };
    return { ok: true, meta: { BYTES: b.bytes, WIDTH: b.width, HEIGHT: b.height, FORMAT: b.format, ASSET_ID: b.asset_id, VERSION_NO: b.version, CLOUD_CREATED_AT: b.created_at, ETAG: b.etag || null } };
  }
  const file = localPath(ev.PUBLIC_ID);
  if (!fs.existsSync(file)) return { ok: false, reason: 'Upload not received yet' };
  const buf = fs.readFileSync(file);
  const s = sniff(buf);
  if (!s) return { ok: false, reason: 'File is not a recognised image' };
  if (buf.length > c.uploadMaxImageMb * 1048576) return { ok: false, reason: 'File too large' };
  return { ok: true, meta: { BYTES: buf.length, WIDTH: s.width, HEIGHT: s.height, FORMAT: s.mime.split('/')[1], SHA256: crypto.createHash('sha256').update(buf).digest('hex') } };
}

function localPath(publicId) {
  const c = config();
  const safe = String(publicId).replace(/[^A-Za-z0-9_\-/]/g, '_');
  return path.join(c.evidenceLocalDir, safe + '.bin');
}

function viewUrl(ev) {
  const c = config();
  if (ev.STORAGE_MODE === 'cloudinary') {
    const toSign = `${ev.PUBLIC_ID}.${ev.FORMAT || 'jpg'}`;
    return { url: `https://res.cloudinary.com/${c.cloudinary.cloudName}/image/authenticated/${deliverySignature(toSign, c.cloudinary.apiSecret)}/${toSign}`, kind: 'SIGNED_AUTHENTICATED_URL' };
  }
  return { url: null, kind: 'STREAM' };
}

module.exports = { signUpload, verify, validateRequest, localPath, viewUrl, sniff, cloudinarySign, deliverySignature, MIME };
