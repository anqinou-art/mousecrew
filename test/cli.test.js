const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const rotation = require('../src/lib/rotation');

const CLI = path.join(__dirname, '..', 'bin', 'mousecrew.js');
const TOKEN = 'cli-test-token';

async function scriptedApi(t, replies) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : undefined });
      const next = replies.shift() || { status: 500, body: { error: 'unexpected request' } };
      res.writeHead(next.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(next.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(resolve);
  }));
  return { base: `http://127.0.0.1:${server.address().port}`, requests };
}

function runCli(args, base, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        MOUSECREW_URL: base,
        MOUSECREW_TOKEN: TOKEN,
        ...(options.env || {}),
      },
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

function localCrewRoot(t, agents = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'config.json'), '{}');
  fs.writeFileSync(path.join(root, 'agents.json'), JSON.stringify({
    agents: agents || [{
      id: 'scout', displayName: 'Scout', aliases: ['s'], transport: 'terminal',
      terminal: { adapter: 'fake' },
    }],
  }));
  return root;
}

test('advance stops at submitted instead of taking review for the assignee', async (t) => {
  const api = await scriptedApi(t, [{ body: { id: 'WO-001', status: 'submitted' } }]);
  const result = await runCli(['advance', 'WO-001', '-s', 'worker'], api.base);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /there is no next state/);
  assert.deepEqual(api.requests.map((r) => [r.method, r.path]), [['GET', '/api/orders/WO-001']]);
});

test('start cannot silently withdraw an order from review', async (t) => {
  const api = await scriptedApi(t, [{
    status: 409,
    body: { error: 'order is in review; withdraw it with the unfreeze endpoint' },
  }]);
  const result = await runCli(['start', 'WO-001', '-s', 'worker'], api.base);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unfreeze endpoint/);
  assert.deepEqual(api.requests[0], {
    method: 'POST', path: '/api/orders/WO-001/transition',
    body: { to_status: 'in_progress', actor: 'worker' },
  });
});

test('dispatch assigns first, then moves the order through the dispatch endpoint', async (t) => {
  const api = await scriptedApi(t, [
    { body: { id: 'WO-001', status: 'draft', assignee: 'worker' } },
    { body: { ok: true, order: { id: 'WO-001', status: 'assigned', assignee: 'worker' } } },
  ]);
  const result = await runCli(['dispatch', 'WO-001', '--assignee', 'worker', '-s', 'owner'], api.base);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(api.requests.map((r) => [r.method, r.path]), [
    ['POST', '/api/orders/WO-001/assign'],
    ['POST', '/api/orders/WO-001/dispatch'],
  ]);
  assert.equal(api.requests[0].body.assignee, 'worker');
  assert.equal(api.requests[1].body.actor, 'owner');
});

test('create dispatches work for someone else but starts work assigned to the actor', async (t) => {
  const delegatedApi = await scriptedApi(t, [
    { body: { id: 'WO-001', status: 'draft', assignee: 'worker' } },
    { body: { ok: true, order: { id: 'WO-001', status: 'assigned', assignee: 'worker' } } },
  ]);
  const delegated = await runCli([
    'create', '--title', 'delegated task', '--assignee', 'worker', '-s', 'owner',
  ], delegatedApi.base);
  assert.equal(delegated.code, 0, delegated.stderr);
  assert.deepEqual(delegatedApi.requests.map((r) => r.path), [
    '/api/orders', '/api/orders/WO-001/dispatch',
  ]);

  const selfApi = await scriptedApi(t, [
    { body: { id: 'WO-002', status: 'draft', assignee: 'worker' } },
    { body: { id: 'WO-002', status: 'in_progress' } },
  ]);
  const self = await runCli(['create', '--title', 'own task', '-s', 'worker'], selfApi.base);
  assert.equal(self.code, 0, self.stderr);
  assert.equal(selfApi.requests[1].path, '/api/orders/WO-002/transition');
  assert.equal(selfApi.requests[1].body.to_status, 'in_progress');
});

