const test = require('node:test');
const assert = require('node:assert');
const core = require('../src/lib/sidecar-core');
const { buildIdentity } = require('../src/lib/identity');
const { normalizeAgent } = require('../src/config');

const identity = buildIdentity([
  { id: 'architect', displayName: '架构师', aliases: [] },
  { id: 'codex', displayName: 'codex', aliases: [] },
  { id: 'kimi', displayName: 'kimi', aliases: [] },
].map(normalizeAgent));
const terminalIds = ['architect', 'codex', 'kimi'];
const targets = (sender, content) => core.mentionTargets({ identity, terminalIds }, sender, content).sort();

// ---------- the bug this whole module is shaped around ----------

test('a crew member is never delivered its own group message', () => {
  // Observed in production for months. The bus records the sender as a canonical id
  // (`architect`) while the local roster knows the display name (`架构师`). Compare the raw
  // strings and 'architect' !== '架构师' is always true, so the guard never fires and every
  // message the agent posts is typed straight back into its own window.
  assert.deepEqual(targets('architect', '@架构师 这是我自己说的话'), []);
  assert.deepEqual(targets('architect', '@architect talking to myself'), []);
});

test('...and it hides, because it only misfires for the one whose name differs from its id', () => {
  // codex and kimi have display name == id, so a naive comparison happens to work for
  // them. Two thirds of the crew look fine; that is why nobody noticed.
  assert.deepEqual(targets('codex', '@codex my own words'), []);
  assert.deepEqual(targets('kimi', '@kimi my own words'), []);
});

test('a display name as sender is also handled — both spellings normalise', () => {
  assert.deepEqual(targets('架构师', '@架构师 me again'), []);
});

test('everyone else addressed in the same message still gets it', () => {
  assert.deepEqual(targets('architect', '@架构师 顺带 @codex 你看下'), ['codex']);
  assert.deepEqual(targets('rina', '@架构师 @codex @kimi 都看一下'), ['architect', 'codex', 'kimi']);
});

test('a name without @ is not an address', () => {
  assert.deepEqual(targets('rina', 'codex 这个词只是出现在句子里'), []);
});

// ---------- busy detection ----------

test('busy comes from the screen, and the marker is configurable per agent', () => {
  assert.equal(core.isBusy('running tool… (esc to interrupt)', 'esc to interrupt'), true);
  assert.equal(core.isBusy('ESC TO INTERRUPT', 'esc to interrupt'), true, 'case-insensitive');
  assert.equal(core.isBusy('> ', 'esc to interrupt'), false);
  assert.equal(core.isBusy('', 'esc to interrupt'), false);
  assert.equal(core.isBusy(null, 'esc to interrupt'), false);
  assert.equal(core.isBusy('thinking...', 'thinking'), true, 'another CLI, another marker');
});

// ---------- shelf life ----------

const at = (minsAgo, extra = {}) => ({ queuedAt: new Date(1_000_000 + 0 - minsAgo * 60_000).toISOString(), ...extra });
const NOW = 1_000_000;

test('stale items are dropped, fresh ones kept', () => {
  const pending = [at(20, { agent: 'a' }), at(2, { agent: 'b' })];
  const fresh = core.filterFresh(pending, NOW, 10 * 60 * 1000);
  assert.deepEqual(fresh.map((p) => p.agent), ['b']);
  assert.deepEqual(core.selectExpired(pending, NOW, 10 * 60 * 1000).map((p) => p.agent), ['a']);
});

test('an unreadable timestamp is kept, not discarded', () => {
  // "I cannot tell how old this is" must not become "therefore throw it away".
  const pending = [{ agent: 'a', queuedAt: 'not-a-date' }, { agent: 'b', queuedAt: undefined }];
  assert.equal(core.filterFresh(pending, NOW).length, 2);
});

test('the queue cap drops the oldest and says which', () => {
  const pending = [1, 2, 3, 4, 5].map((n) => ({ agent: `a${n}` }));
  const { kept, dropped } = core.capPending(pending, 3);
  assert.deepEqual(kept.map((p) => p.agent), ['a3', 'a4', 'a5']);
  assert.deepEqual(dropped.map((p) => p.agent), ['a1', 'a2']);
});

// ---------- envelope ----------

test('the envelope tells the window where the answer goes', () => {
  const group = core.envelope({ kind: 'group', agent: 'architect', sender: 'rina', content: 'hi' });
  const dm = core.envelope({ kind: 'dm', agent: 'architect', sender: 'rina', content: 'hi' });
  assert.match(group, /\[group\]/);
  assert.match(group, /say --as architect/);
  assert.match(dm, /\[direct\]/);
  assert.match(dm, /reply --as architect/);
  // Getting this backwards is quiet and specific: the human waits in a private thread
  // while the answer appears in front of the whole crew.
  assert.ok(!/reply --as/.test(group));
  assert.ok(!/ say --as/.test(dm));
});

// ---------- window resolution ----------

test('a window is found by the identity it claims', () => {
  const windows = [{ ref: '%1', identity: 'codex' }, { ref: '%2', identity: '架构师' }];
  assert.deepEqual(core.resolveWindow(windows, '架构师'), { ref: '%2', reason: 'identity' });
});

test('two windows claiming one identity is refused, not guessed', () => {
  // That state means a session was restored without the old window being cleaned up. One
  // of them is a corpse; guessing picks it half the time.
  const windows = [{ ref: '%1', identity: 'codex' }, { ref: '%2', identity: 'codex' }];
  const r = core.resolveWindow(windows, 'codex');
  assert.equal(r.ref, null);
  assert.equal(r.reason, 'ambiguous');
  assert.deepEqual(r.candidates, ['%1', '%2']);
});

test('an unclaimed identity reports why, so the caller can wait rather than fail', () => {
  assert.deepEqual(core.resolveWindow([{ ref: '%1', identity: null }], 'codex'), { ref: null, reason: 'unclaimed' });
});

// ---------- message identity ----------

test('the same message from either channel has the same key', () => {
  const fromHistory = { content: 'hello', ts: '2026-08-20T12:00:00Z', metadata: JSON.stringify({ sender: 'rina' }) };
  const fromStream = { content: 'hello', ts: '2026-08-20T12:00:00Z', metadata: { sender: 'rina' } };
  assert.equal(core.messageKey(fromHistory), core.messageKey(fromStream));
});

test('different messages do not collide', () => {
  const base = { content: 'hello', ts: '2026-08-20T12:00:00Z', metadata: { sender: 'rina' } };
  const keys = new Set([
    core.messageKey(base),
    core.messageKey({ ...base, content: 'hello ' }),
    core.messageKey({ ...base, ts: '2026-08-20T12:00:01Z' }),
    core.messageKey({ ...base, metadata: { sender: 'codex' } }),
  ]);
  assert.equal(keys.size, 4);
});

test('malformed metadata does not throw', () => {
  assert.doesNotThrow(() => core.messageKey({ content: 'x', metadata: 'not json' }));
  assert.doesNotThrow(() => core.messageKey({}));
  assert.doesNotThrow(() => core.messageKey(null));
});
