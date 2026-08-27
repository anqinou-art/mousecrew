const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { build } = require('../src/server');
const { normalizeAgent } = require('../src/config');

// Route-level tests.
//
// Everything else in this suite proves the *decisions* are right: canWork says no,
// canMerge says no, the state table refuses an edge. None of that proves the decision is
// actually consulted on the way through. Delete a check from a handler and a suite made
// only of unit tests stays green while the gate is wide open.
//
// So these tests speak HTTP. If an enforcement point is removed from a route, one of them
// goes red.

const TOKEN = 'test-token-abcdefghijklmnop';

// Terminal transport on purpose: dispatch treats those as pull-mode and returns without
// touching a process, so no test ever spawns a CLI.
const CREW = [
  { id: 'backend', transport: 'terminal', terminal: { adapter: 'none' }, repos: ['server'] },
  { id: 'auditor', transport: 'terminal', terminal: { adapter: 'none' }, repos: ['server'], canMerge: true },
  { id: 'frontend', transport: 'terminal', terminal: { adapter: 'none' }, repos: ['app'], selfManaged: true },
].map(normalizeAgent);

// `t` is required: cleanup is registered with t.after() so it runs even when an
// assertion throws. Without that, a failing test leaves its HTTP server listening and the
// runner never exits — a suite that hangs the moment it goes red is barely more useful
// than one that never goes red at all, because you cannot tell the two apart.
async function boot(t, crew = CREW) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-routes-'));
  const tokenFile = path.join(dir, 'auth.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ token: TOKEN }));
  fs.chmodSync(tokenFile, 0o600);

  const config = {
    host: '127.0.0.1', port: 0,
    dbPath: path.join(dir, 'test.db'),
    archivePath: path.join(dir, 'archive.jsonl'),
    tokenFile,
    nudge: { enabled: false }, delivery: {}, contextWatch: { enabled: false },
    notify: { type: 'none' }, remoteBridge: { enabled: false },
  };
  const ctx = build({ config, agents: crew });
  const server = http.createServer(ctx.app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, route, body, { token = TOKEN } = {}) => {
    const res = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body: json };
  };

  const close = () => new Promise((r) => {
    // Detach before closing the store: the hub and dispatcher are subscribed to a
    // module-level bus, and a later test's emit would otherwise reach this closed one.
    ctx.hub.detach();
    ctx.dispatcher.detach();
    ctx.manager.destroyAll();
    ctx.store.close();
    // fetch() keeps its sockets alive, and server.close() waits for every one of them —
    // without this the suite hangs after the last assertion passes.
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(r);
  });
  t.after(close);
  return { call, ctx };
}

/** Create an order and put it in a given state without going through the guarded routes. */
function place(ctx, id, status) {
  ctx.store.db.prepare('UPDATE work_orders SET status = ? WHERE id = ?').run(status, id);
}

