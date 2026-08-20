#!/usr/bin/env node
// context-watch.js — tell an agent when its context window is nearly full.
//
// The measure is TURNS REMAINING, not percent used. Percent lies:
//
//     agent   used            per turn   turns left
//     A       120k / 200k     15k        5      <- the one about to hit the wall
//     B       150k / 200k      2k       25
//
// Sorted by percentage you would go help B first. Turns remaining is derived from two
// samples: (tokens now - tokens then) / (messages now - messages then).
//
// It warns; it never rotates anything by itself. Only the agent knows whether the thing
// in its hands can be wrapped up in the next few turns.
//
// Run it from cron/systemd every ~10 minutes.

const fs = require('fs');
const path = require('path');
const { load } = require('../src/config');
const { readTokenFile } = require('../src/lib/require-token');

// Local wall-clock, not UTC. A log stamped in a timezone the server does not use reads as
// if the job died hours ago, and the handoff file lands under the wrong date for anyone
// working late. Both were real confusions; both cost more than this line saves.
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const log = (...a) => console.log(stamp(), ...a);

/**
 * Pure: how many turns are left, and are we below the line?
 * Exported so the arithmetic is testable without a server.
 */
function assess(prev, now, thresholdTurns) {
  const room = now.limit - now.tokens;
  if (room <= 0) return { remain: 0, perTurn: null, warn: true, basis: 'full' };

  // Fresh session: no previous sample to difference against. Whole-window average is
  // optimistic (early turns are small), so it is a fallback only — the next poll has a
  // real number. Without it, an agent that rotated straight into heavy turns is invisible
  // for one cycle, which is exactly when it is at risk.
  if (!prev || prev.sessionId !== now.sessionId || now.msgs <= prev.msgs) {
    if (!now.msgs) return { remain: Infinity, perTurn: null, warn: false, basis: 'no-data' };
    const avg = now.tokens / now.msgs;
    return { remain: Math.floor(room / avg), perTurn: avg, warn: Math.floor(room / avg) <= thresholdTurns, basis: 'window-average' };
  }

  const dTokens = now.tokens - prev.tokens;
  const dMsgs = now.msgs - prev.msgs;
  if (dTokens <= 0) return { remain: Infinity, perTurn: 0, warn: false, basis: 'no-growth' };
  const perTurn = dTokens / dMsgs;
  const remain = Math.floor(room / perTurn);
  return { remain, perTurn, warn: remain <= thresholdTurns, basis: 'delta' };
}

function notice(name, remain, tokens, limit, perTurn, { handoff, handoffDir }) {
  const lines = [
    `Heads-up: your context window is nearly full — about ${remain} turn(s) left.`,
    `Currently ${Math.round(tokens / 1000)}k of ${Math.round(limit / 1000)}k, growing ~${Math.round((perTurn || 0) / 1000)}k per turn.`,
  ];
  if (handoff) {
    lines.push(
      `When the thing in your hands reaches a clean stopping point, write a handoff to`,
      `${path.join(handoffDir, name + '-handoff', today() + '.md')} — what you did, what is left, what to watch out for —`,
      `then rotate: POST /api/agents/${name}/session/new (or ask a human to).`,
      `Nobody will rotate you automatically; you know best when it is safe.`,
    );
  } else {
    lines.push(`No handoff needed for you — your output already lands on disk. Just rotate when convenient.`);
  }
  return lines.join('\n');
}

async function main() {
  const { config, agents } = load();
  const cw = config.contextWatch || {};
  if (cw.enabled === false) return;
  const threshold = cw.thresholdTurns || 10;
  const noHandoff = new Set(cw.noHandoff || []);
  const statePath = path.join(path.dirname(config.dbPath), 'context-watch-state.json');
  const base = `http://${config.host}:${config.port}`;
  const token = readTokenFile(config.tokenFile);
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  let state = {};
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* first run */ }

  const status = await (await fetch(`${base}/api/agents/status`, { headers: H })).json();

  for (const cfg of agents) {
    if (!cfg.contextWatch || cfg.transport !== 'local') continue;
    const s = status[cfg.id];
    if (!s || !s.context) continue;

    // Only bother an agent whose process is actually up. Waking a stopped agent so it can
    // read "you are nearly full" spends a whole turn to deliver news that will still be
    // true — and unchanged — the next time it genuinely has work.
    if (!s.processAlive) { log(`${cfg.id}: not running, skipped`); continue; }

    const now = { sessionId: s.sessionId, tokens: s.context.tokens, limit: s.context.limit, msgs: s.sessionMessages };
    const verdict = assess(state[cfg.id], now, threshold);
    const prevWarned = state[cfg.id] && state[cfg.id].warned && state[cfg.id].sessionId === now.sessionId;
    state[cfg.id] = { ...now, warned: prevWarned || false };

    if (!Number.isFinite(verdict.remain)) { log(`${cfg.id}: ${verdict.basis}, nothing to say`); continue; }

    if (verdict.warn && !prevWarned) {
      const body = notice(cfg.id, verdict.remain, now.tokens, now.limit, verdict.perTurn, {
        handoff: !noHandoff.has(cfg.id), handoffDir: cw.handoffDir,
      });
      const res = await fetch(`${base}/api/agent/${cfg.id}/chat`, { method: 'POST', headers: H, body: JSON.stringify({ message: body }) });
      if (res.ok) {
        state[cfg.id].warned = true;
        log(`${cfg.id}: WARNED — ~${verdict.remain} turns left (${Math.round(verdict.perTurn / 1000)}k/turn, via ${verdict.basis})`);
      } else {
        log(`${cfg.id}: warn failed, HTTP ${res.status}`);
      }
    } else {
      log(`${cfg.id}: ${Math.round(now.tokens / 1000)}k/${Math.round(now.limit / 1000)}k ~${verdict.remain} turns left`);
    }
  }

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

if (require.main === module) {
  main().catch((e) => { log('error:', e.message); process.exit(1); });
}

module.exports = { assess, notice, stamp, today };
