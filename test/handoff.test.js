const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { orderHandoffs, latestHandoff, newWindowSignpost } = require('../src/lib/handoff');

function fixture(t, names) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-handoff-'));
  const dir = path.join(root, 'worker-handoff');
  fs.mkdirSync(dir);
  for (const name of names) fs.writeFileSync(path.join(dir, name), name);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir };
}

test('handoffs are ordered by filename date and numeric suffix, never mtime', (t) => {
  const names = ['2026-09-09.md', '2026-09-10.md', '2026-09-10-2.md', 'README.md'];
  const { dir } = fixture(t, names);
  fs.utimesSync(path.join(dir, '2026-09-09.md'), new Date('2030-01-01'), new Date('2030-01-01'));
  assert.deepEqual(orderHandoffs(names), ['2026-09-09.md', '2026-09-10.md', '2026-09-10-2.md']);
  assert.equal(latestHandoff(dir, new Date(2026, 8, 10)).file, '2026-09-10-2.md');
});

test('new-session signposts cover disabled, absent, future, fresh, and stale handoffs', (t) => {
  const none = fixture(t, []);
  assert.equal(newWindowSignpost('worker', { handoffRoot: none.root, noHandoff: ['worker'] }), null);
  assert.match(newWindowSignpost('worker', { handoffRoot: none.root }), /No handoff was found/);

  const future = fixture(t, ['2026-09-11.md']);
  const futureText = newWindowSignpost('worker', { handoffRoot: future.root, now: new Date(2026, 8, 10) });
  assert.match(futureText, /2026-09-11\.md/);
  assert.match(futureText, /future/);

  const fresh = fixture(t, ['2026-09-08.md']);
  const freshText = newWindowSignpost('worker', { handoffRoot: fresh.root, now: new Date(2026, 8, 10) });
  assert.match(freshText, /2026-09-08\.md/);
  assert.doesNotMatch(freshText, /Warning/);

  const stale = fixture(t, ['2026-09-01.md']);
  const staleText = newWindowSignpost('worker', {
    handoffRoot: stale.root, maxAgeDays: 7, now: new Date(2026, 8, 10),
  });
  assert.match(staleText, /2026-09-01\.md/);
  assert.match(staleText, /9 days old/);
});
