// wake-freshness.js — a wake-up can go stale while it waits in line.
//
// The shape: an order moves to in_progress, the system queues "you have work"; the agent
// is mid-turn, so the message waits a minute; meanwhile the order is submitted and
// rejected and reopened. The agent finally reads a notice about a state that ended four
// seconds after it was written, and answers an echo. That is a whole wasted turn.
//
// So the check runs at *dequeue* time, not enqueue time — at enqueue the state is by
// definition still fresh, which is exactly why checking there finds nothing.

// Statuses where the work item genuinely needs nobody right now.
// `rejected` and `draft` are deliberately NOT here: rejected means someone has to redo it,
// draft means someone has to pick it up. `in_progress` is the state we are waking *for*.
const SETTLED = new Set(['submitted', 'auditing', 'pending_restart', 'closed', 'accepted', 'paused']);

/**
 * Build a freshness predicate for one queued wake-up.
 * @returns {() => {skip:boolean, reason?:string}}
 *
 * Failure direction is fail-open, and that is not an oversight: waking someone twice is
 * mildly annoying, while dropping a real assignment means work sits untouched and nobody
 * knows. Anything unexpected — missing order, thrown query, unrecognised status — delivers.
 * (Note this is the opposite of require-token.js, which fails closed. Don't copy one into
 * the other; they are protecting different things.)
 */
function makeWakeFreshness(store, orderId, { enqueuedStatus } = {}) {
  return function freshness() {
    try {
      const o = store.order.getById.get(orderId);
      if (!o) return { skip: false };
      if (SETTLED.has(o.status)) {
        return {
          skip: true,
          reason: `order ${orderId} was ${enqueuedStatus || '?'} when queued, is ${o.status} now`,
        };
      }
      return { skip: false };
    } catch (e) {
      return { skip: false, error: e.message };
    }
  };
}

module.exports = { makeWakeFreshness, SETTLED };
