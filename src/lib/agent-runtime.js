// agent-runtime.js — the lifecycle of one crew member.
//
//   stopped ──first message──▶ starting ──▶ idle ──▶ busy ──▶ idle ──idle timeout──▶ stopped
//                                            ▲        │
//                          queued messages ──┘        └── crash ──▶ error ──backoff──▶ starting
//
// The five things that make this survivable, each of which exists because its absence
// produced a specific bad day:
//
// 1. Lazy start. A registered agent is not a running process. Twenty configured agents
//    cost nothing until someone talks to them.
// 2. Queue, don't interrupt. A message arriving mid-turn waits its turn.
// 3. Exit is not amnesia. The session id is persisted, so the next wake resumes the same
//    conversation. Rotating to a fresh window is the same mechanism with resume skipped.
// 4. Two turn timers. The idle timer resets on every sign of life and catches true
//    silence. The hard timer never resets and catches the half-dead process that dribbles
//    output forever — without it, an agent that neither produces nor dies stays 'busy'
//    while every new @mention drags it back from idle. (Observed: wedged 38 minutes.)
// 5. Two crashes in a row means the session itself is suspect: drop it and start clean.
//    Losing the thread once beats crash-looping against a poisoned session.

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

class AgentRuntime extends EventEmitter {
  /**
   * @param {object} cfg normalized agent config (see src/config.js)
   * @param {object} deps { dataDir, spawn }  — spawn is injectable so the lifecycle is
   *   testable without launching real CLIs. The production path uses the same call, so a
   *   test that stubs it is testing the real code path, not a parallel one.
   */
  constructor(cfg, deps = {}) {
    super();
    this.cfg = cfg;
    this.name = cfg.id;
    this._spawn = deps.spawn || spawn;
    this.dataDir = deps.dataDir || path.join(process.cwd(), 'data');
    this.sessionFile = path.join(this.dataDir, `session_${this.name}.json`);

    this.proc = null;
    this.state = 'stopped';
    this.queue = [];
    this.currentJob = null;
    this.sessionId = null;

    this._stdoutBuf = '';
    this._idleTimer = null;
    this._turnTimer = null;
    this._turnHardTimer = null;
    this._restartTimer = null;
    this._restartCount = 0;
    this._stopping = false;

    this.contextLimit = cfg.contextLimit || 200_000;
    this.contextTokens = 0;
    this.sessionMessages = 0;

    this.stats = { messages: 0, errors: 0, lastActiveAt: null };
    this._loadSession();
  }

  // ---------- session persistence ----------

  _loadSession() {
    try {
      const s = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
      this.sessionId = s.sessionId || null;
      this.contextTokens = s.contextTokens || 0;
      this.sessionMessages = s.sessionMessages || 0;
    } catch { /* first run */ }
  }

