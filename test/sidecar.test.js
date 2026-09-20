const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Sidecar } = require('../src/lib/sidecar');
const { createFakeAdapter } = require('../adapters/terminal/fake');
const { buildIdentity } = require('../src/lib/identity');
const { load, normalizeAgent } = require('../src/config');
const core = require('../src/lib/sidecar-core');

// These drive the engine against an in-memory terminal and assert its structured events.
//
// Nothing here reads a rendered screen. A screen assertion answers two questions at once —
// did we do the right thing, and did the terminal draw it — and cannot tell you which one
// went wrong. Exactly one test in this package reads a real screen (terminal-live.test.js)
// and it exists for the one question these cannot answer: whether characters arrive.

const CREW = [
  { id: 'architect', displayName: 'lead', transport: 'terminal', terminal: { adapter: 'fake', target: 'lead' } },
  { id: 'builder', displayName: 'builder', transport: 'terminal', terminal: { adapter: 'fake', target: 'builder' } },
  { id: 'server-side', displayName: 'server-side', transport: 'local', workDir: '/tmp' },
].map(normalizeAgent);

function harness({ windows, now, options } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-sidecar-'));
  const adapter = createFakeAdapter({
    windows: windows || [
      { ref: '%1', identity: 'lead', screen: '> ' },
      { ref: '%2', identity: 'builder', screen: '> ' },
    ],
  });
  const acks = [];
  const presences = [];
  let history = [];
  const client = {
    history: async () => history,
    ack: async (agent, dmId, status) => { acks.push({ agent, dmId, status }); },
    presence: async (report) => { presences.push(report); },
  };
  let clock = now || 1_000_000;
  const sc = new Sidecar(
    { adapter, identity: buildIdentity(CREW), agents: CREW, client, statePath: path.join(dir, 'state.json'), now: () => clock },
    { postInjectMs: 0, ...(options || {}) },
  );
  const events = [];
  sc.on('event', (e) => events.push(e));
  return {
    sc, adapter, events, acks, presences, dir,
    setHistory: (h) => { history = h; },
    advance: (ms) => { clock += ms; },
    of: (type) => events.filter((e) => e.type === type),
  };
}

const msg = (sender, content, ts = '2026-08-20T12:00:00Z') => ({ content, ts, metadata: { sender } });

/** Get past the baseline pass, which deliberately delivers nothing. */
function primed(h) {
  h.sc.ingest([], 'history');
  return h;
}

// ---------- intake ----------

test('the first history batch only sets a baseline', async () => {
  // Otherwise a restarting sidecar types the entire backlog into every window: every one
  // of those messages is new to the process and none of them are new to the crew.
  const h = harness();
  h.sc.ingest([msg('human', '@lead old message one'), msg('human', '@builder old message two', '2026-08-20T12:00:01Z')], 'history');
  assert.equal(h.sc.state.pending.length, 0);
  assert.equal(h.of('bootstrapped').length, 1);
  assert.equal(h.of('queued').length, 0);
});

test('after the baseline, an addressed message is queued', async () => {
  const h = primed(harness());
  h.sc.ingest([msg('human', '@lead please look')], 'sse');
  assert.equal(h.of('queued').length, 1);
  assert.equal(h.of('queued')[0].agent, 'architect');
});

test('the same message from both channels is queued once', async () => {
  const h = primed(harness());
  const m = msg('human', '@builder hello');
  h.sc.ingest([m], 'sse');
  h.sc.ingest([{ content: m.content, ts: m.ts, metadata: JSON.stringify({ sender: 'human' }) }], 'history');
  assert.equal(h.of('queued').length, 1);
});

test("a crew member's own message is not queued back to it", async () => {
  // The production bug, at the level that matters: end to end, not just in the pure function.
  const h = primed(harness());
  h.sc.ingest([msg('architect', '@lead note to self, and @builder you look too')], 'sse');
  const queued = h.of('queued').map((e) => e.agent);
  assert.deepEqual(queued, ['builder']);
});

test('order cards are not delivered to windows', async () => {
  const h = primed(harness());
  h.sc.ingest([{ content: '{"type":"order_card"}', ts: '2026-08-20T12:00:02Z', metadata: { sender: 'system', type: 'order_card' } }], 'sse');
  assert.equal(h.of('queued').length, 0);
});

// ---------- delivery ----------

