// thread-rules.js — the five gates, as functions, so a route cannot forget one.
//
// A thread is a piece of work that can be put down and picked back up. Orders go through
// the board; threads are for everything that does not — the idea from last night, the
// half-finished thing, the one you meant to get back to. Those are the ones that get lost,
// because nothing was ever opened for them.
//
// Every rule below was paid for. They are stated here as small pure functions rather than
// as `if` blocks inside handlers, because a rule that lives in one handler is a rule until
// somebody writes a second handler.

const STATES = ['idea', 'todo', 'doing', 'blocked', 'done'];

// Gate 1. What `set` may write.
//
// `plan` is not here, and neither is `snapshot`. Both have their own endpoints for a
// reason: plan is a list with positions that get ticked, and letting it through a generic
// field-setter means "replace the plan" and "record progress on the plan" become the same
// call. Snapshot is not here because a snapshot written by anything other than /finish is
// a snapshot written before the work was actually finished.
const SETTABLE = ['owner', 'status', 'goal', 'next', 'blocked_by', 'needs_human', 'prev'];

// Gate 2. A log line must declare which of three things it is.
//
// Not because the server needs to know, but because the writer does. "I ticked item 3",
// "the plan changed", and "progress, plan unchanged" are three different events, and an
// agent that does not have to choose between them will write "continuing work on this"
// forever. The choice is the point; the field is just where the choice is recorded.
const LOG_INTENTS = ['check', 'plan', 'no_plan_change'];

function fail(error, detail) {
  return detail ? { ok: false, error, detail } : { ok: false, error };
}

const OK = { ok: true };

/** Gate 1: is this a field `set` is allowed to touch, with a value it accepts? */
function checkSet(field, value) {
  if (!SETTABLE.includes(field)) {
    // Naming the two excluded fields explicitly is worth the words: the caller who tried
    // is almost always reaching for one of them, and "use POST /plan" is the answer.
    if (field === 'plan') return fail('plan_not_settable', 'the plan has its own endpoint: POST /api/threads/:name/plan');
    if (field === 'snapshot') return fail('snapshot_not_settable', 'a snapshot is only written by POST /api/threads/:name/finish');
    return fail('field_not_settable', `settable fields: ${SETTABLE.join(', ')}`);
  }
  if (typeof value !== 'string') return fail('value_must_be_string');
  if (field === 'status') {
    if (!STATES.includes(value)) return fail('bad_status', `status is one of: ${STATES.join(', ')}`);
    // Gate 4, stated from the other side. `done` has exactly one door and this is not it —
    // otherwise "mark it done, I'll write the snapshot after" becomes a path, and after is
    // a place nobody goes.
    if (value === 'done') return fail('use_finish', 'the only way to done is POST /api/threads/:name/finish, which needs a snapshot');
  }
  if (field === 'owner' && !value.trim()) return fail('owner_required');
  return OK;
}

/**
 * Gate 2: exactly one intent per log line.
 *
 * Both directions are refused on purpose. Sending none means the writer never made the
 * choice; sending two means they made it twice and one of them is wrong.
 */
function checkLogIntent(body) {
  const given = LOG_INTENTS.filter((k) => body[k] !== undefined && body[k] !== null);
  if (given.length === 0) return fail('log_intent_required', `exactly one of: ${LOG_INTENTS.join(', ')}`);
  if (given.length > 1) return fail('log_intent_ambiguous', `got ${given.join(' + ')} — send exactly one`);
  const intent = given[0];
  if (intent === 'check') {
    const n = Number(body.check);
    // 1-based: the plan is read by people, and people count plans from one.
    if (!Number.isInteger(n) || n < 1) return fail('check_must_be_positive_int', 'plan items are numbered from 1');
  }
  if (intent === 'plan' && !String(body.plan || '').trim()) return fail('plan_text_required');
  return OK;
}

/** Gate 4: a snapshot is what makes done mean something. */
function checkFinish(snapshot) {
  if (typeof snapshot !== 'string' || !snapshot.trim()) {
    return fail('snapshot_required', 'a finished thread needs one: where it landed, what was decided and why, what is still broken');
  }
  return OK;
}

/**
 * Gate 5: archiving without a snapshot needs a stated reason.
 *
 * Not blocked outright — a thread can be legitimately abandoned, duplicated, or folded
 * into another one, and refusing those would only teach people to write a fake snapshot to
 * get past the door. Asking for one sentence is enough to stop the reflexive tidy-up.
 */
function checkArchive(thread, why) {
  if (thread.snapshot && thread.snapshot.trim()) return OK;
  if (typeof why === 'string' && why.trim()) return OK;
  return fail('why_required', 'no snapshot on this thread — say why it is being archived (abandoned / duplicate / folded into X)');
}

/**
 * Renumber a plan to 1..n, keeping the ticks that survive.
 *
 * Positions are identity here: a plan is rewritten wholesale, and item 3 after the rewrite
 * is not necessarily item 3 before it. Ticks are carried by text rather than by position,
 * so re-ordering a plan does not silently un-tick or falsely tick anything.
 */
function mergePlan(oldItems, newTexts) {
  const doneByText = new Map();
  for (const item of oldItems) if (item.done) doneByText.set(item.text, true);
  return newTexts
    .map((t) => String(t == null ? '' : t).trim())
    .filter(Boolean)
    .map((text, i) => ({ idx: i + 1, text, done: doneByText.has(text) ? 1 : 0 }));
}

module.exports = { STATES, SETTABLE, LOG_INTENTS, checkSet, checkLogIntent, checkFinish, checkArchive, mergePlan };
