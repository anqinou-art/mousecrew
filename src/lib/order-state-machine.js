// order-state-machine.js — nine states, one table, no side doors.
//
// The table is the whole specification. If a transition is not listed, it is refused;
// there is no "well, this one time" path anywhere in this file.

const STATES = [
  'draft',
  'in_progress',
  'submitted',
  'auditing',
  'pending_restart',
  'paused',
  'accepted',
  'rejected',
  'closed',
];

// `actors` is advisory metadata, not authorization: transition() records who asked but
// does not reject on it. Real authorization lives in workspace.js (who owns which repo,
// who may merge), because that is the check whose absence actually costs you a day.
const TRANSITIONS = {
  draft: {
    in_progress: { actors: ['*'] },
  },
  in_progress: {
    submitted: { actors: ['assignee'] },
    paused: { actors: ['*'] },
    draft: { actors: ['*'] },
    closed: { actors: ['human'] },          // cancel lane — see note below
  },
  submitted: {
    auditing: { actors: ['merge-gate', 'system'] },
    accepted: { actors: ['human'] },        // self-managed lane: a person accepts it
    rejected: { actors: ['merge-gate', 'human'] },
    closed: { actors: ['human'] },
  },
  auditing: {
    pending_restart: { actors: ['merge-gate'] },   // reviewed and merged, needs a restart to take effect
    closed: { actors: ['merge-gate', 'human'] },   // reviewed and merged, nothing to restart
    rejected: { actors: ['merge-gate', 'human'] },
  },
  pending_restart: {
    closed: { actors: ['system', 'human'] },
    in_progress: { actors: ['human'] },
  },
  paused: {
    in_progress: { actors: ['*'] },
    closed: { actors: ['human'] },
  },
  accepted: {
    closed: { actors: ['*'] },
  },
  rejected: {
    in_progress: { actors: ['*'] },
    draft: { actors: ['*'] },
    closed: { actors: ['human'] },
  },
  closed: {},
};

// Note on the cancel lane: every active state has a direct edge to `closed`. The system
// this came from lacked it, so killing a dead order meant routing it through `accepted`,
// which stamped "verified and delivered" on work nobody did. A state machine that forces
// you to lie is a state machine people route around.

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

  // Unblock: anything paused *because of this order* goes back to work the moment it closes.
  // This is the whole scheduling mechanism for "B can't start until A ships" — nobody has
  // to remember, and nobody gets nagged while they wait.
  const autoResumed = [];
  if (toStatus === 'closed') {
    for (const bo of store.order.getBlockedBy.all(orderId)) {
      const bt = appendTimeline(bo, 'paused', 'in_progress', 'system', `auto-resume: ${orderId} closed`);
      store.db.prepare("UPDATE work_orders SET status = 'in_progress', blocked_by = NULL, timeline = ?, updated_at = datetime('now') WHERE id = ?")
        .run(JSON.stringify(bt), bo.id);
      autoResumed.push(bo.id);
    }
  }

  return {
    ok: true,
    order: store.order.getById.get(orderId),
    ...(autoResumed.length ? { autoResumed } : {}),
  };
}

module.exports = { STATES, TRANSITIONS, checkTransition, transition };
