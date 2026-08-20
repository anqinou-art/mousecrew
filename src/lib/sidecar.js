// sidecar.js — the delivery engine.
//
// It watches the group (and the direct-message stream), works out which terminal-hosted
// crew member each message is for, and types it into that window when the window is free.
//
// It emits a structured event for everything it does. That is not logging with extra
// steps: the events are the layer the tests assert against. Asserting against a terminal
// screen answers two questions at once — did we do the right thing, and did the terminal
// render it — and a red test cannot tell you which. Exactly one test reads a real screen,
// and it exists to answer the one question the events genuinely cannot: whether the
// characters arrived at all. See docs/TERMINAL.md.

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const core = require('./sidecar-core');

const DEFAULTS = {
  historyPollMs: 15_000,
  busyPollMs: 5_000,
  identityPollMs: 30_000,
  presencePollMs: 10_000,
  postInjectMs: 800,
  stalePendingMs: 10 * 60 * 1000,
  maxPending: 200,
  screenLines: 12,
  busyPattern: 'esc to interrupt',
};

class Sidecar extends EventEmitter {
  /**
   * @param {object} deps
   *   adapter   terminal adapter (see adapters/terminal/contract.js)
   *   identity  buildIdentity() over the SAME roster the server uses
   *   agents    normalized agent configs
   *   client    { history, post, ack, presence } — the transport, injectable for tests
   *   statePath where the pending queue is persisted
   *   now       clock, injectable
   */
  constructor(deps, options = {}) {
    super();
    this.adapter = deps.adapter;
    this.identity = deps.identity;
    this.client = deps.client;
    this.now = deps.now || (() => Date.now());
    this.opt = { ...DEFAULTS, ...options };

    this.agents = (deps.agents || []).filter((a) => a.transport === 'terminal');
    this.terminalIds = this.agents.map((a) => a.id);
    this.byId = new Map(this.agents.map((a) => [a.id, a]));

    this.statePath = deps.statePath || null;
    this.state = { seen: [], pending: [], bootstrapped: false };
    this._timers = [];
    this._draining = new Set();
    this._loadState();
  }

  // ---------- persistence ----------

  _loadState() {
    if (!this.statePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      this.state = { seen: raw.seen || [], pending: raw.pending || [], bootstrapped: !!raw.bootstrapped };
    } catch { /* first run */ }
  }

  _saveState() {
    if (!this.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
      // 0600: the queue holds message bodies, which are as private as the messages were.
      fs.writeFileSync(this.statePath, JSON.stringify({ ...this.state, updatedAt: new Date(this.now()).toISOString() }, null, 2), { mode: 0o600 });
    } catch (e) {
      this.emit('event', { type: 'state-save-failed', error: e.message });
    }
  }

  _seen(key) {
    if (this.state.seen.includes(key)) return true;
    this.state.seen.push(key);
    if (this.state.seen.length > 2000) this.state.seen = this.state.seen.slice(-2000);
    return false;
  }

  // ---------- intake ----------

  /**
   * Take a batch of messages from either channel and queue whatever they address.
   *
   * @param {Array} rows    raw rows (history shape or SSE payload shape)
   * @param {string} source 'sse' | 'history' — recorded on the event, does not change behaviour
   *
   * The first history fetch only establishes a baseline. Without that, a sidecar starting
   * up would inject the entire backlog into every window at once — every message in it is
   * new *to this process*, and none of them are new to the crew.
   */
  ingest(rows, source = 'history') {
    const results = [];
    const bootstrapping = !this.state.bootstrapped;
    for (const row of rows || []) {
      const key = core.messageKey(row);
      if (this._seen(key)) continue;
      if (bootstrapping) continue;         // still recorded as seen, deliberately
      const m = core.normalizeMessage(row);
      if (m.type === 'order_card') continue;
      const targets = core.mentionTargets({ identity: this.identity, terminalIds: this.terminalIds }, m.sender, m.content);
      for (const agent of targets) {
        this.queue({ agent, kind: 'group', sender: this.identity.displayNameOf(m.sender) || m.sender, content: m.content, sourceKey: key });
        results.push({ agent, key });
      }
    }
    if (bootstrapping) {
      this.state.bootstrapped = true;
      this.emit('event', { type: 'bootstrapped', seen: this.state.seen.length, source });
    }
    this._saveState();
    return results;
  }

