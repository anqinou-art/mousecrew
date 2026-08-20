const test = require('node:test');
const assert = require('node:assert');
const { makeWakeFreshness, SETTLED } = require('../src/lib/wake-freshness');

function storeWith(status) {
  return { order: { getById: { get: () => (status === null ? undefined : { id: 'WO-001', status }) } } };
}

test('a wake-up for work that has moved on is dropped', () => {
  for (const settled of ['submitted', 'auditing', 'pending_restart', 'closed', 'accepted', 'paused']) {
    const f = makeWakeFreshness(storeWith(settled), 'WO-001', { enqueuedStatus: 'in_progress' });
    const v = f();
    assert.equal(v.skip, true, `${settled} should be dropped`);
    assert.match(v.reason, new RegExp(settled));
  }
});

test('in_progress is exactly what we are waking for — never dropped', () => {
  assert.equal(makeWakeFreshness(storeWith('in_progress'), 'WO-001')().skip, false);
});

test('rejected and draft are NOT dropped — a person still has to act', () => {
  // Deliberate: rejected means redo it, draft means pick it up. Both need a human or an
  // agent to move. Adding them to the settled list would silently swallow real work.
  assert.equal(makeWakeFreshness(storeWith('rejected'), 'WO-001')().skip, false);
  assert.equal(makeWakeFreshness(storeWith('draft'), 'WO-001')().skip, false);
  assert.ok(!SETTLED.has('rejected'));
  assert.ok(!SETTLED.has('draft'));
});

test('an order that cannot be found is delivered anyway — fail open', () => {
  // Waking someone twice is annoying. Dropping a real assignment means work sits and
  // nobody knows. The failure direction is chosen, not accidental.
  assert.equal(makeWakeFreshness(storeWith(null), 'WO-001')().skip, false);
});

test('a thrown query is delivered anyway, and says so', () => {
  const broken = { order: { getById: { get: () => { throw new Error('database is locked'); } } } };
  const v = makeWakeFreshness(broken, 'WO-001')();
  assert.equal(v.skip, false);
  assert.equal(v.error, 'database is locked');
});

test('an unrecognised status is delivered anyway', () => {
  assert.equal(makeWakeFreshness(storeWith('some_new_state'), 'WO-001')().skip, false);
});

test('the reason names both states, so the log explains itself', () => {
  const v = makeWakeFreshness(storeWith('closed'), 'WO-042', { enqueuedStatus: 'in_progress' })();
  assert.match(v.reason, /WO-042/);
  assert.match(v.reason, /in_progress/);
  assert.match(v.reason, /closed/);
});
