const test = require('node:test');
const assert = require('node:assert');
const core = require('../src/lib/sidecar-core');
const { buildIdentity } = require('../src/lib/identity');
const { normalizeAgent } = require('../src/config');

const identity = buildIdentity([
  { id: 'architect', displayName: 'lead', aliases: [] },
  { id: 'builder', displayName: 'builder', aliases: [] },
  { id: 'scout', displayName: 'scout', aliases: [] },
].map(normalizeAgent));
const terminalIds = ['architect', 'builder', 'scout'];
const targets = (sender, content) => core.mentionTargets({ identity, terminalIds }, sender, content).sort();

// ---------- the bug this whole module is shaped around ----------

test('a crew member is never delivered its own group message', () => {
  // Observed in production for months. The bus records the sender as a canonical id
  // (`architect`) while the local roster knows the display name (`lead`). Compare the raw
  // strings and 'architect' !== 'lead' is always true, so the guard never fires and every
  // message the agent posts is typed straight back into its own window.
  assert.deepEqual(targets('architect', '@lead a note to myself'), []);
  assert.deepEqual(targets('architect', '@architect talking to myself'), []);
});

test('...and it hides, because it only misfires for the one whose name differs from its id', () => {
  // Where a display name happens to equal the id, a naive comparison works by accident.
  // Only the entries where they differ misfire — so most of a roster looks fine, which is
  // why this survives review.
  assert.deepEqual(targets('builder', '@builder my own words'), []);
  assert.deepEqual(targets('scout', '@scout my own words'), []);
});

test('a display name as sender is also handled — both spellings normalise', () => {
  assert.deepEqual(targets('lead', '@lead me again'), []);
});

test('display names are not required to be ASCII', () => {
  // Worth its own case: matching lowercases and does substring work on whatever the roster
  // says, and a display name in another script is the most likely reason for one to differ
  // from its id in the first place.
  const id2 = buildIdentity([
    { id: 'writer', displayName: 'ünïcodé-nåme', aliases: [] },
    { id: 'plain', displayName: 'plain', aliases: [] },
  ].map(normalizeAgent));
  const t = (sender, content) => core.mentionTargets({ identity: id2, terminalIds: ['writer', 'plain'] }, sender, content);
  assert.deepEqual(t('human', '@ünïcodé-nåme please look'), ['writer']);
  assert.deepEqual(t('writer', '@ünïcodé-nåme my own words'), [], 'and the self-guard still holds');
});

test('everyone else addressed in the same message still gets it', () => {
  assert.deepEqual(targets('architect', '@lead and @builder take a look'), ['builder']);
  assert.deepEqual(targets('human', '@lead @builder @scout all of you'), ['architect', 'builder', 'scout']);
});

test('a name without @ is not an address', () => {
  assert.deepEqual(targets('human', 'builder appears in this sentence but is not addressed'), []);
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
  const group = core.envelope({ kind: 'group', agent: 'architect', sender: 'human', content: 'hi' });
  const dm = core.envelope({ kind: 'dm', agent: 'architect', sender: 'human', content: 'hi' });
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
  const windows = [{ ref: '%1', identity: 'builder' }, { ref: '%2', identity: 'lead' }];
  assert.deepEqual(core.resolveWindow(windows, 'lead'), { ref: '%2', reason: 'identity' });
});

test('two windows claiming one identity is refused, not guessed', () => {
  // That state means a session was restored without the old window being cleaned up. One
  // of them is a corpse; guessing picks it half the time.
  const windows = [{ ref: '%1', identity: 'builder' }, { ref: '%2', identity: 'builder' }];
  const r = core.resolveWindow(windows, 'builder');
  assert.equal(r.ref, null);
  assert.equal(r.reason, 'ambiguous');
  assert.deepEqual(r.candidates, ['%1', '%2']);
});

test('an unclaimed identity reports why, so the caller can wait rather than fail', () => {
  assert.deepEqual(core.resolveWindow([{ ref: '%1', identity: null }], 'builder'), { ref: null, reason: 'unclaimed' });
});

// ---------- message identity ----------

test('the same message from either channel has the same key', () => {
  const fromHistory = { content: 'hello', ts: '2026-08-20T12:00:00Z', metadata: JSON.stringify({ sender: 'human' }) };
  const fromStream = { content: 'hello', ts: '2026-08-20T12:00:00Z', metadata: { sender: 'human' } };
  assert.equal(core.messageKey(fromHistory), core.messageKey(fromStream));
});

test('different messages do not collide', () => {
  const base = { content: 'hello', ts: '2026-08-20T12:00:00Z', metadata: { sender: 'human' } };
  const keys = new Set([
    core.messageKey(base),
    core.messageKey({ ...base, content: 'hello ' }),
    core.messageKey({ ...base, ts: '2026-08-20T12:00:01Z' }),
    core.messageKey({ ...base, metadata: { sender: 'builder' } }),
  ]);
  assert.equal(keys.size, 4);
});

test('malformed metadata does not throw', () => {
  assert.doesNotThrow(() => core.messageKey({ content: 'x', metadata: 'not json' }));
  assert.doesNotThrow(() => core.messageKey({}));
  assert.doesNotThrow(() => core.messageKey(null));
});

// ---------- the tmux format contract ----------

const { parsePaneLine } = require('../adapters/terminal/tmux');

test('a pane line parses into ref, identity, title', () => {
  assert.deepEqual(parsePaneLine('%18|:|scout|:|my-host'), { ref: '%18', identity: 'scout', title: 'my-host' });
  assert.deepEqual(parsePaneLine('%2|:||:|unclaimed'), { ref: '%2', identity: null, title: 'unclaimed' });
});

test('a title containing the separator cannot corrupt the fields that matter', () => {
  assert.deepEqual(parsePaneLine('%1|:|scout|:|a|:|b'), { ref: '%1', identity: 'scout', title: 'a|:|b' });
});

test('a line the terminal escaped differently is refused, not silently mangled', () => {
  // tmux 3.4 renders a control character in a format string as its four-character escape
  // while 3.6 emits the raw byte. With a control separator the 3.4 output parses into a
  // structurally perfect object with every field wrong — the whole line becomes the ref,
  // every window reads as unclaimed, and nothing is ever delivered to anyone. No error is
  // raised anywhere. Refusing the line is the difference between a loud failure and a crew
  // that silently stops receiving mail.
  assert.throws(() => parsePaneLine(String.raw`%18\001scout\001my-host`), /format contract has changed/);
  assert.throws(() => parsePaneLine('garbage'), /format contract has changed/);
  assert.throws(() => parsePaneLine('not-a-ref|:|scout|:|host'), /format contract has changed/);
});