test('project commands pass -p through and list configured projects', async (t) => {
  const createApi = await scriptedApi(t, [
    { body: { id: 'APP-001', status: 'draft', assignee: null } },
  ]);
  const created = await runCli(['create', '-p', 'app', '--title', 'project task'], createApi.base);
  assert.equal(created.code, 0, created.stderr);
  assert.equal(createApi.requests[0].body.project_id, 'app');

  const listApi = await scriptedApi(t, [{ body: [] }]);
  const listed = await runCli(['list', '-p', 'app'], listApi.base);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(listApi.requests[0].path, '/api/orders?project_id=app');

  const projectsApi = await scriptedApi(t, [{ body: [
    { id: 'app', name: 'Application', prefix: 'APP' },
  ] }]);
  const projects = await runCli(['projects'], projectsApi.base);
  assert.equal(projects.code, 0, projects.stderr);
  assert.equal(projectsApi.requests[0].path, '/api/projects');
  assert.match(projects.stdout, /app\s+Application\s+APP/);
});

test('accept identifies the actor, and cancellation sends an explicit intent and reason', async (t) => {
  const acceptApi = await scriptedApi(t, [
    { body: { ok: true, from: 'assigned', to: 'in_progress', order: { status: 'in_progress' } } },
  ]);
  const accepted = await runCli(['accept', 'WO-001', '-s', 'worker'], acceptApi.base);
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.deepEqual(acceptApi.requests[0].body, { actor: 'worker' });

  const cancelApi = await scriptedApi(t, [
    { body: { id: 'WO-002', status: 'in_progress', timeline: [] } },
    { body: { id: 'WO-002', status: 'closed' } },
  ]);
  const cancelled = await runCli(['cancel', 'WO-002', '-s', 'owner', 'no longer needed'], cancelApi.base);
  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.deepEqual(cancelApi.requests[1].body, {
    to_status: 'closed', actor: 'owner', comment: 'no longer needed', cancelled: true,
  });
});

test('cancel fails closed on a missing reason, and review work requires --void', async (t) => {
  const emptyApi = await scriptedApi(t, []);
  const noReason = await runCli(['cancel', 'WO-001', '-s', 'owner'], emptyApi.base);
  assert.equal(noReason.code, 1);
  assert.match(noReason.stderr, /cancellation reason/);
  assert.equal(emptyApi.requests.length, 0);

  const reviewApi = await scriptedApi(t, [
    { body: { id: 'WO-002', status: 'auditing', timeline: [] } },
  ]);
  const noVoid = await runCli(['cancel', 'WO-002', '-s', 'gate', 'obsolete'], reviewApi.base);
  assert.equal(noVoid.code, 1);
  assert.match(noVoid.stderr, /use --void/);
  assert.equal(reviewApi.requests.length, 1);

  const voidApi = await scriptedApi(t, [
    { body: { id: 'WO-003', status: 'auditing', timeline: [] } },
    { body: { id: 'WO-003', status: 'closed' } },
  ]);
  const voided = await runCli(['cancel', 'WO-003', '--void', '-s', 'gate', 'obsolete'], voidApi.base);
  assert.equal(voided.code, 0, voided.stderr);
  assert.equal(voidApi.requests[1].body.comment, 'obsolete');
  assert.equal(voidApi.requests[1].body.cancelled, true);
});

test('audit decisions require the reviewer to name the revision', async (t) => {
  const missingApi = await scriptedApi(t, []);
  const missing = await runCli(['audit-pass', 'WO-001', '-s', 'auditor'], missingApi.base);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /--rev/);
  assert.equal(missingApi.requests.length, 0);

  const passApi = await scriptedApi(t, [{ body: { status: 'pending_restart' } }]);
  const passed = await runCli(['audit-pass', 'WO-001', '-s', 'auditor', '--rev', '2'], passApi.base);
  assert.equal(passed.code, 0, passed.stderr);
  assert.equal(passApi.requests[0].body.audit_revision, 2);

  const failApi = await scriptedApi(t, [{ body: { status: 'rejected' } }]);
  const failed = await runCli(['audit-fail', 'WO-001', '-s', 'auditor', '--rev', '2', 'needs changes'], failApi.base);
  assert.equal(failed.code, 0, failed.stderr);
  assert.equal(failApi.requests[0].body.audit_revision, 2);
});

test('unfreeze requires an actor and reason, and show calls out the frozen snapshot', async (t) => {
  const unfreezeApi = await scriptedApi(t, [{ body: { unfrozen_revision: 3 } }]);
  const result = await runCli([
    'unfreeze', 'WO-001', '-s', 'worker', '--reason', 'replace delivery',
  ], unfreezeApi.base);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(unfreezeApi.requests[0].body, { actor: 'worker', reason: 'replace delivery' });

  const showApi = await scriptedApi(t, [{ body: {
    id: 'WO-001', frozen: 1, audit_revision: 3,
    revisions: [{ audit_revision: 3, commit_hash: 'abc123' }],
  } }]);
  const shown = await runCli(['show', 'WO-001'], showApi.base);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /frozen at rev 3 \(commit abc123\)/);
});

