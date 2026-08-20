const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { verifyCommit, makeVerifyBudget } = require('../src/lib/commit-verify');

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-git-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  return dir;
}

function commitFile(dir, name, body) {
  fs.writeFileSync(path.join(dir, name), body);
  git(dir, 'add', name);
  git(dir, 'commit', '-q', '-m', `add ${name}`);
  return git(dir, 'rev-parse', 'HEAD');
}

test('a malformed sha is refused before any git runs', () => {
  assert.deepEqual(verifyCommit('not-a-sha', ['/nonexistent']), { verified: false, reason: 'malformed-commit' });
  assert.deepEqual(verifyCommit('', ['/nonexistent']), { verified: false, reason: 'malformed-commit' });
});

test('with no repos configured it says so rather than guessing', () => {
  assert.deepEqual(verifyCommit('abc1234', []), { verified: false, reason: 'no-repos-configured' });
});

test('a commit that exists nowhere locally is unverified, never assumed', () => {
  const repo = makeRepo();
  commitFile(repo, 'a.txt', 'hello');
  const r = verifyCommit('0'.repeat(40), [repo], { requireOnOrigin: false });
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'commit-not-found-locally');
});

test('a real commit yields the file list git actually recorded', () => {
  const repo = makeRepo();
  commitFile(repo, 'one.txt', '1');
  const sha = commitFile(repo, 'two.txt', '2');
  const r = verifyCommit(sha, [repo], { requireOnOrigin: false });
  assert.equal(r.verified, true);
  assert.equal(r.commit, sha);
  assert.deepEqual(r.files, ['two.txt']);
});

test('existing locally is not the same as pushed', () => {
  // A dev clone can hold commits nobody else can see. Reporting those as verified would
  // be a lie with a receipt attached.
  const repo = makeRepo();
  const sha = commitFile(repo, 'local-only.txt', 'x');
  const r = verifyCommit(sha, [repo]);   // requireOnOrigin defaults to true
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'commit-not-on-origin');
});

test('a merge commit does not report zero files', () => {
  // diff-tree in its single-argument form prints nothing for a merge, which would quietly
  // record "this merge changed no files" — the most convincing kind of wrong.
  const repo = makeRepo();
  commitFile(repo, 'base.txt', 'base');
  git(repo, 'checkout', '-q', '-b', 'side');
  commitFile(repo, 'from-side.txt', 'side');
  git(repo, 'checkout', '-q', 'main');
  commitFile(repo, 'from-main.txt', 'main');
  git(repo, 'merge', '--no-ff', '-q', 'side', '-m', 'merge side');
  const sha = git(repo, 'rev-parse', 'HEAD');

  const r = verifyCommit(sha, [repo], { requireOnOrigin: false });
  assert.equal(r.verified, true);
  assert.ok(r.files.length > 0, 'a merge that brought in a file must not report an empty list');
  assert.ok(r.files.includes('from-side.txt'));
});

test('it searches the configured clones in order and reports which one hit', () => {
  const empty = makeRepo();
  commitFile(empty, 'unrelated.txt', 'x');
  const real = makeRepo();
  const sha = commitFile(real, 'target.txt', 'y');
  const r = verifyCommit(sha, [empty, real], { requireOnOrigin: false });
  assert.equal(r.verified, true);
  assert.equal(r.repo, real);
});

test('the verification budget limits how often git may be forked', () => {
  // The transition endpoint is reachable by anyone with the token, and two legal edges
  // can be pushed back and forth forever. Each verification forks git synchronously, so
  // an unbounded loop stalls the whole event loop.
  const take = makeVerifyBudget({ limit: 3, windowMs: 1000 });
  assert.equal(take(1000), true);
  assert.equal(take(1000), true);
  assert.equal(take(1000), true);
  assert.equal(take(1000), false, 'over budget');
  assert.equal(take(2500), true, 'window has rolled');
});
