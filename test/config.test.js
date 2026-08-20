const test = require('node:test');
const assert = require('node:assert');
const { validateAgents } = require('../src/config');

const ok = (agents) => validateAgents(agents).errors;

test('a minimal valid roster passes', () => {
  assert.deepEqual(ok([
    { id: 'backend', transport: 'local', workDir: '/tmp/x' },
  ]), []);
});

test('a mention that is a prefix of another mention is refused at startup', () => {
  // Substring matching is what lets people type "@arch, take a look" in a sentence.
  // The cost is that "@arch" also fires inside "@architect". Rather than guess at match
  // time, refuse the roster — the failure would otherwise be an agent that wakes up for
  // messages addressed to someone else, which reads as flakiness, not misconfiguration.
  const errors = ok([
    { id: 'arch', transport: 'local', workDir: '/tmp/a' },
    { id: 'architect', transport: 'local', workDir: '/tmp/b' },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /@arch.*contained in.*@architect/);
});

test('a prefix within one agent\'s own aliases is fine', () => {
  assert.deepEqual(ok([
    { id: 'frontend', displayName: 'frontend', aliases: ['front', 'fe'], transport: 'local', workDir: '/tmp/f' },
  ]), []);
});

test('two agents cannot claim the same mention', () => {
  const errors = ok([
    { id: 'a', displayName: 'dev', transport: 'local', workDir: '/tmp/a' },
    { id: 'b', aliases: ['dev'], transport: 'local', workDir: '/tmp/b' },
  ]);
  assert.ok(errors.some((e) => /claimed by both/.test(e)));
});

test('the merge gate must be single', () => {
  const errors = ok([
    { id: 'a', transport: 'local', workDir: '/tmp/a', canMerge: true },
    { id: 'b', transport: 'local', workDir: '/tmp/b', canMerge: true },
  ]);
  assert.ok(errors.some((e) => /merge gate must be single/.test(e)));
});

test('structural mistakes are caught with a usable message', () => {
  const errors = ok([
    { id: 'x', transport: 'teleport', workDir: '/tmp/x' },
    { id: 'y', transport: 'local', runner: 'exec', workDir: '/tmp/y' },
    { id: 'z', transport: 'terminal' },
    { id: 'w', transport: 'local' },
    { id: 'v', transport: 'local', workDir: '/tmp/v', repos: 'myrepo' },
  ]);
  assert.ok(errors.some((e) => /transport "teleport"/.test(e)));
  assert.ok(errors.some((e) => /exec.command/.test(e)));
  assert.ok(errors.some((e) => /terminal\.adapter/.test(e)));
  assert.ok(errors.some((e) => /local agents need a workDir/.test(e)));
  assert.ok(errors.some((e) => /repos must be an array/.test(e)));
});

test('duplicate ids are caught', () => {
  const errors = ok([
    { id: 'dup', transport: 'local', workDir: '/tmp/a' },
    { id: 'dup', transport: 'local', workDir: '/tmp/b' },
  ]);
  assert.ok(errors.some((e) => /duplicate id/.test(e)));
});

test('an empty roster is an error, not an empty crew', () => {
  assert.ok(validateAgents([]).errors.length);
});
