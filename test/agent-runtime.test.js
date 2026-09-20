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

function makeRuntime(over = {}, deps = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-rt-'));
  const procs = [];
  const spawns = [];
  const cfg = normalizeAgent({
    id: 'tester', transport: 'local', runner: 'claude', workDir: dir,
    idleTimeoutMs: 60_000, turnIdleMs: 60_000, turnHardMs: 120_000, ...over,
  });
  const rt = new AgentRuntime(cfg, {
    dataDir: dir,
    spawn: (command, args) => {
      const p = fakeProcess();
      procs.push(p);
      spawns.push({ command, args });
      return p;
    },
    ...deps,
  });
  return { rt, procs, spawns, dir };
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

test('graceful rotation waits for the current answer, deduplicates requests, and drains queued work into the new process', async () => {
  const handoffRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-handoff-'));
  const handoffDir = path.join(handoffRoot, 'tester-handoff');
  fs.mkdirSync(handoffDir);
  fs.writeFileSync(path.join(handoffDir, '2026-09-20.md'), 'continue here');
  const { rt, procs, dir } = makeRuntime({}, {
    contextWatch: { handoffDir: handoffRoot, noHandoff: [], handoffMaxAgeDays: 7 },
  });
  const first = rt.send('current work');
  await new Promise((r) => setImmediate(r));
  procs[0].say({ type: 'system', subtype: 'init', session_id: 'old-session' });

  assert.deepEqual(rt.rotate(), { queued: true });
  assert.deepEqual(rt.rotate(), { queued: true });
  assert.equal(rt.status().rotateQueued, true);
  const later = rt.send('queued work');
  const after = rt.send('follow-up work');
  assert.equal(procs.length, 1);

  procs[0].say({ type: 'result', result: 'finished', session_id: 'old-session' });
  assert.equal((await first).text, 'finished');
  assert.equal(rt.status().rotateQueued, false);
  assert.equal(procs[0].written.length, 1, 'queued work must not reach the replaced process');

  rt.start();
  assert.equal(procs.length, 2, 'duplicate requests cause only one replacement');
  const written = procs[1].written.map((line) => JSON.parse(line).message.content);
  assert.match(written[0], /2026-09-20\.md/);
  assert.match(written[0], /queued work/);
  assert.equal(written.length, 1, 'the signpost and task share one managed turn');

  procs[1].say({ type: 'system', subtype: 'init', session_id: 'new-session' });
  assert.deepEqual(
    { ...rt.status().lastRotate, at: 'ignored' },
    { at: 'ignored', ok: true, from: 'old-session', to: 'new-session' },
  );
  assert.equal(rt.status().rotationStatus, 'verified');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, 'session_tester.json'), 'utf8')).sessionId,
    'new-session',
  );
  procs[1].say({ type: 'result', result: 'new answer', session_id: 'new-session' });
  assert.equal((await later).text, 'new answer');
  assert.equal(JSON.parse(procs[1].written[1]).message.content, 'follow-up work');
  procs[1].say({ type: 'result', result: 'follow-up answer', session_id: 'new-session' });
  assert.equal((await after).text, 'follow-up answer');
  rt.destroy();
});

test('rotation without handoffs sends the first task unchanged as one managed turn', async () => {
  const { rt, procs } = makeRuntime({}, {
    contextWatch: { noHandoff: ['tester'] },
  });
  rt.sessionId = 'old-session';
  rt.rotate();

  const task = rt.send('REAL TASK');
  assert.equal(procs[0].written.length, 1);
  assert.equal(JSON.parse(procs[0].written[0]).message.content, 'REAL TASK');

  procs[0].say({ type: 'system', subtype: 'init', session_id: 'new-session' });
  procs[0].say({ type: 'result', result: 'TASK ANSWER', session_id: 'new-session' });
  assert.equal((await task).text, 'TASK ANSWER');
  rt.destroy();
});

async function assertStaleTailIgnored(sameChunk) {
  const { rt, procs, spawns, dir } = makeRuntime({}, {
    contextWatch: { noHandoff: ['tester'] },
  });
  const first = rt.send('current work');
  await new Promise((r) => setImmediate(r));
  procs[0].say({ type: 'system', subtype: 'init', session_id: 'old-session' });
  assert.deepEqual(rt.rotate(), { queued: true });
  const later = rt.send('queued work');

  const result = JSON.stringify({ type: 'result', result: 'finished', session_id: 'old-session' }) + '\n';
  const staleInit = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'old-session' }) + '\n';
  if (sameChunk) procs[0].stdout.write(result + staleInit);
  else {
    procs[0].stdout.write(result);
    procs[0].stdout.write(staleInit);
  }

  assert.equal((await first).text, 'finished');
  assert.equal(rt.sessionId, null);
  assert.equal(rt.lastRotate, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'session_tester.json'), 'utf8')).sessionId, null);

  rt.start();
  assert.equal(spawns.length, 2);
  assert.equal(spawns[1].args.includes('--resume'), false);
  assert.equal(spawns[1].args.includes('old-session'), false);
  procs[1].say({ type: 'system', subtype: 'init', session_id: 'new-session' });
  assert.equal(rt.lastRotate.ok, true);
  procs[1].say({ type: 'result', result: 'new answer', session_id: 'new-session' });
  assert.equal((await later).text, 'new answer');
  rt.destroy();
}