test('restart-done passes named ids through and exits nonzero when any order is skipped', async (t) => {
  const api = await scriptedApi(t, [{ body: {
    closed: ['WO-001'],
    skipped: [{ id: 'WO-002', reason: 'commit-not-in-deploy-tree' }],
    unchecked: ['WO-001'],
    no_commit: [],
  } }]);
  const result = await runCli(['restart-done', 'WO-001', 'WO-002', '-s', 'operator'], api.base);

  assert.equal(result.code, 1);
  assert.deepEqual(api.requests[0].body, { actor: 'operator', ids: ['WO-001', 'WO-002'] });
  assert.match(result.stdout, /closed: WO-001/);
  assert.match(result.stdout, /unchecked.*WO-001/);
  assert.match(result.stderr, /skipped WO-002: commit-not-in-deploy-tree/);
});

test('rotate uses the graceful endpoint and does not claim an unverified success', async (t) => {
  const api = await scriptedApi(t, [{ body: { queued: true } }]);
  const result = await runCli(['rotate', 'backend'], api.base);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(api.requests.map((r) => [r.method, r.path]), [
    ['POST', '/api/agents/backend/session/rotate'],
  ]);
  assert.match(result.stdout, /queued/);
  assert.match(result.stdout, /status/);
  assert.doesNotMatch(result.stdout, /success|succeeded/i);
});

test('status distinguishes pending, verified, and failed rotations and names activity sources', async (t) => {
  const api = await scriptedApi(t, [{ body: {
    checking: { transport: 'local', state: 'starting', rotationStatus: 'pending_confirmation', rotationWaitMs: 12_345, lastRotate: null },
    complete: { transport: 'local', state: 'idle', rotationStatus: 'verified', lastRotate: { ok: true, from: 'a', to: 'b' } },
    failed: { transport: 'local', state: 'idle', rotationStatus: 'failed', lastRotate: { ok: false, from: 'e', to: null } },
    hooked: { transport: 'terminal', state: 'busy', detail: { source: 'hook' } },
    fallback: { transport: 'terminal', state: 'idle', detail: { source: 'screen' } },
  } }]);
  const result = await runCli(['status'], api.base);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /checking[\s\S]*rotation pending confirmation \(waiting 12s\)/);
  assert.match(result.stdout, /complete[\s\S]*last rotation verified: a -> b/);
  assert.match(result.stdout, /failed[\s\S]*last rotation failed: e -> -/);
  assert.match(result.stdout, /hooked[^\n]*activity hook/);
  assert.match(result.stdout, /fallback[^\n]*activity screen/);
});