  /** A direct message addressed at one crew member. Carries a dmId so delivery can be acked. */
  ingestDirect(event) {
    const agent = event && event.target;
    if (!agent || !this.byId.has(agent)) return null;
    const key = core.fingerprint('dm', event.dmId);
    if (this._seen(key)) return null;
    this.queue({
      agent, kind: 'dm', sender: event.sender || 'human', content: event.content,
      sourceKey: key, dmId: event.dmId,
    });
    this._saveState();
    return { agent, dmId: event.dmId };
  }

  queue(item) {
    const entry = { ...item, queuedAt: new Date(this.now()).toISOString() };
    this.state.pending.push(entry);
    const { kept, dropped } = core.capPending(this.state.pending, this.opt.maxPending);
    this.state.pending = kept;
    for (const d of dropped) {
      this.emit('event', { type: 'dropped-overflow', agent: d.agent, kind: d.kind });
      if (d.kind === 'dm' && d.dmId) this._ack(d.dmId, d.agent, 'expired');
    }
    this.emit('event', { type: 'queued', agent: entry.agent, kind: entry.kind, depth: this.state.pending.length });
    return entry;
  }

  // ---------- delivery ----------

  /** Drop everything past its shelf life, reporting each one. */
  pruneStale() {
    const now = this.now();
    const expired = core.selectExpired(this.state.pending, now, this.opt.stalePendingMs);
    if (!expired.length) return [];
    this.state.pending = core.filterFresh(this.state.pending, now, this.opt.stalePendingMs);
    for (const item of expired) {
      this.emit('event', { type: 'expired', agent: item.agent, kind: item.kind, queuedAt: item.queuedAt });
      // A dropped group message still exists in the group history. A dropped direct
      // message looks, from the sender's side, exactly like being ignored — so that one
      // has to be reported back.
      if (item.kind === 'dm' && item.dmId) this._ack(item.dmId, item.agent, 'expired');
    }
    this._saveState();
    return expired;
  }

  async _ack(dmId, agent, status) {
    if (!this.client.ack) return;
    try { await this.client.ack(agent, dmId, status); }
    catch (e) { this.emit('event', { type: 'ack-failed', dmId, status, error: e.message }); }
  }

