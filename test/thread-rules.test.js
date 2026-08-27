const test = require('node:test');
const assert = require('node:assert');
const {
  STATES, SETTABLE, checkSet, checkLogIntent, checkFinish, checkArchive, mergePlan,
} = require('../src/lib/thread-rules');

// Unit level: the rules themselves. That these are *consulted* is proved over HTTP in
// routes.test.js — a rule can be perfectly correct and never called.

test('five states, and the list is the whole vocabulary', () => {
  assert.deepEqual(STATES, ['idea', 'todo', 'doing', 'blocked', 'done']);
});

// --- gate 1: what set may write ---

test('set refuses plan and snapshot by name, and says where to go instead', () => {
  const plan = checkSet('plan', 'anything');
  assert.equal(plan.ok, false);
  assert.equal(plan.error, 'plan_not_settable');
  assert.match(plan.detail, /\/plan/);

  const snap = checkSet('snapshot', 'looks finished to me');
  assert.equal(snap.ok, false);
  assert.equal(snap.error, 'snapshot_not_settable');
  assert.match(snap.detail, /finish/);
});

test('set refuses anything outside the whitelist', () => {
  for (const field of ['archived_at', 'created_at', 'name', 'log', '__proto__']) {
    assert.equal(checkSet(field, 'x').ok, false, `${field} must not be settable`);
  }
  for (const field of SETTABLE) {
    if (field === 'status') continue;                       // covered below
    assert.equal(checkSet(field, 'x').ok, true, `${field} should be settable`);
  }
});

test('done has exactly one door, and set is not it', () => {
  const v = checkSet('status', 'done');
  assert.equal(v.ok, false);
  assert.equal(v.error, 'use_finish');
  // Every other state goes through set normally.
  for (const s of ['idea', 'todo', 'doing', 'blocked']) assert.equal(checkSet('status', s).ok, true);
  assert.equal(checkSet('status', 'in_progress').ok, false);   // an order state, not a thread state
});

test('set refuses a non-string value rather than coercing it', () => {
  // Coercion here would write "[object Object]" into a field and report success.
  for (const bad of [1, null, undefined, {}, ['a']]) assert.equal(checkSet('goal', bad).ok, false);
});

// --- gate 2: one intent per log line ---

test('a log line must declare exactly one intent — none is refused', () => {
  const v = checkLogIntent({ who: 'shu', what: 'did a thing' });
  assert.equal(v.ok, false);
  assert.equal(v.error, 'log_intent_required');
});

test('two intents is refused too, and the message names both', () => {
  const v = checkLogIntent({ check: 1, no_plan_change: true });
  assert.equal(v.ok, false);
  assert.equal(v.error, 'log_intent_ambiguous');
  assert.match(v.detail, /check/);
  assert.match(v.detail, /no_plan_change/);
});

test('each intent alone is accepted', () => {
  assert.equal(checkLogIntent({ check: 3 }).ok, true);
  assert.equal(checkLogIntent({ plan: 'a\nb' }).ok, true);
  assert.equal(checkLogIntent({ no_plan_change: true }).ok, true);
});

test('plan items are numbered from 1, and 0 is a real mistake not a shorthand', () => {
  assert.equal(checkLogIntent({ check: 0 }).ok, false);
  assert.equal(checkLogIntent({ check: -1 }).ok, false);
  assert.equal(checkLogIntent({ check: 1.5 }).ok, false);
  assert.equal(checkLogIntent({ check: 'two' }).ok, false);
  assert.equal(checkLogIntent({ check: 1 }).ok, true);
});

test('an empty plan text is not a plan change', () => {
  assert.equal(checkLogIntent({ plan: '   ' }).ok, false);
});

// --- gate 4: done means a snapshot exists ---

test('finish requires a snapshot with something in it', () => {
  assert.equal(checkFinish('').ok, false);
  assert.equal(checkFinish('   \n  ').ok, false);
  assert.equal(checkFinish(undefined).ok, false);
  assert.equal(checkFinish(42).ok, false);
  assert.equal(checkFinish('shipped; the retry path is still untested').ok, true);
});

// --- gate 5: archiving without a snapshot needs a reason ---

test('a thread with a snapshot archives without further explanation', () => {
  assert.equal(checkArchive({ snapshot: 'landed, notes in docs/' }, undefined).ok, true);
});

test('a thread with no snapshot needs a stated reason — but is not blocked outright', () => {
  const refused = checkArchive({ snapshot: '' }, undefined);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'why_required');
  // Not blocked outright on purpose: refusing legitimate abandonment would only teach
  // people to write a fake snapshot to get through the door.
  assert.equal(checkArchive({ snapshot: '' }, 'folded into the caching thread').ok, true);
  assert.equal(checkArchive({ snapshot: '' }, '   ').ok, false);
});

// --- plan merging ---

test('ticks follow the text, not the position', () => {
  const before = [
    { idx: 1, done: 1, text: 'write the schema' },
    { idx: 2, done: 0, text: 'write the routes' },
  ];
  // Reordered, with a new item inserted first.
  const after = mergePlan(before, ['add tests', 'write the routes', 'write the schema']);
  assert.deepEqual(after, [
    { idx: 1, text: 'add tests', done: 0 },
    { idx: 2, text: 'write the routes', done: 0 },
    { idx: 3, text: 'write the schema', done: 1 },   // still ticked, now at 3
  ]);
});

test('rewriting a plan never invents a tick', () => {
  const before = [{ idx: 1, done: 1, text: 'ship it' }];
  const after = mergePlan(before, ['ship it properly']);
  assert.deepEqual(after, [{ idx: 1, text: 'ship it properly', done: 0 }]);
});

test('blank lines are dropped and numbering closes up behind them', () => {
  assert.deepEqual(
    mergePlan([], ['one', '', '   ', 'two']),
    [{ idx: 1, text: 'one', done: 0 }, { idx: 2, text: 'two', done: 0 }],
  );
});
