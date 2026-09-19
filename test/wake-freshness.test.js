const test = require('node:test');
const assert = require('node:assert');
const { makeWakeFreshness, ownerOf } = require('../src/lib/wake-freshness');

const workspace = {
  mergeGate: { id: 'gate' },
  isSelfManaged: (id) => id === 'solo',
};

function storeWith(status, fields = {}) {
  const order = status === null ? undefined : {
    id: 'WO-001', status, assignee: 'worker', timeline: '[]', ...fields,
  };
  return { order: { getById: { get: () => order } } };
}

function freshness(status, recipient, fields = {}, enqueuedStatus = status) {
  return makeWakeFreshness(storeWith(status, fields), 'WO-001', {
    enqueuedStatus,
    recipient,
    workspace,
  })();
}

test('a wake-up for work that has moved on is dropped', () => {
  for (const current of ['submitted', 'auditing', 'pending_restart', 'closed', 'accepted', 'paused']) {
    const v = freshness(current, 'worker', {}, 'in_progress');
    assert.equal(v.skip, true, `${current} should be dropped`);
    assert.match(v.reason, new RegExp(current));
  }
});

test('submitted and auditing work stays fresh for the merge gate', () => {
  assert.equal(freshness('submitted', 'gate').skip, false);
  assert.equal(freshness('auditing', 'gate').skip, false);
});

test('a wake-up addressed to someone other than the current owner is dropped', () => {
  const v = freshness('submitted', 'worker');
  assert.equal(v.skip, true);
  assert.match(v.reason, /owned by gate, not worker/);
});

test('self-managed submitted work does not owe the merge gate an action', () => {
  const order = { id: 'WO-001', status: 'submitted', assignee: 'solo' };
  assert.equal(ownerOf(order, workspace), null);
  assert.equal(freshness('submitted', 'gate', { assignee: 'solo' }).skip, true);
});

test('paused review work keeps a dependency notice fresh for the merge gate', () => {
  const timeline = JSON.stringify([{ from: 'auditing', status: 'paused' }]);
  assert.equal(freshness('paused', 'gate', { timeline }).skip, false);
});

test('in_progress and rejected work stays fresh for its assignee', () => {
  assert.equal(freshness('in_progress', 'worker').skip, false);
  assert.equal(freshness('rejected', 'worker').skip, false);
});

test('an order that cannot be found is delivered anyway — fail open', () => {
  const f = makeWakeFreshness(storeWith(null), 'WO-001', {
    enqueuedStatus: 'in_progress', recipient: 'worker', workspace,
  });
  assert.equal(f().skip, false);
});

test('a thrown query is delivered anyway, and says so', () => {
  const broken = { order: { getById: { get: () => { throw new Error('database is locked'); } } } };
  const v = makeWakeFreshness(broken, 'WO-001', {
    enqueuedStatus: 'in_progress', recipient: 'worker', workspace,
  })();
  assert.equal(v.skip, false);
  assert.equal(v.error, 'database is locked');
});

test('an unrecognised status is delivered anyway', () => {
  assert.equal(freshness('some_new_state', 'worker').skip, false);
});

test('the reason names both states, so the log explains itself', () => {
  const v = freshness('closed', 'worker', {}, 'in_progress');
  assert.match(v.reason, /WO-001/);
  assert.match(v.reason, /in_progress/);
  assert.match(v.reason, /closed/);
});
