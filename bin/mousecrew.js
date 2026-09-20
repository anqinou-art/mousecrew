#!/usr/bin/env node
// bin/mousecrew.js — what an agent (or a person) uses to drive the board.
//
// Everything here is a thin shell over the HTTP API. That is on purpose: an agent that
// can run one command can file its own work, move it along, and speak to the group
// without waiting for a human to click anything.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildIdentity } = require('../src/lib/identity');
const rotation = require('../src/lib/rotation');

function expandTilde(p) {
  if (p === '~') return os.homedir();
  if (typeof p === 'string' && p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function loadClientConfig() {
  const base = process.env.MOUSECREW_ROOT || process.cwd();
  let cfg = {};
  const cfgPath = process.env.MOUSECREW_CONFIG || path.join(base, 'config.json');
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* fall back to env */ }

  const url = process.env.MOUSECREW_URL
    || `http://${cfg.host || '127.0.0.1'}:${cfg.port || 8787}`;

  let token = process.env.MOUSECREW_TOKEN || null;
  if (!token) {
    const tokenFile = expandTilde(cfg.tokenFile || '~/.config/mousecrew/auth.json');
    try {
      const st = fs.statSync(tokenFile);
      if (st.mode & 0o077) {
        die(`${tokenFile} is group/world readable (want 0600) — refusing to use it`);
      }
      token = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token;
    } catch (e) {
      die(`no token: set MOUSECREW_TOKEN or create ${tokenFile} (mode 0600) with {"token":"..."}`);
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
    if (a === '--void') out.void = true;
    else if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
    else if (a === '-s') out.actor = argv[++i];
    else if (a === '-p') out.project = argv[++i];
    else out._.push(a);
  }
  return out;
}

function loadLocalCrew() {
  const { load } = require('../src/config');
  return load({ root: process.env.MOUSECREW_ROOT || process.cwd() });
}

async function readStdin() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

const NEXT = { draft: 'in_progress', in_progress: 'submitted', rejected: 'in_progress' };

const USAGE = `mousecrew — drive the work board

  list [-p project] [--assignee X] [--status S]
                                          list orders
  projects                                list configured projects
  show <id>                               one order with its timeline and agent logs
  create [-p project] --title "..." [--assignee X] [--repo R] [--desc "..."] [-s me]
  start <id> [-s me]                      draft -> in_progress
  dispatch <id> [--assignee X] [-s me]    draft -> assigned and notify the assignee
  accept <id> -s me                       accept assigned work, review, or rework
  advance <id> [-s me] [--commit SHA] [--branch B] ["note"]
                                          move to the next state in the lane
  audit-pass <id> [-s me] --rev N [--no-restart] ["note"]
  audit-fail <id> [-s me] --rev N "reason"
  unfreeze <id> -s me --reason "why"       withdraw review and return it for changes
  pause <id> [-s me] --blocked-by <id> "why"
  resume <id> [-s me]
  cancel <id> [-s me] [--void] "why"      cancel work; --void closes work in review
  restart-done [id ...] [-s me]           close named orders, or everything waiting on a restart
  comment <id> [-s me] "text"
  say [--as name] [--no-redispatch] "text"    post to the group
  dm --to <agent> "text"                      message one agent
  reply --as <agent> "text"                   answer a direct message
  identity <agent> [--window ref]              claim this window for a crew member
  session-record --as <agent> [--window ref]   record SessionStart JSON from stdin
  session-activity --as <agent> busy|idle       record hook activity JSON from stdin
  rotate <agent>                               rotate a local agent after its current turn
  status                                      every agent's state

Threads — work you can put down and pick back up (see docs/THREADS.zh-CN.md):
  thread list [--owner who] [--all]
  thread show <name>
  thread new <name> --owner who [--goal "..."] [--prev <name>]
  thread set <name> <field> "value"       owner|status|goal|next|blocked_by|needs_human|prev
  thread plan <name> "one per line"       rewrite the plan; ticks follow the text
  thread check <name> <n> / uncheck <name> <n>          n counts from 1
  thread log <name> --who X --what "..." (--check N | --plan "..." | --no-plan-change)
  thread finish <name> --snapshot "..."   the only road to done
  thread archive <name> [--why "..."] [--undo]          soft delete; history stays

Config: MOUSECREW_URL / MOUSECREW_TOKEN, or ./config.json + its tokenFile.`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  const id = f._[0];
  const note = f._.slice(1).join(' ');

  switch (cmd) {
    case 'list': {
      const q = [];
      if (f.project) q.push(`project_id=${encodeURIComponent(f.project)}`);
      if (f.assignee) q.push(`assignee=${encodeURIComponent(f.assignee)}`);
      if (f.status) q.push(`status=${encodeURIComponent(f.status)}`);
      const rows = await api('GET', '/api/orders' + (q.length ? '?' + q.join('&') : ''));
      for (const o of rows) {
        console.log(`  ${o.id.padEnd(10)} ${String(o.status).padEnd(16)} ${String(o.assignee || '-').padEnd(12)} ${o.repo ? '[' + o.repo + '] ' : ''}${o.title}`);
      }
      console.log(`  (${rows.length} orders)`);
      break;
    }

    case 'projects': {
      const rows = await api('GET', '/api/projects');
      for (const project of rows) {
        console.log(`  ${String(project.id).padEnd(16)} ${String(project.name).padEnd(24)} ${project.prefix}`);
      }
      console.log(`  (${rows.length} projects)`);
      break;
    }

    case 'show': {
      if (!id) die('need <id>');
      const o = await api('GET', `/api/orders/${id}`);
      console.log(JSON.stringify(o, null, 2));
      if (o.frozen) {
        const snapshot = (o.revisions || []).find((row) => row.audit_revision === o.audit_revision);
        console.log(`frozen at rev ${o.audit_revision} (commit ${(snapshot && snapshot.commit_hash) || '-'})`);
      }
      break;
    }

    case 'create': {
      if (!f.title) die('need --title');
      const actor = f.actor || 'cli';
      const assignee = f.assignee || f.actor || null;
      const o = await api('POST', '/api/orders', {
        title: f.title, description: f.desc || null,
        assignee, repo: f.repo || null, project_id: f.project || null, actor,
      });
      let status = 'draft';
      if (assignee && f.actor && assignee === f.actor) {
        const started = await api('POST', `/api/orders/${o.id}/transition`, { to_status: 'in_progress', actor, comment: 'created and started' });
        status = started.status;
      } else if (assignee) {
        const dispatched = await api('POST', `/api/orders/${o.id}/dispatch`, { actor });
        status = dispatched.order.status;
      }
      console.log(`created ${o.id} -> ${status}${assignee ? ` (@${assignee})` : ''}`);
      break;
    }

    case 'start': {
      if (!id) die('need <id>');
      const r = await api('POST', `/api/orders/${id}/transition`, { to_status: 'in_progress', actor: f.actor || 'cli' });
      console.log(`${id} -> ${r.status}`);
      break;
    }

    case 'dispatch': {
      if (!id) die('need <id>');
      if (f.assignee) {
        await api('POST', `/api/orders/${id}/assign`, { assignee: f.assignee, actor: f.actor || 'cli' });
      }
      const r = await api('POST', `/api/orders/${id}/dispatch`, { actor: f.actor || 'cli' });
      console.log(`${id} -> ${r.order.status} (@${r.order.assignee})`);
      break;
    }

    case 'accept': {
      if (!id) die('need <id>');
      if (!f.actor) die('need -s <me> — accepting without an actor would not confirm who took it');
      const r = await api('POST', `/api/orders/${id}/accept`, { actor: f.actor });
      console.log(`${id} ${r.from} -> ${r.to}`);
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
      if (f.rev === undefined || !/^\d+$/.test(String(f.rev))) die('need --rev <N>');
      const to = f['no-restart'] ? 'closed' : 'pending_restart';
      const r = await api('POST', `/api/orders/${id}/transition`, {
        to_status: to, actor: f.actor || 'cli', comment: note || 'merged',
        audit_revision: Number(f.rev),
      });
      console.log(`${id} -> ${r.status}`);
      break;
    }

    case 'audit-fail': {
      if (!id) die('need <id>');
      if (f.rev === undefined || !/^\d+$/.test(String(f.rev))) die('need --rev <N>');
      const r = await api('POST', `/api/orders/${id}/transition`, {
        to_status: 'rejected', actor: f.actor || 'cli', comment: note || '',
        audit_revision: Number(f.rev),
      });
      console.log(`${id} -> ${r.status}: ${note || ''}`);
      break;
    }

    case 'unfreeze': {
      if (!id) die('need <id>');
      if (!f.actor) die('need -s <me>');
      if (!String(f.reason || '').trim()) die('need --reason "why"');
      const r = await api('POST', `/api/orders/${id}/unfreeze`, {
        actor: f.actor,
        reason: String(f.reason).trim(),
      });
      console.log(`${id} unfrozen from rev ${r.unfrozen_revision}`);
      break;
    }

    case 'pause': {
      if (!id) die('need <id>');
      if (!f['blocked-by']) die('need --blocked-by <id>');
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
      if (!note.trim()) die('need a cancellation reason');
      const o = await api('GET', `/api/orders/${id}`);
      const pausedFrom = Array.isArray(o.timeline)
        ? [...o.timeline].reverse().find((entry) => entry && entry.status === 'paused')?.from
        : null;
      const inReview = o.status === 'auditing' || (o.status === 'paused' && pausedFrom === 'auditing');
      if (inReview && !f.void) die(`${id} is in review; use --void to make that intent explicit`);
      if (f.void && !inReview) die('--void is only for an auditing order or one paused from auditing');
      const r = await api('POST', `/api/orders/${id}/transition`, {
        to_status: 'closed', actor: f.actor || 'cli', comment: note, cancelled: true,
      });
      console.log(`${id} -> ${r.status} (${f.void ? 'voided' : 'cancelled'})`);
      break;
    }

    case 'restart-done': {
      const r = await api('POST', '/api/orders/restart-done', {
        actor: f.actor || 'cli',
        ...(f._.length ? { ids: f._ } : {}),
      });
      console.log(r.closed.length ? `closed: ${r.closed.join(', ')}` : 'nothing was waiting on a restart');
      if (r.unchecked.length) console.log(`unchecked (no deploy tree configured): ${r.unchecked.join(', ')}`);
      if (r.no_commit.length) console.log(`no commit recorded: ${r.no_commit.join(', ')}`);
      if (r.skipped.length) {
        for (const item of r.skipped) console.error(`skipped ${item.id}: ${item.reason}`);
        process.exitCode = 1;
      }
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
        sender: f.as || process.env.MOUSECREW_ME || 'cli',
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
      const who = f.as || process.env.MOUSECREW_ME;
      if (!who) die('need --as <agent> (or set MOUSECREW_ME)');
      await api('POST', `/api/dm/${who}/post`, { content: f._.join(' ') });
      console.log('replied');
      break;
    }

    case 'identity': {
      // Claim this window for a crew member. Run it inside the window itself.
      //
      // Identity moves rather than duplicates: any other window claiming the same name is
      // released first. Two windows answering to one name is not a tie, it is a message
      // typed into whichever one the resolver happened to pick — and after a session
      // restore, that is often the dead one.
      const who = f._[0];
      if (!who) die('need <agent-id>  (run this inside the window you want to claim)');
      const { createAdapter } = require('../adapters/terminal');
      const { config, agents } = loadLocalCrew();
      const names = buildIdentity(agents);
      const cfg = agents.find((a) => a.id === names.normalizeAgentId(who));
      if (!cfg) die(`"${who}" is not on the roster`);
      if (cfg.transport !== 'terminal') die(`"${who}" is not a terminal agent — nothing to claim`);

      const adapter = createAdapter(f.adapter || cfg.terminal.adapter);
      const target = cfg.terminal.target || cfg.displayName;
      const ref = f.window || process.env.MOUSECREW_WINDOW || process.env.TMUX_PANE;
      if (!ref) {
        die('cannot tell which window this is.\n' +
            'Inside tmux, $TMUX_PANE is set automatically; otherwise pass --window <ref>.\n' +
            `Windows I can see: ${(await adapter.listWindows()).map((w) => w.ref).join(', ') || '(none)'}`);
      }

      const windows = await adapter.listWindows();
      const moved = windows.filter((w) => w.identity === target && w.ref !== ref);
      try {
        rotation.invalidateMovedRecord(
          rotation.sessionDirectory(config), cfg.id, moved.map((window) => window.ref),
        );
      } catch (error) {
        die(`cannot invalidate the old session record (${error.message}) — identity was not moved`);
      }
      for (const w of moved) {
        await adapter.clearIdentity(w.ref);
        console.log(`released ${target} from ${w.ref}`);
      }
      await adapter.setIdentity(ref, target);
      // Read it back. "The command exited 0" is a claim; the listing is the fact.
      const now = (await adapter.listWindows()).find((w) => w.ref === ref);
      if (!now || now.identity !== target) die(`set it, but reading back gave ${now ? now.identity : '(window gone)'} — not claimed`);
      console.log(`${ref} is now ${target}`);
      break;
    }

    case 'session-record': {
      if (typeof f.as !== 'string' || !f.as.trim()) die('need --as <agent>');
      const { config, agents } = loadLocalCrew();
      const names = buildIdentity(agents);
      const agent = names.normalizeAgentId(f.as);
      const cfg = agents.find((entry) => entry.id === agent);
      if (!cfg) die(`"${f.as}" is not on the roster`);
      if (cfg.transport !== 'terminal') die(`"${f.as}" is not a terminal agent — no window session to record`);
      const windowInput = f.window !== undefined
        ? f.window
        : (process.env.MOUSECREW_WINDOW || process.env.TMUX_PANE);
      if (typeof windowInput !== 'string' || !windowInput.trim()) {
        die('cannot tell which window this is; pass --window or set MOUSECREW_WINDOW / TMUX_PANE');
      }
      const windowRef = windowInput.trim();
      const sessionDir = rotation.sessionDirectory(config);
      const invalidateCurrent = () => {
        try { rotation.invalidateMovedRecord(sessionDir, cfg.id, [windowRef]); }
        catch (error) { die(`cannot invalidate the previous session record (${error.message})`); }
      };

      let hook;
      const raw = await readStdin();
      try { hook = JSON.parse(raw); }
      catch (error) {
        invalidateCurrent();
        die(`SessionStart stdin is not valid JSON (${error.message})`);
      }
      if (!hook || typeof hook !== 'object' || Array.isArray(hook)) {
        invalidateCurrent();
        die('SessionStart stdin must be a JSON object');
      }
      if (typeof hook.session_id !== 'string' || !hook.session_id.trim()) {
        invalidateCurrent();
        die('SessionStart JSON is missing non-empty session_id');
      }
      if (typeof hook.transcript_path !== 'string' || !hook.transcript_path.trim()) {
        invalidateCurrent();
        die('SessionStart JSON is missing non-empty transcript_path');
      }
      const record = {
        agent: cfg.id,
        windowRef,
        sessionId: hook.session_id.trim(),
        transcriptPath: hook.transcript_path.trim(),
        cwd: typeof hook.cwd === 'string' ? hook.cwd : null,
        recordedAt: new Date().toISOString(),
      };
      let file;
      try { file = rotation.writeSessionRecord(sessionDir, record); }
      catch (error) {
        invalidateCurrent();
        die(`cannot record SessionStart (${error.message})`);
      }
      console.log(`recorded ${cfg.id} session ${record.sessionId} for ${windowRef} in ${file}`);
      break;
    }

    case 'session-activity': {
      if (typeof f.as !== 'string' || !f.as.trim()) die('need --as <agent>');
      const state = f._[0];
      if (state !== 'busy' && state !== 'idle') die('activity must be busy or idle');
      const { config, agents } = loadLocalCrew();
      const names = buildIdentity(agents);
      const agent = names.normalizeAgentId(f.as);
      const cfg = agents.find((entry) => entry.id === agent);
      if (!cfg) die(`"${f.as}" is not on the roster`);
      if (cfg.transport !== 'terminal') die(`"${f.as}" is not a terminal agent — no window activity to record`);
      const windowInput = f.window !== undefined
        ? f.window
        : (process.env.MOUSECREW_WINDOW || process.env.TMUX_PANE);
      if (typeof windowInput !== 'string' || !windowInput.trim()) {
        die('cannot tell which window this is; pass --window or set MOUSECREW_WINDOW / TMUX_PANE');
      }
      const windowRef = windowInput.trim();
      let hook;
      const raw = await readStdin();
      try { hook = JSON.parse(raw); }
      catch (error) { die(`hook stdin is not valid JSON (${error.message})`); }
      if (!hook || typeof hook !== 'object' || Array.isArray(hook)) {
        die('hook stdin must be a JSON object');
      }
      if (typeof hook.session_id !== 'string' || !hook.session_id.trim()) {
        die('hook JSON is missing non-empty session_id');
      }

      const sessionDir = rotation.sessionDirectory(config);
      const sessionId = hook.session_id.trim();
      let result;
      try {
        result = rotation.updateSessionActivity(sessionDir, cfg.id, {
          state, recordedAt: new Date().toISOString(), windowRef, sessionId,
        });
      }
      catch (error) { die(`cannot record session activity (${error.message})`); }
      if (!result.updated) {
        console.log(`ignored ${state} activity for ${cfg.id}: window or session does not match SessionStart`);
        break;
      }
      console.log(`recorded ${cfg.id} ${state} activity for ${windowRef} in ${result.file}`);
      break;
    }

    case 'rotate': {
      if (!id) die('need <agent>');
      const r = await api('POST', `/api/agents/${id}/session/rotate`);
      console.log(r.queued
        ? `${id}: rotation queued until the current turn finishes`
        : `${id}: rotation started`);
      console.log('check `mousecrew status` for confirmation from the new process');
      break;
    }

    // Threads. One verb per kind of change, mirroring the API — the CLI does not get a
    // shortcut the API refuses, because then the gate would only apply to whoever used curl.
    case 'thread': {
      const [sub, name, ...more] = f._;
      const t = (route, body, method = 'POST') => api(method, `/api/threads${route}`, body);
      const need = (v, what) => { if (!v) die(`need ${what}`); return v; };

      switch (sub) {
        case undefined:
        case 'list': {
          const q = [];
          if (f.owner) q.push(`owner=${encodeURIComponent(f.owner)}`);
          if (f.all) q.push('archived=all');
          const rows = await api('GET', '/api/threads' + (q.length ? '?' + q.join('&') : ''));
          for (const th of rows) {
            const plan = th.plan.length ? `${th.plan.filter((p) => p.done).length}/${th.plan.length}` : '-';
            const mark = th.archived ? ' (archived)' : '';
            console.log(`  ${String(th.status).padEnd(8)} ${String(th.owner).padEnd(10)} ${String(plan).padEnd(6)} ${th.name}${mark}`);
            // next is the handle. Showing it in the list is the whole point of the list:
            // you should be able to pick a thread back up without opening it first.
            if (th.next) console.log(`  ${' '.repeat(26)}↳ ${th.next}`);
          }
          console.log(`  (${rows.length} threads)`);
          break;
        }

        case 'show':
          console.log(JSON.stringify(await api('GET', `/api/threads/${encodeURIComponent(need(name, '<name>'))}`), null, 2));
          break;

        case 'new': {
          need(name, '<name>'); need(f.owner, '--owner');
          const r = await t('', { name, owner: f.owner, goal: f.goal || '', next: f.next || '', prev: f.prev || null });
          console.log(`${r.data.name} (idea / ${r.data.owner})`);
          break;
        }

        case 'set': {
          need(name, '<name>');
          const field = need(more[0], '<field>');
          const value = more.slice(1).join(' ');
          const r = await t(`/${encodeURIComponent(name)}`, { field, value }, 'PATCH');
          console.log(`${name}: ${field} = ${r.data[field] === null ? '(none)' : r.data[field]}`);
          break;
        }

        case 'plan': {
          need(name, '<name>');
          const text = need(more.join(' ') || f.text, '<text>');
          const r = await t(`/${encodeURIComponent(name)}/plan`, { items: String(text).split('\n') });
          for (const p of r.data.plan) console.log(`  ${p.done ? '[x]' : '[ ]'} ${p.idx}. ${p.text}`);
          break;
        }

        case 'check':
        case 'uncheck': {
          need(name, '<name>');
          const n = need(more[0], '<n>');
          const r = await t(`/${encodeURIComponent(name)}/plan/${n}/${sub}`, {});
          const item = r.data.plan.find((p) => String(p.idx) === String(n));
          console.log(`  ${item.done ? '[x]' : '[ ]'} ${item.idx}. ${item.text}`);
          break;
        }

        case 'log': {
          need(name, '<name>');
          need(f.who, '--who'); need(f.what, '--what');
          const body = { who: f.who, what: f.what };
          // Exactly one of the three, and the CLI does not pick for you — the choice is
          // the point. Sending none gets a 400 that says so.
          if (f.check !== undefined) body.check = Number(f.check);
          if (f.plan !== undefined) body.plan = f.plan;
          if (f['no-plan-change'] !== undefined) body.no_plan_change = true;
          const r = await t(`/${encodeURIComponent(name)}/log`, body);
          console.log(`${name}: logged (${r.data.log.length} lines)`);
          break;
        }

        case 'finish': {
          need(name, '<name>');
          const r = await t(`/${encodeURIComponent(name)}/finish`, { snapshot: need(f.snapshot, '--snapshot') });
          console.log(`${name} -> done`);
          // Reported, not enforced: finishing with items open is legitimate, and refusing
          // it would only produce ticks added to get past the door.
          if (r.open_plan_items) console.log(`  (${r.open_plan_items} plan item(s) still unticked)`);
          break;
        }

        case 'archive': {
          need(name, '<name>');
          const r = await t(`/${encodeURIComponent(name)}/archive`, f.undo ? { undo: true } : { why: f.why });
          console.log(`${name} ${r.data.archived ? 'archived' : 'restored'}`);
          break;
        }

        default:
          die(`unknown: thread ${sub}`);
      }
      break;
    }

    case 'status': {
      const s = await api('GET', '/api/agents/status');
      for (const [name, v] of Object.entries(s)) {
        const ctx = v.context ? ` ctx ${Math.round((v.context.tokens || 0) / 1000)}k/${Math.round(v.context.limit / 1000)}k` : '';
        const activity = v.detail && (v.detail.source === 'hook' || v.detail.source === 'screen')
          ? ` activity ${v.detail.source}` : '';
        console.log(`  ${name.padEnd(12)} ${String(v.transport).padEnd(9)} ${String(v.state).padEnd(10)}${ctx}${activity}`);
        if (v.rotateQueued) console.log('               rotation queued');
        if (v.rotationStatus === 'pending_confirmation') {
          const seconds = Math.floor((v.rotationWaitMs || 0) / 1000);
          console.log(`               rotation pending confirmation (waiting ${seconds}s)`);
        } else if (v.lastRotate) {
          const verdict = v.lastRotate.ok ? 'verified' : 'failed';
          const waited = Number.isFinite(v.lastRotate.waitedMs)
            ? ` (waited ${Math.floor(v.lastRotate.waitedMs / 1000)}s)` : '';
          console.log(`               last rotation ${verdict}: ${v.lastRotate.from || '-'} -> ${v.lastRotate.to || '-'}${waited}`);
        }
      }
      break;
    }

    default:
      console.log(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => die(e.message));
