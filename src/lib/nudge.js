// nudge.js — chase whoever currently owes an action. Nobody else.
//
// The rule that matters: an order sitting in `submitted` is NOT the assignee's problem
// any more — they delivered, the ball is with the reviewer. Nagging them there is
// pestering somebody for finishing their work, which is exactly the complaint that
// produced this mapping in the first place.

const bus = require('./event-bus');

/**
 * @param {object} deps { store, identity, notifier, config, workspace }
 * @returns {{ start: Function, stop: Function, scanOnce: Function }}
 */
function createNudger({ store, identity, notifier, config, workspace }) {
  const cfg = config.nudge || {};
  const idleMs = cfg.idleMs || 10 * 60 * 1000;
  const dedupMs = cfg.dedupMs || 30 * 60 * 1000;
  const scanMs = cfg.scanMs || 5 * 60 * 1000;
  const lastNudged = new Map();     // orderId -> ts (in memory; a restart forgives everyone)
  let timer = null;
  let lastPendingReport = 0;

  // Who owes an action in each state. States not listed are never chased — that is the
  // point, not an omission. `paused` in particular must stay silent: it is waiting on
  // another order by design.
  const OWES = {
    in_progress: (o) => o.assignee,
    auditing: () => (workspace.mergeGate ? workspace.mergeGate.id : null),
  };

  function scanOnce(now = Date.now()) {
    const sent = [];
    for (const status of Object.keys(OWES)) {
      for (const o of store.order.getByStatus.all(status)) {
        const who = OWES[status](o);
        if (!who) continue;
        const raw = o.updated_at || o.created_at;
        if (!raw) continue;
        const updated = new Date(String(raw).replace(' ', 'T') + (String(raw).endsWith('Z') ? '' : 'Z')).getTime();
        if (!Number.isFinite(updated) || now - updated < idleMs) continue;
        if (now - (lastNudged.get(o.id) || 0) < dedupMs) continue;
        lastNudged.set(o.id, now);

        const mins = Math.round((now - updated) / 60000);
        const verb = status === 'auditing'
          ? 'still reviewing? say so if it is stuck'
          : 'still on this? pause it or say so if it is stuck';
        const content = `@${identity.displayNameOf(who)} ${o.id} "${o.title}" has been ${status} for ${mins}min — ${verb}.`;

        // Posted as a real group message rather than only dispatched: a nudge nobody can
        // read is a nudge that did not happen, and terminal agents only ever see the
        // group stream.
        bus.emit('group:post', { role: 'user', content, sender: 'system' });
        bus.emit('group:dispatch_mentions', { content, sender: 'system' });
        sent.push({ order: o.id, who, mins });
      }
    }

    const pending = store.order.getByStatus.all('pending_restart');
    if (pending.length && now - lastPendingReport > 60 * 60 * 1000) {
      lastPendingReport = now;
      notifier.send('waiting on a restart', `${pending.length} merged order(s) need a restart: ${pending.map((o) => o.id).join(', ')}`).catch(() => {});
    }
    return sent;
  }

  return {
    scanOnce,
    start() {
      if (!cfg.enabled || timer) return;
      timer = setInterval(() => {
        // One bad scan must never take the timer down with it.
        try { scanOnce(); } catch (e) { console.error('[nudge] scan failed:', e.message); }
      }, scanMs);
      if (timer.unref) timer.unref();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}

module.exports = { createNudger };
