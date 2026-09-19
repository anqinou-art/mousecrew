const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

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

function runCli(args, base) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, MOUSECREW_URL: base, MOUSECREW_TOKEN: TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('advance stops at submitted instead of taking review for the assignee', async (t) => {
  const api = await scriptedApi(t, [{ body: { id: 'WO-001', status: 'submitted' } }]);
  const result = await runCli(['advance', 'WO-001', '-s', 'worker'], api.base);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /there is no next state/);
  assert.deepEqual(api.requests.map((r) => [r.method, r.path]), [['GET', '/api/orders/WO-001']]);
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
