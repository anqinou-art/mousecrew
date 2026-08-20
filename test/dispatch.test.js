const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createDispatcher } = require('../src/lib/dispatch');
const { buildIdentity } = require('../src/lib/identity');
const { WorkspaceRules } = require('../src/lib/workspace');
const { normalizeAgent } = require('../src/config');

// Dispatch is where a decision either gets consulted or quietly does not. These tests
// assert the wiring, not the rules — the rules have their own file.

const CREW = [
  { id: 'local-one', transport: 'local', runner: 'exec', exec: { command: '/bin/true' }, workDir: '/tmp' },
  { id: 'far-one', transport: 'remote' },
  { id: 'window-one', transport: 'terminal', terminal: { adapter: 'none' } },
].map(normalizeAgent);

function harness() {
  const identity = buildIdentity(CREW);
  const posted = [];
  const hub = {
    post: (m) => { posted.push(m); return identity.normalizeAgentId(m.sender); },
    broadcast: () => {},
  };
  const sent = [];
  const manager = new EventEmitter();
  manager.registry = new Map(CREW.map((a) => [a.id, a]));
  manager.remotes = new Map();
  manager.get = (id) => manager.registry.get(id) || null;
  let replyText = null;   // set per test when the reply itself needs to mention someone
  manager.runtime = (id) => ({
    send: async (text, opts) => {
      sent.push({ id, text, opts });
      // Mirror AgentRuntime exactly, including its fail-open contract: a freshness check
      // that throws must not propagate, it must deliver. A stub that lets the throw escape
      // would be testing a runtime that does not exist.
      if (typeof opts.freshness === 'function') {
        let v = null;
        try { v = opts.freshness(); } catch { v = null; }
        if (v && v.skip) return { text: '', skipped: 'stale', reason: v.reason };
      }
      return { text: replyText || `reply from ${id}` };
    },
  });
  manager.waitForRemote = async () => true;

  const dispatcher = createDispatcher({
    manager, identity, hub,
    workspace: new WorkspaceRules(CREW),
    config: { remoteBridge: { reconnectWaitMs: 10 } },
  });
  const setReply = (t) => { replyText = t; };
  return { dispatcher, hub, posted, sent, manager, identity, setReply };
}

test('a local agent gets the message and its reply reaches the group', async () => {
  const { dispatcher, posted, sent } = harness();
  const reply = await dispatcher.dispatchTo('local-one', 'do the thing', 'human');
  assert.equal(reply, 'reply from local-one');
  assert.equal(sent.length, 1);
  assert.equal(posted[0].sender, 'local-one');
});

test('a stale wake-up never reaches a local agent, and posts nothing', async () => {
  const { dispatcher, posted } = harness();
  const reply = await dispatcher.dispatchTo('local-one', 'stale work', 'system', {
    freshness: () => ({ skip: true, reason: 'order already closed' }),
  });
  assert.equal(reply, '');
  assert.equal(posted.length, 0, 'a dropped turn must not post "returned nothing" — that reads as an outage');
});

test('a stale wake-up never reaches a REMOTE agent either', async () => {
  // Remote is a push transport with no local queue to filter on the way out, so the check
  // has to be made here. Missing it leaves exactly one transport still delivering
  // instructions everyone else already knows are dead.
  const { dispatcher, manager, posted } = harness();
  let delivered = 0;
  manager.remotes.set('far-one', { online: true, sendFn: async () => { delivered++; return { text: 'x' }; } });

  const reply = await dispatcher.dispatchTo('far-one', 'stale work', 'system', {
    freshness: () => ({ skip: true, reason: 'order already closed' }),
  });
  assert.equal(reply, '');
  assert.equal(delivered, 0, 'the remote worker must not receive a dead instruction');
  assert.equal(posted.length, 0);
});

