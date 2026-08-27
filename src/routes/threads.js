// routes/threads.js — the thread API.
//
// One write path per kind of change, and each one consults the matching gate in
// lib/thread-rules.js. The gates are stated there so they can be unit-tested; they are
// called here so that removing a call turns a route test red rather than leaving a green
// suite in front of an open door.

const express = require('express');
const {
  checkSet, checkLogIntent, checkFinish, checkArchive, mergePlan,
} = require('../lib/thread-rules');

function createThreadsRouter({ store, requireToken }) {
  const router = express.Router();
  router.use(requireToken);

  /** A thread plus its plan and log — the shape every read returns. */
  function hydrate(row) {
    if (!row) return null;
    return {
      ...row,
      archived: row.archived_at != null,
      plan: store.threadPlan.byThread.all(row.name),
      log: store.threadLog.byThread.all(row.name),
    };
  }

  function load(req, res) {
    const row = store.thread.get.get(req.params.name);
    if (!row) {
      res.status(404).json({ error: 'thread_not_found' });
      return null;
    }
    return row;
  }

  /** Refusals carry the rule's own words — the caller is usually one command away. */
  function refuse(res, verdict) {
    return res.status(400).json({ error: verdict.error, detail: verdict.detail || undefined });
  }

  // ---------- read ----------

  router.get('/api/threads', (req, res) => {
    const rows = req.query.archived === 'all'
      ? store.thread.allWithArchived.all()
      : store.thread.all.all();
    const filtered = req.query.owner ? rows.filter((r) => r.owner === req.query.owner) : rows;
    res.json(filtered.map(hydrate));
  });

  router.get('/api/threads/:name', (req, res) => {
    const row = load(req, res);
    if (row) res.json(hydrate(row));
  });

  // ---------- create ----------

  router.post('/api/threads', (req, res) => {
    const { name, owner, goal, next, prev } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name_required' });
    if (!owner || !String(owner).trim()) return res.status(400).json({ error: 'owner_required' });
    if (store.thread.get.get(name)) return res.status(409).json({ error: 'thread_exists' });
    // prev is a one-way index and must point at something real; a dangling pointer here
    // would be a lie told to whoever follows the chain back in three months.
    if (prev && !store.thread.get.get(prev)) return res.status(400).json({ error: 'prev_not_found' });
    // Every thread starts as an idea. There is no way to file something as already
    // in progress, because "I'll open it properly later" is how they get lost.
    store.thread.create.run(String(name), String(owner), 'idea', String(goal || ''), String(next || ''), prev || null);
    res.json({ ok: true, data: hydrate(store.thread.get.get(name)) });
  });

  // ---------- set (gate 1) ----------

  const SETTERS = {
    owner: (n, v) => store.thread.setOwner.run(v, n),
    status: (n, v) => store.thread.setStatus.run(v, n),
    goal: (n, v) => store.thread.setGoal.run(v, n),
    next: (n, v) => store.thread.setNext.run(v, n),
    blocked_by: (n, v) => store.thread.setBlockedBy.run(v, n),
    needs_human: (n, v) => store.thread.setNeedsHuman.run(v, n),
    prev: (n, v) => store.thread.setPrev.run(v || null, n),
  };

  router.patch('/api/threads/:name', (req, res) => {
    const row = load(req, res);
    if (!row) return undefined;
    const { field, value } = req.body || {};
    const verdict = checkSet(field, value);
    if (!verdict.ok) return refuse(res, verdict);
    if (field === 'prev') {
      if (value && !store.thread.get.get(value)) return res.status(400).json({ error: 'prev_not_found' });
      if (value === row.name) return res.status(400).json({ error: 'prev_self_reference' });
    }
    SETTERS[field](row.name, value);
    return res.json({ ok: true, data: hydrate(store.thread.get.get(row.name)) });
  });

  // ---------- plan ----------

  router.post('/api/threads/:name/plan', (req, res) => {
    const row = load(req, res);
    if (!row) return undefined;
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items) return res.status(400).json({ error: 'items_required', detail: 'items: [string, ...]' });
    const merged = mergePlan(store.threadPlan.byThread.all(row.name), items);
    if (!merged.length) return res.status(400).json({ error: 'plan_empty' });
    // One transaction: a half-written plan is worse than the old one, because the ticks
    // would no longer line up with anything.
    store.db.transaction(() => {
      store.threadPlan.clear.run(row.name);
      for (const it of merged) store.threadPlan.insert.run(row.name, it.idx, it.done, it.text);
      store.thread.touch.run(row.name);
    })();
    return res.json({ ok: true, data: hydrate(store.thread.get.get(row.name)) });
  });

  // Ticking and un-ticking are the same operation with a different value, on purpose:
  // the plan is where we are now, not what we once believed. Un-ticking has to be as easy
  // as ticking or the plan drifts optimistic. The log is the part that cannot be revised.
  for (const [verb, done] of [['check', 1], ['uncheck', 0]]) {
    router.post(`/api/threads/:name/plan/:idx/${verb}`, (req, res) => {
      const row = load(req, res);
      if (!row) return undefined;
      const idx = Number(req.params.idx);
      if (!Number.isInteger(idx) || idx < 1) return res.status(400).json({ error: 'bad_index', detail: 'plan items are numbered from 1' });
      if (!store.threadPlan.get.get(row.name, idx)) return res.status(404).json({ error: 'plan_item_not_found' });
      store.threadPlan.setDone.run(done, row.name, idx);
      store.thread.touch.run(row.name);
      return res.json({ ok: true, data: hydrate(store.thread.get.get(row.name)) });
    });
  }

  // ---------- log (gate 2) ----------

  router.post('/api/threads/:name/log', (req, res) => {
    const row = load(req, res);
    if (!row) return undefined;
    const body = req.body || {};
    const { who, what } = body;
    if (!who || !String(who).trim()) return res.status(400).json({ error: 'who_required' });
    if (!what || !String(what).trim()) return res.status(400).json({ error: 'what_required' });

    const verdict = checkLogIntent(body);
    if (!verdict.ok) return refuse(res, verdict);

    // The log line and the plan change it describes land together or not at all. Split
    // them and you get log lines pointing at plan states that never existed.
    //
    // Rolling back is done by throwing, because that is how better-sqlite3 transactions
    // abort — so the throw has to be caught here and turned back into a 400. Letting it
    // escape would surface a refusal the caller is meant to read as a 500 they cannot act on.
    let planError = null;
    try {
      store.db.transaction(() => {
        if (body.check !== undefined && body.check !== null) {
          const idx = Number(body.check);
          if (!store.threadPlan.get.get(row.name, idx)) { planError = { error: 'plan_item_not_found' }; throw new Error('rollback'); }
          store.threadPlan.setDone.run(1, row.name, idx);
        } else if (body.plan !== undefined && body.plan !== null) {
          const texts = Array.isArray(body.plan) ? body.plan : String(body.plan).split('\n');
          const merged = mergePlan(store.threadPlan.byThread.all(row.name), texts);
          if (!merged.length) { planError = { error: 'plan_empty' }; throw new Error('rollback'); }
          store.threadPlan.clear.run(row.name);
          for (const it of merged) store.threadPlan.insert.run(row.name, it.idx, it.done, it.text);
        }
        store.threadLog.insert.run(row.name, String(who), String(what));
        store.thread.touch.run(row.name);
      })();
    } catch (err) {
      // Only our own rollback is a 400. Anything else is a real failure and must not be
      // dressed up as a refusal — a disk error reported as "plan item not found" would
      // send the caller looking in exactly the wrong place.
      if (!planError) throw err;
    }

    if (planError) return res.status(400).json(planError);
    return res.json({ ok: true, data: hydrate(store.thread.get.get(row.name)) });
  });

  // ---------- finish (gate 4) ----------

  router.post('/api/threads/:name/finish', (req, res) => {
    const row = load(req, res);
    if (!row) return undefined;
    const snapshot = req.body?.snapshot;
    const verdict = checkFinish(snapshot);
    if (!verdict.ok) return refuse(res, verdict);
    // Snapshot and status move in one statement so they cannot end up disagreeing.
    store.thread.finish.run(String(snapshot).trim(), row.name);
    const open = store.threadPlan.byThread.all(row.name).filter((p) => !p.done).length;
    return res.json({
      ok: true,
      data: hydrate(store.thread.get.get(row.name)),
      // Reported, not enforced: a thread can legitimately finish with items left undone
      // (dropped, or handed to another thread). Refusing here would only produce ticks
      // added to get past the door, which is worse than an honest unticked item.
      open_plan_items: open,
    });
  });

  // ---------- archive (gate 5) ----------

  router.post('/api/threads/:name/archive', (req, res) => {
    const row = load(req, res);
    if (!row) return undefined;
    if (req.body?.undo) {
      store.thread.unarchive.run(row.name);
      return res.json({ ok: true, data: hydrate(store.thread.get.get(row.name)) });
    }
    const verdict = checkArchive(row, req.body?.why);
    if (!verdict.ok) return refuse(res, verdict);
    // Soft delete. The log is history; a thread being over does not make how it went away.
    store.thread.archive.run(row.name);
    return res.json({ ok: true, data: hydrate(store.thread.get.get(row.name)) });
  });

  return router;
}

module.exports = { createThreadsRouter };
