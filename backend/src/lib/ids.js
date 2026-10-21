'use strict';
const crypto = require('crypto');
function uid(prefix) { return `${prefix}-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(4).toString('hex').toUpperCase()}`; }
function token(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function hmac(secret, s) { return crypto.createHmac('sha256', secret).update(String(s)).digest('hex'); }
module.exports = { uid, token, sha256, hmac };
