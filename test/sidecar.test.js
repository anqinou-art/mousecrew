const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Sidecar } = require('../src/lib/sidecar');
const { createFakeAdapter } = require('../adapters/terminal/fake');
const { buildIdentity } = require('../src/lib/identity');
const { normalizeAgent } = require('../src/config');

// These drive the engine against an in-memory terminal and assert its structured events.
//
// Nothing here reads a rendered screen. A screen assertion answers two questions at once —
// did we do the right thing, and did the terminal draw it — and cannot tell you which one
// went wrong. Exactly one test in this package reads a real screen (terminal-live.test.js)
// and it exists for the one question these cannot answer: whether characters arrive.

const CREW = [
  { id: 'architect', displayName: '架构师', transport: 'terminal', terminal: { adapter: 'fake', target: '架构师' } },
  { id: 'codex', displayName: 'codex', transport: 'terminal', terminal: { adapter: 'fake', target: 'codex' } },
  { id: 'server-side', displayName: 'server-side', transport: 'local', workDir: '/tmp' },
].map(normalizeAgent);

function harness({ windows, now, options } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-sidecar-'));
  const adapter = createFakeAdapter({
    windows: windows || [
      { ref: '%1', identity: '架构师', screen: '> ' },
      { ref: '%2', identity: 'codex', screen: '> ' },
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
  h.sc.ingest([msg('rina', '@架构师 old message one'), msg('rina', '@codex old message two', '2026-08-20T12:00:01Z')], 'history');
  assert.equal(h.sc.state.pending.length, 0);
  assert.equal(h.of('bootstrapped').length, 1);
  assert.equal(h.of('queued').length, 0);
});

test('after the baseline, an addressed message is queued', async () => {
  const h = primed(harness());
  h.sc.ingest([msg('rina', '@架构师 please look')], 'sse');
  assert.equal(h.of('queued').length, 1);
  assert.equal(h.of('queued')[0].agent, 'architect');
});

test('the same message from both channels is queued once', async () => {
  const h = primed(harness());
  const m = msg('rina', '@codex hello');
  h.sc.ingest([m], 'sse');
  h.sc.ingest([{ content: m.content, ts: m.ts, metadata: JSON.stringify({ sender: 'rina' }) }], 'history');
  assert.equal(h.of('queued').length, 1);
});

test("a crew member's own message is not queued back to it", async () => {
  // The production bug, at the level that matters: end to end, not just in the pure function.
  const h = primed(harness());
  h.sc.ingest([msg('architect', '@架构师 note to self, and @codex you look too')], 'sse');
  const queued = h.of('queued').map((e) => e.agent);
  assert.deepEqual(queued, ['codex']);
});

test('order cards are not delivered to windows', async () => {
  const h = primed(harness());
  h.sc.ingest([{ content: '{"type":"order_card"}', ts: '2026-08-20T12:00:02Z', metadata: { sender: 'system', type: 'order_card' } }], 'sse');
  assert.equal(h.of('queued').length, 0);
});

// ---------- delivery ----------

test('an idle window receives the message, and the queue empties', async () => {
  const h = primed(harness());
  h.sc.ingest([msg('rina', '@架构师 the deploy is red')], 'sse');
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
  const h = primed(harness({ windows: [{ ref: '%1', identity: '架构师', screen: 'working… (esc to interrupt)' }] }));
  h.sc.ingest([msg('rina', '@架构师 when you get a moment')], 'sse');
  await h.sc.deliver();

  assert.equal(h.of('busy-wait').length, 1);
  assert.equal(h.of('injected').length, 0);
  assert.equal(h.sc.state.pending.length, 1, 'still queued, not dropped');
  assert.equal(h.adapter.__test.sentTo('%1').length, 0);
});

test('...and it lands once the window frees up', async () => {
  const h = primed(harness({ windows: [{ ref: '%1', identity: '架构师', screen: 'working… (esc to interrupt)' }] }));
  h.sc.ingest([msg('rina', '@架构师 later then')], 'sse');
  await h.sc.deliver();
  h.adapter.__test.setScreen('%1', '> ');
  await h.sc.deliver();
  assert.equal(h.of('injected').length, 1);
});

test('an unregistered window is waited for, not treated as an error', async () => {
  const h = primed(harness({ windows: [{ ref: '%1', identity: null, screen: '> ' }] }));
  h.sc.ingest([msg('rina', '@架构师 anyone home')], 'sse');
  await h.sc.deliver();
  assert.equal(h.of('no-window')[0].reason, 'unclaimed');
  assert.equal(h.sc.state.pending.length, 1);
});

test('two windows claiming one identity is refused rather than guessed', async () => {
  const h = primed(harness({
    windows: [{ ref: '%1', identity: 'codex', screen: '> ' }, { ref: '%2', identity: 'codex', screen: '> ' }],
  }));
  h.sc.ingest([msg('rina', '@codex which of you')], 'sse');
  await h.sc.deliver();
  assert.equal(h.of('no-window')[0].reason, 'ambiguous');
  assert.equal(h.of('injected').length, 0);
  assert.equal(h.adapter.__test.sentTo('%1').length + h.adapter.__test.sentTo('%2').length, 0);
});

test('a failed injection keeps the message queued', async () => {
  const h = primed(harness());
  h.adapter.sendText = async () => { throw new Error('window went away'); };
  h.sc.ingest([msg('rina', '@架构师 hello')], 'sse');
  await h.sc.deliver();
  assert.equal(h.of('inject-failed').length, 1);
  assert.equal(h.sc.state.pending.length, 1, 'dropping it here would lose a message nobody could trace');
});

// ---------- shelf life ----------

test('a message that waited too long is dropped, and the drop is reported', async () => {
  const h = primed(harness({ windows: [{ ref: '%1', identity: '架构师', screen: 'busy (esc to interrupt)' }] }));
  h.sc.ingest([msg('rina', '@架构师 urgent an hour ago')], 'sse');
  await h.sc.deliver();
  h.advance(11 * 60 * 1000);
  await h.sc.deliver();

  assert.equal(h.of('expired').length, 1);
  assert.equal(h.sc.state.pending.length, 0);
});

test('an expired direct message is acknowledged back; a group one is not', async () => {
  // A dropped group message is still in the group history. A dropped direct message looks,
  // from the sender's side, exactly like being ignored.
  const h = primed(harness({ windows: [{ ref: '%1', identity: '架构师', screen: 'busy (esc to interrupt)' }] }));
  h.sc.ingestDirect({ target: 'architect', dmId: 'dm-1', sender: 'rina', content: 'just between us' });
  h.sc.ingest([msg('rina', '@架构师 group thing')], 'sse');
  h.advance(11 * 60 * 1000);
  await h.sc.deliver();

  assert.deepEqual(h.acks, [{ agent: 'architect', dmId: 'dm-1', status: 'expired' }]);
});

test('a delivered direct message is acknowledged too', async () => {
  const h = primed(harness());
  h.sc.ingestDirect({ target: 'architect', dmId: 'dm-2', sender: 'rina', content: 'you there?' });
  await h.sc.deliver();
  assert.deepEqual(h.acks, [{ agent: 'architect', dmId: 'dm-2', status: 'delivered' }]);
  assert.match(h.adapter.__test.sentTo('%1').join(''), /reply --as architect/);
});

// ---------- persistence ----------

test('the queue survives a restart', async () => {
  const h = primed(harness({ windows: [{ ref: '%1', identity: '架构师', screen: 'busy (esc to interrupt)' }] }));
  h.sc.ingest([msg('rina', '@架构师 remember me')], 'sse');
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
  const h = primed(harness({ windows: [{ ref: '%1', identity: 'codex', screen: '> ' }] }));
  const report = await h.sc.reportPresence();
  assert.equal(report.architect.state, 'stopped', 'we cannot see it — that is not the same as free');
  assert.equal(report.codex.state, 'idle');
});

test('presence uses the same screen reading as delivery back-pressure', async () => {
  // So the dashboard can never say "idle" about an agent the sidecar is holding messages
  // back from.
  const h = primed(harness({ windows: [{ ref: '%1', identity: '架构师', screen: 'running (esc to interrupt)' }] }));
  const report = await h.sc.reportPresence();
  assert.equal(report.architect.state, 'busy');

  h.sc.ingest([msg('rina', '@架构师 hi')], 'sse');
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
  assert.equal(h.presences[0].codex.state, 'idle');
});
