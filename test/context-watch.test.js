const test = require('node:test');
const assert = require('node:assert');
const { assess, notice, stamp, today } = require('../scripts/context-watch');

test('turns remaining, not percent used — the whole point', () => {
  // A is at 60% and B at 75%. Sorted by percentage you would go help B. A is the one
  // about to hit the wall.
  const A = assess({ sessionId: 's', tokens: 105_000, msgs: 9 }, { sessionId: 's', tokens: 120_000, limit: 200_000, msgs: 10 }, 10);
  const B = assess({ sessionId: 's', tokens: 148_000, msgs: 9 }, { sessionId: 's', tokens: 150_000, limit: 200_000, msgs: 10 }, 10);

  assert.equal(A.remain, 5);
  assert.equal(B.remain, 25);
  assert.equal(A.warn, true, 'the 60% agent is the one in trouble');
  assert.equal(B.warn, false, 'the 75% agent has plenty of room');
});

test('a fresh session falls back to the whole-window average', () => {
  // No previous sample to difference against. Without this fallback an agent that rotated
  // straight into heavy turns is invisible for a full cycle — exactly when it is at risk.
  const v = assess(null, { sessionId: 'new', tokens: 190_000, limit: 200_000, msgs: 19 }, 10);
  assert.equal(v.basis, 'window-average');
  assert.equal(v.remain, 1);
  assert.equal(v.warn, true);
});

test('a rotated session is not compared against the old one\'s numbers', () => {
  const prev = { sessionId: 'old', tokens: 190_000, msgs: 40 };
  const v = assess(prev, { sessionId: 'new', tokens: 5_000, limit: 200_000, msgs: 2 }, 10);
  assert.equal(v.basis, 'window-average');
  assert.ok(v.remain > 10);
  assert.equal(v.warn, false);
});

test('a session with no turns yet says "no data" instead of guessing', () => {
  const v = assess(null, { sessionId: 'new', tokens: 0, limit: 200_000, msgs: 0 }, 10);
  assert.equal(v.basis, 'no-data');
  assert.equal(v.warn, false);
});

test('a window that is not growing never warns', () => {
  const v = assess({ sessionId: 's', tokens: 100_000, msgs: 5 }, { sessionId: 's', tokens: 100_000, limit: 200_000, msgs: 6 }, 10);
  assert.equal(v.basis, 'no-growth');
  assert.equal(v.warn, false);
  assert.equal(v.remain, Infinity);
});

test('a full window warns regardless of arithmetic', () => {
  const v = assess({ sessionId: 's', tokens: 190_000, msgs: 5 }, { sessionId: 's', tokens: 200_000, limit: 200_000, msgs: 6 }, 10);
  assert.equal(v.warn, true);
  assert.equal(v.remain, 0);
});

test('the notice tells the agent to finish first, and to hand off', () => {
  const withHandoff = notice('backend', 4, 180_000, 200_000, 5_000, { handoff: true, handoffDir: '/tmp/handoff' });
  assert.match(withHandoff, /4 turn/);
  assert.match(withHandoff, /clean stopping point/);
  assert.match(withHandoff, /session\/new/);
  assert.match(withHandoff, /Nobody will rotate you automatically/);

  // Some agents produce nothing that would be lost. Asking them for a handoff is asking
  // for busywork.
  const without = notice('clerk', 4, 180_000, 200_000, 5_000, { handoff: false, handoffDir: '/tmp/handoff' });
  assert.match(without, /No handoff needed/);
  assert.ok(!/clean stopping point/.test(without));
});

test('timestamps are local wall-clock, not UTC', () => {
  // A log stamped in a timezone the machine does not use reads as if the job died hours
  // ago, and dated handoff files land under the wrong day for anyone working late.
  const d = new Date(2026, 7, 20, 18, 0, 1);      // local 18:00:01
  assert.equal(stamp(d), '2026-08-20 18:00:01');
  assert.equal(today(d), '2026-08-20');
});