test('an idle window receives the message, and the queue empties', async () => {
  const h = primed(harness());
  h.sc.ingest([msg('human', '@lead the deploy is red')], 'sse');
  await h.sc.deliver();

  const injected = h.of('injected');
  assert.equal(injected.length, 1);
  assert.equal(injected[0].agent, 'architect');
  assert.equal(h.sc.state.pending.length, 0);

  const typed = h.adapter.__test.sentTo('%1').join('');
  assert.match(typed, /the deploy is red/);
  assert.match(typed, /say --as architect/);
  assert.deepEqual(h.adapter.__test.window('%1').keys, ['enter'], 'the message is submitted, not left sitting');
});

test('a busy window is left alone and the message waits', async () => {
  const h = primed(harness({ windows: [{ ref: '%1', identity: 'lead', screen: 'working… (esc to interrupt)' }] }));
  h.sc.ingest([msg('human', '@lead when you get a moment')], 'sse');
  await h.sc.deliver();

  assert.equal(h.of('busy-wait').length, 1);
  assert.equal(h.of('injected').length, 0);
  assert.equal(h.sc.state.pending.length, 1, 'still queued, not dropped');
  assert.equal(h.adapter.__test.sentTo('%1').length, 0);
});

test('...and it lands once the window frees up', async () => {
  const h = primed(harness({ windows: [{ ref: '%1', identity: 'lead', screen: 'working… (esc to interrupt)' }] }));
  h.sc.ingest([msg('human', '@lead later then')], 'sse');
  await h.sc.deliver();
  h.adapter.__test.setScreen('%1', '> ');
  await h.sc.deliver();
  assert.equal(h.of('injected').length, 1);
});

test('an unregistered window is waited for, not treated as an error', async () => {
  const h = primed(harness({ windows: [{ ref: '%1', identity: null, screen: '> ' }] }));
  h.sc.ingest([msg('human', '@lead anyone home')], 'sse');
  await h.sc.deliver();
  assert.equal(h.of('no-window')[0].reason, 'unclaimed');
  assert.equal(h.sc.state.pending.length, 1);
});

test('two windows claiming one identity is refused rather than guessed', async () => {
  const h = primed(harness({
    windows: [{ ref: '%1', identity: 'builder', screen: '> ' }, { ref: '%2', identity: 'builder', screen: '> ' }],
  }));
  h.sc.ingest([msg('human', '@builder which of you')], 'sse');
  await h.sc.deliver();
  assert.equal(h.of('no-window')[0].reason, 'ambiguous');
  assert.equal(h.of('injected').length, 0);
  assert.equal(h.adapter.__test.sentTo('%1').length + h.adapter.__test.sentTo('%2').length, 0);
});

test('a failed injection keeps the message queued', async () => {
  const h = primed(harness());
  h.adapter.sendText = async () => { throw new Error('window went away'); };
  h.sc.ingest([msg('human', '@lead hello')], 'sse');
  await h.sc.deliver();
  assert.equal(h.of('inject-failed').length, 1);
  assert.equal(h.sc.state.pending.length, 1, 'dropping it here would lose a message nobody could trace');
});

test('five consecutive group messages are injected and persisted as one batch', async () => {
  const h = primed(harness());
  h.sc.ingest(Array.from({ length: 5 }, (_, i) => (
    msg('human', `@lead message ${i + 1}`, `2026-08-20T12:00:0${i}Z`)
  )), 'sse');
  let saves = 0;
  const save = h.sc._saveState.bind(h.sc);
  h.sc._saveState = () => { saves += 1; save(); };

  await h.sc.deliver();

  assert.equal(h.adapter.__test.sentTo('%1').length, 1);
  assert.deepEqual(h.adapter.__test.window('%1').keys, ['enter']);
  assert.equal(h.of('injected')[0].count, 5);
  assert.equal(h.sc.state.pending.length, 0);
  assert.equal(saves, 1, 'the successful batch is persisted once after it leaves the queue');
});

