const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { open } = require('../src/db');
const { checkTransition, transition, STATES } = require('../src/lib/order-state-machine');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-test-'));
  const store = open(path.join(dir, 'test.db'));
  let n = 0;
  store._make = (over = {}) => {
    const id = `WO-${String(++n).padStart(3, '0')}`;
    store.order.create.run({
      id, project_id: null, title: over.title || 'a task', description: null,
      status: 'draft', assignee: over.assignee || 'backend', repo: over.repo || null,
      created_by: 'test', timeline: JSON.stringify([]),
    });
    if (over.status && over.status !== 'draft') {
      store.db.prepare('UPDATE work_orders SET status = ? WHERE id = ?').run(over.status, id);
    }
    return id;
  };
  return store;
}

test('the happy path walks all the way to closed', () => {
  const s = freshStore();
  const id = s._make();
  for (const to of ['in_progress', 'submitted', 'auditing', 'pending_restart', 'closed']) {
    const r = transition(s, id, to, 'tester');
    assert.equal(r.ok, true, `${to}: ${r.error || ''}`);
    assert.equal(r.order.status, to);
  }
  s.close();
});

test('an edge that is not in the table is refused', () => {
  assert.equal(checkTransition('draft', 'closed').ok, false);
  assert.equal(checkTransition('draft', 'auditing').ok, false);
  assert.equal(checkTransition('closed', 'in_progress').ok, false);
  assert.equal(checkTransition('nonsense', 'closed').ok, false);
});

test('checkTransition is pure — it can be called before doing expensive work', () => {
  // The order endpoint runs git subprocesses. Validating after that work means any
  // request with a real order id can make the server fork processes.
  const before = checkTransition('in_progress', 'submitted');
  const again = checkTransition('in_progress', 'submitted');
  assert.deepEqual(before, again);
  assert.deepEqual(before, { ok: true });
});

test('every timeline entry records where it came from and who moved it', () => {
  const s = freshStore();
  const id = s._make();
  transition(s, id, 'in_progress', 'alice', 'picking this up');
  const o = s.order.getById.get(id);
  const tl = JSON.parse(o.timeline);
  assert.equal(tl.length, 1);
  assert.equal(tl[0].from, 'draft');
  assert.equal(tl[0].status, 'in_progress');
  assert.equal(tl[0].actor, 'alice');
  assert.equal(tl[0].comment, 'picking this up');
  assert.ok(tl[0].ts);
  s.close();
});

test('closing an order releases whatever was blocked on it', () => {
  const s = freshStore();
  const blocker = s._make({ title: 'ship the API', status: 'auditing' });
  const waiter = s._make({ title: 'use the API', status: 'in_progress' });
  transition(s, waiter, 'paused', 'tester', 'waiting for the API');
  s.order.setBlockFields.run(blocker, 'waiting for the API', waiter);

  transition(s, blocker, 'closed', 'tester');

  const w = s.order.getById.get(waiter);
  assert.equal(w.status, 'in_progress');
  assert.equal(w.blocked_by, null, 'the block is cleared, not just the status');
  const tl = JSON.parse(w.timeline);
  assert.match(tl[tl.length - 1].comment, /auto-resume/);
  s.close();
});

test('auto-resume reports which orders it woke, so the caller can notify them', () => {
  const s = freshStore();
  const blocker = s._make({ status: 'accepted' });
  const a = s._make({ status: 'in_progress' });
  const b = s._make({ status: 'in_progress' });
  for (const w of [a, b]) {
    transition(s, w, 'paused', 't', 'blocked');
    s.order.setBlockFields.run(blocker, 'blocked', w);
  }
  const r = transition(s, blocker, 'closed', 't');
  assert.deepEqual(r.autoResumed.sort(), [a, b].sort());
  s.close();
});

test('a paused order blocked on an unrelated order is not woken', () => {
  const s = freshStore();
  const one = s._make({ status: 'accepted' });
  const other = s._make({ status: 'accepted' });
  const waiter = s._make({ status: 'in_progress' });
  transition(s, waiter, 'paused', 't', 'blocked');
  s.order.setBlockFields.run(other, 'blocked', waiter);

  const r = transition(s, one, 'closed', 't');
  assert.equal(r.autoResumed, undefined);
  assert.equal(s.order.getById.get(waiter).status, 'paused');
  s.close();
});

test('every active state can be cancelled straight to closed', () => {
  // Without this edge, killing a dead order means routing it through `accepted`, which
  // stamps "verified and delivered" on work nobody did. A state machine that forces you
  // to lie gets routed around.
  for (const from of ['in_progress', 'submitted', 'paused', 'rejected']) {
    assert.equal(checkTransition(from, 'closed').ok, true, `${from} -> closed should be allowed`);
  }
  const s = freshStore();
  const id = s._make({ status: 'in_progress' });
  const r = transition(s, id, 'closed', 'human', 'cancelled: no longer needed');
  assert.equal(r.ok, true);
  assert.equal(r.order.status, 'closed');
  s.close();
});

test('a rejected order goes back to work rather than dying', () => {
  const s = freshStore();
  const id = s._make({ status: 'auditing' });
  assert.equal(transition(s, id, 'rejected', 'auditor', 'needs changes').ok, true);
  assert.equal(transition(s, id, 'in_progress', 'backend').ok, true);
  s.close();
});

test('a missing order is reported, not crashed on', () => {
  const s = freshStore();
  assert.deepEqual(transition(s, 'WO-999', 'closed', 't'), { ok: false, error: 'order not found' });
  s.close();
});

test('the state list and the transition table agree', () => {
  const { TRANSITIONS } = require('../src/lib/order-state-machine');
  for (const from of Object.keys(TRANSITIONS)) {
    assert.ok(STATES.includes(from), `${from} is a source state but not in STATES`);
    for (const to of Object.keys(TRANSITIONS[from])) {
      assert.ok(STATES.includes(to), `${from} -> ${to}: ${to} is not in STATES`);
    }
  }
});
