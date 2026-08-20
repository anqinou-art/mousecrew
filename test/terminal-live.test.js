const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createTmuxAdapter } = require('../adapters/terminal/tmux');
const { Sidecar } = require('../src/lib/sidecar');
const { buildIdentity } = require('../src/lib/identity');
const { normalizeAgent } = require('../src/config');

// The only test in this package that reads a rendered screen.
//
// Everything else asserts structured events, because a screen assertion answers two
// questions at once and cannot tell you which one failed. This one exists for the single
// question events genuinely cannot answer: **do the characters actually arrive in a real
// terminal**. An adapter reporting "I issued the command" is a claim, the same shape as an
// agent reporting which files it changed — and the rule in this codebase is that a claim
// gets stored as a claim while anything derivable gets derived. This is the derivation.
//
// Its verdict is deliberately NOT fed back into anything else. It answers end-to-end and
// nothing more.

function hasTmux() {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const SESSION = `mousecrew-live-${process.pid}`;
const tmux = (...args) => execFileSync('tmux', args, { encoding: 'utf8' });

/**
 * The probe. Deliberately a named function with its own assertions below: a probe that
 * cannot fail is worse than no probe, because it spends the credit of "this was checked".
 */
function screenShows(screen, nonce) {
  return String(screen).includes(nonce);
}

test('the screen probe fails on stale content — proving it can go red at all', () => {
  // Run this before trusting the probe for anything. If it matched loosely, a window that
  // still had the *previous* run's output on it would report success while nothing was
  // delivered at all, and the end-to-end check would be decorative.
  const leftoverFromAnEarlierRun = '[group] human: deploy is red mc-nonce-OLD1234\n> ';
  assert.equal(screenShows(leftoverFromAnEarlierRun, 'mc-nonce-NEW5678'), false, 'stale residue must not count as delivery');
  assert.equal(screenShows(leftoverFromAnEarlierRun, 'mc-nonce-OLD1234'), true, 'and it must still see content that is genuinely there');
});

test('characters really arrive in a real tmux pane', { skip: hasTmux() ? false : 'tmux not installed' }, async (t) => {
  // `cat` rather than a shell: the pane echoes whatever is typed without executing it.
  // A test that types into a live shell and presses Enter is a test that runs whatever it
  // happened to compose.
  tmux('new-session', '-d', '-s', SESSION, 'cat');
  t.after(() => { try { tmux('kill-session', '-t', SESSION); } catch { /* already gone */ } });

  const pane = tmux('list-panes', '-t', SESSION, '-F', '#{pane_id}').trim().split('\n')[0];
  const adapter = createTmuxAdapter();
  await adapter.setIdentity(pane, 'live-agent');

  const listed = await adapter.listWindows();
  const mine = listed.find((w) => w.ref === pane);
  assert.ok(mine, 'the pane is listed');
  assert.equal(mine.identity, 'live-agent', 'identity is stored where the adapter says it is');

  const nonce = `mc-nonce-${Math.random().toString(36).slice(2, 10)}`;
  const crew = [normalizeAgent({
    id: 'live-agent', displayName: 'live-agent', transport: 'terminal',
    terminal: { adapter: 'tmux', target: 'live-agent' },
  })];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-live-'));
  const sc = new Sidecar({
    adapter, identity: buildIdentity(crew), agents: crew,
    client: { history: async () => [] },
    statePath: path.join(dir, 'state.json'),
  }, { postInjectMs: 100 });
  sc.state.bootstrapped = true;

  // Before delivery the nonce is nowhere — so a pass below cannot be residue.
  assert.equal(screenShows(await adapter.readScreen(pane, 20), nonce), false);

  sc.ingest([{ content: `@live-agent ${nonce}`, ts: new Date().toISOString(), metadata: { sender: 'human' } }], 'sse');
  const delivered = await sc.deliver();
  assert.equal(delivered.length, 1, 'the engine reports a delivery');

  // Give the pane a moment to render what it echoed.
  for (let i = 0; i < 20; i++) {
    if (screenShows(await adapter.readScreen(pane, 20), nonce)) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const screen = await adapter.readScreen(pane, 20);
  assert.equal(screenShows(screen, nonce), true,
    `the message never reached the pane. Screen was:\n${screen}`);

  await adapter.clearIdentity(pane);
  const after = (await adapter.listWindows()).find((w) => w.ref === pane);
  assert.equal(after.identity, null, 'and the identity can be released again');
});
