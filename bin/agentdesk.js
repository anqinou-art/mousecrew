#!/usr/bin/env node
// bin/agentdesk.js — what an agent (or a person) uses to drive the board.
//
// Everything here is a thin shell over the HTTP API. That is on purpose: an agent that
// can run one command can file its own work, move it along, and speak to the group
// without waiting for a human to click anything.

const fs = require('fs');
const path = require('path');
const os = require('os');

function expandTilde(p) {
  if (p === '~') return os.homedir();
  if (typeof p === 'string' && p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function loadClientConfig() {
  const base = process.env.AGENTDESK_ROOT || process.cwd();
  let cfg = {};
  const cfgPath = process.env.AGENTDESK_CONFIG || path.join(base, 'config.json');
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* fall back to env */ }

  const url = process.env.AGENTDESK_URL
    || `http://${cfg.host || '127.0.0.1'}:${cfg.port || 8787}`;

  let token = process.env.AGENTDESK_TOKEN || null;
  if (!token) {
    const tokenFile = expandTilde(cfg.tokenFile || '~/.config/agentdesk/auth.json');
    try {
      const st = fs.statSync(tokenFile);
      if (st.mode & 0o077) {
        die(`${tokenFile} is group/world readable (want 0600) — refusing to use it`);
      }
      token = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token;
    } catch (e) {
      die(`no token: set AGENTDESK_TOKEN or create ${tokenFile} (mode 0600) with {"token":"..."}`);
    }
  }
  return { url, token };
}

function die(msg) { console.error(msg); process.exit(1); }

async function api(method, route, body) {
  const { url, token } = loadClientConfig();
  const res = await fetch(url + route, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    // Say what went wrong and what to do, not just a status code.
    const hint = res.status === 401 ? ' (token not accepted — is it the same file the server reads?)'
      : res.status === 409 ? ' (ownership rule refused this — see `owners` below)'
      : res.status === 403 ? ' (only the merge gate may do that)'
      : '';
    die(`HTTP ${res.status}${hint}\n${JSON.stringify(json, null, 2)}`);
  }
  return json;
}

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
    else if (a === '-s') out.actor = argv[++i];
    else out._.push(a);
  }
  return out;
}

const NEXT = { draft: 'in_progress', in_progress: 'submitted', submitted: 'auditing', rejected: 'in_progress' };

