// routes/orders.js — the work-order API.
//
// Order of operations in the transition endpoint matters more than it looks: legality is
// checked before anything expensive runs. See order-state-machine.checkTransition.

const express = require('express');
const bus = require('../lib/event-bus');
const { STATES, checkTransition, transition } = require('../lib/order-state-machine');
const { verifyCommit, makeVerifyBudget } = require('../lib/commit-verify');
const { makeWakeFreshness } = require('../lib/wake-freshness');

function createOrdersRouter({ store, identity, hub, workspace, notifier, requireToken, config }) {
  const router = express.Router();
  const takeBudget = makeVerifyBudget(config.verifyBudget || {});
  const verifyRepos = (config.verifyRepos || []).slice();

  router.use(requireToken);

  function nextId() {
    const n = store.order.nextSeq.get().n + 1;
    return `${config.orderPrefix || 'WO'}-${String(n).padStart(3, '0')}`;
  }

  function card({ order_id, title, from_status, to_status, actor, assignee, comment }) {
    const payload = { type: 'order_card', order_id, title, from_status, to_status, actor, assignee, comment: comment || null };
    bus.emit('group:post', {
      role: 'system', content: JSON.stringify(payload), sender: 'system',
      archiveType: 'order_card', extraMeta: { type: 'order_card' }, broadcast: payload,
    });
  }

  /**
   * Wake whoever now owes an action, on whichever transport they live.
   *
   * All three channels fire, and they do not overlap: the internal dispatch reaches
   * local/remote agents, the group message is what a terminal agent's sidecar picks up,
   * and the notification reaches the human. An agent is on exactly one of the first two.
   */
  function wakeAssignee(order, text) {
    if (!order.assignee) return;
    const mention = identity.displayNameOf(order.assignee);
    const content = `@${mention} ${text}`;
    // Carry the order id so the wake-up can be re-checked when it reaches the front of
    // the queue — by then the order may have moved on without it.
    bus.emit('group:dispatch_mentions', {
      content, sender: 'system',
      freshness: makeWakeFreshness(store, order.id, { enqueuedStatus: order.status }),
    });
    bus.emit('group:post', { role: 'user', content, sender: 'system' });
    notifier.send('new work', `${order.id} @${mention}: ${order.title}`).catch(() => {});
  }

  // ---------- read ----------

  router.get('/api/orders', (req, res) => {
    let rows = store.order.all.all();
    if (req.query.assignee) rows = rows.filter((o) => o.assignee === req.query.assignee);
    if (req.query.status) rows = rows.filter((o) => o.status === req.query.status);
    res.json(rows);
  });

  router.get('/api/orders/:id', (req, res) => {
    const o = store.order.getById.get(req.params.id);
    if (!o) return res.status(404).json({ error: 'order not found' });
    res.json({ ...o, timeline: o.timeline ? JSON.parse(o.timeline) : [], logs: store.log.byOrder.all(o.id) });
  });

  router.get('/api/orders/meta/states', (req, res) => res.json({ states: STATES }));

  // ---------- create ----------

  router.post('/api/orders', (req, res) => {
    const { title, description, assignee, repo, project_id, actor } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });

    // Ownership is checked at creation, not left to good manners. Assigning work to an
    // agent that does not own the repo is how changes end up in the wrong tree, and that
    // is measured in days to unwind, not minutes.
    if (assignee) {
      const verdict = workspace.canWork(assignee, repo);
      if (!verdict.ok) {
        return res.status(409).json({
          error: verdict.reason,
          owners: workspace.ownersOf(repo),
        });
      }
    }

    const id = nextId();
    const now = new Date().toISOString();
    store.order.create.run({
      id, project_id: project_id || null, title, description: description || null,
      status: 'draft', assignee: assignee || null, repo: repo || null,
      created_by: actor || 'unknown',
      timeline: JSON.stringify([{ status: 'draft', actor: actor || 'unknown', ts: now }]),
    });
    res.json(store.order.getById.get(id));
  });

  // ---------- transition ----------

  router.post('/api/orders/:id/transition', (req, res) => {
    const { to_status, actor, comment, commit_hash, git_branch } = req.body || {};
    const o = store.order.getById.get(req.params.id);
    if (!o) return res.status(404).json({ error: 'order not found' });
    if (!to_status) return res.status(400).json({ error: 'to_status required' });

    // Gate first. Everything below this line may cost real work.
    const gate = checkTransition(o.status, to_status);
    if (!gate.ok) return res.status(400).json({ error: gate.error });

    // Only the single merge-gate agent may push an order past review.
    if (to_status === 'pending_restart' || (o.status === 'auditing' && to_status === 'closed')) {
      const verdict = workspace.canMerge(identity.normalizeAgentId(actor));
      if (!verdict.ok) return res.status(403).json({ error: verdict.reason });
    }

    // The two lanes are mutually exclusive, and BOTH directions have to be closed.
    //
    // Guarding only one of them is how a gate ends up manned at the front door with the
    // side door open: block "self-managed work must not enter review" and you still leave
    // `submitted -> accepted -> closed`, which reaches a terminal state with no review in
    // its timeline at all. The merge-gate check above never fires, because that path
    // never touches `auditing` or `pending_restart`.
    if (to_status === 'auditing' && workspace.isSelfManaged(o.assignee)) {
      return res.status(409).json({
        error: `"${o.assignee}" is self-managed: this order ends at submitted and is accepted by a person, not the audit lane`,
      });
    }
    if (to_status === 'accepted' && !workspace.isSelfManaged(o.assignee) && workspace.mergeGate) {
      // The escape hatch is deliberate: with no merge gate configured there is nothing to
      // bypass, and a solo setup would otherwise have no way to finish an order at all.
      return res.status(409).json({
        error: `"${o.assignee || 'unassigned'}" is not a self-managed lane: this order goes through review `
             + `(submitted -> auditing), not straight to accepted. Cancel it with -> closed if it should not ship.`,
      });
    }

    let meta;
    if (commit_hash || git_branch) meta = backfill(o, { commit_hash, git_branch });

    const result = transition(store, o.id, to_status, actor || 'unknown', comment, meta && meta.timelineMeta);
    if (!result.ok) return res.status(400).json({ error: result.error });

    card({
      order_id: o.id, title: o.title, from_status: o.status, to_status,
      actor: actor || 'unknown', assignee: result.order.assignee, comment,
    });

    if (to_status === 'in_progress' && !result.autoResumed) {
      wakeAssignee(result.order, `new work on ${o.id}: ${o.title}. Take a look when you can.`);
    }
    for (const rid of result.autoResumed || []) {
      const ro = store.order.getById.get(rid);
      card({ order_id: rid, title: ro.title, from_status: 'paused', to_status: 'in_progress', actor: 'system', assignee: ro.assignee, comment: `auto-resume: ${o.id} closed` });
      wakeAssignee(ro, `${o.id} shipped, so ${rid} (${ro.title}) is unblocked.`);
    }
    if (to_status === 'pending_restart') {
      const n = store.order.getByStatus.all('pending_restart').length;
      notifier.send('waiting on a restart', `${n} order(s) merged and waiting for the next restart`).catch(() => {});
    }

    res.json({ ...result.order, ...(meta ? { commit_verify: meta.report } : {}) });
  });

  /**
   * Structured backfill. Claims are stored as claims; the file list is derived or null.
   * Verification failing never blocks the transition — it records that it could not be
   * verified, which is a different and more useful thing than pretending it was.
   */
  function backfill(o, { commit_hash, git_branch }) {
    const claimed = commit_hash ? String(commit_hash).trim() : '';
    const branch = git_branch ? String(git_branch).trim() : '';

    if (!claimed) {
      if (branch) store.order.setBranch.run(branch, o.id);
      return { timelineMeta: { git_branch: branch || undefined }, report: null };
    }

    let report;
    if (!takeBudget()) {
      report = { verified: false, reason: 'verify-rate-limited' };
    } else {
      const repos = verifyRepos.length ? verifyRepos : (o.repo ? [] : []);
      report = repos.length ? verifyCommit(claimed, repos) : { verified: false, reason: 'no-repos-configured' };
    }

    // Rule: a newly reported commit takes its file list with it. If we cannot derive one,
    // the column goes null rather than keeping a list that belonged to an older commit —
    // a stale list paired with a fresh sha is a confident lie.
    store.order.setCommitFields.run(
      report.verified ? report.commit : claimed,
      branch || o.git_branch || null,
      report.verified ? JSON.stringify(report.files) : null,
      o.id,
    );

    return {
      report,
      timelineMeta: {
        commit: report.verified ? report.commit : claimed,
        git_branch: branch || undefined,
        files_verified: !!report.verified,
        ...(report.verified ? { files_count: report.files.length } : { verify_reason: report.reason }),
      },
    };
  }

  // ---------- pause / resume ----------

  router.post('/api/orders/:id/pause', (req, res) => {
    const { actor, blocked_by, reason } = req.body || {};
    const o = store.order.getById.get(req.params.id);
    if (!o) return res.status(404).json({ error: 'order not found' });

    // Refuse to block on an order that does not exist. Without this the order pauses
    // successfully, is never chased (paused work is deliberately not nagged), and dies
    // quietly waiting for something that was never coming.
    if (blocked_by && !store.order.getById.get(blocked_by)) {
      return res.status(400).json({ error: `blocked_by "${blocked_by}" is not an existing order` });
    }
    const result = transition(store, o.id, 'paused', actor || 'unknown', reason);
    if (!result.ok) return res.status(400).json({ error: result.error });
    store.order.setBlockFields.run(blocked_by || null, reason || null, o.id);
    card({ order_id: o.id, title: o.title, from_status: o.status, to_status: 'paused', actor, assignee: o.assignee, comment: reason });
    res.json(store.order.getById.get(o.id));
  });

  router.post('/api/orders/:id/resume', (req, res) => {
    const { actor } = req.body || {};
    const o = store.order.getById.get(req.params.id);
    if (!o) return res.status(404).json({ error: 'order not found' });
    const result = transition(store, o.id, 'in_progress', actor || 'unknown', 'resumed');
    if (!result.ok) return res.status(400).json({ error: result.error });
    store.order.setBlockFields.run(null, null, o.id);
    // from_status comes from the row, not from an assumption. Resume is reachable from
    // more than one state, and a card that says "paused" for an order that was rejected
    // puts a false history in front of a human while the timeline says something else.
    card({ order_id: o.id, title: o.title, from_status: o.status, to_status: 'in_progress', actor, assignee: o.assignee });
    wakeAssignee(result.order, `unblocked — back to ${o.id} (${o.title}).`);
    res.json(store.order.getById.get(o.id));
  });

  // ---------- assignment ----------

  const TERMINAL = new Set(['closed', 'accepted']);

  router.post('/api/orders/:id/assign', (req, res) => {
    const { assignee, actor } = req.body || {};
    const o = store.order.getById.get(req.params.id);
    if (!o) return res.status(404).json({ error: 'order not found' });
    // Reassigning finished work rewrites who did it. The row would say one thing and the
    // timeline another, and the timeline is the part nobody re-reads.
    if (TERMINAL.has(o.status)) {
      return res.status(409).json({ error: `${o.id} is ${o.status}; reassigning finished work would rewrite who did it` });
    }
    const verdict = workspace.canWork(assignee, o.repo);
    if (!verdict.ok) return res.status(409).json({ error: verdict.reason, owners: workspace.ownersOf(o.repo) });
    store.order.setAssignee.run(assignee, o.id);
    store.log.insert.run(o.id, actor || 'unknown', 'assign', assignee);
    res.json(store.order.getById.get(o.id));
  });

  // ---------- bulk close after a restart ----------

  router.post('/api/orders/restart-done', (req, res) => {
    const { actor } = req.body || {};
    // Closing the restart queue asserts "the restart happened". Restarting is a human
    // act, so a human (any actor not on the roster) may say so, and the merge gate may
    // say so — but a working agent must not be able to wipe the queue that tracks whether
    // its own merged work is live yet. The damage is not a bad merge; it is the record of
    // what is still waiting quietly disappearing.
    const actorId = identity.normalizeAgentId(actor);
    const isAgent = !!workspace.get(actorId);
    if (isAgent && !workspace.canMerge(actorId).ok) {
      return res.status(403).json({
        error: `"${actorId}" may not close the restart queue — that is for whoever performed the restart`,
      });
    }
    const closed = [];
    for (const o of store.order.getByStatus.all('pending_restart')) {
      const r = transition(store, o.id, 'closed', actor || 'system', 'closed after restart');
      if (r.ok) closed.push(o.id);
    }
    res.json({ ok: true, closed });
  });

  // ---------- logs ----------

  router.post('/api/orders/:id/logs', (req, res) => {
    const { agent_name, action, detail } = req.body || {};
    if (!store.order.getById.get(req.params.id)) return res.status(404).json({ error: 'order not found' });
    store.log.insert.run(req.params.id, agent_name || 'unknown', action || 'comment', detail || '');
    res.json({ ok: true });
  });

  return { router, wakeAssignee };
}

module.exports = { createOrdersRouter };
