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

test('local wake requests normalise terminal identities and reject invalid fields', () => {
  assert.deepEqual(core.parseWakeRequest(JSON.stringify({
    agent: 'lead', key: 'build:ready', content: 'check the local build',
  }), { identity, terminalIds }), {
    agent: 'architect', sender: 'local', content: 'check the local build', key: 'wake:build:ready',
  });
  assert.deepEqual(core.parseWakeRequest(JSON.stringify({
    agent: 'builder', sender: 'scheduler', key: 'nightly', content: 'inspect the report', kind: 'dm',
  }), { identity, terminalIds }), {
    agent: 'builder', sender: 'scheduler', content: 'inspect the report', key: 'wake:nightly',
  });

  for (const [raw, expected] of [
    ['{broken', /not valid JSON/],
    ['[]', /top level must be an object/],
    [JSON.stringify({ agent: 7, key: 'k', content: 'x' }), /agent must be a string/],
    [JSON.stringify({ agent: 'unknown', key: 'k', content: 'x' }), /not a terminal agent/],
    [JSON.stringify({ agent: 'builder', content: 'x' }), /key is required/],
    [JSON.stringify({ agent: 'builder', key: 'k' }), /content is required/],
    [JSON.stringify({ agent: 'builder', key: 'k', content: 'xxxx' }), /exceeds 3/],
  ]) {
    assert.match(core.parseWakeRequest(raw, { identity, terminalIds, maxContent: 3 }).error, expected);
  }
});

test('pending wake merging uses the same freshness decision as expiry', () => {
  const now = 1_000_000;
  const pending = [
    { kind: 'wake', agent: 'architect', sender: 'local', queuedAt: new Date(now - 1000).toISOString() },
    { kind: 'wake', agent: 'builder', sender: 'local', queuedAt: new Date(now - 11 * 60 * 1000).toISOString() },
  ];
  assert.equal(core.hasPendingWake('architect', 'local', pending, now), true);
  assert.equal(core.hasPendingWake('builder', 'local', pending, now), false);
  assert.equal(core.hasPendingWake('architect', 'someone-else', pending, now), false);
});

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

