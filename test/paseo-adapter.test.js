const test = require('node:test');
const assert = require('node:assert/strict');
const { createPaseoAdapter } = require('../adapters/terminal/paseo');
const { createAdapter, validateAdapter } = require('../adapters/terminal');

function fakeExec(responses = []) {
  const calls = [];
  const exec = async (args) => {
    calls.push(args);
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response === undefined ? '' : response;
  };
  return { exec, calls };
}

test('Paseo lists every terminal and uses its fixed name as identity', async () => {
  const h = fakeExec([JSON.stringify([
    { id: 'full-terminal-id', name: 'scout', cwd: '/work' },
    { id: 'unnamed-id', name: '', cwd: '/tmp' },
  ])]);
  const adapter = createPaseoAdapter({ exec: h.exec });

  assert.deepEqual(await adapter.listWindows(), [
    { ref: 'full-terminal-id', identity: 'scout', title: null },
    { ref: 'unnamed-id', identity: null, title: null },
  ]);
  assert.deepEqual(h.calls, [['terminal', 'ls', '--all', '--json']]);
  assert.deepEqual(validateAdapter(adapter), { ok: true, errors: [] });
  assert.equal(createAdapter('paseo', { exec: async () => '[]' }).name, 'paseo');
});

test('Paseo accepts an existing matching name and explains immutable identity', async () => {
  const matching = fakeExec([JSON.stringify([{ id: 'term-1', name: 'scout', cwd: '/work' }])]);
  await createPaseoAdapter({ exec: matching.exec }).setIdentity('term-1', 'scout');

  const different = fakeExec([JSON.stringify([{ id: 'term-1', name: 'builder', cwd: '/work' }])]);
  await assert.rejects(
    createPaseoAdapter({ exec: different.exec }).setIdentity('term-1', 'scout'),
    /fixed when created; create a new terminal named "scout"/,
  );
  await assert.rejects(
    createPaseoAdapter().clearIdentity('term-1'),
    /close the terminal to release its identity/,
  );
});

test('Paseo captures the requested tail and sends text literally without submitting it', async () => {
  const h = fakeExec([JSON.stringify({
    terminalId: 'term-1', lines: ['older', 'last line', '', ''], totalLines: 4,
  }), '', '']);
  const adapter = createPaseoAdapter({ exec: h.exec });

  assert.equal(await adapter.readScreen('term-1', 2), 'older\nlast line');
  await adapter.sendText('term-1', '-first\r\nsecond\rthird');
  await adapter.sendKey('term-1', 'enter');

  assert.deepEqual(h.calls, [
    ['terminal', 'capture', 'term-1', '--start', '-2', '--json'],
    ['terminal', 'send-keys', 'term-1', '--literal', '--', '-first\nsecond\nthird'],
    ['terminal', 'send-keys', 'term-1', 'Enter'],
  ]);
  await assert.rejects(adapter.sendKey('term-1', 'delete'), /unsupported key "delete"/);
});

test('Paseo availability fails closed when its command cannot run', async () => {
  const h = fakeExec([new Error('ENOENT')]);
  assert.equal(await createPaseoAdapter({ exec: h.exec }).available(), false);
  assert.deepEqual(h.calls, [['--version']]);
});
