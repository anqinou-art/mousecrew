const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load, validateAgents, validateProjects } = require('../src/config');

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

test('two local agents cannot resolve to the same workDir', () => {
  const errors = ok([
    { id: 'a', transport: 'local', workDir: '/tmp/mousecrew-shared' },
    { id: 'b', transport: 'local', workDir: '/tmp/../tmp/mousecrew-shared' },
  ]);
  assert.ok(errors.some((error) => /agent "b".*agent "a".*mousecrew-shared/.test(error)));
});

test('terminal input-box detection only accepts a known reader', () => {
  assert.deepEqual(ok([
    { id: 'term', transport: 'terminal', terminal: { adapter: 'tmux', inputBox: 'claude-code' } },
  ]), []);
  assert.ok(ok([
    { id: 'term', transport: 'terminal', terminal: { adapter: 'tmux', inputBox: 'unknown-cli' } },
  ]).some((error) => /terminal\.inputBox must be "claude-code"/.test(error)));
});

test('the old verifyRepos array is refused with the object format in the error', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, 'config.json');
  const agentsFile = path.join(dir, 'agents.json');
  fs.writeFileSync(configFile, JSON.stringify({ verifyRepos: ['/tmp/repo'] }));
  fs.writeFileSync(agentsFile, JSON.stringify({
    agents: [{ id: 'worker', transport: 'local', workDir: '/tmp/worker' }],
  }));

  assert.throws(
    () => load({ configFile, agentsFile, root: dir }),
    /verifyRepos: expected an object keyed by repo.*\{ "repo": \["\/path\/to\/clone"\] \}/,
  );
});

test('delivery batching config has defaults and refuses invalid types at startup', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-delivery-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const agentsFile = path.join(dir, 'agents.json');
  fs.writeFileSync(agentsFile, JSON.stringify({
    agents: [{ id: 'worker', transport: 'local', workDir: '/tmp/worker' }],
  }));
  const defaultsFile = path.join(dir, 'config-defaults.json');
  fs.writeFileSync(defaultsFile, '{}');
  assert.deepEqual(load({ configFile: defaultsFile, agentsFile, root: dir }).config.delivery, {
    stalePendingMs: 600000,
    maxPending: 200,
    batchGroup: true,
    inlineLimit: 600,
    forceOnExpiry: true,
    forcedGraceMs: 120000,
    draftQuietMs: 120000,
    forcedDraftHoldMs: 90000,
    wakeDir: null,
    wakeMaxContent: 600,
    wakeSettleMs: 5000,
    rotationPollMs: 300000,
  });
  for (const [delivery, expected] of [
    [{ batchGroup: 'yes' }, /delivery\.batchGroup must be a boolean/],
    [{ inlineLimit: 0 }, /delivery\.inlineLimit must be a positive integer/],
    [{ forceOnExpiry: 'yes' }, /delivery\.forceOnExpiry must be a boolean/],
    [{ forcedGraceMs: 0 }, /delivery\.forcedGraceMs must be a positive integer/],
    [{ draftQuietMs: 0 }, /delivery\.draftQuietMs must be a positive integer/],
    [{ forcedDraftHoldMs: -1 }, /delivery\.forcedDraftHoldMs must be a non-negative integer/],
    [{ wakeDir: '' }, /delivery\.wakeDir must be a non-empty path/],
    [{ wakeMaxContent: 0 }, /delivery\.wakeMaxContent must be a positive integer/],
    [{ wakeSettleMs: -1 }, /delivery\.wakeSettleMs must be a non-negative integer/],
    [{ rotationPollMs: 0 }, /delivery\.rotationPollMs must be a positive integer/],
  ]) {
    const configFile = path.join(dir, `config-${Object.keys(delivery)[0]}.json`);
    fs.writeFileSync(configFile, JSON.stringify({ delivery }));
    assert.throws(() => load({ configFile, agentsFile, root: dir }), expected);
  }
});

test('terminal rotation accepts one or more known rules and rejects incomplete rules', () => {
  const terminal = (rotation) => [{
    id: 'term', transport: 'terminal', terminal: { adapter: 'fake', rotation },
  }];
  assert.deepEqual(ok(terminal({ kind: 'tokens', limit: 120000 })), []);
  assert.deepEqual(ok(terminal([
    { kind: 'tokens', limit: 120000 },
    { kind: 'marker', marker: '"type":"compacted"', limit: 10 },
  ])), []);

  for (const [rotation, expected] of [
    [[], /must contain at least one rule/],
    [{ kind: 'bytes', limit: 10 }, /kind must be "tokens" or "marker"/],
    [{ kind: 'tokens', limit: 0 }, /limit must be a positive integer/],
    [{ kind: 'marker', limit: 2 }, /marker must be a non-empty string/],
  ]) {
    assert.ok(ok(terminal(rotation)).some((error) => expected.test(error)));
  }
});