test('old output cannot cross the generation boundary within one stdout chunk', async () => {
  await assertStaleTailIgnored(true);
});

test('old output in a later stdout chunk remains fenced out', async () => {
  await assertStaleTailIgnored(false);
});

test('rotation fails for the same session id and stale output cannot settle a replacement', async () => {
  const { rt, procs } = makeRuntime();
  const first = rt.send('work');
  await new Promise((r) => setImmediate(r));
  procs[0].say({ type: 'system', subtype: 'init', session_id: 'same-session' });
  procs[0].say({ type: 'result', result: 'done', session_id: 'same-session' });
  await first;

  assert.deepEqual(rt.rotate(), { queued: false, rotating: true });
  assert.equal(procs[0].killed, true, 'an idle runtime starts rotation immediately');

  rt.start();
  procs[0].say({ type: 'system', subtype: 'init', session_id: 'stale-session' });
  assert.equal(rt.lastRotate, null, 'discarded process output must not settle verification');
  procs[1].say({ type: 'system', subtype: 'init', session_id: 'same-session' });
  assert.equal(rt.lastRotate.ok, false);
  assert.equal(rt.lastRotate.from, 'same-session');
  assert.equal(rt.lastRotate.to, 'same-session');
  rt.destroy();
});

test('a new session id arriving after the deadline corrects rotation to late success', async () => {
  const { rt, procs } = makeRuntime({ rotateVerifyMs: 10 });
  rt.sessionId = 'old-session';
  assert.deepEqual(rt.rotate(), { queued: false, rotating: true });
  assert.equal(rt.status().rotationStatus, 'verifying');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(rt.lastRotate.ok, false);
  assert.equal(rt.lastRotate.from, 'old-session');
  assert.equal(rt.lastRotate.to, null);
  assert.equal(rt.status().rotationStatus, 'failed');

  procs[0].say({ type: 'system', subtype: 'init', session_id: 'new-session' });
  assert.equal(rt.lastRotate.ok, true);
  assert.equal(rt.lastRotate.to, 'new-session');
  assert.equal(rt.lastRotate.late, true);
  assert.equal(rt.status().rotationStatus, 'verified_late');
  rt.destroy();
});

test('the old session id arriving after the deadline keeps the failed result', async () => {
  const { rt, procs } = makeRuntime({ rotateVerifyMs: 10 });
  rt.sessionId = 'old-session';
  rt.rotate();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const failedAt = rt.lastRotate.at;

  procs[0].say({ type: 'system', subtype: 'init', session_id: 'old-session' });
  assert.deepEqual(rt.lastRotate, {
    at: failedAt, ok: false, from: 'old-session', to: null,
  });
  assert.equal(rt.status().rotationStatus, 'failed');
  rt.destroy();
});

test('a forced new session supersedes timed-out graceful verification', async () => {
  const { rt, procs } = makeRuntime({ rotateVerifyMs: 10 });
  rt.sessionId = 'original';
  rt.rotate();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const gracefulFailure = { ...rt.lastRotate };

  rt.newSession();
  rt.start();
  procs[1].say({ type: 'system', subtype: 'init', session_id: 'forced-new' });

  assert.equal(rt.sessionId, 'forced-new', 'the forced replacement still owns the session');
  assert.deepEqual(rt.lastRotate, gracefulFailure, 'its init cannot settle the earlier request');
  assert.equal(rt.status().rotationStatus, 'failed');
  const work = rt.send('FORCED WORK');
  assert.equal(JSON.parse(procs[1].written[0]).message.content, 'FORCED WORK',
    'the superseded graceful request cannot leave its briefing behind');
  procs[1].say({ type: 'result', result: 'done', session_id: 'forced-new' });
  await work;
  rt.destroy();
});

test('a forced new session also cancels a graceful request still queued behind work', async () => {
  const { rt, procs } = makeRuntime();
  const current = rt.send('current work');
  await new Promise((resolve) => setImmediate(resolve));
  procs[0].say({ type: 'system', subtype: 'init', session_id: 'original' });
  assert.deepEqual(rt.rotate(), { queued: true });

  rt.newSession();
  await assert.rejects(current, /rotate to a fresh session/);
  assert.equal(rt.status().rotateQueued, false);
  rt.start();
  procs[1].say({ type: 'system', subtype: 'init', session_id: 'forced-new' });

  assert.equal(rt.sessionId, 'forced-new');
  assert.equal(procs[1].killed, undefined, 'the cancelled graceful request cannot rotate again');
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