  _saveSession() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.sessionFile, JSON.stringify({
        sessionId: this.sessionId,
        contextTokens: this.contextTokens,
        sessionMessages: this.sessionMessages,
        updatedAt: new Date().toISOString(),
      }, null, 2));
    } catch (e) {
      console.error(`[${this.name}] session save failed:`, e.message);
    }
  }

  /** Drop the conversation and start a new one on next wake. This is "rotate window". */
  newSession() {
    const old = this.sessionId;
    this.sessionId = null;
    this.contextTokens = 0;
    this.sessionMessages = 0;
    this._saveSession();
    this.emit('session:new', { previous: old });
    if (this.proc) this._killAndRestart('rotate to a fresh session');
    return { previous: old };
  }

  // ---------- process lifecycle ----------

  buildSpawnArgs() {
    const c = this.cfg;
    if (c.runner === 'exec') {
      return { command: c.exec.command, args: [...(c.exec.args || [])] };
    }
    // Default runner: a CLI speaking newline-delimited JSON in both directions.
    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];
    if (c.model) args.push('--model', c.model);
    if (c.effort) args.push('--effort', c.effort);
    if (c.systemPromptFile) args.push('--append-system-prompt-file', c.systemPromptFile);
    if (this.sessionId) args.push('--resume', this.sessionId);
    return { command: c.cliCommand || 'claude', args };
  }

  start() {
    if (this.proc || this.cfg.runner === 'exec') return;
    this._stopping = false;
    const { command, args } = this.buildSpawnArgs();
    console.log(`[${this.name}] starting ${command}${this.sessionId ? ` (resume ${this.sessionId.slice(0, 8)})` : ' (new session)'}`);

    this.proc = this._spawn(command, args, {
      cwd: this.cfg.workDir,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._stdoutBuf = '';
    this.proc.stdout.on('data', (raw) => this._onStdout(raw));
    this.proc.stderr.on('data', (raw) => {
      const m = raw.toString().trim();
      if (m) this.emit('log', { message: m.slice(0, 500) });
    });
    this.proc.on('error', (e) => {
      console.error(`[${this.name}] process error:`, e.message);
      this._onExit(-1);
    });
    this.proc.on('close', (code) => this._onExit(code));

    this._setState('idle');
    this._drain();
  }

  stop() {
    this._stopping = true;
    for (const t of ['_restartTimer', '_idleTimer', '_turnTimer', '_turnHardTimer']) {
      if (this[t]) { clearTimeout(this[t]); this[t] = null; }
    }
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.stdin.end(); } catch { /* already gone */ }
      // Both fallbacks are unref'd: in a server they change nothing, but in a test or a
      // short-lived CLI they would be the only live handles and the process would hang
      // for their full duration. Cleanup code can be the thing that leaks.
      const hard = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
      if (hard.unref) hard.unref();
      const term = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 200);
      if (term.unref) term.unref();
    }
    this._setState('stopped');
  }

  _onExit(code) {
    this.proc = null;
    for (const t of ['_turnTimer', '_turnHardTimer']) {
      if (this[t]) { clearTimeout(this[t]); this[t] = null; }
    }

    if (this.currentJob) {
      const partial = this.currentJob._chunks.join('');
      if (partial) {
        this.currentJob.resolve({ text: partial, partial: true, sessionId: this.sessionId });
      } else {
        this.currentJob.reject(new Error(`process exited (code ${code}) mid-turn`));
      }
      this.currentJob = null;
    }

    if (this._stopping || this.state === 'stopped') return;

    if (this._restartCount >= 2 && this.sessionId) {
      console.warn(`[${this.name}] repeated crashes — dropping session and starting clean`);
      this.sessionId = null;
      this.contextTokens = 0;
      this.sessionMessages = 0;
      this._saveSession();
      this.emit('session:reset', { reason: 'repeated-crash' });
    }
    this.stats.errors++;
    this._setState('error');
    this._scheduleRestart();
  }

  _scheduleRestart() {
    if (this._restartTimer) return;
    this._restartCount++;
    const delay = Math.min(2000 * 2 ** (this._restartCount - 1), 30_000);
    console.log(`[${this.name}] restarting in ${delay}ms (attempt ${this._restartCount})`);
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this.start();
    }, delay);
    if (this._restartTimer.unref) this._restartTimer.unref();
  }

  /** Kill a wedged process and recover the queue (unlike stop(), which stands down). */
  _killAndRestart(reason) {
    console.warn(`[${this.name}] ${reason} — killing process`);
    const proc = this.proc;
    if (this.currentJob) {
      this.currentJob.reject(new Error(reason));
      this.currentJob = null;
    }
    this.proc = null;
    if (proc) { try { proc.kill('SIGTERM'); } catch {} }
    this._setState('error');       // not 'stopped', so _onExit reschedules and drains
    this._scheduleRestart();
  }

  _setState(state) {
    this.state = state;
    this.emit('state', { agent: this.name, state });
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    if (state === 'idle' && this.proc && this.cfg.idleTimeoutMs > 0) {
      this._idleTimer = setTimeout(() => {
        console.log(`[${this.name}] idle for ${Math.round(this.cfg.idleTimeoutMs / 60000)}min — standing down`);
        this.stop();
      }, this.cfg.idleTimeoutMs);
      if (this._idleTimer.unref) this._idleTimer.unref();
    }
  }

  /** Reset the idle timer without sending anything. Cheap way to keep a process warm. */
  keepAlive() {
    if (this.state === 'idle') this._setState('idle');
  }

  // ---------- stream handling ----------

  _onStdout(raw) {
    this._stdoutBuf += raw.toString();
    let idx;
    while ((idx = this._stdoutBuf.indexOf('\n')) >= 0) {
      const line = this._stdoutBuf.slice(0, idx).trim();
      this._stdoutBuf = this._stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      this._handleEvent(ev);
    }
  }

  _resetTurnIdleTimer() {
    if (!this._turnTimer || !this.currentJob) return;
    clearTimeout(this._turnTimer);
    const job = this.currentJob;
    this._turnTimer = setTimeout(() => {
      if (this.currentJob === job) this._killAndRestart(`no output for ${Math.round(this.cfg.turnIdleMs / 60000)}min`);
    }, this.cfg.turnIdleMs);
    if (this._turnTimer.unref) this._turnTimer.unref();
    // The hard timer is deliberately untouched here: it counts from job start, always.
  }

  _handleEvent(ev) {
    if (ev.session_id && ev.session_id !== this.sessionId) {
      this.sessionId = ev.session_id;
      this._saveSession();
    }
    if (ev.type === 'assistant' || ev.type === 'user') this._resetTurnIdleTimer();

    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          this._restartCount = 0;
          if (!this.currentJob) this._setState('idle');
          this._drain();
        }
        break;

      case 'assistant': {
        // Context is measured from the usage each model call reports, NOT from the
        // end-of-turn roll-up. The roll-up sums every tool round in the turn, so it
        // tracks how many tools ran rather than how full the window is — using it gives
        // you a level that climbs with tool use and never matches reality.
        const u = ev.message && ev.message.usage;
        if (u) {
          const used = (u.cache_read_input_tokens || 0)
                     + (u.cache_creation_input_tokens || 0)
                     + (u.input_tokens || 0);
          if (used > 0) this.contextTokens = used;
        }
        const blocks = (ev.message && ev.message.content) || [];
        for (const b of blocks) {
          if (b.type === 'text' && b.text && this.currentJob) {
            this.currentJob._chunks.push(b.text);
            this.emit('delta', { agent: this.name, text: b.text });
          }
        }
        break;
      }

      case 'result': {
        const text = ev.result || (this.currentJob ? this.currentJob._chunks.join('') : '');
        if (!this.currentJob) {
          // A result with nobody waiting: the turn it belonged to already ended (timeout,
          // restart). Returning to idle is right; inventing a recipient is not.
          console.warn(`[${this.name}] unsolicited result, ${String(text).length} chars discarded`);
          this._setState('idle');
          this._drain();
          break;
        }
        this.sessionMessages++;
        this.stats.messages++;
        this.stats.lastActiveAt = new Date().toISOString();
        this._saveSession();
        for (const t of ['_turnTimer', '_turnHardTimer']) {
          if (this[t]) { clearTimeout(this[t]); this[t] = null; }
        }
        const result = {
          text,
          sessionId: this.sessionId,
          cost: ev.total_cost_usd || 0,
          durationMs: Date.now() - this.currentJob._startedAt,
        };
        this.emit('done', { agent: this.name, ...result });
        this.currentJob.resolve(result);
        this.currentJob = null;
        this._setState('idle');
        this._drain();
        break;
      }
    }
  }

  _writeMessage(text) {
    if (!this.proc || !this.proc.stdin.writable) throw new Error('process not running');
    this.proc.stdin.write(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
    }) + '\n');
  }

  // ---------- queue ----------

  /**
   * Queue a message. Resolves with { text, ... } or { text:'', skipped:'stale' }.
   * @param {object} opts { source, freshness } — freshness is checked at dequeue.
   */
  send(message, opts = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ message, opts, resolve, reject, _chunks: [] });
      this.emit('queue:update', { agent: this.name, length: this.queue.length });
      if (this.cfg.runner === 'exec') return this._drainExec();
      if (!this.proc && this.state !== 'starting') this.start();
      else if (this.state === 'idle') this._drain();
    });
  }

  _takeFreshJob() {
    // A loop, not recursion: N stale items would otherwise be N stack frames, and JS
    // makes no promise about tail calls.
    while (this.queue.length) {
      const job = this.queue.shift();
      let verdict = null;
      if (typeof job.opts.freshness === 'function') {
        try { verdict = job.opts.freshness(); }
        catch (e) {
          console.error(`[${this.name}] freshness check threw, delivering anyway: ${e.message}`);
          verdict = null;
        }
      }
      if (verdict && verdict.skip) {
        console.log(`[${this.name}] dropping stale message: ${verdict.reason || 'stale'}`);
        job.resolve({ text: '', skipped: 'stale', reason: verdict.reason || 'stale' });
        continue;
      }
      return job;
    }
    return null;
  }

  _drain() {
    if (this.currentJob || !this.queue.length) return;
    if (!this.proc || this.state === 'starting') return;

    const job = this._takeFreshJob();
    if (!job) { this.emit('queue:update', { agent: this.name, length: 0 }); return; }

    job._startedAt = Date.now();
    this.currentJob = job;
    this._setState('busy');
    this.emit('queue:update', { agent: this.name, length: this.queue.length });

    this._turnTimer = setTimeout(() => {
      if (this.currentJob === job) this._killAndRestart(`no output for ${Math.round(this.cfg.turnIdleMs / 60000)}min`);
    }, this.cfg.turnIdleMs);
    if (this._turnTimer.unref) this._turnTimer.unref();

    this._turnHardTimer = setTimeout(() => {
      if (this.currentJob === job) this._killAndRestart(`turn exceeded ${Math.round(this.cfg.turnHardMs / 60000)}min wall clock`);
    }, this.cfg.turnHardMs);
    if (this._turnHardTimer.unref) this._turnHardTimer.unref();

    try {
      this._writeMessage(job.message);
    } catch (e) {
      this.currentJob = null;
      job.reject(e);
      this._setState('error');
      this._scheduleRestart();
    }
  }

  /**
   * The generic runner: one process per message. No session continuity — whatever the
   * CLI remembers, it remembers on its own. Simple, and it makes any prompt-in/text-out
   * binary a crew member.
   */
  _drainExec() {
    if (this.currentJob || !this.queue.length) return;
    const job = this._takeFreshJob();
    if (!job) return;

    job._startedAt = Date.now();
    this.currentJob = job;
    this._setState('busy');

    const { command, args } = this.buildSpawnArgs();
    const proc = this._spawn(command, args, { cwd: this.cfg.workDir, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const hard = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, this.cfg.turnHardMs);
    if (hard.unref) hard.unref();

    proc.stdout.on('data', (d) => {
      out += d.toString();
      this.emit('delta', { agent: this.name, text: d.toString() });
    });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => {
      clearTimeout(hard);
      this.currentJob = null;
      job.reject(e);
      this._setState('idle');
      this._drainExec();
    });
    proc.on('close', (code) => {
      clearTimeout(hard);
      this.currentJob = null;
      this.stats.messages++;
      this.stats.lastActiveAt = new Date().toISOString();
      if (code === 0) {
        const result = { text: out.trim(), durationMs: Date.now() - job._startedAt, cost: 0 };
        this.emit('done', { agent: this.name, ...result });
        job.resolve(result);
      } else {
        job.reject(new Error(`${command} exited ${code}: ${err.slice(0, 200)}`));
      }
      this._setState('idle');
      this._drainExec();
    });

    try {
      proc.stdin.write(job.message);
      proc.stdin.end();
    } catch (e) {
      job.reject(e);
      this.currentJob = null;
    }
  }

  status() {
    return {
      id: this.name,
      transport: 'local',
      runner: this.cfg.runner,
      state: this.state,
      queueLength: this.queue.length,
      processAlive: !!this.proc,
      sessionId: this.sessionId,
      context: { tokens: this.contextTokens, limit: this.contextLimit },
      sessionMessages: this.sessionMessages,
      stats: this.stats,
    };
  }

  /** Public teardown used by tests and shutdown. Never leaves a timer behind. */
  destroy() {
    this.stop();
    this.removeAllListeners();
  }
}

module.exports = { AgentRuntime };