test('a configured wake directory is resolved from the config root', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-wake-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, 'config.json');
  const agentsFile = path.join(dir, 'agents.json');
  fs.writeFileSync(configFile, JSON.stringify({ delivery: { wakeDir: './state/wake' } }));
  fs.writeFileSync(agentsFile, JSON.stringify({
    agents: [{ id: 'worker', transport: 'terminal', terminal: { adapter: 'fake' } }],
  }));

  assert.equal(load({ configFile, agentsFile, root: dir }).config.delivery.wakeDir,
    path.join(dir, 'state', 'wake'));
});

test('context-watch token and handoff-age thresholds are optional validated config', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-context-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const agentsFile = path.join(dir, 'agents.json');
  fs.writeFileSync(agentsFile, JSON.stringify({
    agents: [{ id: 'worker', transport: 'local', workDir: '/tmp/worker' }],
  }));
  const write = (name, contextWatch) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify({ contextWatch }));
    return file;
  };

  const defaults = load({ configFile: write('defaults.json', {}), agentsFile, root: dir }).config.contextWatch;
  assert.equal(defaults.thresholdTokens, null);
  assert.equal(defaults.handoffMaxAgeDays, 7);
  assert.equal(load({ configFile: write('set.json', { thresholdTokens: 120000, handoffMaxAgeDays: 3 }), agentsFile, root: dir }).config.contextWatch.thresholdTokens, 120000);
  assert.throws(() => load({ configFile: write('bad-token.json', { thresholdTokens: 0 }), agentsFile, root: dir }), /thresholdTokens/);
  assert.throws(() => load({ configFile: write('bad-age.json', { handoffMaxAgeDays: -1 }), agentsFile, root: dir }), /handoffMaxAgeDays/);
});

test('draft hold timing only constrains rosters that enable input-box detection', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-draft-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, 'config.json');
  const agentsFile = path.join(dir, 'agents.json');
  fs.writeFileSync(configFile, JSON.stringify({ delivery: { forcedGraceMs: 60000 } }));
  fs.writeFileSync(agentsFile, JSON.stringify({
    agents: [{ id: 'worker', transport: 'terminal', terminal: { adapter: 'fake' } }],
  }));

  assert.equal(load({ configFile, agentsFile, root: dir }).config.delivery.forcedGraceMs, 60000,
    'an existing short grace remains valid while the new gate is disabled');

  fs.writeFileSync(agentsFile, JSON.stringify({
    agents: [{
      id: 'worker', transport: 'terminal',
      terminal: { adapter: 'fake', inputBox: 'claude-code' },
    }],
  }));
  assert.throws(
    () => load({ configFile, agentsFile, root: dir }),
    /delivery\.forcedDraftHoldMs must be shorter than delivery\.forcedGraceMs when terminal\.inputBox is enabled/,
  );

  fs.writeFileSync(configFile, JSON.stringify({ delivery: { forcedGraceMs: 120000 } }));
  assert.equal(load({ configFile, agentsFile, root: dir }).config.delivery.forcedDraftHoldMs, 90000);
});

test('an empty roster is an error, not an empty crew', () => {
  assert.ok(validateAgents([]).errors.length);
});

test('projects require unique ids and unique 2-5 letter uppercase prefixes', () => {
  assert.deepEqual(validateProjects([
    { id: 'app', name: 'Application', prefix: 'APP' },
    { id: 'docs', name: 'Documentation', prefix: 'DOCS' },
  ]).errors, []);

  const errors = validateProjects([
    { id: 'app', name: 'Application', prefix: 'app' },
    { id: 'app', name: 'Second app', prefix: 'DOC' },
    { id: 'docs', name: 'Documentation', prefix: 'DOC' },
  ]).errors;
  assert.ok(errors.some((error) => /prefix "app" must be 2-5 uppercase letters/.test(error)));
  assert.ok(errors.some((error) => /duplicate id/.test(error)));
  assert.ok(errors.some((error) => /prefix "DOC" is also used by "app"/.test(error)));
});