test('session-record accepts the three window sources, replaces the agent record, and keeps it private', async (t) => {
  const root = localCrewRoot(t);
  const env = { MOUSECREW_ROOT: root, MOUSECREW_WINDOW: '%env', TMUX_PANE: '%tmux' };
  const hook = (session) => JSON.stringify({
    session_id: session,
    transcript_path: path.join(root, `${session}.jsonl`),
    cwd: root,
  });
  const calls = [
    { args: ['session-record', '--as', 'Scout', '--window', '%flag'], input: hook('flag'), windowRef: '%flag' },
    { args: ['session-record', '--as', 's'], input: hook('env'), windowRef: '%env' },
    {
      args: ['session-record', '--as', 'scout'], input: hook('tmux'), windowRef: '%tmux',
      env: { ...env, MOUSECREW_WINDOW: '' },
    },
  ];

  const file = rotation.sessionRecordPath(path.join(root, 'data', 'sessions'), 'scout');
  for (const call of calls) {
    const result = await runCli(call.args, 'http://unused', {
      input: call.input,
      env: call.env || env,
    });
    assert.equal(result.code, 0, result.stderr);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(record.agent, 'scout');
    assert.equal(record.sessionId, JSON.parse(call.input).session_id);
    assert.equal(record.windowRef, call.windowRef);
  }
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('session-record rejects malformed or incomplete hook input without creating a record', async (t) => {
  const root = localCrewRoot(t);
  const env = { MOUSECREW_ROOT: root, MOUSECREW_WINDOW: '%1' };
  const file = rotation.sessionRecordPath(path.join(root, 'data', 'sessions'), 'scout');
  const valid = await runCli(['session-record', '--as', 'scout'], 'http://unused', {
    env,
    input: JSON.stringify({ session_id: 'old', transcript_path: '/tmp/old.jsonl' }),
  });
  assert.equal(valid.code, 0, valid.stderr);
  assert.equal(fs.existsSync(file), true);

  for (const input of [
    '{not json',
    JSON.stringify({ transcript_path: '/tmp/transcript.jsonl' }),
    JSON.stringify({ session_id: 'session-a', transcript_path: '   ' }),
  ]) {
    const result = await runCli(['session-record', '--as', 'scout'], 'http://unused', { env, input });
    assert.equal(result.code, 1);
    assert.equal(fs.existsSync(file), false, 'a failed SessionStart cannot leave the old session current');
  }
});

test('session-activity updates only the matching SessionStart record', async (t) => {
  const root = localCrewRoot(t);
  const env = { MOUSECREW_ROOT: root, MOUSECREW_WINDOW: '%1' };
  const file = rotation.sessionRecordPath(path.join(root, 'data', 'sessions'), 'scout');
  const started = await runCli(['session-record', '--as', 'scout'], 'http://unused', {
    env,
    input: JSON.stringify({ session_id: 'session-a', transcript_path: '/tmp/a.jsonl' }),
  });
  assert.equal(started.code, 0, started.stderr);

  for (const state of ['busy', 'idle']) {
    const result = await runCli(['session-activity', '--as', 'scout', state], 'http://unused', {
      env, input: JSON.stringify({ session_id: 'session-a' }),
    });
    assert.equal(result.code, 0, result.stderr);
    const activity = JSON.parse(fs.readFileSync(file, 'utf8')).activity;
    assert.equal(activity.state, state);
    assert.equal(activity.windowRef, '%1');
    assert.equal(activity.sessionId, 'session-a');
    assert.ok(Date.parse(activity.recordedAt));
  }

  const before = fs.readFileSync(file, 'utf8');
  const wrongSession = await runCli(['session-activity', '--as', 'scout', 'busy'], 'http://unused', {
    env, input: JSON.stringify({ session_id: 'session-b' }),
  });
  assert.equal(wrongSession.code, 0, wrongSession.stderr);
  assert.match(wrongSession.stdout, /ignored/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  const wrongWindow = await runCli([
    'session-activity', '--as', 'scout', 'busy', '--window', '%2',
  ], 'http://unused', {
    env, input: JSON.stringify({ session_id: 'session-a' }),
  });
  assert.equal(wrongWindow.code, 0, wrongWindow.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  const invalid = await runCli(['session-activity', '--as', 'scout', 'working'], 'http://unused', {
    env, input: JSON.stringify({ session_id: 'session-a' }),
  });
  assert.equal(invalid.code, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('an old activity hook cannot replace a newer SessionStart record', async (t) => {
  const root = localCrewRoot(t);
  const env = { MOUSECREW_ROOT: root, MOUSECREW_WINDOW: '%1' };
  const file = rotation.sessionRecordPath(path.join(root, 'data', 'sessions'), 'scout');
  const oldStart = await runCli(['session-record', '--as', 'scout'], 'http://unused', {
    env,
    input: JSON.stringify({ session_id: 'session-a', transcript_path: '/tmp/a.jsonl' }),
  });
  assert.equal(oldStart.code, 0, oldStart.stderr);

  const signal = path.join(root, 'idle-before-rename');
  const shim = path.join(root, 'delay-idle-rename.cjs');
  fs.writeFileSync(shim, `
const fs = require('fs');
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  const text = fs.readFileSync(from, 'utf8');
  if (text.includes('"sessionId": "session-a"') && text.includes('"state": "idle"')) {
    fs.writeFileSync(process.env.MOUSECREW_TEST_SIGNAL, 'ready');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  return rename(from, to);
};
`);
  const oldIdle = runCli(['session-activity', '--as', 'scout', 'idle'], 'http://unused', {
    env: { ...env, NODE_OPTIONS: `--require=${shim}`, MOUSECREW_TEST_SIGNAL: signal },
    input: JSON.stringify({ session_id: 'session-a' }),
  });
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(signal) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(signal), true, 'old activity reached its commit point');

  const newStart = await runCli(['session-record', '--as', 'scout'], 'http://unused', {
    env,
    input: JSON.stringify({ session_id: 'session-b', transcript_path: '/tmp/b.jsonl' }),
  });
  assert.equal(newStart.code, 0, newStart.stderr);
  const newBusy = await runCli(['session-activity', '--as', 'scout', 'busy'], 'http://unused', {
    env, input: JSON.stringify({ session_id: 'session-b' }),
  });
  assert.equal(newBusy.code, 0, newBusy.stderr);
  const oldResult = await oldIdle;
  assert.equal(oldResult.code, 0, oldResult.stderr);

  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(record.sessionId, 'session-b');
  assert.equal(record.transcriptPath, '/tmp/b.jsonl');
  assert.equal(record.activity.state, 'busy');
  assert.equal(record.activity.sessionId, 'session-b');
});

test('a session writer recovers after the previous lock owner exits', async (t) => {
  const root = localCrewRoot(t);
  const env = { MOUSECREW_ROOT: root, MOUSECREW_WINDOW: '%1' };
  const dir = path.join(root, 'data', 'sessions');
  const file = rotation.sessionRecordPath(dir, 'scout');
  const lock = `${file}.lock`;
  const oldStart = await runCli(['session-record', '--as', 'scout'], 'http://unused', {
    env,
    input: JSON.stringify({ session_id: 'session-a', transcript_path: '/tmp/a.jsonl' }),
  });
  assert.equal(oldStart.code, 0, oldStart.stderr);

  const shim = path.join(root, 'exit-before-activity-commit.cjs');
  fs.writeFileSync(shim, `
const fs = require('fs');
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  const pending = JSON.parse(fs.readFileSync(from, 'utf8'));
  if (pending.activity) process.exit(73);
  return rename.apply(fs, arguments);
};
`);
  const interrupted = await runCli([
    'session-activity', '--as', 'scout', 'idle',
  ], 'http://unused', {
    env: { ...env, NODE_OPTIONS: `--require=${shim}` },
    input: JSON.stringify({ session_id: 'session-a' }),
  });
  assert.equal(interrupted.code, 73);
  assert.equal(fs.existsSync(lock), true);

  const newStart = await runCli(['session-record', '--as', 'scout'], 'http://unused', {
    env,
    input: JSON.stringify({ session_id: 'session-b', transcript_path: '/tmp/b.jsonl' }),
  });
  assert.equal(newStart.code, 0, newStart.stderr);
  const newBusy = await runCli(['session-activity', '--as', 'scout', 'busy'], 'http://unused', {
    env, input: JSON.stringify({ session_id: 'session-b' }),
  });
  assert.equal(newBusy.code, 0, newBusy.stderr);

  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(record.sessionId, 'session-b');
  assert.equal(record.transcriptPath, '/tmp/b.jsonl');
  assert.equal(record.activity.state, 'busy');
  assert.equal(record.activity.sessionId, 'session-b');
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(`${lock}.reclaim`), false);
});

test('session-record keeps an encoded-looking id separate from the id that encodes to it', async (t) => {
  const ids = ['../scout', 'id-Li4vc2NvdXQ'];
  const root = localCrewRoot(t, ids.map((id, index) => ({
    id,
    displayName: index ? 'Beta' : 'Alpha',
    transport: 'terminal',
    terminal: { adapter: 'fake' },
  })));
  const dir = path.join(root, 'data', 'sessions');

  for (const [index, id] of ids.entries()) {
    const result = await runCli([
      'session-record', '--as', id, '--window', `%${index + 1}`,
    ], 'http://unused', {
      env: { MOUSECREW_ROOT: root },
      input: JSON.stringify({
        session_id: `session-${index + 1}`,
        transcript_path: `/tmp/session-${index + 1}.jsonl`,
      }),
    });
    assert.equal(result.code, 0, result.stderr);
  }

  const files = ids.map((id) => rotation.sessionRecordPath(dir, id));
  assert.notEqual(files[0], files[1]);
  assert.ok(files.every((file) => path.dirname(file) === dir && fs.existsSync(file)));
  assert.deepEqual(ids.map((id) => rotation.readSessionRecord(dir, id).sessionId), [
    'session-1', 'session-2',
  ]);
});
