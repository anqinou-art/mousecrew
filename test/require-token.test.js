const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequireToken, readTokenFile, parseBearer, tokenMatches } = require('../src/lib/require-token');

// This is the front door. Everything here exists because the failure mode is silent:
// a guard that stops guarding does not throw, it just starts saying yes.

function fakeRes() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const reqWith = (auth) => ({ headers: auth ? { authorization: auth } : {} });

test('a correct token is accepted', () => {
  const guard = createRequireToken({ loadToken: () => 'secret-value' });
  const res = fakeRes();
  assert.equal(guard(reqWith('Bearer secret-value'), res, 'test'), true);
  assert.equal(res.statusCode, null, 'nothing was written on the happy path');
});

test('a wrong token is refused with 401', () => {
  const guard = createRequireToken({ loadToken: () => 'secret-value' });
  const res = fakeRes();
  assert.equal(guard(reqWith('Bearer wrong-value'), res, 'test'), false);
  assert.equal(res.statusCode, 401);
});

test('a missing header is refused', () => {
  const guard = createRequireToken({ loadToken: () => 'secret-value' });
  const res = fakeRes();
  assert.equal(guard(reqWith(null), res, 'test'), false);
  assert.equal(res.statusCode, 401);
});

test('an unreadable token file refuses everything — fail CLOSED', () => {
  // The one that matters most, and the one no other test in this package was covering:
  // if this branch ever returns true instead of false, every endpoint opens and the whole
  // suite still passes. Misconfiguration must not open the door.
  const guard = createRequireToken({ loadToken: () => { throw new Error('ENOENT'); } });
  const res = fakeRes();
  assert.equal(guard(reqWith('Bearer anything'), res, 'test'), false);
  assert.equal(res.statusCode, 401);
});

test('an empty configured token refuses everything rather than matching empty input', () => {
  const guard = createRequireToken({ loadToken: () => '' });
  for (const header of ['Bearer ', 'Bearer x', null]) {
    const res = fakeRes();
    assert.equal(guard(reqWith(header), res, 'test'), false);
    assert.equal(res.statusCode, 401);
  }
});

test('the 401 body never echoes the token back', () => {
  const guard = createRequireToken({ loadToken: () => 'secret-value' });
  const res = fakeRes();
  guard(reqWith('Bearer secret-value-but-longer'), res, 'test');
  assert.deepEqual(res.body, { error: 'unauthorized' });
});

test('comparison is length-safe and does not throw on mismatched lengths', () => {
  assert.equal(tokenMatches('short', 'much-longer-token'), false);
  assert.equal(tokenMatches('', 'x'), false);
  assert.equal(tokenMatches(null, 'x'), false);
  assert.equal(tokenMatches('x', null), false);
  assert.equal(tokenMatches('same', 'same'), true);
});

test('the Bearer scheme is parsed, and nothing else is accepted as one', () => {
  assert.equal(parseBearer('Bearer abc'), 'abc');
  assert.equal(parseBearer('bearer abc'), 'abc');
  assert.equal(parseBearer('Basic abc'), null);
  assert.equal(parseBearer(''), null);
  assert.equal(parseBearer(undefined), null);
});

test('a token file with permissions wider than owner-only is rejected', () => {
  // Already-shared secret. Accepting it would just file the problem away.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-tok-'));
  const file = path.join(dir, 'auth.json');
  fs.writeFileSync(file, JSON.stringify({ token: 'abc' }));
  fs.chmodSync(file, 0o644);
  assert.throws(() => readTokenFile(file), /group\/world accessible/);

  fs.chmodSync(file, 0o600);
  assert.equal(readTokenFile(file), 'abc');
});

test('a token file with no token field is an error, not an empty token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-tok-'));
  const file = path.join(dir, 'auth.json');
  fs.writeFileSync(file, JSON.stringify({ nope: 'abc' }), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  assert.throws(() => readTokenFile(file), /no "token" field/);
});
