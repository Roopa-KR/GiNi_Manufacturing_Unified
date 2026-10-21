'use strict';
/*
 * PIN / password verification compatible with seed/seedops.py hash_pin():
 *   scrypt$16384$8$1$<salt hex (16 bytes)>$<digest hex (32 bytes)>   (hashlib.scrypt(pin.encode(), salt, n, r, p, dklen=32))
 * PINs are strings (leading zeros preserved). Parameters are bounded to prevent resource exhaustion from a crafted hash.
 */
const crypto = require('crypto');

const LIMITS = { maxN: 1 << 17, maxR: 16, maxP: 4, saltBytes: [8, 64], keyBytes: [16, 64] };

function parse(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, nS, rS, pS, saltHex, digestHex] = parts;
  const N = Number(nS), r = Number(rS), p = Number(pS);
  if (![N, r, p].every(Number.isInteger)) return null;
  if (N < 2 || N > LIMITS.maxN || (N & (N - 1)) !== 0 || r < 1 || r > LIMITS.maxR || p < 1 || p > LIMITS.maxP) return null;
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(digestHex) || saltHex.length % 2 || digestHex.length % 2) return null;
  const salt = Buffer.from(saltHex, 'hex'), digest = Buffer.from(digestHex, 'hex');
  if (salt.length < LIMITS.saltBytes[0] || salt.length > LIMITS.saltBytes[1] || digest.length < LIMITS.keyBytes[0] || digest.length > LIMITS.keyBytes[1]) return null;
  return { N, r, p, salt, digest };
}

function scryptAsync(secret, salt, keylen, opts) {
  return new Promise((resolve, reject) => crypto.scrypt(secret, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

async function verifyPin(pin, stored) {
  const h = parse(stored);
  if (!h || typeof pin !== 'string' || pin.length === 0 || pin.length > 256) return false;
  const maxmem = 128 * h.N * h.r * h.p + 1024 * 1024;
  const key = await scryptAsync(Buffer.from(pin, 'utf8'), h.salt, h.digest.length, { N: h.N, r: h.r, p: h.p, maxmem });
  return key.length === h.digest.length && crypto.timingSafeEqual(key, h.digest);
}

async function hashPin(pin, salt = crypto.randomBytes(16)) {
  if (typeof pin !== 'string') throw new TypeError('PIN must be a string (leading zeros are significant)');
  const key = await scryptAsync(Buffer.from(pin, 'utf8'), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** a valid dummy hash so unknown accounts take the same time as wrong PINs (no user enumeration by timing). */
const DUMMY = 'scrypt$16384$8$1$00000000000000000000000000000000$' + '00'.repeat(32);

module.exports = { verifyPin, hashPin, parse, DUMMY };
