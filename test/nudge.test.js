const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bus = require('../src/lib/event-bus');
const { open } = require('../src/db');
const { buildIdentity } = require('../src/lib/identity');
const { createDispatcher } = require('../src/lib/dispatch');
const {
  createNudger,
  runNudgeRound,
  createNudgePacer,
  backoffIntervalMs,
  appendNote,
  lastMovedAt,
} = require('../src/lib/nudge');

const MIN = 60 * 1000;
const NOW = Date.parse('2026-09-20T12:00:00Z');
const PACING = {
  baseIntervalMs: 30 * MIN,
  backoffCapMs: 4 * 60 * MIN,
  backoffAfter: 3,
};
const IDLE = {
  assigned: 10 * MIN,
  submitted: 10 * MIN,
  rejected: 10 * MIN,
  in_progress: 40 * MIN,
  auditing: 40 * MIN,
};
const workspace = {
  mergeGate: { id: 'gate' },
  isSelfManaged: (id) => id === 'solo',
};

function order(status, idleMinutes, fields = {}) {
  return {
    id: fields.id || `WO-${status}`,
    title: fields.title || 'Do the work',
    status,
    assignee: fields.assignee || 'worker',
    timeline: JSON.stringify([{ status, ts: new Date(NOW - idleMinutes * MIN).toISOString() }]),
    ...fields,
  };
}

function round(orders, options = {}) {
  const sent = [];
  const notes = [];
  const result = runNudgeRound({
    listByStatus: (status) => orders.filter((item) => item.status === status),
    now: options.now == null ? NOW : options.now,
    pacer: options.pacer || createNudgePacer(PACING),
    lastNudged: options.lastNudged || new Map(),
    send: (status, item, owner) => { sent.push({ status, id: item.id, owner }); return true; },
    writeNote: (timeline, id) => notes.push({ timeline, id }),
    logsOf: options.logsOf || (() => []),
    workspace,
    idleMsByStatus: IDLE,
    normalizeAgentId: (id) => id,
    backoffCapMs: PACING.backoffCapMs,
  });
  return { sent, notes, result };
}

test('the five actionable states use the two configured idle thresholds and ownerOf', () => {
  const cases = [
    ['assigned', 10, 'worker'],
    ['submitted', 10, 'gate'],
    ['rejected', 10, 'worker'],
    ['in_progress', 40, 'worker'],
    ['auditing', 40, 'gate'],
  ];
  for (const [status, threshold, ownerId] of cases) {
    assert.equal(round([order(status, threshold - 1)]).sent.length, 0, `${status} before threshold`);
    assert.deepEqual(round([order(status, threshold)]).sent, [
      { status, id: `WO-${status}`, owner: ownerId },
    ]);
  }

  assert.equal(round([order('submitted', 60, { assignee: 'solo' })]).sent.length, 0,
    'self-managed delivery does not owe the merge gate an action');
  for (const status of ['draft', 'paused', 'pending_restart', 'closed', 'accepted']) {
    assert.equal(round([order(status, 600)]).sent.length, 0, status);
  }
});

test('one owner gets one reminder per round and orders rotate across rounds', () => {
  const orders = [
    order('in_progress', 70, { id: 'WO-1' }),
    order('in_progress', 60, { id: 'WO-2' }),
    order('in_progress', 50, { id: 'WO-3' }),
  ];
  const pacer = createNudgePacer(PACING);
  const lastNudged = new Map();
  const ids = [];
  for (let step = 0; step < 3; step++) {
    const { sent } = round(orders, { now: NOW + step * 30 * MIN, pacer, lastNudged });
    assert.equal(sent.length, 1);
    ids.push(sent[0].id);
  }
  assert.equal(new Set(ids).size, 3);
});

test('unanswered reminders back off once each, cap at four hours, and owner activity clears immediately', () => {
  const item = order('in_progress', 60, { id: 'WO-BACKOFF' });
  const logs = [];
  const pacer = createNudgePacer(PACING);
  const lastNudged = new Map();
  let clock = NOW;

  round([item], { now: clock, pacer, lastNudged, logsOf: () => logs });
  clock += 30 * MIN;
  round([item], { now: clock, pacer, lastNudged, logsOf: () => logs });
  const once = pacer._state.get('worker').strikes;
  round([item], { now: clock, pacer, lastNudged, logsOf: () => logs });
  assert.equal(pacer._state.get('worker').strikes, once, 'one sent reminder is not settled twice');

  clock += 30 * MIN;
  round([item], { now: clock, pacer, lastNudged, logsOf: () => logs });
  clock += 30 * MIN;
  const escalated = round([item], { now: clock, pacer, lastNudged, logsOf: () => logs });
  assert.equal(pacer._state.get('worker').strikes, 3);
  assert.equal(pacer._state.get('worker').pending, false);
  assert.equal(escalated.result.notes.length, 1, 'entering backoff is recorded');
  assert.equal(backoffIntervalMs(3, PACING), 60 * MIN);
  assert.equal(backoffIntervalMs(99, PACING), 4 * 60 * MIN);

  clock += 30 * MIN;
  round([item], { now: clock, pacer, lastNudged, logsOf: () => logs });
  clock += 30 * MIN;
  const deepened = round([item], { now: clock, pacer, lastNudged, logsOf: () => logs });
  assert.equal(pacer._state.get('worker').strikes, 4);
  assert.equal(deepened.result.notes.length, 1, 'deepening backoff is recorded');

  logs.push({ agent_name: 'worker', ts: new Date(clock + 5 * MIN).toISOString() });
  const recovered = round([item], {
    now: clock + 6 * MIN,
    pacer,
    lastNudged,
    logsOf: () => logs,
  });
  assert.equal(recovered.sent.length, 0, 'the owner log also removes the order from this round');
  assert.equal(pacer._state.get('worker').strikes, 0, 'the same movement clears existing backoff');
  assert.equal(recovered.result.notes.length, 1, 'clearing backoff is recorded');
});

