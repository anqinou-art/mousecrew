#!/usr/bin/env node
// mousecrew-sidecar.js — run this next to your terminal windows.
//
// It watches the group, works out which of your windows each message is for, and types it
// in when that window is free. Replies go back the normal way: the window runs
// `mousecrew say` or `mousecrew reply`, exactly as a person would.
//
//   mousecrew-sidecar                       use the adapter the roster asks for
//   mousecrew-sidecar --adapter tmux        override it
//   mousecrew-sidecar --once                one pass, then exit (useful in cron or a check)
//
// ⚠️ If you are using the cmux adapter, this must be started from inside cmux itself.
// cmux authorises its control socket by process ancestry, so a sidecar started outside it
// will happily receive every message and then fail to type a single character — while
// still consuming the messages. See adapters/terminal/cmux.js.

const path = require('path');
const { load } = require('../src/config');
const { buildIdentity } = require('../src/lib/identity');
const { createAdapter } = require('../adapters/terminal');
const { Sidecar } = require('../src/lib/sidecar');
const { readTokenFile } = require('../src/lib/require-token');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

function die(msg) { console.error(msg); process.exit(1); }

const { config, agents } = load();
const terminalAgents = agents.filter((a) => a.transport === 'terminal');
if (!terminalAgents.length) {
  die('no agents have transport:"terminal" — nothing for a sidecar to do.\n' +
      'Add one to agents.json, or run the server alone if your whole crew is headless.');
}

const adapterName = flag('adapter', terminalAgents[0].terminal.adapter);
const mixed = terminalAgents.filter((a) => a.terminal.adapter !== adapterName).map((a) => a.id);
if (mixed.length) {
  // One sidecar drives one multiplexer. Two multiplexers means two sidecars, which is
  // fine — but silently ignoring half the roster is not.
  die(`this sidecar is running "${adapterName}", but these agents ask for a different adapter: ${mixed.join(', ')}\n` +
      `start a second sidecar with --adapter, or make the roster agree.`);
}

const adapter = createAdapter(adapterName);
const base = `http://${config.host}:${config.port}`;
let token;
try { token = readTokenFile(config.tokenFile); }
catch (e) { die(`cannot read the token (${e.message}) — the sidecar speaks to the same API as everyone else and needs it`); }
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

const client = {
  async history(limit = 200) {
    const res = await fetch(`${base}/api/group/history?limit=${limit}`, { headers: H });
    if (!res.ok) throw new Error(`history HTTP ${res.status}`);
    return (await res.json()).messages || [];
  },
  async pendingDms() {
    const res = await fetch(`${base}/api/dm/pending`, { headers: H });
    if (!res.ok) throw new Error(`dm pending HTTP ${res.status}`);
    return (await res.json()).pending || [];
  },
  async ack(agent, dmId, status) {
    const res = await fetch(`${base}/api/dm/${agent}/ack`, { method: 'POST', headers: H, body: JSON.stringify({ dmId, status }) });
    if (!res.ok) throw new Error(`ack HTTP ${res.status}`);
  },
  async presence(report) {
    const res = await fetch(`${base}/api/agents/presence`, { method: 'POST', headers: H, body: JSON.stringify({ agents: report }) });
    if (!res.ok) throw new Error(`presence HTTP ${res.status}`);
  },
};

const sidecar = new Sidecar({
  adapter,
  identity: buildIdentity(agents),
  agents,
  client,
  statePath: path.join(path.dirname(config.dbPath), 'sidecar-state.json'),
}, {
  stalePendingMs: config.delivery.stalePendingMs,
  maxPending: config.delivery.maxPending,
});

// Log every structured event. These are the same events the tests assert against, so what
// you read here is exactly what is being checked — not a parallel description of it.
sidecar.on('event', (e) => {
  const when = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const { type, ...rest } = e;
  console.log(`${when} [${type}] ${Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ')}`);
});

/**
 * Subscribe to a server-sent-events endpoint, reconnecting with backoff.
 *
 * The stream is for latency, not for reliability: everything it carries is also reachable
 * by polling history. That is why a disconnect here is a log line rather than an incident —
 * and why the poll interval is not something to tune away to nothing.
 */
async function subscribe(url, onEvent, label) {
  let delay = 3000;
  let announced = false;
  for (;;) {
    try {
      const res = await fetch(url, { headers: H });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!announced) { console.log(`[${label}] connected`); announced = true; }
      delay = 3000;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try { onEvent(JSON.parse(line.slice(6))); } catch { /* heartbeat or partial */ }
        }
      }
      throw new Error('stream ended');
    } catch (e) {
      // Quiet on purpose: a fixed fast retry turns an outage into a log nobody can read,
      // and the real delivery failures drown in it.
      if (announced) { console.log(`[${label}] disconnected (${e.message}) — retrying`); announced = false; }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 60_000);
    }
  }
}

async function main() {
  if (!(await adapter.available())) {
    die(`the "${adapterName}" adapter is not usable on this machine — is ${adapterName} installed and running?`);
  }

  console.log(`mousecrew sidecar — adapter=${adapterName}, watching for: ${terminalAgents.map((a) => a.displayName).join(', ')}`);
  await sidecar.pollHistory();       // establishes the baseline; delivers nothing

  if (has('once')) {
    await sidecar.deliver();
    await sidecar.reportPresence();
    return;
  }

  sidecar.start();
  subscribe(`${base}/api/group/events`, (ev) => {
    if (ev && ev.type === 'message') {
      sidecar.ingest([{ content: ev.content, ts: ev.ts, metadata: { sender: ev.sender } }], 'sse');
      sidecar.deliver().catch(() => {});
    }
  }, 'group').catch(() => {});
  subscribe(`${base}/api/dm/events`, (ev) => {
    if (ev && ev.type === 'dm') {
      sidecar.ingestDirect(ev);
      sidecar.deliver().catch(() => {});
    }
  }, 'direct').catch(() => {});

  // Catch up on direct messages that arrived while this process was down. The group has
  // history for that; direct messages have this.
  try {
    for (const ev of await client.pendingDms()) sidecar.ingestDirect(ev);
  } catch (e) {
    console.log(`[direct] could not fetch pending: ${e.message}`);
  }

  const shutdown = () => { sidecar.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => die(e.message));
