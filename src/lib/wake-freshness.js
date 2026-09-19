// wake-freshness.js — a wake-up can go stale while it waits in line.
//
// The shape: an order moves to in_progress, the system queues "you have work"; the agent
// is mid-turn, so the message waits a minute; meanwhile the order is submitted and
// rejected and reopened. The agent finally reads a notice about a state that ended four
// seconds after it was written, and answers an echo. That is a whole wasted turn.
//
// So the check runs at *dequeue* time, not enqueue time — at enqueue the state is by
// definition still fresh, which is exactly why checking there finds nothing.

const { resumeTargetOf } = require('./order-state-machine');

/**
 * Who owes the action represented by a work-order wake-up right now.
 *
 * This deliberately stays narrower than the nudge scheduler: it answers whether a queued
 * message still belongs to its recipient. A paused order only reaches this function when
 * a specific dependency notice was queued, so its recipient follows the state it would
 * resume to rather than treating every paused order as generally actionable.
 */
function ownerOf(order, workspace) {
  if (!order || !workspace) return undefined;
  const status = order.status === 'paused' ? resumeTargetOf(order) : order.status;
  if (status === 'assigned' || status === 'in_progress' || status === 'rejected') {
    return order.assignee || null;
  }
  if (status === 'submitted' || status === 'auditing') {
    if (workspace.isSelfManaged(order.assignee)) return null;
    return workspace.mergeGate ? workspace.mergeGate.id : null;
  }
  if (status === 'draft' || status === 'pending_restart' || status === 'closed' || status === 'accepted') {
    return null;
  }
  return undefined;
}

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
function makeWakeFreshness(store, orderId, { enqueuedStatus, recipient, workspace }) {
  return function freshness() {
    try {
      const o = store.order.getById.get(orderId);
      if (!o) return { skip: false };

      if (o.status !== enqueuedStatus) {
        return {
          skip: true,
          reason: `order ${orderId} was ${enqueuedStatus} when queued, is ${o.status} now`,
        };
      }
      const currentOwner = ownerOf(o, workspace);
      if (currentOwner === undefined) return { skip: false };
      if (currentOwner !== recipient) {
        return {
          skip: true,
          reason: currentOwner
            ? `order ${orderId} is now owned by ${currentOwner}, not ${recipient}`
            : `order ${orderId} no longer owes an action to ${recipient}`,
        };
      }
      return { skip: false };
    } catch (e) {
      return { skip: false, error: e.message };
    }
  };
}

module.exports = { makeWakeFreshness, ownerOf };
