// config.js — load + validate config and the agent roster.
//
// Two rules worth knowing before you edit this file:
//
// 1. Validation is a feature, not paperwork. Every check below exists because the
//    equivalent misconfiguration produced a *silent* wrong behaviour in the system
//    this was extracted from — nothing crashed, it just quietly did the wrong thing.
//    Loud at startup beats subtle at 3am.
//
// 2. `@mention` matching is substring-based (that is what people actually type), so a
//    display name that is a prefix of another one will silently wake the wrong agent.
//    We refuse to start rather than ship that ambiguity.

const fs = require('fs');
const path = require('path');
const os = require('os');

function expandTilde(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  // Strip "// key" documentation entries so the example files can carry prose.
  const parsed = JSON.parse(raw);
  return stripComments(parsed);
}

function stripComments(value) {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('//')) continue;
      out[k] = stripComments(v);
    }
    return out;
  }
  return value;
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  dbPath: './data/mousecrew.db',
  archivePath: './data/group-archive.jsonl',
  tokenFile: '~/.config/mousecrew/auth.json',
  nudge: { enabled: true, scanMs: 300000, idleMs: 600000, dedupMs: 1800000 },
  delivery: { stalePendingMs: 600000, maxPending: 200 },
  contextWatch: { enabled: true, thresholdTurns: 10, noHandoff: [], handoffDir: './data/handoff' },
  notify: { type: 'none', url: '' },
  remoteBridge: { enabled: true, reconnectWaitMs: 60000 },
};

const VALID_TRANSPORTS = new Set(['local', 'remote', 'terminal']);
const VALID_RUNNERS = new Set(['claude', 'exec']);

/**
 * Validate the roster. Returns { agents, errors } — the caller decides whether to die.
 * Kept pure (no fs, no process.exit) so the rules are testable.
 */
function validateAgents(agents) {
  const errors = [];
  if (!Array.isArray(agents) || agents.length === 0) {
    return { agents: [], errors: ['agents: expected a non-empty array'] };
  }

  const ids = new Set();
  const triggers = new Map();   // lowercased trigger -> agent id

  for (const a of agents) {
    const where = `agent "${a.id || '(no id)'}"`;
    if (!a.id) { errors.push('an agent has no id'); continue; }
    if (ids.has(a.id)) errors.push(`${where}: duplicate id`);
    ids.add(a.id);

    const transport = a.transport || 'local';
    if (!VALID_TRANSPORTS.has(transport)) {
      errors.push(`${where}: transport "${transport}" must be one of ${[...VALID_TRANSPORTS].join(' | ')}`);
    }
    if (transport === 'local') {
      const runner = a.runner || 'claude';
      if (!VALID_RUNNERS.has(runner)) {
        errors.push(`${where}: runner "${runner}" must be one of ${[...VALID_RUNNERS].join(' | ')}`);
      }
      if (runner === 'exec' && !(a.exec && a.exec.command)) {
        errors.push(`${where}: runner "exec" needs exec.command`);
      }
      if (!a.workDir) errors.push(`${where}: local agents need a workDir`);
    }
    if (transport === 'terminal' && !(a.terminal && a.terminal.adapter)) {
      errors.push(`${where}: terminal agents need terminal.adapter (e.g. "tmux")`);
    }
    if (a.repos !== undefined && !Array.isArray(a.repos)) {
      errors.push(`${where}: repos must be an array`);
    }

    // Every name a human might type after "@".
    const names = [a.displayName || a.id, ...(a.aliases || [])];
    for (const n of names) {
      const key = String(n).toLowerCase();
      if (triggers.has(key) && triggers.get(key) !== a.id) {
        errors.push(`mention "@${n}" is claimed by both "${triggers.get(key)}" and "${a.id}"`);
      }
      triggers.set(key, a.id);
    }
  }

  // Prefix collisions: "@arch" would also fire inside "@architect".
  // Substring matching is what makes plain-language @mentions work at all, so the fix
  // is to forbid the ambiguity up front instead of guessing at match time.
  const all = [...triggers.keys()];
  for (const short of all) {
    for (const long of all) {
      if (short === long) continue;
      if (long.includes(short) && triggers.get(short) !== triggers.get(long)) {
        errors.push(
          `mention "@${short}" (${triggers.get(short)}) is contained in "@${long}" (${triggers.get(long)}) — ` +
          `@${long} would wake both. Rename one.`
        );
      }
    }
  }

  const mergers = agents.filter((a) => a.canMerge);
  if (mergers.length > 1) {
    errors.push(`more than one agent has canMerge:true (${mergers.map((a) => a.id).join(', ')}) — the merge gate must be single`);
  }

  return { agents, errors };
}

function normalizeAgent(a) {
  return {
    id: a.id,
    displayName: a.displayName || a.id,
    aliases: a.aliases || [],
    transport: a.transport || 'local',
    runner: a.runner || 'claude',
    exec: a.exec || null,
    model: a.model || null,
    effort: a.effort || null,
    systemPromptFile: a.systemPromptFile ? expandTilde(a.systemPromptFile) : null,
    workDir: a.workDir ? expandTilde(a.workDir) : null,
    repos: a.repos || [],
    canMerge: !!a.canMerge,
    selfManaged: !!a.selfManaged,
    idleTimeoutMs: a.idleTimeoutMs || 30 * 60 * 1000,
    turnIdleMs: a.turnIdleMs || 10 * 60 * 1000,
    turnHardMs: a.turnHardMs || 30 * 60 * 1000,
    contextLimit: a.contextLimit || 200_000,
    contextWatch: a.contextWatch !== false,
    terminal: a.terminal || null,
  };
}

function load({ configFile, agentsFile, root } = {}) {
  const base = root || process.cwd();
  const cfgPath = configFile || process.env.MOUSECREW_CONFIG || path.join(base, 'config.json');
  const agtPath = agentsFile || process.env.MOUSECREW_AGENTS || path.join(base, 'agents.json');

  const fileCfg = fs.existsSync(cfgPath) ? readJson(cfgPath) : {};
  const cfg = { ...DEFAULTS, ...fileCfg };
  for (const key of ['nudge', 'delivery', 'contextWatch', 'notify', 'remoteBridge']) {
    cfg[key] = { ...DEFAULTS[key], ...(fileCfg[key] || {}) };
  }
  cfg.dbPath = path.resolve(base, expandTilde(cfg.dbPath));
  cfg.archivePath = path.resolve(base, expandTilde(cfg.archivePath));
  cfg.tokenFile = expandTilde(cfg.tokenFile);
  cfg.contextWatch.handoffDir = path.resolve(base, expandTilde(cfg.contextWatch.handoffDir));

  if (!fs.existsSync(agtPath)) {
    throw new Error(`agents file not found: ${agtPath} (copy agents.example.json to agents.json)`);
  }
  const roster = readJson(agtPath).agents;
  const { errors } = validateAgents(roster);
  if (errors.length) {
    throw new Error('agent roster is invalid:\n  - ' + errors.join('\n  - '));
  }

  return { config: cfg, agents: roster.map(normalizeAgent) };
}

module.exports = { load, validateAgents, normalizeAgent, expandTilde, stripComments, DEFAULTS };
