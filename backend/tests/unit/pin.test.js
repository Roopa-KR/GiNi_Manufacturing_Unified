'use strict';
/* Cross-language PIN compatibility: hashes created by seed/seedops.py (scrypt$16384$8$1$<salt hex>$<digest hex>) verify in Node. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { verifyPin, hashPin } = require('../../src/lib/pin');

const SEED = path.join(__dirname, '..', '..', 'seed');
function pyHash(pin) {
  return execFileSync(process.env.PYTHON || 'python3', ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import seedops as O; print(O.hash_pin(sys.argv[2]))', SEED, pin], { encoding: 'utf8' }).trim();
}
function pyVerify(pin, h) {
  return execFileSync(process.env.PYTHON || 'python3', ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import seedops as O; print(O.verify_pin(sys.argv[2], sys.argv[3]))', SEED, pin, h], { encoding: 'utf8' }).trim() === 'True';
}

test('Python-created hash verifies in Node; wrong PIN fails', async () => {
  const h = pyHash('482913');
  assert.match(h, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(await verifyPin('482913', h), true);
  assert.equal(await verifyPin('482914', h), false);
});

test('leading zeros are part of the PIN (string, not number)', async () => {
  const h = pyHash('007809');
  assert.equal(await verifyPin('007809', h), true);
  assert.equal(await verifyPin('7809', h), false);
  assert.equal(await verifyPin(7809, h), false);
});

test('Node-created hash verifies in Python', async () => {
  const h = await hashPin('000123');
  assert.equal(pyVerify('000123', h), true);
  assert.equal(pyVerify('123', h), false);
});

test('malformed or out-of-bounds hashes are rejected, not thrown', async () => {
  assert.equal(await verifyPin('1', 'bcrypt$whatever'), false);
  assert.equal(await verifyPin('1', 'scrypt$1048576$8$1$00$00'), false);
  assert.equal(await verifyPin('1', ''), false);
  assert.equal(await verifyPin('1', null), false);
});