test('group, group, direct, group keeps order across three deliveries', async () => {
  const h = primed(harness());
  h.sc.queue({ agent: 'architect', kind: 'group', sender: 'one', content: 'first' });
  h.sc.queue({ agent: 'architect', kind: 'group', sender: 'two', content: 'second' });
  h.sc.queue({ agent: 'architect', kind: 'dm', sender: 'three', content: 'private', dmId: 'dm-batch' });
  h.sc.queue({ agent: 'architect', kind: 'group', sender: 'four', content: 'last' });

  await h.sc.deliver();
  await h.sc.deliver();
  await h.sc.deliver();

  const sent = h.adapter.__test.sentTo('%1');
  assert.equal(sent.length, 3);
  assert.ok(sent[0].indexOf('first') < sent[0].indexOf('second'));
  assert.match(sent[1], /\[direct\].*private/);
  assert.match(sent[2], /\[group\].*last/);
  assert.deepEqual(h.of('injected').map((event) => event.count), [2, 1, 1]);
  assert.deepEqual(h.acks, [{ agent: 'architect', dmId: 'dm-batch', status: 'delivered' }]);
});

test('a failed batch injection keeps every message for the next pass', async () => {
  const h = primed(harness());
  h.sc.ingest(Array.from({ length: 5 }, (_, i) => (
    msg('human', `@lead retry ${i + 1}`, `2026-08-20T12:01:0${i}Z`)
  )), 'sse');
  const sendText = h.adapter.sendText.bind(h.adapter);
  h.adapter.sendText = async () => { throw new Error('window went away'); };

  await h.sc.deliver();
  assert.equal(h.sc.state.pending.length, 5);
  h.adapter.sendText = sendText;
  await h.sc.deliver();

  assert.equal(h.adapter.__test.sentTo('%1').length, 1);
  assert.equal(h.of('injected')[0].count, 5);
  assert.equal(h.sc.state.pending.length, 0);
});

test('long delivery text is stored privately and the injected prefix points to it', async () => {
  const h = primed(harness({ options: { inlineLimit: 40 } }));
  h.sc.queue({ agent: 'architect', kind: 'group', sender: 'one', content: 'first' });
  h.sc.queue({ agent: 'architect', kind: 'group', sender: 'two', content: 'second' });
  const full = core.batchEnvelope({ items: h.sc.state.pending, agent: 'architect' });
  const body = core.batchBody(h.sc.state.pending);

  await h.sc.deliver();

  const injected = h.adapter.__test.sentTo('%1')[0];
  const match = injected.match(/read the full message before replying: (.+)\]\n  — reply with:/);
  assert.ok(match, injected);
  assert.equal(injected.startsWith(`[group batch] 2 messages delivered together\n${body.slice(0, 40)}`), true);
  assert.equal(injected.length, 40
    + `[group batch] 2 messages delivered together\n\n\n[truncated — read the full message before replying: ${match[1]}]`
      .concat('\n  — reply with: mousecrew say --as architect "..."').length);
  assert.equal(fs.readFileSync(match[1], 'utf8'), full);
  assert.equal(fs.statSync(match[1]).mode & 0o777, 0o600);
});

test('inline limit applies to the body rather than envelope overhead', async () => {
  const h = primed(harness({ options: { inlineLimit: 40 } }));
  h.sc.queue({ agent: 'architect', kind: 'group', sender: 'human', content: 'x'.repeat(40) });

  await h.sc.deliver();

  assert.equal(h.of('body-save-failed').length, 0);
  assert.equal(h.adapter.__test.sentTo('%1')[0], core.envelope({
    kind: 'group', agent: 'architect', sender: 'human', content: 'x'.repeat(40),
  }));
  assert.equal(fs.existsSync(path.join(h.dir, 'inbox')), false);
});

test('a body-file failure falls back to injecting the complete text', async () => {
  const h = primed(harness({ options: { inlineLimit: 20 } }));
  h.sc.queue({ agent: 'architect', kind: 'group', sender: 'human', content: 'complete me'.repeat(20) });
  const full = core.batchEnvelope({ items: h.sc.state.pending, agent: 'architect' });
  const blocker = path.join(h.dir, 'not-a-directory');
  fs.writeFileSync(blocker, 'x');
  h.sc.statePath = path.join(blocker, 'state.json');

  await h.sc.deliver();

  assert.equal(h.adapter.__test.sentTo('%1')[0], full);
  assert.equal(h.of('body-save-failed').length, 1);
  assert.equal(h.sc.state.pending.length, 0);
});

