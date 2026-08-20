// routes/agents.js — status, presence, and direct messages.
//
// Direct messages exist because "tell everyone" and "ask one person" are different acts.
// The transport is the same pipeline as the group; only the recipient changes.

const express = require('express');
const crypto = require('crypto');

const PRESENCE_STATES = new Set(['idle', 'busy', 'needs_input', 'stopped']);

function createAgentsRouter({ manager, identity, store, requireToken, config }) {
  const router = express.Router();
  router.use(requireToken);

  // Terminal agents report themselves; the manager cannot see their processes.
  const terminalPresence = {};

  const dmClients = new Set();
  const agentClients = new Map();       // agent id -> Set<res>
  const pendingDms = new Map();         // dmId -> event, cleared by ack
  const MAX_PENDING = 500;

  function dmBroadcast(data) {
    const json = JSON.stringify(data);
    for (const res of dmClients) {
      try { res.write(`data: ${json}\n\n`); } catch { /* closing */ }
    }
  }

  function agentBroadcast(id, data) {
    const set = agentClients.get(id);
    if (!set || !set.size) return;
    const json = JSON.stringify(data);
    for (const res of set) {
      try { res.write(`data: ${json}\n\n`); } catch { /* closing */ }
    }
  }

  manager.on('delta', ({ agent, text }) => agentBroadcast(agent, { type: 'chunk', text }));
  manager.on('done', ({ agent, text }) => agentBroadcast(agent, { type: 'reply', text }));

  // ---------- status ----------

  router.get('/api/agents/status', (req, res) => {
    const out = manager.status();
    for (const [id, p] of Object.entries(terminalPresence)) {
      if (out[id]) out[id] = { ...out[id], state: p.state, detail: p.detail, reportedAt: new Date(p.ts).toISOString() };
    }
    res.json(out);
  });

  router.get('/api/agents/:id/status', (req, res) => {
    const all = manager.status();
    const one = all[req.params.id];
    if (!one) return res.status(404).json({ error: 'unknown agent' });
    res.json(one);
  });

  /**
   * Presence report from a terminal-window agent's sidecar.
   *
   * Only ids on the roster are accepted: an endpoint that lets a caller invent keys is an
   * endpoint that lets a caller invent crew members.
   */
  router.post('/api/agents/presence', (req, res) => {
    const { agents } = req.body || {};
    if (!agents || typeof agents !== 'object') return res.status(400).json({ error: 'agents object required' });
    const accepted = [];
    for (const [id, v] of Object.entries(agents)) {
      const cfg = manager.get(id);
      if (!cfg || cfg.transport !== 'terminal') continue;
      const state = PRESENCE_STATES.has(v && v.state) ? v.state : 'stopped';
      terminalPresence[id] = { state, detail: (v && v.detail) || null, ts: Date.now() };
      accepted.push(id);
    }
    res.json({ ok: true, accepted });
  });

  /** Rotate an agent onto a fresh session (the "new window" button). */
  router.post('/api/agents/:id/session/new', (req, res) => {
    const rt = manager.runtime(req.params.id);
    if (!rt) return res.status(404).json({ error: 'not a local agent' });
    res.json({ ok: true, ...rt.newSession() });
  });

  // ---------- direct messages ----------

  router.get('/api/dm/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write('data: {"type":"connected"}\n\n');
    dmClients.add(res);
    const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch {} }, 15_000);
    req.on('close', () => { clearInterval(hb); dmClients.delete(res); });
  });

  /** Catch-up for a sidecar that reconnected: everything still unacknowledged. */
  router.get('/api/dm/pending', (req, res) => {
    const since = req.query.since ? String(req.query.since) : null;
    res.json({ pending: [...pendingDms.values()].filter((e) => !since || e.ts > since) });
  });

  router.get('/api/agent/:id/history', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    res.json({ messages: store.msg.recent.all(`dm-${req.params.id}`, limit).reverse() });
  });

  router.get('/api/agent/:id/events', (req, res) => {
    const id = req.params.id;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write('data: {"type":"connected"}\n\n');
    if (!agentClients.has(id)) agentClients.set(id, new Set());
    agentClients.get(id).add(res);
    const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch {} }, 15_000);
    req.on('close', () => { clearInterval(hb); agentClients.get(id)?.delete(res); });
  });

  /** Human -> one agent. */
  router.post('/api/agent/:id/chat', async (req, res) => {
    const id = req.params.id;
    const cfg = manager.get(id);
    if (!cfg) return res.status(404).json({ error: `unknown agent "${id}"` });
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });

    const ts = new Date().toISOString();
    const channel = `dm-${id}`;

    if (cfg.transport === 'terminal') {
      // Nothing is spawned here: this crew member lives in a window we do not own. The
      // message is published and its sidecar picks it up.
      const dmId = crypto.randomUUID();
      store.msg.insert.run(channel, 'user', message, ts, JSON.stringify({ dm: true, dmId }));
      const event = { type: 'dm', dmId, target: id, sender: 'human', content: message, ts };
      if (pendingDms.size >= MAX_PENDING) pendingDms.delete(pendingDms.keys().next().value);
      pendingDms.set(dmId, event);
      dmBroadcast(event);
      return res.json({ ok: true, dmId });
    }

    store.msg.insert.run(channel, 'user', message, ts, JSON.stringify({ dm: true }));
    res.json({ ok: true });
    try {
      const rt = manager.runtime(id);
      if (!rt) return;
      const result = await rt.send(message, { source: 'dm' });
      const text = (result && result.text) || '';
      if (text) {
        store.msg.insert.run(channel, 'assistant', text, new Date().toISOString(), JSON.stringify({ sender: id }));
        agentBroadcast(id, { type: 'reply', text });
      }
    } catch (e) {
      agentBroadcast(id, { type: 'error', text: `${id}: ${e.message}` });
    }
  });

  /** Agent -> human, in the same 1:1 thread. */
  router.post('/api/dm/:id/post', (req, res) => {
    const id = req.params.id;
    if (!manager.get(id)) return res.status(404).json({ error: `unknown agent "${id}"` });
    const { content } = req.body || {};
    if (!content) return res.status(400).json({ error: 'content required' });
    store.msg.insert.run(`dm-${id}`, 'assistant', content, new Date().toISOString(), JSON.stringify({ sender: id }));
    agentBroadcast(id, { type: 'reply', text: content });
    res.json({ ok: true });
  });

  /**
   * Delivery receipt. `expired` is the important one: a group message that never lands is
   * still in the group history, but a direct message that never lands looks — from the
   * sender's side — exactly like being ignored. So an undelivered DM comes back as a
   * visible system line in the same thread.
   */
  router.post('/api/dm/:id/ack', (req, res) => {
    const id = req.params.id;
    const { dmId, status } = req.body || {};
    if (!dmId || !['delivered', 'expired'].includes(status)) {
      return res.status(400).json({ error: 'dmId and status (delivered|expired) required' });
    }
    pendingDms.delete(dmId);
    if (status === 'expired') {
      const text = `(not delivered: ${identity.displayNameOf(id)}'s window was not available, so this message expired)`;
      store.msg.insert.run(`dm-${id}`, 'system', text, new Date().toISOString(), JSON.stringify({ sender: 'system', dmId, dmStatus: 'expired' }));
      agentBroadcast(id, { type: 'reply', text });
    }
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createAgentsRouter, PRESENCE_STATES };