test('a backoff note is persisted without moving updated_at or masquerading as a transition', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-nudge-'));
  const store = open(path.join(dir, 'test.db'));
  try {
    const transitionAt = '2026-09-20T10:00:00.000Z';
    store.order.create.run({
      id: 'WO-NOTE', project_id: null, title: 'Note test', description: null,
      status: 'in_progress', assignee: 'worker', repo: null, created_by: null,
      timeline: JSON.stringify([{ status: 'in_progress', ts: transitionAt }]),
    });
    store.db.prepare('UPDATE work_orders SET updated_at = ? WHERE id = ?')
      .run('2026-09-20 10:30:00', 'WO-NOTE');
    const before = store.order.getById.get('WO-NOTE');
    appendNote(before, {
      type: 'nudge_backoff', actor: 'system', ts: '2026-09-20T11:00:00.000Z', comment: 'backoff',
    }, (timeline, id) => store.order.appendTimelineNote.run(timeline, id));
    const after = store.order.getById.get('WO-NOTE');
    const note = JSON.parse(after.timeline).at(-1);

    assert.equal(after.updated_at, before.updated_at);
    assert.equal(note.status, undefined);
    assert.equal(lastMovedAt(after, 'worker', () => []), Date.parse(transitionAt),
      'the scheduler note is not treated as order movement');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real scan sends both channels once, with dequeue freshness and durable wording', async () => {
  let current = order('submitted', 20, { id: 'WO-SEND', assignee: 'worker' });
  const rows = [current];
  const store = {
    order: {
      getByStatus: { all: (status) => rows.filter((item) => item.status === status) },
      getById: { get: () => current },
      appendTimelineNote: { run: () => {} },
    },
    log: { byOrder: { all: () => [] } },
  };
  const agents = [{ id: 'gate', displayName: 'Reviewer', transport: 'remote', canMerge: true }];
  const identity = buildIdentity(agents);
  const manager = {
    remotes: new Map(),
    get: (id) => agents.find((agent) => agent.id === id) || null,
    waitForRemote: async () => true,
  };
  let delivered = 0;
  manager.remotes.set('gate', {
    online: true,
    sendFn: async () => { delivered++; return { text: 'ok' }; },
  });
  const dispatcher = createDispatcher({
    manager,
    identity,
    hub: { post: () => {}, broadcast: () => {} },
    workspace,
    config: { remoteBridge: { reconnectWaitMs: 1 } },
  });
  const posts = [];
  const onPost = (event) => posts.push(event);
  bus.on('group:post', onPost);

  try {
    const nudger = createNudger({
      store,
      identity,
      notifier: { send: async () => {} },
      workspace,
      config: { nudge: { enabled: false, scanMs: 5 * MIN, ...PACING,
        claimIdleMs: 10 * MIN, progressIdleMs: 40 * MIN } },
    });
    const result = nudger.scanOnce(NOW);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(result.sent, [{ owner: 'gate', id: 'WO-SEND' }]);
    assert.equal(posts.length, 1, 'the group copy is posted once');
    assert.equal(delivered, 1, 'the dispatcher sends the push copy once');
    assert.match(posts[0].content, /is waiting on you/);
    assert.match(posts[0].content, /mousecrew accept WO-SEND/);
    assert.match(posts[0].content, /mousecrew show WO-SEND/);
    assert.doesNotMatch(posts[0].content, /submitted|\d+\s*min/i);

    current = { ...current, status: 'rejected' };
    const event = [];
    const capture = (payload) => event.push(payload);
    bus.once('group:dispatch_mentions', capture);
    current = order('submitted', 20, { id: 'WO-FRESH', assignee: 'worker' });
    rows.splice(0, rows.length, current);
    nudger.scanOnce(NOW + 30 * MIN);
    current = { ...current, status: 'rejected' };
    assert.equal(event[0].freshness().skip, true, 'queued reminder is rechecked against current owner');
  } finally {
    bus.off('group:post', onPost);
    dispatcher.detach();
  }
});

test('pending-restart notification keeps its hourly cadence', () => {
  const pending = { id: 'WO-RESTART', status: 'pending_restart' };
  const store = {
    order: {
      getByStatus: { all: (status) => status === 'pending_restart' ? [pending] : [] },
      getById: { get: () => pending },
      appendTimelineNote: { run: () => {} },
    },
    log: { byOrder: { all: () => [] } },
  };
  const notices = [];
  const nudger = createNudger({
    store,
    identity: { normalizeAgentId: (id) => id, displayNameOf: (id) => id },
    notifier: { send: async (...args) => { notices.push(args); } },
    workspace,
    config: { nudge: { enabled: false, scanMs: 5 * MIN, ...PACING,
      claimIdleMs: 10 * MIN, progressIdleMs: 40 * MIN } },
  });
  nudger.scanOnce(NOW);
  nudger.scanOnce(NOW + 30 * MIN);
  nudger.scanOnce(NOW + 61 * MIN);
  assert.equal(notices.length, 2);
});
