// nudge.js — remind whoever currently owes an action, without inventing a second owner map.

const bus = require('./event-bus');
const { makeWakeFreshness, ownerOf } = require('./wake-freshness');

const NUDGE_STATES = {
  assigned: 'claimIdleMs',
  submitted: 'claimIdleMs',
  rejected: 'claimIdleMs',
  in_progress: 'progressIdleMs',
  auditing: 'progressIdleMs',
};

const NEXT_STEP = {
  assigned: (id) => `Accept it with mousecrew accept ${id}, or update the order if it cannot start`,
  submitted: (id) => `Accept the review with mousecrew accept ${id}`,
  rejected: (id) => `Accept the rework with mousecrew accept ${id}`,
  in_progress: () => 'Post an update, or pause it if it is blocked',
  auditing: () => 'Finish the review, or pause it if it is blocked',
};

function tsOf(raw) {
  if (!raw) return NaN;
  const value = String(raw);
  const iso = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(value)
    ? value
    : value.replace(' ', 'T') + 'Z';
  return new Date(iso).getTime();
}

/** The latest real state transition or note written by the person who owes the action. */
function lastMovedAt(order, owner, logsOf, normalizeAgentId = (id) => id) {
  let latest = NaN;
  try {
    const timeline = typeof order.timeline === 'string'
      ? JSON.parse(order.timeline || '[]')
      : (order.timeline || []);
    for (const entry of Array.isArray(timeline) ? timeline : []) {
      // Timeline notes deliberately omit status. They describe the scheduler, not work moving.
      if (!entry || !entry.status) continue;
      const at = tsOf(entry.ts || entry.at);
      if (Number.isFinite(at) && (!Number.isFinite(latest) || at > latest)) latest = at;
    }
  } catch { /* fall through to logs and the row timestamp */ }

  if (owner && typeof logsOf === 'function') {
    try {
      const wanted = normalizeAgentId(owner);
      for (const row of logsOf(order.id) || []) {
        if (!row || normalizeAgentId(row.agent_name) !== wanted) continue;
        const at = tsOf(row.ts || row.created_at);
        if (Number.isFinite(at) && (!Number.isFinite(latest) || at > latest)) latest = at;
      }
    } catch (error) {
      console.error(`[nudge] could not read logs for ${order.id}: ${error.message}`);
    }
  }

  return Number.isFinite(latest) ? latest : tsOf(order.updated_at || order.created_at);
}

function watchOf(orders, owner, logsOf, normalizeAgentId) {
  return new Map(orders.map((order) => [
    order.id,
    String(lastMovedAt(order, owner, logsOf, normalizeAgentId)),
  ]));
}

function movedSince(watched, orders, owner, logsOf, normalizeAgentId) {
  if (!watched) return false;
  const current = watchOf(orders, owner, logsOf, normalizeAgentId);
  for (const [id, at] of watched) {
    if (!current.has(id) || current.get(id) !== at) return true;
  }
  return false;
}

function backoffIntervalMs(strikes, { baseIntervalMs, backoffCapMs, backoffAfter }) {
  const steps = Math.max(0, strikes - (backoffAfter - 1));
  return Math.min(baseIntervalMs * Math.pow(2, steps), backoffCapMs);
}

function createNudgePacer({ baseIntervalMs, backoffCapMs, backoffAfter }, state = new Map()) {
  const pacing = { baseIntervalMs, backoffCapMs, backoffAfter };
  return {
    _state: state,
    evaluate(owner, orders, now, logsOf, normalizeAgentId) {
      const current = state.get(owner) || {
        strikes: 0, lastNudgeAt: 0, watched: null, pending: false,
      };
      const previousInterval = backoffIntervalMs(current.strikes, pacing);
      let recovered = false;

      if (current.watched && movedSince(current.watched, orders, owner, logsOf, normalizeAgentId)) {
        recovered = current.strikes > 0;
        current.strikes = 0;
        current.watched = null;
        current.pending = false;
      } else if (current.pending && now - current.lastNudgeAt >= baseIntervalMs) {
        current.strikes += 1;
        current.pending = false; // each sent reminder is settled once, independent of scan rate
      }

      const intervalMs = backoffIntervalMs(current.strikes, pacing);
      state.set(owner, current);
      return {
        nudge: now - current.lastNudgeAt >= intervalMs,
        strikes: current.strikes,
        intervalMs,
        escalatedTo: intervalMs > previousInterval ? intervalMs : null,
        recovered,
      };
    },
    record(owner, orders, now, logsOf, normalizeAgentId) {
      const current = state.get(owner) || {
        strikes: 0, lastNudgeAt: 0, watched: null, pending: false,
      };
      current.lastNudgeAt = now;
      current.watched = watchOf(orders, owner, logsOf, normalizeAgentId);
      current.pending = true;
      state.set(owner, current);
    },
  };
}

function backoffNote(owner, strikes, intervalMs, kind, now, capMs) {
  const minutes = Math.round(intervalMs / 60000);
  const comment = kind === 'cleared'
    ? `Nudge backoff cleared: ${owner} acted; interval returned to the ${minutes}-minute baseline.`
    : `Nudge backoff increased to ${minutes} minutes after ${strikes} reminders without movement from ${owner}.`
      + (intervalMs >= capMs ? ' Reminders continue at the cap.' : '');
  return { type: 'nudge_backoff', actor: 'system', ts: new Date(now).toISOString(), comment };
}

