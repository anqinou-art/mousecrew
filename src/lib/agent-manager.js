// agent-manager.js — the registry. Knows every crew member; runs the local ones.
//
// Three transports, one interface:
//   local    — a CLI process on this machine, managed by AgentRuntime
//   remote   — a CLI on another machine, reached over the WebSocket bridge
//   terminal — an interactive window, reached by the terminal adapter (batch 2)
//
// Callers ask "send this to `backend`" and never learn which of the three it was. That
// separation is the reason a crew member can move house without anything upstream
// changing.

const { EventEmitter } = require('events');
const { AgentRuntime } = require('./agent-runtime');

class AgentManager extends EventEmitter {
  constructor(agents, deps = {}) {
    super();
    this.registry = new Map(agents.map((a) => [a.id, a]));
    this.instances = new Map();   // id -> AgentRuntime (local only)
    this.remotes = new Map();     // id -> { online, sendFn, registeredAt }
    this.deps = deps;
  }

  get(id) { return this.registry.get(id) || null; }
  list() { return [...this.registry.values()]; }

  /** Start nothing; just hand back (creating if needed) the runtime for a local agent. */
  runtime(id) {
    const cfg = this.registry.get(id);
    if (!cfg || cfg.transport !== 'local') return null;
    if (!this.instances.has(id)) {
      const rt = new AgentRuntime(cfg, this.deps);
      for (const ev of ['delta', 'done', 'state', 'queue:update', 'log', 'session:new', 'session:reset']) {
        rt.on(ev, (payload) => this.emit(ev, payload));
      }
      this.instances.set(id, rt);
    }
    return this.instances.get(id);
  }

  registerRemote(id, meta = {}) {
    if (!this.registry.has(id)) {
      console.warn(`[manager] remote "${id}" is not in the roster — refusing registration`);
      return false;
    }
    this.remotes.set(id, { online: true, registeredAt: new Date().toISOString(), ...meta });
    this.emit('remote:online', { agent: id });
    return true;
  }

  unregisterRemote(id) {
    const r = this.remotes.get(id);
    if (r) { r.online = false; r.sendFn = null; }
    this.emit('remote:offline', { agent: id });
  }

  /** Wait (briefly) for a remote to come back rather than failing the moment it blips. */
  waitForRemote(id, timeoutMs) {
    return new Promise((resolve) => {
      const r = this.remotes.get(id);
      if (r && r.online) return resolve(true);
      const timer = setTimeout(() => { this.off('remote:online', onUp); resolve(false); }, timeoutMs);
      if (timer.unref) timer.unref();
      const onUp = ({ agent }) => {
        if (agent !== id) return;
        clearTimeout(timer);
        this.off('remote:online', onUp);
        resolve(true);
      };
      this.on('remote:online', onUp);
    });
  }

  status() {
    const out = {};
    for (const [id, cfg] of this.registry) {
      if (cfg.transport === 'local') {
        const rt = this.instances.get(id);
        out[id] = rt ? rt.status() : {
          id, transport: 'local', runner: cfg.runner, state: 'unspawned',
          queueLength: 0, processAlive: false, sessionId: null,
          context: { tokens: 0, limit: cfg.contextLimit }, sessionMessages: 0,
        };
      } else if (cfg.transport === 'remote') {
        const r = this.remotes.get(id);
        out[id] = {
          id, transport: 'remote',
          state: r && r.online ? 'idle' : 'offline',
          online: !!(r && r.online),
          registeredAt: r ? r.registeredAt : null,
        };
      } else {
        // Terminal agents report themselves through the presence endpoint; the manager
        // has no process to inspect. Saying "unknown" is honest — claiming idle is not.
        out[id] = { id, transport: 'terminal', state: 'unknown', online: false };
      }
    }
    return out;
  }

  destroyAll() {
    for (const rt of this.instances.values()) rt.destroy();
    this.instances.clear();
  }
}

module.exports = { AgentManager };