test('loaded agent ids cannot navigate long-message writes outside the state inbox', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-inbox-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const [id, expectedPartition] of [
    ['worker', 'worker'],
    ['../../outside', `id-${Buffer.from('../../outside').toString('base64url')}`],
  ]) {
    const caseDir = path.join(root, expectedPartition);
    const configFile = path.join(caseDir, 'config.json');
    const agentsFile = path.join(caseDir, 'agents.json');
    fs.mkdirSync(caseDir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ delivery: { inlineLimit: 10 } }));
    fs.writeFileSync(agentsFile, JSON.stringify({ agents: [{
      id, displayName: 'target', transport: 'terminal',
      terminal: { adapter: 'fake', target: 'target' },
    }] }));
    const { config, agents } = load({ configFile, agentsFile, root: caseDir });
    const adapter = createFakeAdapter({ windows: [{ ref: '%1', identity: 'target', screen: '> ' }] });
    const statePath = path.join(caseDir, 'state', 'state.json');
    const sc = new Sidecar({
      adapter, identity: buildIdentity(agents), agents, client: {}, statePath,
    }, {
      postInjectMs: 0,
      batchGroup: config.delivery.batchGroup,
      inlineLimit: config.delivery.inlineLimit,
    });
    sc.queue({ agent: id, kind: 'group', sender: 'human', content: 'complete body' });

    await sc.deliver();

    const injected = adapter.__test.sentTo('%1')[0];
    const bodyFile = injected.match(/read the full message before replying: (.+)\]\n/)[1];
    const inbox = path.join(caseDir, 'state', 'inbox');
    assert.equal(path.relative(inbox, bodyFile).startsWith('..'), false, bodyFile);
    assert.equal(path.relative(inbox, bodyFile).split(path.sep)[0], expectedPartition);
    assert.equal(fs.readFileSync(bodyFile, 'utf8'), core.envelope({
      kind: 'group', agent: id, sender: 'human', content: 'complete body',
    }));
    assert.equal(sc.state.pending.length, 0);
  }
});

test('batchGroup false preserves one-message-per-pass delivery', async () => {
  const h = primed(harness({ options: { batchGroup: false } }));
  h.sc.queue({ agent: 'architect', kind: 'group', sender: 'one', content: 'first' });
  h.sc.queue({ agent: 'architect', kind: 'group', sender: 'two', content: 'second' });

  await h.sc.deliver();

  assert.equal(h.adapter.__test.sentTo('%1').length, 1);
  assert.equal(h.of('injected')[0].count, 1);
  assert.equal(h.sc.state.pending.length, 1);
});

// ---------- shelf life ----------

test('a message held by a busy window for ten minutes is forced once and delivered', async () => {
  const h = primed(harness({ windows: [{ ref: '%1', identity: 'lead', screen: 'busy (esc to interrupt)' }] }));
  h.sc.ingest([msg('human', '@lead urgent an hour ago')], 'sse');
  await h.sc.deliver();
  h.advance(11 * 60 * 1000);
  await h.sc.deliver();

  assert.equal(h.adapter.__test.sentTo('%1').length, 1);
  assert.equal(h.of('forced').length, 1);
  assert.equal(h.of('forced-injected')[0].count, 1);
  assert.equal(h.sc.state.pending.length, 0);
});

test('a forced group batch does not carry a fresh group message through the busy gate', async () => {
  const h = primed(harness({ windows: [{ ref: '%1', identity: 'lead', screen: 'busy (esc to interrupt)' }] }));
  h.sc.queue({ agent: 'architect', kind: 'group', sender: 'one', content: 'stale and forced' });
  h.advance(11 * 60 * 1000);
  h.sc.queue({ agent: 'architect', kind: 'group', sender: 'two', content: 'fresh and waiting' });

  await h.sc.deliver();

  const sent = h.adapter.__test.sentTo('%1');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /stale and forced/);
  assert.doesNotMatch(sent[0], /fresh and waiting/);
  assert.deepEqual(h.sc.state.pending.map((item) => item.content), ['fresh and waiting']);
});

test('an expired direct message with no window is acknowledged without a forced attempt', async () => {
  // A dropped group message is still in the group history. A dropped direct message looks,
  // from the sender's side, exactly like being ignored.
  const h = primed(harness({ windows: [{ ref: '%2', identity: 'builder', screen: '> ' }] }));
  h.sc.ingestDirect({ target: 'architect', dmId: 'dm-1', sender: 'human', content: 'just between us' });
  h.advance(11 * 60 * 1000);
  await h.sc.deliver();

  assert.deepEqual(h.acks, [{ agent: 'architect', dmId: 'dm-1', status: 'expired' }]);
  assert.equal(h.of('forced').length, 0);
  assert.equal(h.sc.state.pending.length, 0);
});