const USAGE = `agentdesk — drive the work board

  list [--assignee X] [--status S]        list orders
  show <id>                               one order with its timeline
  create --title "..." [--assignee X] [--repo R] [--desc "..."] [-s me]
  start <id> [-s me]                      draft -> in_progress
  advance <id> [-s me] [--commit SHA] [--branch B] ["note"]
                                          move to the next state in the lane
  audit-pass <id> [-s me] [--no-restart] ["note"]
  audit-fail <id> [-s me] "reason"
  pause <id> [-s me] --blocked-by <id> "why"
  resume <id> [-s me]
  cancel <id> [-s me] "why"               any active state -> closed
  restart-done [-s me]                    close everything that was waiting on a restart
  comment <id> [-s me] "text"
  say [--as name] [--no-redispatch] "text"    post to the group
  dm --to <agent> "text"                      message one agent
  reply --as <agent> "text"                   answer a direct message
  status                                      every agent's state

Config: AGENTDESK_URL / AGENTDESK_TOKEN, or ./config.json + its tokenFile.`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  const id = f._[0];
  const note = f._[1] || f._[0];

  switch (cmd) {
    case 'list': {
      const q = [];
      if (f.assignee) q.push(`assignee=${encodeURIComponent(f.assignee)}`);
      if (f.status) q.push(`status=${encodeURIComponent(f.status)}`);
      const rows = await api('GET', '/api/orders' + (q.length ? '?' + q.join('&') : ''));
      for (const o of rows) {
        console.log(`  ${o.id.padEnd(10)} ${String(o.status).padEnd(16)} ${String(o.assignee || '-').padEnd(12)} ${o.repo ? '[' + o.repo + '] ' : ''}${o.title}`);
      }
      console.log(`  (${rows.length} orders)`);
      break;
    }

    case 'show': {
      if (!id) die('need <id>');
      console.log(JSON.stringify(await api('GET', `/api/orders/${id}`), null, 2));
      break;
    }

    case 'create': {
      if (!f.title) die('need --title');
      const o = await api('POST', '/api/orders', {
        title: f.title, description: f.desc || null,
        assignee: f.assignee || f.actor || null, repo: f.repo || null, actor: f.actor || 'cli',
      });
      await api('POST', `/api/orders/${o.id}/transition`, { to_status: 'in_progress', actor: f.actor || 'cli', comment: 'created' });
      console.log(`created ${o.id} -> in_progress${o.assignee ? ` (@${o.assignee})` : ''}`);
      break;
    }

    case 'start': {
      if (!id) die('need <id>');
      const r = await api('POST', `/api/orders/${id}/transition`, { to_status: 'in_progress', actor: f.actor || 'cli' });
      console.log(`${id} -> ${r.status}`);
      break;
    }

    case 'advance': {
      if (!id) die('need <id>');
      const o = await api('GET', `/api/orders/${id}`);
      const to = NEXT[o.status];
      if (!to) die(`${id} is ${o.status}; there is no next state (use audit-pass / pause / cancel)`);
      const r = await api('POST', `/api/orders/${id}/transition`, {
        to_status: to, actor: f.actor || 'cli', comment: note || '',
        commit_hash: f.commit || undefined, git_branch: f.branch || undefined,
      });
      console.log(`${id} ${o.status} -> ${r.status}`);
      // Show the verification verdict immediately: a result nobody reads is a result
      // that may as well not have been recorded.
      if (r.commit_verify) {
        const v = r.commit_verify;
        console.log(v.verified
          ? `  commit ${String(v.commit).slice(0, 9)} verified in ${v.repo} — ${v.files.length} file(s) recorded`
          : `  commit NOT verified (${v.reason}) — file list left empty rather than guessed`);
      }
      break;
    }

    case 'audit-pass': {
      if (!id) die('need <id>');
      const to = f['no-restart'] ? 'closed' : 'pending_restart';
      const r = await api('POST', `/api/orders/${id}/transition`, { to_status: to, actor: f.actor || 'cli', comment: note || 'merged' });
      console.log(`${id} -> ${r.status}`);
      break;
    }

    case 'audit-fail': {
      if (!id) die('need <id>');
      const r = await api('POST', `/api/orders/${id}/transition`, { to_status: 'rejected', actor: f.actor || 'cli', comment: note || '' });
      console.log(`${id} -> ${r.status}: ${note || ''}`);
      break;
    }

    case 'pause': {
      if (!id) die('need <id>');
      const r = await api('POST', `/api/orders/${id}/pause`, { actor: f.actor || 'cli', blocked_by: f['blocked-by'], reason: note || '' });
      console.log(`${id} paused (blocked_by=${r.blocked_by || '-'})`);
      break;
    }

    case 'resume': {
      if (!id) die('need <id>');
      await api('POST', `/api/orders/${id}/resume`, { actor: f.actor || 'cli' });
      console.log(`${id} resumed`);
      break;
    }

    case 'cancel': {
      if (!id) die('need <id>');
      const r = await api('POST', `/api/orders/${id}/transition`, { to_status: 'closed', actor: f.actor || 'cli', comment: `cancelled: ${note || 'no reason given'}` });
      console.log(`${id} -> ${r.status} (cancelled)`);
      break;
    }

    case 'restart-done': {
      const r = await api('POST', '/api/orders/restart-done', { actor: f.actor || 'cli' });
      console.log(r.closed.length ? `closed: ${r.closed.join(', ')}` : 'nothing was waiting on a restart');
      break;
    }

    case 'comment': {
      if (!id) die('need <id>');
      await api('POST', `/api/orders/${id}/logs`, { agent_name: f.actor || 'cli', action: 'comment', detail: f._[1] || '' });
      console.log(`noted on ${id}`);
      break;
    }

    case 'say': {
      const text = f._.join(' ');
      if (!text) die('need "text"');
      const r = await api('POST', '/api/group/post', {
        sender: f.as || process.env.AGENTDESK_ME || 'cli',
        content: text,
        reDispatch: !f['no-redispatch'],
      });
      console.log(`posted as ${r.sender}`);
      break;
    }

    case 'dm': {
      if (!f.to) die('need --to <agent>');
      await api('POST', `/api/agent/${f.to}/chat`, { message: f._.join(' ') });
      console.log(`sent to ${f.to}`);
      break;
    }

    case 'reply': {
      const who = f.as || process.env.AGENTDESK_ME;
      if (!who) die('need --as <agent> (or set AGENTDESK_ME)');
      await api('POST', `/api/dm/${who}/post`, { content: f._.join(' ') });
      console.log('replied');
      break;
    }

    case 'status': {
      const s = await api('GET', '/api/agents/status');
      for (const [name, v] of Object.entries(s)) {
        const ctx = v.context ? ` ctx ${Math.round((v.context.tokens || 0) / 1000)}k/${Math.round(v.context.limit / 1000)}k` : '';
        console.log(`  ${name.padEnd(12)} ${String(v.transport).padEnd(9)} ${String(v.state).padEnd(10)}${ctx}`);
      }
      break;
    }

    default:
      console.log(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => die(e.message));