async function newOrder(call, { assignee, repo, title = 'a task' }) {
  const r = await call('POST', '/api/orders', { title, assignee, repo, actor: 'human' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id;
}

// ---------- the door ----------

test('every route requires a token', async (t) => {
  const { call } = await boot(t);
  for (const [method, route] of [['GET', '/api/orders'], ['POST', '/api/orders'], ['GET', '/api/agents/status'], ['GET', '/api/group/history']]) {
    const r = await call(method, route, method === 'POST' ? { title: 'x' } : undefined, { token: null });
    assert.equal(r.status, 401, `${method} ${route} should require a token`);
  }
  const bad = await call('GET', '/api/orders', undefined, { token: 'wrong-token-same-length!!' });
  assert.equal(bad.status, 401);
});

// ---------- ownership, at the route ----------

test('creating an order across a repo boundary is refused by the route', async (t) => {
  const { call } = await boot(t);
  const r = await call('POST', '/api/orders', { title: 'wrong tree', assignee: 'frontend', repo: 'server', actor: 'human' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /does not own repo "server"/);
  assert.deepEqual(r.body.owners.sort(), ['auditor', 'backend']);
});

test('reassigning across a repo boundary is refused by the route', async (t) => {
  const { call } = await boot(t);
  const id = await newOrder(call, { assignee: 'backend', repo: 'server' });
  const r = await call('POST', `/api/orders/${id}/assign`, { assignee: 'frontend', actor: 'human' });
  assert.equal(r.status, 409);
});

test('finished work cannot be reassigned', async (t) => {
  const { call, ctx } = await boot(t);
  const id = await newOrder(call, { assignee: 'backend', repo: 'server' });
  place(ctx, id, 'closed');
  const r = await call('POST', `/api/orders/${id}/assign`, { assignee: 'auditor', actor: 'human' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /reassigning finished work/);
});

// ---------- the merge gate, at the route ----------

test('a non-gate agent cannot take an order past review', async (t) => {
  const { call, ctx } = await boot(t);
  const id = await newOrder(call, { assignee: 'backend', repo: 'server' });
  place(ctx, id, 'auditing');

  const viaRestart = await call('POST', `/api/orders/${id}/transition`, { to_status: 'pending_restart', actor: 'backend' });
  assert.equal(viaRestart.status, 403);

  const viaClose = await call('POST', `/api/orders/${id}/transition`, { to_status: 'closed', actor: 'backend' });
  assert.equal(viaClose.status, 403);

  const asGate = await call('POST', `/api/orders/${id}/transition`, { to_status: 'pending_restart', actor: 'auditor' });
  assert.equal(asGate.status, 200);
});

test('the audit lane cannot be bypassed through accepted', async (t) => {
  // The side door. Guarding only "self-managed must not enter review" leaves
  // submitted -> accepted -> closed, which reaches a terminal state with no review in its
  // timeline, and never touches the states the merge-gate check watches.
  const { call, ctx } = await boot(t);
  const id = await newOrder(call, { assignee: 'backend', repo: 'server' });
  place(ctx, id, 'submitted');

  const r = await call('POST', `/api/orders/${id}/transition`, { to_status: 'accepted', actor: 'backend' });
  assert.equal(r.status, 409, 'a non-self-managed order must not go straight to accepted');
  assert.match(r.body.error, /goes through review/);

  const stillThere = await call('GET', `/api/orders/${id}`);
  assert.equal(stillThere.body.status, 'submitted');
});

test('a self-managed lane still ends at human acceptance', async (t) => {
  const { call, ctx } = await boot(t);
  const id = await newOrder(call, { assignee: 'frontend', repo: 'app' });
  place(ctx, id, 'submitted');

  const accepted = await call('POST', `/api/orders/${id}/transition`, { to_status: 'accepted', actor: 'human' });
  assert.equal(accepted.status, 200);
  const closed = await call('POST', `/api/orders/${id}/transition`, { to_status: 'closed', actor: 'human' });
  assert.equal(closed.status, 200);
});

test('a self-managed lane is kept out of review', async (t) => {
  const { call, ctx } = await boot(t);
  const id = await newOrder(call, { assignee: 'frontend', repo: 'app' });
  place(ctx, id, 'submitted');
  const r = await call('POST', `/api/orders/${id}/transition`, { to_status: 'auditing', actor: 'auditor' });
  assert.equal(r.status, 409);
});

test('with no merge gate configured, accepted stays open — the solo escape hatch', async (t) => {
  // Refusing here would leave a one-agent setup with no way to finish anything: the audit
  // lane needs a gate that does not exist. A rule that traps its user gets routed around.
  const solo = [normalizeAgent({ id: 'solo', transport: 'terminal', terminal: { adapter: 'none' } })];
  const { call, ctx } = await boot(t, solo);
  const id = await newOrder(call, { assignee: 'solo' });
  place(ctx, id, 'submitted');
  const r = await call('POST', `/api/orders/${id}/transition`, { to_status: 'accepted', actor: 'human' });
  assert.equal(r.status, 200);
});

test('with no merge gate, review is refused at the entrance, not at the exit', async (t) => {
  // The other half of the solo escape hatch. If nobody may take an order out of review,
  // letting it in creates a one-way door whose only exit is `rejected` — the order enters
  // on a 200 and then cannot leave. Refuse at the entrance, for the same reason a
  // self-managed lane is refused there: do not park work in a queue no one can clear.
  const solo = [normalizeAgent({ id: 'solo', transport: 'terminal', terminal: { adapter: 'none' } })];
  const { call, ctx } = await boot(t, solo);
  const id = await newOrder(call, { assignee: 'solo' });
  place(ctx, id, 'submitted');

  const r = await call('POST', `/api/orders/${id}/transition`, { to_status: 'auditing', actor: 'human' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /nothing can leave review/);
  assert.equal((await call('GET', `/api/orders/${id}`)).body.status, 'submitted');
});

test('with a merge gate, review is of course still open', async (t) => {
  // Companion assertion: proves the rule above is about the missing gate, not about
  // review being closed in general.
  const { call, ctx } = await boot(t);
  const id = await newOrder(call, { assignee: 'backend', repo: 'server' });
  place(ctx, id, 'submitted');
  const r = await call('POST', `/api/orders/${id}/transition`, { to_status: 'auditing', actor: 'auditor' });
  assert.equal(r.status, 200);
});

test('a working agent cannot wipe the restart queue', async (t) => {
  // Not about bad merges — the merge already happened. It is about the record of what is
  // still waiting to go live quietly disappearing.
  const { call, ctx } = await boot(t);
  const id = await newOrder(call, { assignee: 'backend', repo: 'server' });
  place(ctx, id, 'pending_restart');

  const byAgent = await call('POST', '/api/orders/restart-done', { actor: 'backend' });
  assert.equal(byAgent.status, 403);
  assert.equal((await call('GET', `/api/orders/${id}`)).body.status, 'pending_restart');

  const byHuman = await call('POST', '/api/orders/restart-done', { actor: 'ops-person' });
  assert.equal(byHuman.status, 200);
  assert.deepEqual(byHuman.body.closed, [id]);
});

// ---------- the rest of the lane ----------

test('an illegal edge is refused before anything else happens', async (t) => {
  const { call } = await boot(t);
  const id = await newOrder(call, { assignee: 'backend', repo: 'server' });
  const r = await call('POST', `/api/orders/${id}/transition`, { to_status: 'closed', actor: 'human' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /draft -> closed not allowed/);
});

test('blocking on an order that does not exist is refused', async (t) => {
  const { call, ctx } = await boot(t);
  const id = await newOrder(call, { assignee: 'backend', repo: 'server' });
  place(ctx, id, 'in_progress');
  const r = await call('POST', `/api/orders/${id}/pause`, { actor: 'human', blocked_by: 'WO-999', reason: 'typo' });
  assert.equal(r.status, 400);
});

test('the card a human sees says where the order actually came from', async (t) => {
  // The row and the broadcast must not disagree. A card that claims "paused" for an order
  // that was rejected puts a false history in front of the one reader who will not go and
  // check the timeline.
  const { call, ctx } = await boot(t);
  const id = await newOrder(call, { assignee: 'backend', repo: 'server' });
  place(ctx, id, 'rejected');

  const cards = [];
  ctx.hub.addClient({ write: (s) => { try { cards.push(JSON.parse(s.replace(/^data: /, ''))); } catch {} } });
  await call('POST', `/api/orders/${id}/resume`, { actor: 'human' });

  const card = cards.find((c) => c.type === 'order_card' && c.order_id === id);
  assert.ok(card, 'a card was broadcast');
  assert.equal(card.from_status, 'rejected');

  const tl = (await call('GET', `/api/orders/${id}`)).body.timeline;
  assert.equal(tl[tl.length - 1].from, card.from_status, 'the card and the timeline agree');
});

test('a group message reaches the group and names its author canonically', async (t) => {
  const { call } = await boot(t);
  const posted = await call('POST', '/api/group/post', { sender: 'backend', content: 'looking at it now', reDispatch: false });
  assert.equal(posted.status, 200);
  assert.equal(posted.body.sender, 'backend');

  const history = await call('GET', '/api/group/history?limit=10');
  const last = history.body.messages[history.body.messages.length - 1];
  assert.equal(last.content, 'looking at it now');
  assert.equal(JSON.parse(last.metadata).sender, 'backend');
});

test('agent status is reported for every crew member', async (t) => {
  const { call } = await boot(t);
  const s = (await call('GET', '/api/agents/status')).body;
  assert.deepEqual(Object.keys(s).sort(), ['auditor', 'backend', 'frontend']);
});

test('presence only accepts crew members that are actually terminal agents', async (t) => {
  const { call } = await boot(t);
  const r = await call('POST', '/api/agents/presence', {
    agents: { backend: { state: 'busy' }, 'not-on-the-roster': { state: 'idle' } },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.accepted, ['backend']);
  const s = (await call('GET', '/api/agents/status')).body;
  assert.equal(s.backend.state, 'busy');
  assert.ok(!('not-on-the-roster' in s));
});

// ---------------------------------------------------------------------------
// Threads.
//
// The gates are unit-tested in thread-rules.test.js. These prove each one is actually
// consulted on the way through — delete a check from a handler and one of these goes red
// while every unit test stays green.

async function newThread(call, name, owner = 'shu') {
  const r = await call('POST', '/api/threads', { name, owner });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.data;
}

test('threads: a new thread starts as an idea, with no way to file it as already running', async (t) => {
  const { call } = await boot(t);
  const made = await newThread(call, 'caching');
  assert.equal(made.status, 'idea');
  assert.deepEqual(made.plan, []);
  assert.deepEqual(made.log, []);
  // Naming it twice is a conflict, not a silent overwrite of someone else's thread.
  assert.equal((await call('POST', '/api/threads', { name: 'caching', owner: 'other' })).status, 409);
});

test('threads: set refuses plan and snapshot, over HTTP', async (t) => {
  const { call } = await boot(t);
  await newThread(call, 'caching');
  const plan = await call('PATCH', '/api/threads/caching', { field: 'plan', value: 'sneaking it in' });
  assert.equal(plan.status, 400);
  assert.equal(plan.body.error, 'plan_not_settable');

  const snap = await call('PATCH', '/api/threads/caching', { field: 'snapshot', value: 'done I guess' });
  assert.equal(snap.status, 400);
  assert.equal(snap.body.error, 'snapshot_not_settable');
});

test('threads: the only road to done is finish, and finish needs a snapshot', async (t) => {
  const { call } = await boot(t);
  await newThread(call, 'caching');

  const viaSet = await call('PATCH', '/api/threads/caching', { field: 'status', value: 'done' });
  assert.equal(viaSet.status, 400);
  assert.equal(viaSet.body.error, 'use_finish');

  const bare = await call('POST', '/api/threads/caching/finish', {});
  assert.equal(bare.status, 400);
  assert.equal(bare.body.error, 'snapshot_required');

  const ok = await call('POST', '/api/threads/caching/finish', { snapshot: 'shipped; retry path untested' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.status, 'done');
  assert.equal(ok.body.data.snapshot, 'shipped; retry path untested');
});

test('threads: a log line must declare one intent — none and two are both refused', async (t) => {
  const { call } = await boot(t);
  await newThread(call, 'caching');

  const none = await call('POST', '/api/threads/caching/log', { who: 'shu', what: 'poked at it' });
  assert.equal(none.status, 400);
  assert.equal(none.body.error, 'log_intent_required');

  const two = await call('POST', '/api/threads/caching/log', { who: 'shu', what: 'x', check: 1, no_plan_change: true });
  assert.equal(two.status, 400);
  assert.equal(two.body.error, 'log_intent_ambiguous');

  const one = await call('POST', '/api/threads/caching/log', { who: 'shu', what: 'read the code, no changes yet', no_plan_change: true });
  assert.equal(one.status, 200);
  assert.equal(one.body.data.log.length, 1);
});

test('threads: nobody can rewrite or delete a log line, including whoever wrote it', async (t) => {
  const { call, ctx } = await boot(t);
  await newThread(call, 'caching');
  await call('POST', '/api/threads/caching/log', { who: 'shu', what: 'wrote it wrong', no_plan_change: true });

  assert.throws(() => ctx.store.db.exec("UPDATE thread_log SET what = 'actually right'"), /append-only/);
  assert.throws(() => ctx.store.db.exec('DELETE FROM thread_log'), /append-only/);
  // The line is still there, unchanged. A correction goes on the next line.
  const after = await call('GET', '/api/threads/caching');
  assert.equal(after.body.log[0].what, 'wrote it wrong');
});

test('threads: a log line and the plan change it describes land together or not at all', async (t) => {
  const { call } = await boot(t);
  await newThread(call, 'caching');
  await call('POST', '/api/threads/caching/plan', { items: ['schema', 'routes'] });

  // Ticking an item that does not exist must leave no log line behind, or the log would
  // point at a plan state that never happened.
  const bad = await call('POST', '/api/threads/caching/log', { who: 'shu', what: 'ticked 9', check: 9 });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'plan_item_not_found');
  const after = await call('GET', '/api/threads/caching');
  assert.equal(after.body.log.length, 0, 'a refused plan change must not leave a log line');

  const good = await call('POST', '/api/threads/caching/log', { who: 'shu', what: 'schema is in', check: 1 });
  assert.equal(good.status, 200);
  assert.equal(good.body.data.plan[0].done, 1);
  assert.equal(good.body.data.log.length, 1);
});

test('threads: a tick can be taken back, because the plan is where we are now', async (t) => {
  const { call } = await boot(t);
  await newThread(call, 'caching');
  await call('POST', '/api/threads/caching/plan', { items: ['schema'] });
  await call('POST', '/api/threads/caching/plan/1/check');
  assert.equal((await call('GET', '/api/threads/caching')).body.plan[0].done, 1);
  await call('POST', '/api/threads/caching/plan/1/uncheck');
  assert.equal((await call('GET', '/api/threads/caching')).body.plan[0].done, 0);
});

test('threads: archiving without a snapshot needs a reason; with one it does not', async (t) => {
  const { call } = await boot(t);
  await newThread(call, 'abandoned');
  const bare = await call('POST', '/api/threads/abandoned/archive', {});
  assert.equal(bare.status, 400);
  assert.equal(bare.body.error, 'why_required');

  const withWhy = await call('POST', '/api/threads/abandoned/archive', { why: 'folded into caching' });
  assert.equal(withWhy.status, 200);
  assert.equal(withWhy.body.data.archived, true);

  // Soft delete: it is out of the default list but its history is still readable.
  assert.equal((await call('GET', '/api/threads')).body.find((x) => x.name === 'abandoned'), undefined);
  assert.equal((await call('GET', '/api/threads?archived=all')).body.find((x) => x.name === 'abandoned').name, 'abandoned');
  assert.equal((await call('GET', '/api/threads/abandoned')).status, 200);

  const undone = await call('POST', '/api/threads/abandoned/archive', { undo: true });
  assert.equal(undone.body.data.archived, false);
});

test('threads: prev is one-way and must point at something real', async (t) => {
  const { call } = await boot(t);
  await newThread(call, 'v1');
  assert.equal((await call('POST', '/api/threads', { name: 'v2', owner: 'shu', prev: 'ghost' })).status, 400);
  const v2 = await newThread(call, 'v2');
  assert.equal(v2.prev, null);
  assert.equal((await call('PATCH', '/api/threads/v2', { field: 'prev', value: 'v1' })).body.data.prev, 'v1');
  assert.equal((await call('PATCH', '/api/threads/v2', { field: 'prev', value: 'v2' })).status, 400);
});

test('threads: the API is behind the token like everything else', async (t) => {
  const { call } = await boot(t);
  assert.equal((await call('GET', '/api/threads', undefined, { token: null })).status, 401);
  assert.equal((await call('POST', '/api/threads', { name: 'x', owner: 'y' }, { token: null })).status, 401);
});
