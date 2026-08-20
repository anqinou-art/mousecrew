const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { AgentRuntime } = require('../src/lib/agent-runtime');
const { normalizeAgent } = require('../src/config');

// A stand-in for a CLI process. The runtime is handed its spawn function, and the
// production path calls the very same one — so these tests exercise real code, not a
// parallel implementation that happens to look similar.
function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.stdin.writable = true;
  proc.written = [];
  proc.stdin.on('data', (d) => proc.written.push(d.toString()));
  proc.kill = () => { proc.killed = true; proc.emit('close', 143); };
  proc.say = (obj) => proc.stdout.write(JSON.stringify(obj) + '\n');
  return proc;
}

function makeRuntime(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-rt-'));
  const procs = [];
  const cfg = normalizeAgent({
    id: 'tester', transport: 'local', runner: 'claude', workDir: dir,
    idleTimeoutMs: 60_000, turnIdleMs: 60_000, turnHardMs: 120_000, ...over,
  });
  const rt = new AgentRuntime(cfg, {
    dataDir: dir,
    spawn: () => { const p = fakeProcess(); procs.push(p); return p; },
  });
  return { rt, procs, dir };
}

test('a registered agent is not a running process until someone talks to it', () => {
  const { rt, procs } = makeRuntime();
  assert.equal(rt.state, 'stopped');
  assert.equal(procs.length, 0);
  assert.equal(rt.status().processAlive, false);
  rt.destroy();
});

test('the first message starts the process and delivers the turn', async () => {
  const { rt, procs } = makeRuntime();
  const p = rt.send('hello');
  assert.equal(procs.length, 1, 'lazy start fired');

  await new Promise((r) => setImmediate(r));
  procs[0].say({ type: 'result', result: 'hi back', session_id: 'sess-1' });

  const result = await p;
  assert.equal(result.text, 'hi back');
  assert.equal(rt.state, 'idle');
  assert.equal(rt.sessionId, 'sess-1');
  rt.destroy();
});

test('a message arriving mid-turn waits instead of interrupting', async () => {
  const { rt, procs } = makeRuntime();
  const first = rt.send('one');
  await new Promise((r) => setImmediate(r));
  const second = rt.send('two');

  assert.equal(rt.state, 'busy');
  assert.equal(rt.queue.length, 1, 'the second message is queued, not written');

  procs[0].say({ type: 'result', result: 'answer one' });
  assert.equal(await first, (await first));       // settle
  await new Promise((r) => setImmediate(r));
  procs[0].say({ type: 'result', result: 'answer two' });

  assert.equal((await second).text, 'answer two');
  rt.destroy();
});

test('a stale queued message is dropped at dequeue, not at enqueue', async () => {
  const { rt, procs } = makeRuntime();
  const busy = rt.send('keep me busy');
  await new Promise((r) => setImmediate(r));

  // Fresh when queued; settled by the time it reaches the front. Checking at enqueue
  // would find nothing wrong, which is exactly why the check lives at dequeue.
  let settled = false;
  const queued = rt.send('you have new work', { freshness: () => ({ skip: settled, reason: 'order already closed' }) });
  settled = true;

  procs[0].say({ type: 'result', result: 'done with the first' });
  await busy;

  const r = await queued;
  assert.equal(r.skipped, 'stale');
  assert.equal(r.text, '');
  assert.match(r.reason, /already closed/);
  rt.destroy();
});

test('a freshness check that throws still delivers — fail open', async () => {
  const { rt, procs } = makeRuntime();
  const p = rt.send('work', { freshness: () => { throw new Error('db locked'); } });
  await new Promise((r) => setImmediate(r));
  procs[0].say({ type: 'result', result: 'delivered anyway' });
  assert.equal((await p).text, 'delivered anyway');
  rt.destroy();
});

test('context is measured from per-call usage, not an end-of-turn roll-up', async () => {
  const { rt, procs } = makeRuntime({ contextLimit: 200_000 });
  const p = rt.send('hi');
  await new Promise((r) => setImmediate(r));

  procs[0].say({
    type: 'assistant',
    message: { usage: { input_tokens: 1000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 2000 }, content: [] },
  });
  assert.equal(rt.contextTokens, 53_000);

  // A later call in the same turn reports the window as it now stands — the level tracks
  // the window, not the number of tool rounds.
  procs[0].say({
    type: 'assistant',
    message: { usage: { input_tokens: 1200, cache_read_input_tokens: 54_000, cache_creation_input_tokens: 0 }, content: [] },
  });
  assert.equal(rt.contextTokens, 55_200);

  procs[0].say({ type: 'result', result: 'ok' });
  await p;
  rt.destroy();
});