test('a failed forced attempt is persisted first, never retried, then expires after grace', async () => {
  const h = primed(harness({
    windows: [{ ref: '%1', identity: 'lead', screen: 'busy (esc to interrupt)' }],
    options: { forcedGraceMs: 120000 },
  }));
  h.sc.ingestDirect({ target: 'architect', dmId: 'dm-force-fail', sender: 'human', content: 'important' });
  h.advance(11 * 60 * 1000);
  let attempts = 0;
  let persisted;
  h.adapter.sendText = async () => {
    attempts += 1;
    persisted = JSON.parse(fs.readFileSync(h.sc.statePath, 'utf8'));
    throw new Error('terminal write failed');
  };

  await h.sc.deliver();

  assert.ok(persisted.pending[0].forcedTriedAt, 'the attempt is durable before terminal IO');
  assert.equal(attempts, 1);
  assert.equal(h.sc.state.pending.length, 1);
  assert.equal(h.acks.length, 0);

  h.adapter.__test.setScreen('%1', '> ');
  await h.sc.deliver();
  assert.equal(attempts, 1, 'becoming idle cannot turn the spent forced attempt into a normal retry');

  h.advance(120001);
  await h.sc.deliver();
  assert.equal(attempts, 1);
  assert.equal(h.sc.state.pending.length, 0);
  assert.deepEqual(h.acks, [{ agent: 'architect', dmId: 'dm-force-fail', status: 'expired' }]);
});

test('three expired direct messages merge into one forced injection and three receipts', async () => {
  const h = primed(harness({ windows: [{ ref: '%1', identity: 'lead', screen: 'busy (esc to interrupt)' }] }));
  for (const [dmId, content] of [['dm-a', 'first'], ['dm-b', 'second'], ['dm-c', 'third']]) {
    h.sc.ingestDirect({ target: 'architect', dmId, sender: 'human', content });
  }
  h.advance(11 * 60 * 1000);

  await h.sc.deliver();

  const sent = h.adapter.__test.sentTo('%1');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /first[\s\S]*second[\s\S]*third/);
  assert.equal(h.of('forced-injected')[0].count, 3);
  assert.deepEqual(h.acks, [
    { agent: 'architect', dmId: 'dm-a', status: 'delivered' },
    { agent: 'architect', dmId: 'dm-b', status: 'delivered' },
    { agent: 'architect', dmId: 'dm-c', status: 'delivered' },
  ]);
});

test('an idle injection failure expires without gaining forced delivery', async () => {
  const h = primed(harness());
  h.sc.queue({ agent: 'architect', kind: 'group', sender: 'human', content: 'cannot inject' });
  let attempts = 0;
  h.adapter.sendText = async () => { attempts += 1; throw new Error('terminal write failed'); };
  await h.sc.deliver();
  h.advance(11 * 60 * 1000);

  await h.sc.deliver();

  assert.equal(attempts, 1);
  assert.equal(h.of('forced').length, 0);
  assert.equal(h.of('expired').length, 1);
  assert.equal(h.sc.state.pending.length, 0);
});

test('forceOnExpiry false preserves immediate expiry without interruption', async () => {
  const h = primed(harness({
    windows: [{ ref: '%1', identity: 'lead', screen: 'busy (esc to interrupt)' }],
    options: { forceOnExpiry: false },
  }));
  h.sc.queue({ agent: 'architect', kind: 'group', sender: 'human', content: 'old behaviour' });
  h.advance(11 * 60 * 1000);

  await h.sc.deliver();

  assert.equal(h.adapter.__test.sentTo('%1').length, 0);
  assert.equal(h.of('forced').length, 0);
  assert.equal(h.of('expired').length, 1);
  assert.equal(h.sc.state.pending.length, 0);
});

test('a delivered direct message is acknowledged too', async () => {
  const h = primed(harness());
  h.sc.ingestDirect({ target: 'architect', dmId: 'dm-2', sender: 'human', content: 'you there?' });
  await h.sc.deliver();
  assert.deepEqual(h.acks, [{ agent: 'architect', dmId: 'dm-2', status: 'delivered' }]);
  assert.match(h.adapter.__test.sentTo('%1').join(''), /reply --as architect/);
});

// ---------- persistence ----------

