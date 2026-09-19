// order-state-machine.js — ten states, one table, no side doors.
//
// The table is the whole specification. If a transition is not listed, it is refused;
// there is no "well, this one time" path anywhere in this file.

const STATES = [
  'draft',
  'assigned',
  'in_progress',
  'submitted',
  'auditing',
  'pending_restart',
  'paused',
  'accepted',
  'rejected',
  'closed',
];

// `docActors` is advisory metadata, not authorization: transition() records who asked but
// does not reject on it. Real authorization lives in workspace.js (who owns which repo,
// who may merge), because that is the check whose absence actually costs you a day.
const TRANSITIONS = {
  draft: {
    assigned: { docActors: ['owner', 'system'] },
    in_progress: { docActors: ['assignee'] },
    // This edge also closes completed decisions. Callers must say `cancelled` when they
    // mean cancellation, because the edge itself cannot distinguish those two meanings.
    closed: { docActors: ['owner', 'system'], cancel: true, cancelIntent: true },
  },
  assigned: {
    in_progress: { docActors: ['assignee'] },
    paused: { docActors: ['assignee', 'owner'] },
    closed: { docActors: ['owner'], cancel: true },
  },
  in_progress: {
    submitted: { docActors: ['assignee'] },
    paused: { docActors: ['assignee', 'owner'] },
    draft: { docActors: ['owner'] },
    closed: { docActors: ['owner'], cancel: true },
  },
  submitted: {
    auditing: { docActors: ['merge-gate'] },
    accepted: { docActors: ['owner'] },
    rejected: { docActors: ['merge-gate', 'owner'] },
    // Kept for self-managed and single-person crews; the HTTP route guards that scope.
    closed: { docActors: ['owner'] },
  },
  auditing: {
    pending_restart: { docActors: ['merge-gate'] },
    // Normally this is a successful no-restart close. `cancelled` makes it a void instead.
    closed: { docActors: ['merge-gate', 'owner'], cancelIntent: true },
    rejected: { docActors: ['merge-gate', 'owner'] },
    in_progress: { docActors: ['assignee', 'merge-gate', 'owner'] },
    paused: { docActors: ['merge-gate', 'owner'] },
  },
  pending_restart: {
    closed: { docActors: ['system', 'owner'] },
    in_progress: { docActors: ['owner'] },
  },
  paused: {
    in_progress: { docActors: ['assignee', 'owner'] },
    assigned: { docActors: ['assignee', 'owner', 'system'] },
    auditing: { docActors: ['merge-gate', 'owner', 'system'] },
    closed: { docActors: ['owner'], cancel: true },
  },
  accepted: {
    closed: { docActors: ['owner', 'system'] },
  },
  rejected: {
    in_progress: { docActors: ['assignee'] },
    draft: { docActors: ['owner'] },
    // Kept for self-managed and single-person crews; the HTTP route guards that scope.
    closed: { docActors: ['owner'] },
  },
  closed: {},
};

// Cancellation edges are marked in the table. Deriving the set below keeps the transition
// table as the only place that decides which source states require a cancellation reason.

/**
 * Is this edge legal? Pure, and separate from transition() on purpose.
 *
 * Callers check this *before* doing anything expensive. The order endpoint runs git
 * subprocesses to verify commits; running them first and validating second means any
 * request with a real order id can make the server fork processes — on a single-threaded
 * runtime that is the whole service, not just that request. Close the door, then work.
 */
function checkTransition(fromStatus, toStatus) {
  const allowed = TRANSITIONS[fromStatus];
  if (!allowed) return { ok: false, error: `unknown source status: ${fromStatus}` };
  if (!allowed[toStatus]) return { ok: false, error: `transition ${fromStatus} -> ${toStatus} not allowed` };
  return { ok: true };
}

function appendTimeline(o, fromStatus, toStatus, actor, comment, meta) {
  const timeline = o.timeline ? JSON.parse(o.timeline) : [];
  timeline.push({
    from: fromStatus,
    status: toStatus,
    actor,
    ts: new Date().toISOString(),
    ...(comment ? { comment } : {}),
    ...(meta || {}),
  });
  return timeline;
}