test('a remote wake-up is re-checked after waiting for a reconnect', async () => {
  // The reconnect wait is the window that actually produces stale wake-ups: up to a
  // minute passes offline, which is plenty of time for the order to move on.
  const { dispatcher, manager } = harness();
  let delivered = 0;
  manager.remotes.set('far-one', { online: false, sendFn: null });
  manager.waitForRemote = async () => {
    manager.remotes.set('far-one', { online: true, sendFn: async () => { delivered++; return { text: 'x' }; } });
    return true;
  };

  let stale = false;
  const p = dispatcher.dispatchTo('far-one', 'work', 'system', { freshness: () => ({ skip: stale, reason: 'moved on while offline' }) });
  stale = true;                       // the order moves while the worker is away
  assert.equal(await p, '');
  assert.equal(delivered, 0);
});

test('a fresh remote wake-up is delivered', async () => {
  const { dispatcher, manager } = harness();
  let delivered = 0;
  manager.remotes.set('far-one', { online: true, sendFn: async () => { delivered++; return { text: 'on it' }; } });
  const reply = await dispatcher.dispatchTo('far-one', 'work', 'system', { freshness: () => ({ skip: false }) });
  assert.equal(reply, 'on it');
  assert.equal(delivered, 1);
});

test('a freshness check that throws still delivers, on every transport', async () => {
  const { dispatcher, manager, sent } = harness();
  let remoteDelivered = 0;
  manager.remotes.set('far-one', { online: true, sendFn: async () => { remoteDelivered++; return { text: 'ok' }; } });
  const boom = () => { throw new Error('database is locked'); };

  await dispatcher.dispatchTo('local-one', 'work', 'system', { freshness: boom });
  await dispatcher.dispatchTo('far-one', 'work', 'system', { freshness: boom });

  assert.equal(sent.length, 1, 'local delivered anyway');
  assert.equal(remoteDelivered, 1, 'remote delivered anyway');
});

test('a terminal agent is not pushed to — it pulls from the group', async () => {
  const { dispatcher, sent, posted } = harness();
  const reply = await dispatcher.dispatchTo('window-one', 'work', 'human');
  assert.equal(reply, '');
  assert.equal(sent.length, 0);
  assert.equal(posted.length, 0);
});

test('mentions wake everyone named, and never the sender', async () => {
  const { dispatcher, sent } = harness();
  const woken = dispatcher.dispatchMentions('@local-one and @far-one, see this', 'local-one');
  assert.deepEqual(woken, ['far-one'], 'the sender is not woken by their own words');
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 0);
});

test('a reply that mentions someone wakes them, and the chain stops there', async () => {
  // The invariant is not "reDispatch was passed along" — it is that the woken agent's own
  // reply does not wake a third party. Assert the outcome, not the argument.
  const { dispatcher, sent, manager, setReply } = harness();
  let remoteWoken = 0;
  manager.remotes.set('far-one', { online: true, sendFn: async () => { remoteWoken++; return { text: 'x' }; } });
  setReply('on it — @far-one you are next');          // the woken agent mentions someone else

  dispatcher.fireReplyDispatches('done — @local-one your turn', 'far-one');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(sent.length, 1, 'exactly one agent was woken');
  assert.equal(sent[0].id, 'local-one');
  assert.equal(remoteWoken, 0, 'the second hop must not fire');
});

test('a first-hop reply DOES wake whoever it mentions', async () => {
  // The companion assertion: proves the previous test is measuring the one-hop rule and
  // not simply a dispatcher that never chains at all.
  const { dispatcher, manager, setReply } = harness();
  let remoteWoken = 0;
  manager.remotes.set('far-one', { online: true, sendFn: async () => { remoteWoken++; return { text: 'x' }; } });
  setReply('on it — @far-one you are next');

  await dispatcher.dispatchTo('local-one', 'please start', 'human');   // reDispatch defaults true
  await new Promise((r) => setImmediate(r));
  assert.equal(remoteWoken, 1);
});