test('the queue survives a restart', async () => {
  const h = primed(harness({ windows: [{ ref: '%1', identity: 'lead', screen: 'busy (esc to interrupt)' }] }));
  h.sc.ingest([msg('human', '@lead remember me')], 'sse');
  await h.sc.deliver();

  const statePath = h.sc.statePath;
  const mode = fs.statSync(statePath).mode & 0o777;
  assert.equal(mode, 0o600, 'the queue holds message bodies and is as private as they were');

  const revived = new Sidecar(
    { adapter: h.adapter, identity: buildIdentity(CREW), agents: CREW, client: { history: async () => [] }, statePath, now: () => 1_000_000 },
    { postInjectMs: 0 },
  );
  assert.equal(revived.state.pending.length, 1);
  assert.equal(revived.state.bootstrapped, true, 'and it does not re-baseline and swallow the backlog again');
});

// ---------- presence ----------

test('presence: no window is "stopped", not "idle"', async () => {
  const h = primed(harness({ windows: [{ ref: '%1', identity: 'builder', screen: '> ' }] }));
  const report = await h.sc.reportPresence();
  assert.equal(report.architect.state, 'stopped', 'we cannot see it — that is not the same as free');
  assert.equal(report.builder.state, 'idle');
});

test('presence uses the same screen reading as delivery back-pressure', async () => {
  // So the dashboard can never say "idle" about an agent the sidecar is holding messages
  // back from.
  const h = primed(harness({ windows: [{ ref: '%1', identity: 'lead', screen: 'running (esc to interrupt)' }] }));
  const report = await h.sc.reportPresence();
  assert.equal(report.architect.state, 'busy');

  h.sc.ingest([msg('human', '@lead hi')], 'sse');
  await h.sc.deliver();
  assert.equal(h.of('busy-wait').length, 1, 'delivery agrees with the report');
});

test('presence only covers terminal crew members', async () => {
  const h = primed(harness());
  const report = await h.sc.reportPresence();
  assert.ok(!('server-side' in report), 'the server knows its own processes; this would be a second opinion with less information');
});

test('a presence report is sent upstream', async () => {
  const h = primed(harness());
  await h.sc.reportPresence();
  assert.equal(h.presences.length, 1);
  assert.equal(h.presences[0].builder.state, 'idle');
});

// ---------- receipts survive a failing endpoint ----------

test('a receipt that cannot be sent is kept and retried, not lost', async () => {
  // The reason undelivered direct messages are reported at all is that silence looks
  // exactly like being ignored. A receipt attempted once and dropped on failure puts the
  // system back in precisely that state — and by then the queue entry is gone, so nothing
  // would ever try again.
  const h = primed(harness({
    windows: [{ ref: '%1', identity: 'lead', screen: 'busy (esc to interrupt)' }],
    options: { forceOnExpiry: false },
  }));
  let failing = true;
  h.sc.client.ack = async (agent, dmId, status) => {
    if (failing) throw new Error('server unreachable');
    h.acks.push({ agent, dmId, status });
  };

  h.sc.ingestDirect({ target: 'architect', dmId: 'dm-9', sender: 'human', content: 'still there?' });
  h.advance(11 * 60 * 1000);
  await h.sc.deliver();

  assert.equal(h.acks.length, 0, 'the send failed');
  assert.equal(h.sc.state.acks.length, 1, 'and the debt is recorded rather than forgotten');
  assert.equal(h.of('ack-failed').length, 1);

  failing = false;
  await h.sc.deliver();
  assert.deepEqual(h.acks, [{ agent: 'architect', dmId: 'dm-9', status: 'expired' }]);
  assert.equal(h.sc.state.acks.length, 0, 'and it is only forgotten once it actually landed');
});

test('an owed receipt survives a restart', async () => {
  const h = primed(harness({
    windows: [{ ref: '%1', identity: 'lead', screen: 'busy (esc to interrupt)' }],
    options: { forceOnExpiry: false },
  }));
  h.sc.client.ack = async () => { throw new Error('down'); };
  h.sc.ingestDirect({ target: 'architect', dmId: 'dm-10', sender: 'human', content: 'hello' });
  h.advance(11 * 60 * 1000);
  await h.sc.deliver();

  const sent = [];
  const revived = new Sidecar({
    adapter: h.adapter, identity: buildIdentity(CREW), agents: CREW,
    client: { history: async () => [], ack: async (agent, dmId, status) => { sent.push({ agent, dmId, status }); } },
    statePath: h.sc.statePath, now: () => 1_000_000,
  }, { postInjectMs: 0 });
  await revived.flushAcks();
  assert.deepEqual(sent, [{ agent: 'architect', dmId: 'dm-10', status: 'expired' }]);
});
