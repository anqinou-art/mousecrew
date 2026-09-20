// routes/orders.js — the work-order API.
//
// Order of operations in the transition endpoint matters more than it looks: legality is
// checked before anything expensive runs. See order-state-machine.checkTransition.

const express = require('express');
const bus = require('../lib/event-bus');
const {
  STATES,
  isCancelClose,
  resumeTargetOf,
  canReachClosed,
  checkTransition,
  transition,
} = require('../lib/order-state-machine');
const {
  verifyCommitForRepo,
  makeDeploymentCheck,
  makeVerifyBudget,
} = require('../lib/commit-verify');
const { makeWakeFreshness, ownerOf } = require('../lib/wake-freshness');
const { createAuditFreeze } = require('../lib/audit-freeze');

const CLAIM_TARGETS = {
  draft: 'in_progress',
  assigned: 'in_progress',
  rejected: 'in_progress',
  submitted: 'auditing',
};

function createOrdersRouter({ store, identity, hub, workspace, notifier, requireToken, config }) {
  const router = express.Router();
  const takeBudget = makeVerifyBudget(config.verifyBudget || {});
  const verifyRepos = config.verifyRepos || {};
  const deployTrees = config.deployTrees || {};
  const auditFreeze = createAuditFreeze(store);

  router.use(requireToken);

  function createOrder(prefix, fields) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const n = (store.order.maxSeqForPrefix.get(prefix.length + 2, `${prefix}-%`).n || 0) + 1;
      const id = `${prefix}-${String(n).padStart(3, '0')}`;
      try {
        store.order.create.run({ id, ...fields });
        return store.order.getById.get(id);
      } catch (error) {
        if (!String(error.message).includes('UNIQUE constraint failed: work_orders.id')) throw error;
      }
    }
    return null;
  }

  function card({ order_id, title, from_status, to_status, actor, assignee, comment }) {
    const payload = { type: 'order_card', order_id, title, from_status, to_status, actor, assignee, comment: comment || null };
    bus.emit('group:post', {
      role: 'system', content: JSON.stringify(payload), sender: 'system',
      archiveType: 'order_card', extraMeta: { type: 'order_card' }, broadcast: payload,
    });
  }

  function sendNotice(order, recipient, text, title, actor, freshness) {
    if (!recipient) return;
    const recipientId = identity.normalizeAgentId(recipient);
    if (actor && identity.normalizeAgentId(actor) === recipientId) return;
    const mention = identity.displayNameOf(recipientId);
    const content = `@${mention} ${text}`;
    bus.emit('group:dispatch_mentions', {
      content, sender: 'system',
      ...(freshness ? { freshness } : {}),
    });
    bus.emit('group:post', { role: 'user', content, sender: 'system' });
    notifier.send(title, `${order.id} @${mention}: ${order.title}`).catch(() => {});
  }

  /**
   * Wake whoever now owes an action, on whichever transport they live.
   *
   * All three channels fire, and they do not overlap: the internal dispatch reaches
   * local/remote agents, the group message is what a terminal agent's sidecar picks up,
   * and the notification reaches the human. An agent is on exactly one of the first two.
   */
  function wake(order, recipient, text, title = 'new work', actor) {
    if (!recipient) return;
    const recipientId = identity.normalizeAgentId(recipient);
    sendNotice(
      order,
      recipientId,
      text,
      title,
      actor,
      // Carry the order id so the wake-up can be re-checked when it reaches the front of
      // the queue — by then the order may have moved on without it.
      makeWakeFreshness(store, order.id, {
        enqueuedStatus: order.status,
        recipient: recipientId,
        workspace,
      }),
    );
  }

  // A review state and its freeze flag are one fact: either both writes land or neither does.
  const moveOrder = store.db.transaction((orderId, toStatus, actor, comment, meta, delivery) => {
    const before = store.order.getById.get(orderId);
    const commitMeta = delivery ? backfill(before, delivery) : null;
    const timelineMeta = {
      ...(commitMeta ? commitMeta.timelineMeta : {}),
      ...(meta || {}),
    };
    const result = transition(
      store,
      orderId,
      toStatus,
      actor,
      comment,
      Object.keys(timelineMeta).length ? timelineMeta : undefined,
    );
    if (!result.ok) return result;

    const auditChange = auditFreeze.applyOnTransition(
      result.order,
      before.status,
      toStatus,
      actor,
    );
    for (const resumedId of result.autoResumed || []) {
      const resumed = store.order.getById.get(resumedId);
      auditFreeze.applyOnTransition(resumed, 'paused', resumed.status, 'system');
    }
    return {
      ...result,
      order: store.order.getById.get(orderId),
      auditChange,
      commitMeta,
    };
  });

  function claimFor(order, toStatus) {
    if (CLAIM_TARGETS[order.status] !== toStatus) return null;
    const role = order.status === 'submitted' ? 'merge gate' : 'assignee';
    const owner = role === 'merge gate'
      ? (!workspace.isSelfManaged(order.assignee) && workspace.mergeGate
        ? workspace.mergeGate.id
        : null)
      : order.assignee;
    return { owner, role };
  }

  function checkResumeTarget(order, toStatus) {
    if (order.status === 'paused' && toStatus !== 'closed') {
      const target = resumeTargetOf(order);
      if (toStatus !== target) {
        return {
          ok: false,
          error: `${order.id} was paused from ${target}; it cannot resume to ${toStatus}`,
        };
      }
    }
    return { ok: true };
  }

  function checkClaimOwner(order, toStatus, actor) {
    const claim = claimFor(order, toStatus);
    if (!claim) return { ok: true };
    if (!claim.owner) {
      return { ok: false, error: `${order.id} has no ${claim.role} to accept it` };
    }
    if (!actor || identity.normalizeAgentId(actor) !== identity.normalizeAgentId(claim.owner)) {
      return {
        ok: false,
        error: `only the ${claim.role} (${claim.owner}) may accept ${order.id}; actor is required`,
      };
    }
    return { ok: true, role: claim.role };
  }

  function wakeForTransition(before, after, toStatus, actor) {
    if (toStatus === 'assigned') {
      wake(after, after.assignee, `new work on ${after.id}: ${after.title}. Use \`mousecrew accept ${after.id}\` to take it.`, 'new work', actor);
      return;
    }
    if (toStatus === 'submitted') {
      wake(after, ownerOf(after, workspace), `${after.id} is ready for review. Use \`mousecrew accept ${after.id}\` to take it.`, 'review ready', actor);
      return;
    }
    if (toStatus === 'rejected') {
      wake(after, after.assignee, `${after.id} needs changes before it can pass review.`, 'changes requested', actor);
      return;
    }
    if (toStatus !== 'in_progress') return;

    const bySource = {
      draft: { title: 'new work', text: `new work on ${after.id}: ${after.title}.` },
      assigned: { title: 'work accepted', text: `${after.id} was accepted and is now in progress.` },
      rejected: { title: 'changes requested', text: `${after.id} was rejected and is ready for another pass.` },
      paused: { title: 'unblocked', text: `${after.id} is unblocked and back in progress.` },
      pending_restart: { title: 'returned to work', text: `${after.id} was returned for more work.` },
    };
    const notice = bySource[before.status] || {
      title: 'work resumed',
      text: `${after.id} moved from ${before.status} back to in progress.`,
    };
    wake(after, after.assignee, notice.text, notice.title, actor);
  }

  // ---------- read ----------

  router.get('/api/orders', (req, res) => {
    let rows = req.query.project_id
      ? store.order.getByProject.all(req.query.project_id)
      : store.order.all.all();
    if (req.query.assignee) rows = rows.filter((o) => o.assignee === req.query.assignee);
    if (req.query.status) rows = rows.filter((o) => o.status === req.query.status);
    res.json(rows);
  });

  router.get('/api/orders/:id', (req, res) => {
    const o = store.order.getById.get(req.params.id);
    if (!o) return res.status(404).json({ error: 'order not found' });
    res.json({
      ...o,
      timeline: o.timeline ? JSON.parse(o.timeline) : [],
      logs: store.log.byOrder.all(o.id),
      revisions: store.orderRevision.byOrder.all(o.id),
    });
  });

  router.get('/api/orders/meta/states', (req, res) => res.json({ states: STATES }));

  // ---------- create ----------

  router.post('/api/orders', (req, res) => {
    const { title, description, assignee, repo, project_id, actor } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });

    const projects = config.projects || [];
    const availableProjects = projects.map((project) => project.id);
    if (projects.length && !project_id) {
      return res.status(400).json({
        error: `project_id required; available projects: ${availableProjects.join(', ')}`,
        available_projects: availableProjects,
      });
    }
    const project = project_id
      ? projects.find((candidate) => candidate.id === project_id)
      : null;
    if (project_id && !project) {
      return res.status(404).json({
        error: `unknown project_id "${project_id}"; available projects: ${availableProjects.join(', ') || '(none)'}`,
        available_projects: availableProjects,
      });
    }

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

    const now = new Date().toISOString();
    const order = createOrder(project ? project.prefix : (config.orderPrefix || 'WO'), {
      project_id: project_id || null, title, description: description || null,
      status: 'draft', assignee: assignee || null, repo: repo || null,
      created_by: actor || 'unknown',
      timeline: JSON.stringify([{ status: 'draft', actor: actor || 'unknown', ts: now }]),
    });
    if (!order) {
      const prefix = project ? project.prefix : (config.orderPrefix || 'WO');
      return res.status(409).json({
        error: 'could not allocate an order id',
        detail: `prefix ${prefix} — 5 attempts all collided`,
      });
    }
    res.json(order);
  });

  // ---------- dispatch / accept ----------

  router.post('/api/orders/:id/dispatch', (req, res) => {
    const o = store.order.getById.get(req.params.id);
    if (!o) return res.status(404).json({ error: 'order not found' });
    if (!o.assignee) return res.status(400).json({ error: 'dispatch requires an assignee' });

    if (o.status === 'draft') {
      const moved = moveOrder(o.id, 'assigned', (req.body && req.body.actor) || 'system', 'dispatched');
      if (!moved.ok) return res.status(400).json({ error: moved.error });
      card({
        order_id: o.id, title: o.title, from_status: 'draft', to_status: 'assigned',
        actor: (req.body && req.body.actor) || 'system', assignee: moved.order.assignee,
        comment: 'dispatched',
      });
    } else if (o.status !== 'assigned') {
      return res.status(400).json({
        error: `${o.id} is ${o.status}; only draft can be dispatched and assigned can be re-dispatched`,
      });
    }

    const current = store.order.getById.get(o.id);
    wake(current, current.assignee, `new work on ${current.id}: ${current.title}. Use \`mousecrew accept ${current.id}\` to take it.`, 'new work', req.body && req.body.actor);
    res.json({ ok: true, order: current });
  });

  router.post('/api/orders/:id/accept', (req, res) => {
    const o = store.order.getById.get(req.params.id);
    if (!o) return res.status(404).json({ error: 'order not found' });
    const { actor } = req.body || {};
    const toStatus = CLAIM_TARGETS[o.status];
    if (!toStatus || o.status === 'draft') {
      return res.status(400).json({
        error: `accept is only valid for assigned, submitted, or rejected orders; ${o.id} is ${o.status}`,
      });
    }
    const claim = checkClaimOwner(o, toStatus, actor);
    if (!claim.ok) return res.status(400).json({ error: claim.error });

    const result = moveOrder(o.id, toStatus, actor, `${claim.role} accepted`);
    if (!result.ok) return res.status(400).json({ error: result.error });
    card({
      order_id: o.id, title: o.title, from_status: o.status, to_status: toStatus,
      actor, assignee: result.order.assignee, comment: `${claim.role} accepted`,
    });
    res.json({ ok: true, order: result.order, from: o.status, to: toStatus, ...result.auditChange });
  });

  // ---------- transition ----------

  router.post('/api/orders/:id/transition', (req, res) => {
    const { to_status, actor, comment, commit_hash, git_branch, cancelled, audit_revision } = req.body || {};
    const o = store.order.getById.get(req.params.id);
    if (!o) return res.status(404).json({ error: 'order not found' });
    if (!to_status) return res.status(400).json({ error: 'to_status required' });

    // Gate first. Everything below this line may cost real work.
    const gate = checkTransition(o.status, to_status);
    if (!gate.ok) return res.status(400).json({ error: gate.error });
    const resumeGate = checkResumeTarget(o, to_status);
    if (!resumeGate.ok) return res.status(400).json({ error: resumeGate.error });
    if (o.status === 'auditing' && to_status === 'in_progress') {
      return res.status(409).json({
        error: `${o.id} is in review; withdraw it with the unfreeze endpoint so actor, reason, and gate notification are enforced`,
      });
    }

    if (cancelled !== undefined && typeof cancelled !== 'boolean') {
      return res.status(400).json({ error: 'cancelled must be a boolean' });
    }
    if (cancelled === true && to_status !== 'closed') {
      return res.status(400).json({ error: 'cancelled can only be used with a transition to closed' });
    }
    const cancelMeta = cancelled === true ? { cancelled: true } : undefined;
    const isCancellation = isCancelClose(o.status, to_status, cancelMeta);
    if (isCancellation && !String(comment || '').trim()) {
      return res.status(400).json({ error: 'a cancellation or void requires a reason' });
    }

    if (commit_hash || git_branch) {
      const blocked = auditFreeze.freezeBlocks(o);
      if (blocked) return res.status(409).json(blocked);
    }

    const revisionGate = auditFreeze.checkRevision(o, to_status, cancelled, audit_revision);
    if (!revisionGate.ok) {
      return res.status(revisionGate.status).json({
        error: revisionGate.error,
        ...(revisionGate.audit_revision ? { audit_revision: revisionGate.audit_revision } : {}),
      });
    }

    // Only the single merge-gate agent may push an order past review.
    if (to_status === 'pending_restart' || (o.status === 'auditing' && to_status === 'closed')) {
      const verdict = workspace.canMerge(identity.normalizeAgentId(actor));
      if (!verdict.ok) return res.status(403).json({ error: verdict.reason });
    }
    if (isCancellation && o.status === 'paused' && resumeTargetOf(o) === 'auditing') {
      const verdict = workspace.canMerge(identity.normalizeAgentId(actor));
      if (!verdict.ok) return res.status(403).json({ error: verdict.reason });
    }

    // These two direct-close edges are the public single-person escape hatch. With a
    // merge gate configured, they would bypass the review lane and are therefore closed.
    if ((o.status === 'submitted' || o.status === 'rejected') && to_status === 'closed'
        && !workspace.isSelfManaged(o.assignee) && workspace.mergeGate) {
      return res.status(409).json({
        error: `${o.status} -> closed is only available to self-managed work or crews without a merge gate`,
      });
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
    // Same reasoning, other cause: with no merge gate configured nobody is allowed to take
    // an order out of review, so entering review is a one-way door — the only exit left is
    // `rejected`. Refusing at the entrance beats letting the order sit in a queue that has
    // no one who can clear it, which is exactly the argument three lines above.
    if (to_status === 'auditing' && !workspace.mergeGate) {
      return res.status(409).json({
        error: 'no agent has canMerge:true, so nothing can leave review — set a merge gate, '
             + 'or take this lane through accepted instead',
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

    const claim = checkClaimOwner(o, to_status, actor);
    if (!claim.ok) return res.status(400).json({ error: claim.error });

    const delivery = commit_hash || git_branch ? { commit_hash, git_branch } : null;
    const transitionComment = isCancellation
      ? `${o.status === 'auditing' || resumeTargetOf(o) === 'auditing' ? 'voided' : 'cancelled'}: ${String(comment).trim()}`
      : comment;

    const result = moveOrder(
      o.id,
      to_status,
      actor || 'unknown',
      transitionComment,
      isCancellation ? { cancelled: true } : undefined,
      delivery,
    );
    if (!result.ok) return res.status(400).json({ error: result.error });

    card({
      order_id: o.id, title: o.title, from_status: o.status, to_status,
      actor: actor || 'unknown', assignee: result.order.assignee, comment: transitionComment,
    });

    wakeForTransition(o, result.order, to_status, actor);
    for (const rid of result.autoResumed || []) {
      const ro = store.order.getById.get(rid);
      card({ order_id: rid, title: ro.title, from_status: 'paused', to_status: ro.status, actor: 'system', assignee: ro.assignee, comment: `auto-resume: ${o.id} closed` });
      wake(ro, ownerOf(ro, workspace), `${o.id} closed, so ${rid} (${ro.title}) is unblocked.`, 'unblocked');
    }
    for (const rid of result.blockedSkipped || []) {
      const ro = store.order.getById.get(rid);
      if (!ro) continue;
      const detail = `${o.id} was cancelled instead of completed: ${String(comment).trim()}. Review this dependency, then resume or cancel ${rid}.`;
      store.log.insert.run(rid, 'system', 'comment', detail);
      wake(ro, ownerOf(ro, workspace), detail, 'dependency cancelled');
    }
    if (to_status === 'pending_restart') {
      const n = store.order.getByStatus.all('pending_restart').length;
      notifier.send('waiting on a restart', `${n} order(s) merged and waiting for the next restart`).catch(() => {});
    }

    res.json({
      ...result.order,
      ...(result.autoResumed ? { autoResumed: result.autoResumed } : {}),
      ...(result.blockedSkipped ? { blockedSkipped: result.blockedSkipped } : {}),
      ...(result.commitMeta ? { commit_verify: result.commitMeta.report } : {}),
    });
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
      report = verifyCommitForRepo(claimed, o.repo, verifyRepos);
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
    if (blocked_by) {
      const blocker = store.order.getById.get(blocked_by);
      if (!blocker) {
        return res.status(400).json({ error: `blocked_by "${blocked_by}" is not an existing order` });
      }
      if (!canReachClosed(blocker.status)) {
        return res.status(400).json({
          error: `blocked_by "${blocked_by}" is ${blocker.status} and cannot reach closed again`,
        });
      }
    }
    const result = moveOrder(o.id, 'paused', actor || 'unknown', reason);
    if (!result.ok) return res.status(400).json({ error: result.error });
    store.order.setBlockFields.run(blocked_by || null, reason || null, o.id);
    card({ order_id: o.id, title: o.title, from_status: o.status, to_status: 'paused', actor, assignee: o.assignee, comment: reason });
    res.json(store.order.getById.get(o.id));
  });

  router.post('/api/orders/:id/resume', (req, res) => {
    const { actor } = req.body || {};
    const o = store.order.getById.get(req.params.id);
    if (!o) return res.status(404).json({ error: 'order not found' });
    if (o.status !== 'paused') {
      return res.status(400).json({ error: `${o.id} is ${o.status}; only paused orders can be resumed` });
    }
    const target = resumeTargetOf(o);
    const resumeGate = checkResumeTarget(o, target);
    if (!resumeGate.ok) return res.status(400).json({ error: resumeGate.error });
    const result = moveOrder(o.id, target, actor || 'unknown', 'resumed');
    if (!result.ok) return res.status(400).json({ error: result.error });
    store.order.setBlockFields.run(null, null, o.id);
    card({ order_id: o.id, title: o.title, from_status: o.status, to_status: target, actor, assignee: o.assignee });
    wake(result.order, ownerOf(result.order, workspace), `unblocked — back to ${target} on ${o.id} (${o.title}).`, 'unblocked', actor);
    res.json(store.order.getById.get(o.id));
  });

  router.post('/api/orders/:id/unfreeze', (req, res) => {
    const o = store.order.getById.get(req.params.id);
    if (!o) return res.status(404).json({ error: 'order not found' });
    const { actor, reason } = req.body || {};
    if (!actor) return res.status(400).json({ error: 'actor required' });
    if (!String(reason || '').trim()) return res.status(400).json({ error: 'unfreeze requires a reason' });
    if (o.status !== 'auditing') {
      return res.status(400).json({ error: `${o.id} is not in review` });
    }

    const who = identity.normalizeAgentId(actor);
    const allowed = new Set([
      identity.normalizeAgentId(o.assignee),
      workspace.mergeGate && workspace.mergeGate.id,
      identity.normalizeAgentId(o.created_by),
    ].filter(Boolean));
    if (!allowed.has(who)) {
      return res.status(403).json({ error: `${who} is not the assignee, merge gate, or order owner` });
    }

    const revision = o.audit_revision;
    const result = moveOrder(
      o.id,
      'in_progress',
      actor,
      `unfroze revision ${revision}: ${String(reason).trim()}`,
    );
    if (!result.ok) return res.status(400).json({ error: result.error });
    card({
      order_id: o.id, title: o.title, from_status: o.status, to_status: 'in_progress',
      actor, assignee: result.order.assignee, comment: `unfroze revision ${revision}`,
    });
    const gate = workspace.mergeGate && workspace.mergeGate.id;
    // This reports a fact, not an action still owed. Once a revision is invalidated the
    // notice never becomes stale, so attaching owner-based wake freshness would drop it.
    sendNotice(
      result.order,
      gate,
      revision > 0
        ? `${o.id} review revision ${revision} was invalidated: ${String(reason).trim()}`
        : `${o.id} review without a frozen revision was withdrawn: ${String(reason).trim()}`,
      'review invalidated',
      null,
      null,
    );
    res.json({ ok: true, order: result.order, unfrozen_revision: revision });
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
    const { actor, ids } = req.body || {};
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
    if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id.trim()))) {
      return res.status(400).json({ error: 'ids must be an array of non-empty order ids' });
    }

    const wanted = ids === undefined ? null : new Set(ids);
    const closed = [];
    const skipped = [];
    const unchecked = [];
    const noCommit = [];
    const checkDeployment = makeDeploymentCheck(deployTrees);
    for (const o of store.order.getByStatus.all('pending_restart')) {
      if (wanted && !wanted.has(o.id)) continue;

      const deployment = checkDeployment(o.commit_hash, o.repo);
      if (!deployment.ok) {
        skipped.push({ id: o.id, reason: deployment.reason });
        continue;
      }
      if (deployment.unchecked) unchecked.push(o.id);
      if (deployment.noCommit) noCommit.push(o.id);
      const r = moveOrder(o.id, 'closed', actor || 'system', 'closed after restart');
      if (r.ok) closed.push(o.id);
    }
    res.json({ ok: true, closed, skipped, unchecked, no_commit: noCommit });
  });

  // ---------- logs ----------

  router.post('/api/orders/:id/logs', (req, res) => {
    const { agent_name, action, detail } = req.body || {};
    if (!store.order.getById.get(req.params.id)) return res.status(404).json({ error: 'order not found' });
    store.log.insert.run(req.params.id, agent_name || 'unknown', action || 'comment', detail || '');
    res.json({ ok: true });
  });

  return { router, wake };
}

module.exports = { createOrdersRouter };