function cancelEdgesFrom(transitions = TRANSITIONS) {
  const out = new Set();
  for (const [from, targets] of Object.entries(transitions)) {
    if (targets && targets.closed && targets.closed.cancel) out.add(from);
  }
  return out;
}

function cancelIntentEdgesFrom(transitions = TRANSITIONS) {
  const out = new Set();
  for (const [from, targets] of Object.entries(transitions)) {
    if (targets && targets.closed && targets.closed.cancelIntent) out.add(from);
  }
  return out;
}

function isCancelClose(fromStatus, toStatus, meta, transitions = TRANSITIONS) {
  if (toStatus !== 'closed') return false;
  if (meta && meta.cancelled) return true;
  return cancelEdgesFrom(transitions).has(fromStatus)
    && !cancelIntentEdgesFrom(transitions).has(fromStatus);
}

function resumeTargetOf(order) {
  let timeline;
  try { timeline = JSON.parse((order && order.timeline) || '[]'); } catch { return 'in_progress'; }
  if (!Array.isArray(timeline)) return 'in_progress';
  for (let i = timeline.length - 1; i >= 0; i--) {
    const entry = timeline[i];
    if (entry && entry.status === 'paused') {
      return entry.from && TRANSITIONS.paused[entry.from] ? entry.from : 'in_progress';
    }
  }
  return 'in_progress';
}

/**
 * Move an order. Validates, writes, appends one timeline entry, and — on close —
 * releases whatever was waiting on it.
 *
 * @param {object} store db handle from src/db.js
 * @param {object} [meta] structured fields merged into this timeline entry. Must agree
 *   with what was written to the columns: a row saying "verified" next to a timeline
 *   saying "could not verify" is worse than having neither.
 * @returns {{ok:boolean, order?:object, error?:string, autoResumed?:string[]}}
 */
function transition(store, orderId, toStatus, actor, comment, meta) {
  const o = store.order.getById.get(orderId);
  if (!o) return { ok: false, error: 'order not found' };

  const fromStatus = o.status;
  const gate = checkTransition(fromStatus, toStatus);
  if (!gate.ok) return gate;

  const timeline = appendTimeline(o, fromStatus, toStatus, actor, comment, meta);
  store.db.prepare("UPDATE work_orders SET status = ?, timeline = ?, updated_at = datetime('now') WHERE id = ?")
    .run(toStatus, JSON.stringify(timeline), orderId);

  // Completed blockers release their waiters. Cancelled blockers do not: their dependency
  // disappeared rather than shipping, so waking the waiters would tell them to use work
  // that will never exist. Return those ids so the caller can make that visible.
  const cancelled = isCancelClose(fromStatus, toStatus, meta);
  const autoResumed = [];
  const blockedSkipped = [];
  if (toStatus === 'closed' && cancelled) {
    for (const bo of store.order.getBlockedBy.all(orderId)) blockedSkipped.push(bo.id);
  }
  if (toStatus === 'closed' && !cancelled) {
    for (const bo of store.order.getBlockedBy.all(orderId)) {
      const target = resumeTargetOf(bo);
      const bt = appendTimeline(bo, 'paused', target, 'system', `auto-resume: ${orderId} closed`);
      store.db.prepare("UPDATE work_orders SET status = ?, blocked_by = NULL, pause_reason = NULL, timeline = ?, updated_at = datetime('now') WHERE id = ?")
        .run(target, JSON.stringify(bt), bo.id);
      autoResumed.push(bo.id);
    }
  }

  return {
    ok: true,
    order: store.order.getById.get(orderId),
    ...(autoResumed.length ? { autoResumed } : {}),
    ...(blockedSkipped.length ? { blockedSkipped } : {}),
  };
}

function canReachClosed(status) {
  if (!status || !(status in TRANSITIONS)) return false;
  const seen = new Set([status]);
  const queue = [status];
  while (queue.length) {
    const current = queue.shift();
    for (const next of Object.keys(TRANSITIONS[current] || {})) {
      if (next === 'closed') return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

module.exports = {
  STATES,
  TRANSITIONS,
  cancelEdgesFrom,
  cancelIntentEdgesFrom,
  isCancelClose,
  resumeTargetOf,
  canReachClosed,
  checkTransition,
  transition,
};