function appendNote(order, entry, write) {
  let timeline;
  try { timeline = JSON.parse(order.timeline || '[]'); } catch { timeline = []; }
  if (!Array.isArray(timeline)) timeline = [];
  timeline.push(entry);
  write(JSON.stringify(timeline), order.id);
}

/** Run one round with its clock and every external read/write supplied by the caller. */
function runNudgeRound({
  listByStatus,
  now,
  pacer,
  lastNudged,
  send,
  writeNote,
  logsOf,
  workspace,
  idleMsByStatus,
  normalizeAgentId,
  backoffCapMs,
}) {
  const out = { sent: [], skipped: [], notes: [] };
  const byOwner = new Map();

  for (const status of Object.keys(NUDGE_STATES)) {
    for (const order of listByStatus(status)) {
      const owner = ownerOf(order, workspace);
      if (!owner) continue;
      const movedAt = lastMovedAt(order, owner, logsOf, normalizeAgentId);
      if (!byOwner.has(owner)) byOwner.set(owner, { held: [], due: [] });
      const bucket = byOwner.get(owner);
      const entry = { status, order, movedAt };
      bucket.held.push(entry);
      if (Number.isFinite(movedAt) && now - movedAt >= idleMsByStatus[status]) bucket.due.push(entry);
    }
  }

  for (const [owner, { held, due }] of byOwner) {
    const orders = held.map((entry) => entry.order);
    const pace = pacer.evaluate(owner, orders, now, logsOf, normalizeAgentId);

    if (pace.escalatedTo || pace.recovered) {
      const note = backoffNote(
        owner,
        pace.strikes,
        pace.intervalMs,
        pace.recovered ? 'cleared' : 'backoff',
        now,
        backoffCapMs,
      );
      for (const order of orders) {
        try {
          appendNote(order, note, writeNote);
          out.notes.push({ id: order.id, owner, entry: note });
        } catch (error) {
          console.error(`[nudge] could not append a backoff note to ${order.id}: ${error.message}`);
        }
      }
    }

    if (!due.length) {
      out.skipped.push({ owner, reason: 'none-due', strikes: pace.strikes });
      continue;
    }
    if (!pace.nudge) {
      out.skipped.push({ owner, intervalMs: pace.intervalMs, strikes: pace.strikes });
      continue;
    }

    // Rotate across an owner's due work before preferring the order that has waited longest.
    due.sort((a, b) =>
      (lastNudged.get(a.order.id) || 0) - (lastNudged.get(b.order.id) || 0)
      || a.movedAt - b.movedAt);
    const picked = due[0];
    if (send(picked.status, picked.order, owner)) {
      lastNudged.set(picked.order.id, now);
      pacer.record(owner, orders, now, logsOf, normalizeAgentId);
      out.sent.push({ owner, id: picked.order.id });
    }
  }
  return out;
}

/** @returns {{ start: Function, stop: Function, scanOnce: Function }} */
function createNudger({ store, identity, notifier, config, workspace }) {
  const cfg = config.nudge;
  const idleMsByStatus = Object.fromEntries(
    Object.entries(NUDGE_STATES).map(([status, key]) => [status, cfg[key]]),
  );
  const pacer = createNudgePacer(cfg);
  const lastNudged = new Map();
  let timer = null;
  let lastPendingReport = 0;

  function send(status, order, owner) {
    const recipient = identity.normalizeAgentId(owner);
    const mention = identity.displayNameOf(recipient);
    const content = `@${mention} ${order.id} "${order.title}" is waiting on you. `
      + `${NEXT_STEP[status](order.id)}. Check its current state with mousecrew show ${order.id}.`;
    bus.emit('group:post', { role: 'user', content, sender: 'system' });
    bus.emit('group:dispatch_mentions', {
      content,
      sender: 'system',
      freshness: makeWakeFreshness(store, order.id, {
        enqueuedStatus: order.status,
        recipient,
        workspace,
      }),
    });
    return true;
  }

  function scanOnce(now = Date.now()) {
    const result = runNudgeRound({
      listByStatus: (status) => store.order.getByStatus.all(status),
      now,
      pacer,
      lastNudged,
      send,
      writeNote: (timeline, id) => store.order.appendTimelineNote.run(timeline, id),
      logsOf: (id) => store.log.byOrder.all(id),
      workspace,
      idleMsByStatus,
      normalizeAgentId: identity.normalizeAgentId,
      backoffCapMs: cfg.backoffCapMs,
    });

    const pending = store.order.getByStatus.all('pending_restart');
    if (pending.length && now - lastPendingReport > 60 * 60 * 1000) {
      lastPendingReport = now;
      notifier.send(
        'waiting on a restart',
        `${pending.length} merged order(s) need a restart: ${pending.map((order) => order.id).join(', ')}`,
      ).catch(() => {});
    }
    return result;
  }

  return {
    scanOnce,
    start() {
      if (!cfg.enabled || timer) return;
      timer = setInterval(() => {
        try { scanOnce(); } catch (error) { console.error('[nudge] scan failed:', error.message); }
      }, cfg.scanMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = {
  createNudger,
  runNudgeRound,
  createNudgePacer,
  backoffIntervalMs,
  backoffNote,
  appendNote,
  lastMovedAt,
  movedSince,
  tsOf,
  NUDGE_STATES,
};
