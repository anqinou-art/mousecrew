#!/usr/bin/env node
// mousecrew-worker.js — run crew members on a machine that is not the server.
//
// Why this exists: some work is physically tied to a box. Building a phone app needs the
// laptop with the toolchain; touching a private repo needs the machine holding the key.
// The worker dials out to the server, so the laptop needs no inbound port.
//
// Usage:
//   MOUSECREW_URL=http://server:8787 MOUSECREW_TOKEN=... \
//     node bin/mousecrew-worker.js --agents frontend --workdir ~/myapp --cli claude

const WebSocket = require('ws');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
}

const URL_BASE = process.env.MOUSECREW_URL || 'http://127.0.0.1:8787';
const TOKEN = process.env.MOUSECREW_TOKEN;
const AGENTS = (flag('agents', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const WORKDIR = flag('workdir', process.cwd());
const CLI = flag('cli', 'claude');
const MODEL = flag('model', null);
const RECONNECT_MS = 5000;
const HEARTBEAT_MS = 25_000;
// Backstop for a turn that produces nothing at all. Keep it above the server's own hang
// timeout so the server gives up first and the user sees one clear failure, not two.
const TURN_TIMEOUT_MS = Number(flag('turn-timeout-ms', 10 * 60 * 1000));

if (!TOKEN) { console.error('set MOUSECREW_TOKEN'); process.exit(1); }
if (!AGENTS.length) { console.error('need --agents <id[,id...]>'); process.exit(1); }

const wsUrl = URL_BASE.replace(/^http/, 'ws') + '/ws/bridge?token=' + encodeURIComponent(TOKEN);
let ws = null;
let heartbeat = null;

function runTurn(text) {
  return new Promise((resolve, reject) => {
    const a = ['-p', text, '--output-format', 'text', '--dangerously-skip-permissions'];
    if (MODEL) a.push('--model', MODEL);
    const proc = spawn(CLI, a, { cwd: WORKDIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      reject(new Error(`local ${CLI} produced nothing for ${Math.round(TURN_TIMEOUT_MS / 60000)}min`));
    }, TURN_TIMEOUT_MS);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${CLI} exited ${code}: ${err.slice(0, 200)}`));
    });
  });
}

function connect() {
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log(`[worker] connected, registering: ${AGENTS.join(', ')}`);
    ws.send(JSON.stringify({ type: 'register', agents: AGENTS }));
    heartbeat = setInterval(() => {
      try { ws.send(JSON.stringify({ type: 'heartbeat' })); } catch {}
    }, HEARTBEAT_MS);
  });

  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'registered') { console.log(`[worker] registered: ${m.agents.join(', ')}`); return; }
    if (m.type !== 'dispatch') return;

    console.log(`[worker] ${m.agent} <- ${String(m.text).slice(0, 80)}`);
    try {
      const text = await runTurn(m.text);
      ws.send(JSON.stringify({ type: 'reply', requestId: m.requestId, text }));
    } catch (e) {
      // Always answer. Silence here leaves a promise hanging on the server and the agent
      // looks busy forever.
      ws.send(JSON.stringify({ type: 'error', requestId: m.requestId, message: e.message }));
    }
  });

  const retry = (why) => {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    console.log(`[worker] ${why}; reconnecting in ${RECONNECT_MS / 1000}s`);
    setTimeout(connect, RECONNECT_MS);
  };
  ws.on('close', () => retry('disconnected'));
  ws.on('error', (e) => retry(`socket error (${e.message})`));
}

connect();