  /**
   * One delivery pass: for each crew member with something waiting, if their window is
   * free, type the oldest item in.
   */
  async deliver() {
    this.pruneStale();
    if (!this.state.pending.length) return [];

    let windows;
    try {
      windows = await this.adapter.listWindows();
    } catch (e) {
      this.emit('event', { type: 'list-failed', error: e.message });
      return [];
    }

    const delivered = [];
    for (const agent of [...new Set(this.state.pending.map((p) => p.agent))]) {
      if (this._draining.has(agent)) continue;
      const item = this.state.pending.find((p) => p.agent === agent);
      if (!item) continue;

      const cfg = this.byId.get(agent);
      const identityName = (cfg && cfg.terminal && cfg.terminal.target) || (cfg && cfg.displayName) || agent;
      const found = core.resolveWindow(windows, identityName);
      if (!found.ref) {
        // Not an error: a window that has not registered yet is a window that will. The
        // item stays queued and the shelf life decides how long that hope lasts.
        this.emit('event', { type: 'no-window', agent, reason: found.reason, candidates: found.candidates });
        continue;
      }

      const pattern = (cfg && cfg.terminal && cfg.terminal.busyPattern) || this.opt.busyPattern;
      let screen = '';
      try { screen = await this.adapter.readScreen(found.ref, this.opt.screenLines); }
      catch (e) { this.emit('event', { type: 'read-failed', agent, ref: found.ref, error: e.message }); continue; }

      if (core.isBusy(screen, pattern)) {
        this.emit('event', { type: 'busy-wait', agent, ref: found.ref });
        continue;
      }

      this._draining.add(agent);
      try {
        const text = core.envelope({ kind: item.kind, agent, sender: item.sender, content: item.content, cli: this.opt.cli });
        await this.adapter.sendText(found.ref, text);
        await new Promise((r) => setTimeout(r, this.opt.postInjectMs));
        await this.adapter.sendKey(found.ref, 'enter');

        this.state.pending = this.state.pending.filter((p) => p !== item);
        this._saveState();
        this.emit('event', { type: 'injected', agent, ref: found.ref, kind: item.kind, chars: text.length });
        if (item.kind === 'dm' && item.dmId) await this._ack(item.dmId, agent, 'delivered');
        delivered.push({ agent, ref: found.ref, kind: item.kind });
      } catch (e) {
        // Injection failed: keep the item queued. Dropping it here would lose a message
        // for a reason the sender can never discover.
        this.emit('event', { type: 'inject-failed', agent, ref: found.ref, error: e.message });
      } finally {
        this._draining.delete(agent);
      }
    }
    return delivered;
  }

  // ---------- presence ----------

  /**
   * Report each crew member's state. Order matters and is fixed:
   *   no window            -> stopped      ("we cannot see it", not "it is free")
   *   screen says busy     -> busy
   *   otherwise            -> idle
   *
   * Same screen reading the delivery back-pressure uses, so the status line and the
   * delivery decision can never contradict each other — no "holding messages back from an
   * agent the dashboard says is idle".
   */
  async reportPresence() {
    let windows = [];
    try { windows = await this.adapter.listWindows(); }
    catch (e) { this.emit('event', { type: 'list-failed', error: e.message }); }

    const report = {};
    for (const cfg of this.agents) {
      const identityName = (cfg.terminal && cfg.terminal.target) || cfg.displayName || cfg.id;
      const found = core.resolveWindow(windows, identityName);
      if (!found.ref) { report[cfg.id] = { state: 'stopped', detail: found.reason }; continue; }
      let screen = '';
      try { screen = await this.adapter.readScreen(found.ref, this.opt.screenLines); }
      catch { report[cfg.id] = { state: 'stopped', detail: 'unreadable' }; continue; }
      const pattern = (cfg.terminal && cfg.terminal.busyPattern) || this.opt.busyPattern;
      report[cfg.id] = { state: core.isBusy(screen, pattern) ? 'busy' : 'idle', detail: null };
    }

    if (this.client.presence) {
      try { await this.client.presence(report); }
      catch (e) { this.emit('event', { type: 'presence-failed', error: e.message }); }
    }
    this.emit('event', { type: 'presence', report });
    return report;
  }

  // ---------- lifecycle ----------

  async pollHistory() {
    try {
      const rows = await this.client.history(200);
      return this.ingest(rows, 'history');
    } catch (e) {
      this.emit('event', { type: 'history-failed', error: e.message });
      return [];
    }
  }

  start() {
    const every = (ms, fn) => {
      const t = setInterval(() => { Promise.resolve(fn()).catch((e) => this.emit('event', { type: 'tick-failed', error: e.message })); }, ms);
      if (t.unref) t.unref();
      this._timers.push(t);
    };
    every(this.opt.historyPollMs, () => this.pollHistory());
    every(this.opt.busyPollMs, () => this.deliver());
    every(this.opt.presencePollMs, () => this.reportPresence());
    this.emit('event', { type: 'started', agents: this.terminalIds });
  }

  stop() {
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    this.emit('event', { type: 'stopped' });
  }
}

module.exports = { Sidecar, DEFAULTS };
