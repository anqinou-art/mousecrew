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
const inputDraft = require('./input-draft');

const DEFAULTS = {
  historyPollMs: 15_000,
  busyPollMs: 5_000,
  identityPollMs: 30_000,
  presencePollMs: 10_000,
  postInjectMs: 800,
  stalePendingMs: 10 * 60 * 1000,
  maxPending: 200,
  batchGroup: core.DEFAULT_BATCH_GROUP,
  inlineLimit: core.DEFAULT_INLINE_LIMIT,
  forceOnExpiry: core.DEFAULT_FORCE_ON_EXPIRY,
  forcedGraceMs: core.DEFAULT_FORCED_GRACE_MS,
  draftQuietMs: inputDraft.DEFAULT_DRAFT_QUIET_MS,
  forcedDraftHoldMs: inputDraft.DEFAULT_FORCED_DRAFT_HOLD_MS,
  wakeDir: null,
  wakeMaxContent: core.DEFAULT_WAKE_MAX_CONTENT,
  wakeSettleMs: core.DEFAULT_WAKE_SETTLE_MS,
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
    this.state = { seen: [], pending: [], acks: [], bootstrapped: false };
    this._timers = [];
    this._draining = new Set();
    this._draftWatch = inputDraft.createDraftWatch({ quietMs: this.opt.draftQuietMs });
    this._loadState();
  }

  // ---------- persistence ----------

  _loadState() {
    if (!this.statePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      this.state = { seen: raw.seen || [], pending: raw.pending || [], acks: raw.acks || [], bootstrapped: !!raw.bootstrapped };
    } catch { /* first run */ }
  }

  _saveState() {
    if (!this.statePath) return false;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
      // 0600: the queue holds message bodies, which are as private as the messages were.
      fs.writeFileSync(this.statePath, JSON.stringify({ ...this.state, updatedAt: new Date(this.now()).toISOString() }, null, 2), { mode: 0o600 });
      return true;
    } catch (e) {
      this.emit('event', { type: 'state-save-failed', error: e.message });
      return false;
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

  _appendQueue(item) {
    const entry = { ...item, queuedAt: new Date(this.now()).toISOString() };
    this.state.pending.push(entry);
    const { kept, dropped } = core.capPending(this.state.pending, this.opt.maxPending);
    this.state.pending = kept;
    return { entry, dropped };
  }

  _emitOverflow(item) {
    this.emit('event', {
      type: 'dropped-overflow', agent: item.agent, kind: item.kind, count: this._itemCount(item),
    });
  }

  _emitQueued(entry) {
    this.emit('event', { type: 'queued', agent: entry.agent, kind: entry.kind, depth: this.state.pending.length });
  }

  queue(item) {
    const staged = this._appendQueue(item);
    for (const dropped of staged.dropped) {
      this._emitOverflow(dropped);
      this._queueAcksFor(dropped, 'expired');
    }
    this._emitQueued(staged.entry);
    return staged.entry;
  }

  _queueWake(request) {
    if (this.state.seen.includes(request.key)) return null;
    const snapshot = {
      seen: this.state.seen.slice(),
      pending: this.state.pending.slice(),
      acks: this.state.acks.slice(),
    };
    this._seen(request.key);
    const staged = this._appendQueue({
      agent: request.agent,
      kind: 'wake',
      sender: request.sender,
      content: request.content,
      sourceKey: request.key,
    });
    for (const dropped of staged.dropped) this._appendAcksFor(dropped, 'expired');
    if (!this._saveState()) {
      this.state.seen = snapshot.seen;
      this.state.pending = snapshot.pending;
      this.state.acks = snapshot.acks;
      throw new Error('wake queue state was not persisted');
    }
    for (const dropped of staged.dropped) this._emitOverflow(dropped);
    this._emitQueued(staged.entry);
    return staged.entry;
  }

  ingestWakeDir({ now = this.now() } = {}) {
    const result = { queued: 0, rejected: 0, deferred: 0, failed: 0, merged: 0 };
    const dir = this.opt.wakeDir;
    if (!dir) return result;
    const failed = (file, action, error) => {
      result.failed += 1;
      this.emit('event', {
        type: 'wake-file-failed', file, action,
        error: error instanceof Error ? error.message : String(error),
      });
    };
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    } catch (error) {
      failed(dir, 'open-directory', error);
      return result;
    }

    let names;
    try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort(); }
    catch (error) {
      failed(dir, 'read-directory', error);
      return result;
    }

    const remove = (file, name) => {
      try { fs.unlinkSync(file); return true; }
      catch (error) { failed(name, 'delete-source', error); return false; }
    };
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        let raw;
        let mtimeMs;
        try {
          raw = fs.readFileSync(file, 'utf8');
          mtimeMs = fs.statSync(file).mtimeMs;
        } catch (error) {
          failed(name, 'read-source', error);
          continue;
        }
        const request = core.parseWakeRequest(raw, {
          identity: this.identity,
          terminalIds: this.terminalIds,
          maxContent: this.opt.wakeMaxContent,
        });
        if (request.error) {
          if (request.notJson && now - mtimeMs < this.opt.wakeSettleMs) {
            result.deferred += 1;
            continue;
          }
          result.rejected += 1;
          this.emit('event', { type: 'wake-rejected', file: name, reason: request.error });
          remove(file, name);
          continue;
        }
        if (core.hasPendingWake(
          request.agent, request.sender, this.state.pending, now,
          this.opt.stalePendingMs, this.opt.forcedGraceMs,
        )) {
          if (!remove(file, name)) continue;
          result.merged += 1;
          this.emit('event', {
            type: 'wake-merged', file: name, agent: request.agent,
            sender: request.sender, key: request.key,
          });
          continue;
        }
        let entry;
        try { entry = this._queueWake(request); }
        catch (error) {
          failed(name, 'persist-queue', error);
          continue;
        }
        if (!remove(file, name)) continue;
        if (entry) {
          result.queued += 1;
          this.emit('event', {
            type: 'wake-queued', file: name, agent: request.agent,
            sender: request.sender, key: request.key,
          });
        } else {
          this.emit('event', { type: 'wake-duplicate', file: name, key: request.key });
        }
      } catch (error) {
        failed(name, 'process-source', error);
      }
    }
    return result;
  }

  // ---------- delivery ----------

  _itemCount(item) {
    return item && Array.isArray(item.mergedFrom) ? item.mergedFrom.length : 1;
  }

  _queueAcksFor(item, status) {
    const appended = this._appendAcksFor(item, status);
    if (appended) this._saveState();
  }

  _appendAcksFor(item, status) {
    if (!item || item.kind !== 'dm') return;
    let appended = 0;
    for (const source of item.mergedFrom || [item]) {
      if (source.dmId && this._appendAck(source.dmId, item.agent, status)) appended += 1;
    }
    return appended;
  }

  _markDraftHeld(agent, held) {
    let changed = false;
    const heldAt = new Date(this.now()).toISOString();
    for (const item of this.state.pending) {
      if (!item || item.agent !== agent) continue;
      if (held && !item.draftHeldAt) { item.draftHeldAt = heldAt; changed = true; }
      if (!held && item.draftHeldAt) { delete item.draftHeldAt; changed = true; }
    }
    if (changed) this._saveState();
    return changed;
  }

  _draftVerdict(cfg, ref, screen) {
    const type = cfg && cfg.terminal && cfg.terminal.inputBox;
    if (!type) return { hold: false, reason: 'disabled', chars: 0 };
    const box = inputDraft.readInputBox(type, screen);
    return {
      ...this._draftWatch.observe(ref, box, this.now()),
      chars: box.text.length,
    };
  }

  /** Resolve expired items for one agent after the window and busy state are known. */
  pruneStale({ agent = null, canForce = false, busy = false } = {}) {
    const now = this.now();
    const belongs = (item) => agent === null || item.agent === agent;
    const candidates = this.state.pending.filter(belongs);
    const expiring = core.selectExpired(
      candidates, now, this.opt.stalePendingMs, this.opt.forcedGraceMs,
    );
    let forced = [];
    if (canForce && this.opt.forceOnExpiry && expiring.length) {
      const marked = core.markForcedDeliveries(expiring, now, busy);
      forced = marked.forced;
      if (marked.absorbed.length) {
        const absorbed = new Set(marked.absorbed);
        this.state.pending = this.state.pending.filter((item) => !absorbed.has(item));
      }
      for (const item of forced) {
        this.emit('event', {
          type: 'forced', agent: item.agent, kind: item.kind, count: this._itemCount(item),
        });
      }
    }

    const current = this.state.pending.filter(belongs);
    const expired = core.selectExpired(
      current, now, this.opt.stalePendingMs, this.opt.forcedGraceMs,
    );
    if (!forced.length && !expired.length) return [];
    if (expired.length) {
      const expiredSet = new Set(expired);
      this.state.pending = this.state.pending.filter((item) => !expiredSet.has(item));
    }
    for (const item of expired) {
      this.emit('event', {
        type: 'expired', agent: item.agent, kind: item.kind,
        queuedAt: item.queuedAt, count: this._itemCount(item),
      });
      // A dropped group message still exists in the group history. A dropped direct
      // message looks, from the sender's side, exactly like being ignored — so that one
      // has to be reported back.
      this._queueAcksFor(item, 'expired');
    }
    this._saveState();
    return expired;
  }

  /**
   * Record a receipt, then try to send it. Written down first, deliberately.
   *
   * The whole reason an undelivered direct message is reported at all is that silence on
   * the sender's side is indistinguishable from being ignored. A receipt that is attempted
   * once and dropped on failure lands the system back in exactly that state — with the
   * added insult that the queue entry is already gone, so nothing will ever retry.
   *
   * Fire-and-forget was also untestable in the way that matters: a mutation could delete
   * the send and go red, but making the send *fail* changed nothing observable. A failure
   * path with no consequence cannot be asserted, and an assertion you cannot break is
   * decoration.
   */
  _queueAck(dmId, agent, status) {
    if (this._appendAck(dmId, agent, status)) this._saveState();
  }

  _appendAck(dmId, agent, status) {
    if (!this.client.ack) return;
    this.state.acks.push({ dmId, agent, status, queuedAt: new Date(this.now()).toISOString() });
    if (this.state.acks.length > 500) {
      const dropped = this.state.acks.shift();
      this.emit('event', { type: 'ack-overflow', dmId: dropped.dmId });
    }
    return true;
  }

  /** Send whatever receipts are owed. Anything that fails stays owed. */
  async flushAcks() {
    if (!this.state.acks.length || !this.client.ack) return;
    const owed = this.state.acks;
    const remaining = [];
    for (const a of owed) {
      try {
        await this.client.ack(a.agent, a.dmId, a.status);
        this.emit('event', { type: 'ack-sent', agent: a.agent, dmId: a.dmId, status: a.status });
      } catch (e) {
        remaining.push(a);
        this.emit('event', { type: 'ack-failed', agent: a.agent, dmId: a.dmId, status: a.status, error: e.message });
      }
    }
    this.state.acks = remaining;
    this._saveState();
  }

  _persistBody(agent, text) {
    if (!this.statePath) {
      this.emit('event', { type: 'body-save-failed', agent, error: 'no state path configured' });
      return null;
    }
    try {
      const agentId = String(agent || 'unknown');
      const partition = /^[A-Za-z0-9_-]+$/.test(agentId)
        ? agentId
        : `id-${Buffer.from(agentId).toString('base64url')}`;
      const dir = path.join(path.dirname(this.statePath), 'inbox', partition);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, `${stamp}-${core.fingerprint(text).slice(0, 8)}.txt`);
      fs.writeFileSync(file, text, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      return file;
    } catch (e) {
      this.emit('event', { type: 'body-save-failed', agent, error: e.message });
      return null;
    }
  }

  /**
   * One delivery pass: for each crew member with something waiting, if their window is
   * free, type the oldest item in.
   */
  async deliver() {
    if (this.opt.wakeDir) {
      try { this.ingestWakeDir(); }
      catch (error) {
        this.emit('event', { type: 'wake-file-failed', file: this.opt.wakeDir, action: 'scan', error: error.message });
      }
    }
    // Receipts owed from earlier passes go out first: a delivery attempt is the only thing
    // that runs on a timer here, so it is also the retry loop.
    await this.flushAcks();
    if (!this.state.pending.length) return [];

    let windows;
    try {
      windows = await this.adapter.listWindows();
    } catch (e) {
      this.emit('event', { type: 'list-failed', error: e.message });
      this.pruneStale();
      await this.flushAcks();
      return [];
    }

    const delivered = [];
    for (const agent of [...new Set(this.state.pending.map((p) => p.agent))]) {
      if (this._draining.has(agent)) continue;

      const cfg = this.byId.get(agent);
      const identityName = (cfg && cfg.terminal && cfg.terminal.target) || (cfg && cfg.displayName) || agent;
      const found = core.resolveWindow(windows, identityName);
      if (!found.ref) {
        this.pruneStale({ agent });
        // Not an error: a window that has not registered yet is a window that will. The
        // item stays queued and the shelf life decides how long that hope lasts.
        if (this.state.pending.some((item) => item.agent === agent)) {
          this.emit('event', { type: 'no-window', agent, reason: found.reason, candidates: found.candidates });
        }
        continue;
      }

      const pattern = (cfg && cfg.terminal && cfg.terminal.busyPattern) || this.opt.busyPattern;
      let screen = '';
      try { screen = await this.adapter.readScreen(found.ref, this.opt.screenLines); }
      catch (e) {
        this.emit('event', { type: 'read-failed', agent, ref: found.ref, error: e.message });
        this.pruneStale({ agent });
        continue;
      }

      const busy = core.isBusy(screen, pattern);
      let draft = null;
      const inspectDraft = () => {
        if (!draft) draft = this._draftVerdict(cfg, found.ref, screen);
        return draft;
      };
      // A normal busy item stops at the activity gate. Only paths that can otherwise
      // inject need an input-box decision, and both decisions reuse this screen read.
      if (!busy) {
        const verdict = inspectDraft();
        if (verdict.hold) this._markDraftHeld(agent, true);
      }
      this.pruneStale({ agent, canForce: true, busy });
      // Keep prior hold evidence until expiry has awarded any forced delivery it earned.
      // Once that decision is made, a released gate clears the marker on survivors.
      if (!busy && draft && !draft.hold) this._markDraftHeld(agent, false);
      const batch = core.nextDeliverableBatch(this.state.pending, agent, this.opt.batchGroup);
      const item = batch[0];
      if (!item) continue;
      const plan = core.planDelivery(item, busy);
      if (plan === 'wait_forced_expiry') continue;
      if (plan === 'wait_busy') {
        this.emit('event', { type: 'busy-wait', agent, ref: found.ref });
        continue;
      }

      const forced = plan === 'inject_forced';
      const verdict = inspectDraft();
      this._markDraftHeld(agent, verdict.hold);
      const forcedAt = Date.parse(item.forcedAt);
      const forcedMayWait = forced && Number.isFinite(forcedAt)
        && this.now() - forcedAt < this.opt.forcedDraftHoldMs;
      if (verdict.hold && (!forced || forcedMayWait)) {
        this.emit('event', {
          type: 'draft-hold', agent, ref: found.ref, reason: verdict.reason,
          chars: verdict.chars, forced,
        });
        continue;
      }

      this._draining.add(agent);
      try {
        if (forced) {
          const triedAt = new Date(this.now()).toISOString();
          for (const entry of batch) entry.forcedTriedAt = triedAt;
          if (!this._saveState()) {
            this.emit('event', { type: 'forced-save-failed', agent, ref: found.ref });
            continue;
          }
        }
        const body = core.batchBody(batch);
        const fullText = core.batchEnvelope({ items: batch, agent, cli: this.opt.cli });
        const bodyFile = body.length > this.opt.inlineLimit
          ? this._persistBody(agent, fullText)
          : null;
        const text = bodyFile
          ? core.batchEnvelope({
            items: batch, agent, cli: this.opt.cli,
            bodyFile, inlineLimit: this.opt.inlineLimit,
          })
          : fullText;
        await this.adapter.sendText(found.ref, text);
        await new Promise((r) => setTimeout(r, this.opt.postInjectMs));
        await this.adapter.sendKey(found.ref, 'enter');

        const deliveredBatch = new Set(batch);
        this.state.pending = this.state.pending.filter((p) => !deliveredBatch.has(p));
        this._saveState();
        const count = batch.reduce((sum, entry) => sum + this._itemCount(entry), 0);
        this.emit('event', {
          type: forced ? 'forced-injected' : 'injected', agent, ref: found.ref, kind: item.kind,
          chars: text.length, count, forced,
        });
        for (const entry of batch) this._queueAcksFor(entry, 'delivered');
        delivered.push({ agent, ref: found.ref, kind: item.kind, count, forced });
      } catch (e) {
        // Injection failed: keep the item queued. Dropping it here would lose a message
        // for a reason the sender can never discover.
        this.emit('event', {
          type: 'inject-failed', agent, ref: found.ref,
          forced: plan === 'inject_forced', error: e.message,
        });
      } finally {
        this._draining.delete(agent);
      }
    }
    await this.flushAcks();
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