test('the default busy marker recognises current and older Claude Code without trapping a finished screen', () => {
  const busy = '✢ Harmonizing… (52s · ↓ 2.5k tokens · thinking)\n  ⎿  Tip: Use /btw to ask a quick side question';
  const justFinished = '✻ Cogitated for 5s · done 3:38 PM\n\n────────────────────────\n❯ ';
  const idle = '⏺ 20 — two full tens, a good stopping point.\n\n✻ Cogitated for 5s · done 3:38 PM\n\n❯ ';

  assert.equal(core.isBusy(busy, core.DEFAULT_BUSY_PATTERN), true);
  assert.equal(core.isBusy('running tool… (esc to interrupt)', core.DEFAULT_BUSY_PATTERN), true);
  assert.equal(core.isBusy(justFinished, core.DEFAULT_BUSY_PATTERN), false);
  assert.equal(core.isBusy(idle, core.DEFAULT_BUSY_PATTERN), false);
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

test('forced items use their own grace clock and broken timestamps remain exempt', () => {
  const pending = [
    { agent: 'fresh', queuedAt: at(20).queuedAt, forcedAt: new Date(NOW - 60_000).toISOString() },
    { agent: 'expired', queuedAt: at(20).queuedAt, forcedAt: new Date(NOW - 3 * 60_000).toISOString() },
    { agent: 'unknown', queuedAt: at(20).queuedAt, forcedAt: 'not-a-date' },
  ];
  assert.deepEqual(core.filterFresh(pending, NOW).map((item) => item.agent), ['fresh', 'unknown']);
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

test('delivery batches consecutive group messages but never folds in a direct message', () => {
  const rows = [
    { id: 'other', agent: 'builder', kind: 'group' },
    { id: 'g1', agent: 'architect', kind: 'group' },
    { id: 'g2', agent: 'architect', kind: 'group' },
    { id: 'dm', agent: 'architect', kind: 'dm' },
    { id: 'g3', agent: 'architect', kind: 'group' },
  ];
  assert.deepEqual(core.nextDeliverableBatch(rows, 'architect').map((item) => item.id), ['g1', 'g2']);
  assert.deepEqual(core.nextDeliverableBatch(rows.slice(3), 'architect').map((item) => item.id), ['dm']);
  assert.deepEqual(core.nextDeliverableBatch(rows.slice(4), 'architect').map((item) => item.id), ['g3']);
  assert.deepEqual(core.nextDeliverableBatch(rows, 'architect', false).map((item) => item.id), ['g1']);

  const forced = [
    { id: 'old', agent: 'architect', kind: 'group', forcedAt: 'T' },
    { id: 'new', agent: 'architect', kind: 'group' },
  ];
  assert.deepEqual(core.nextDeliverableBatch(forced, 'architect').map((item) => item.id), ['old']);
});

test('one-item batch envelopes stay byte-for-byte compatible and group batches reply once', () => {
  const one = { kind: 'group', sender: 'human', content: 'hi', queuedAt: 'T1' };
  assert.equal(
    core.batchEnvelope({ items: [one], agent: 'architect' }),
    '[group] human: hi\n  — reply with: mousecrew say --as architect "..."',
  );

  const text = core.batchEnvelope({
    agent: 'architect',
    items: [one, { kind: 'group', sender: 'builder', content: 'there', queuedAt: 'T2' }],
  });
  assert.match(text, /2 messages delivered together/);
  assert.ok(text.indexOf('human · T1') < text.indexOf('builder · T2'));
  assert.equal((text.match(/reply with:/g) || []).length, 1);
});

test('forced delivery planning has four outcomes and merged direct messages retain every receipt', () => {
  assert.equal(core.planDelivery({}, false), 'inject');
  assert.equal(core.planDelivery({}, true), 'wait_busy');
  assert.equal(core.planDelivery({ forcedAt: 'T' }, true), 'inject_forced');
  assert.equal(core.planDelivery({ forcedAt: 'T', forcedTriedAt: 'T2' }, false), 'wait_forced_expiry');

  const items = [
    { agent: 'architect', kind: 'dm', sender: 'one', content: 'first', dmId: 'd1', queuedAt: 'T1' },
    { agent: 'architect', kind: 'dm', sender: 'two', content: 'second', dmId: 'd2', queuedAt: 'T2' },
    { agent: 'architect', kind: 'group', sender: 'three', content: 'third', queuedAt: 'T3' },
  ];
  const marked = core.markForcedDeliveries(items, 1_000_000, true);
  assert.equal(marked.forced.length, 2, 'one direct carrier and one group item');
  assert.deepEqual(marked.absorbed, [items[1]]);
  assert.deepEqual(items[0].mergedFrom.map((source) => source.dmId), ['d1', 'd2']);
  assert.match(items[0].content, /first[\s\S]*second/);
  assert.equal(items[2].content, 'third', 'group batching remains owned by the group path');
});

test('a local wake is a standalone envelope and never gains forced delivery', () => {
  const wake = {
    agent: 'architect', kind: 'wake', sender: 'scheduler', content: 'check the build',
    draftHeldAt: 'earlier',
  };
  const group = { agent: 'architect', kind: 'group', content: 'group message' };

  assert.deepEqual(core.nextDeliverableBatch([wake, group], 'architect'), [wake]);
  assert.equal(core.envelope(wake), '[local wake · scheduler] check the build');
  assert.equal(core.batchEnvelope({ items: [wake], agent: 'architect', bodyFile: '/tmp/wake.txt', inlineLimit: 5 }),
    '[local wake · scheduler] check\n\n[truncated — read the full message before replying: /tmp/wake.txt]');
  assert.deepEqual(core.markForcedDeliveries([wake], 1_000_000, true), { forced: [], absorbed: [] });
  assert.equal(wake.forcedAt, undefined);
});

test('a rotation reminder never expires, batches, gains a reply instruction, or becomes forced', () => {
  const rotate = {
    agent: 'architect', kind: 'rotate', sender: 'mousecrew', content: 'write a handoff',
    queuedAt: new Date(NOW - 11 * 60_000).toISOString(), draftHeldAt: 'earlier',
  };
  const group = { agent: 'architect', kind: 'group', content: 'ordinary message' };

  assert.deepEqual(core.filterFresh([rotate], NOW, 10 * 60_000), [rotate]);
  assert.deepEqual(core.nextDeliverableBatch([rotate, group], 'architect'), [rotate]);
  assert.equal(core.batchEnvelope({ items: [rotate], agent: 'architect' }),
    '[session rotation reminder] write a handoff');
  assert.equal(core.batchEnvelope({
    items: [rotate], agent: 'architect', bodyFile: '/tmp/rotate.txt', inlineLimit: 5,
  }), '[session rotation reminder] write\n\n[truncated — read the full message before replying: /tmp/rotate.txt]');
  assert.deepEqual(core.markForcedDeliveries([rotate], NOW, true), { forced: [], absorbed: [] });
  assert.equal(rotate.forcedAt, undefined);
});

test('an idle expired item only earns forced delivery after a persisted draft hold', () => {
  const plain = { agent: 'architect', kind: 'group' };
  const held = { agent: 'architect', kind: 'group', draftHeldAt: 'earlier' };
  const marked = core.markForcedDeliveries([plain, held], 1_000_000, false);

  assert.deepEqual(marked.forced, [held]);
  assert.equal(plain.forcedAt, undefined);
  assert.ok(held.forcedAt);
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
