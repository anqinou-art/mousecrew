const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rotation = require('../src/lib/rotation');

test('token measurement reads a bounded tail and uses the last reported model usage', () => {
  let read = null;
  const fsImpl = {
    openSync: () => 7,
    fstatSync: () => ({ size: 10 * 1024 * 1024 }),
    readSync: (fd, buffer, offset, length, position) => {
      read = { fd, length, position };
      const row = '\n' + JSON.stringify({
        message: { usage: {
          input_tokens: 30,
          cache_creation_input_tokens: 40,
          cache_read_input_tokens: 50,
          output_tokens: 999,
        } },
      });
      buffer.write(row);
      return Buffer.byteLength(row);
    },
    closeSync: () => {},
  };
  const tail = rotation.readTail('/large.jsonl', 1024, fsImpl);
  assert.deepEqual(read, { fd: 7, length: 1024, position: 10 * 1024 * 1024 - 1024 });
  assert.equal(rotation.measureTokens(tail), 120);

  const rows = [
    { message: { usage: { input_tokens: 10 } } },
    { type: 'progress' },
    { usage: { input_tokens: 11, cache_creation_input_tokens: 12, cache_read_input_tokens: 13 } },
  ].map(JSON.stringify).join('\n');
  assert.equal(rotation.measureTokens(rows), 36);
  assert.equal(rotation.measureTokens('{"type":"progress"}\nnot json'), null);
  assert.equal(rotation.measureTokens(JSON.stringify({ usage: { input_tokens: '100' } })), null);
});

test('marker measurement counts matching lines without passing config through a shell', () => {
  let call;
  const value = rotation.measureMarker('/tmp/transcript.jsonl', '"type":"compacted"', {
    exec: (command, args) => {
      call = { command, args };
      return '10\n';
    },
  });
  assert.equal(value, 10);
  assert.deepEqual(call, {
    command: 'grep',
    args: ['-F', '-c', '--', '"type":"compacted"', '/tmp/transcript.jsonl'],
  });
  assert.equal(rotation.measureMarker('/tmp/x', 'none', {
    exec: () => { const error = new Error('no match'); error.status = 1; throw error; },
  }), 0);
});

test('multiple rotation rules warn when either rule crosses and unreadable input stays null', () => {
  const record = { transcriptPath: '/tmp/session.jsonl' };
  const rules = [
    { kind: 'tokens', limit: 100 },
    { kind: 'marker', marker: 'compact', limit: 2 },
  ];
  assert.deepEqual(rotation.measure(record, rules, {
    read: () => JSON.stringify({ usage: { input_tokens: 90 } }),
    countMarker: () => 2,
  }), { kind: 'marker', value: 2, limit: 2, over: true });
  assert.deepEqual(rotation.measure(record, rules, {
    read: () => JSON.stringify({ usage: { input_tokens: 100 } }),
    countMarker: () => 0,
  }), { kind: 'tokens', value: 100, limit: 100, over: true });
  assert.equal(rotation.measure(record, rules, {
    read: () => { throw new Error('ENOENT'); },
    countMarker: () => { throw new Error('ENOENT'); },
  }), null);
});

test('session records are private, replace the previous session, and invalidate only a moved window', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-rotation-'));
  const record = {
    agent: '../scout', windowRef: '%1', sessionId: 'old',
    transcriptPath: '/tmp/old.jsonl', recordedAt: new Date(0).toISOString(),
  };
  const file = rotation.writeSessionRecord(dir, record);
  assert.equal(path.dirname(file), dir);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(rotation.readSessionRecord(dir, '../scout').sessionId, 'old');

  rotation.writeSessionRecord(dir, { ...record, sessionId: 'new' });
  assert.equal(rotation.readSessionRecord(dir, '../scout').sessionId, 'new');
  assert.equal(rotation.invalidateMovedRecord(dir, '../scout', ['%2']), false);
  assert.equal(fs.existsSync(file), true);
  assert.equal(rotation.invalidateMovedRecord(dir, '../scout', ['%1']), true);
  assert.equal(fs.existsSync(file), false);
});

test('rotation source requires the same window and session, and the reminder names the handoff and manual action', () => {
  const item = { kind: 'rotate', rotateWindowRef: '%1', rotateSessionId: 'session-a' };
  assert.equal(rotation.rotateSourceState(item, '%1', { sessionId: 'session-a' }), 'match');
  assert.equal(rotation.rotateSourceState(item, '%2', { sessionId: 'session-a' }), 'stale');
  assert.equal(rotation.rotateSourceState(item, '%1', { sessionId: 'session-b' }), 'stale');
  assert.equal(rotation.rotateSourceState(item, '%1', null), 'unknown');
  assert.equal(rotation.rotateSourceState({ kind: 'group' }, null, null), 'match');

  const now = new Date(2026, 8, 20, 10, 0, 0);
  const body = rotation.rotateBody('scout', {
    kind: 'tokens', value: 123000, limit: 120000, over: true,
  }, '/state/handoff', now);
  assert.match(body, /123000 context token\(s\), configured limit 120000/);
  assert.match(body, /\/state\/handoff\/scout-handoff\/2026-09-20\.md/);
  assert.match(body, /start a new session yourself/);
  assert.match(body, /only a reminder.*will not rotate/s);
  assert.equal(rotation.rotateKey('scout', 'session-a', now), 'rotate:scout:session-a:2026-09-20T10');
});