test('exiting is not amnesia: the session id is persisted for the next wake', async () => {
  const { rt, procs, dir } = makeRuntime();
  const p = rt.send('remember me');
  await new Promise((r) => setImmediate(r));
  procs[0].say({ type: 'result', result: 'ok', session_id: 'sess-abc' });
  await p;

  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'session_tester.json'), 'utf8'));
  assert.equal(saved.sessionId, 'sess-abc');

  // Next start resumes that session — rotating a window is the same code path with the
  // resume deliberately skipped.
  rt.stop();
  const args = rt.buildSpawnArgs().args;
  assert.ok(args.includes('--resume'));
  assert.ok(args.includes('sess-abc'));
  rt.destroy();
});

test('rotating to a new session drops the resume', async () => {
  const { rt, procs } = makeRuntime();
  const p = rt.send('x');
  await new Promise((r) => setImmediate(r));
  procs[0].say({ type: 'result', result: 'ok', session_id: 'sess-old' });
  await p;

  const { previous } = rt.newSession();
  assert.equal(previous, 'sess-old');
  assert.equal(rt.sessionId, null);
  assert.equal(rt.contextTokens, 0);
  assert.ok(!rt.buildSpawnArgs().args.includes('--resume'));
  rt.destroy();
});

test('two crashes in a row drop the session instead of crash-looping on it', async () => {
  const { rt, procs } = makeRuntime();
  const first = rt.send('x').catch(() => {});
  await new Promise((r) => setImmediate(r));
  procs[0].say({ type: 'result', result: 'ok', session_id: 'poison' });
  await first;

  const events = [];
  rt.on('session:reset', (e) => events.push(e));

  rt._restartCount = 2;             // as if two restarts already failed
  rt.state = 'idle';
  rt._onExit(1);

  assert.equal(rt.sessionId, null, 'a suspect session is dropped');
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'repeated-crash');
  rt.destroy();
});

test('a result with nobody waiting is discarded, not handed to the next caller', async () => {
  const { rt, procs } = makeRuntime();
  const p = rt.send('x');
  await new Promise((r) => setImmediate(r));
  procs[0].say({ type: 'result', result: 'first' });
  await p;

  // Late output from a turn that already ended. Attaching it to whoever asks next would
  // answer one question with another question's answer.
  procs[0].say({ type: 'result', result: 'ghost' });
  assert.equal(rt.currentJob, null);
  assert.equal(rt.state, 'idle');
  rt.destroy();
});

test('a process that dies mid-turn returns what it managed to say', async () => {
  const { rt, procs } = makeRuntime();
  const p = rt.send('x');
  await new Promise((r) => setImmediate(r));
  procs[0].say({ type: 'assistant', message: { content: [{ type: 'text', text: 'half an ans' }] } });
  procs[0].emit('close', 1);

  const r = await p;
  assert.equal(r.text, 'half an ans');
  assert.equal(r.partial, true);
  rt.destroy();
});

test('destroy leaves no live timer behind', async () => {
  // Cleanup code can be the leak: stop() arms fallback kill timers, and in a test process
  // those are the only live handles — the run would sit there for their full duration.
  const { rt, procs } = makeRuntime();
  const p = rt.send('x').catch(() => {});
  await new Promise((r) => setImmediate(r));
  procs[0].say({ type: 'result', result: 'ok' });
  await p;
  rt.destroy();

  const live = process.getActiveResourcesInfo().filter((r) => r === 'Timeout');
  assert.equal(live.length, 0, `expected no live timers, found ${live.length}`);
});

test('status reports enough to act on without opening the database', () => {
  const { rt } = makeRuntime();
  const s = rt.status();
  for (const key of ['id', 'state', 'queueLength', 'processAlive', 'sessionId', 'context', 'sessionMessages']) {
    assert.ok(key in s, `status is missing ${key}`);
  }
  rt.destroy();
});
