// commit-verify.js — the agent says what it changed; we go and look.
//
// The rule: a claimed commit hash and branch name get stored as claims (both are
// checkable later). The file list is NEVER taken from the claim — it is derived here from
// git, or it is left null. Storing a self-reported file list in a column labelled
// `files_changed` doesn't make it true; it just moves untrusted data somewhere it looks
// official, and destroys the only use it had: reconciling claim against reality.
//
// Every failure path leads to unverified. None leads to "assume it's fine".

const { execFileSync } = require('child_process');

const SHA_RE = /^[0-9a-f]{7,40}$/i;

function git(repoPath, args, timeoutMs) {
  return execFileSync('git', ['-C', repoPath, ...args], {
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Resolve a commit against a list of local clones and derive its file list.
 *
 * @param {string} commit claimed sha
 * @param {string[]} repoPaths clones to try, in order. Read-only access only.
 * @param {object} [opts] { timeoutMs = 2000, requireOnOrigin = true }
 * @returns {{verified:boolean, commit?:string, repo?:string, files?:string[], reason?:string}}
 */
function verifyCommit(commit, repoPaths, opts = {}) {
  const timeoutMs = opts.timeoutMs || 2000;
  const requireOnOrigin = opts.requireOnOrigin !== false;

  const claimed = String(commit || '').trim();
  if (!SHA_RE.test(claimed)) return { verified: false, reason: 'malformed-commit' };
  if (!repoPaths || !repoPaths.length) return { verified: false, reason: 'no-repos-configured' };

  for (const repo of repoPaths) {
    let full;
    try {
      // Object must exist here. A feature branch's objects often live only in the clone
      // where the work happened — the deployment tree, which only fast-forwards main,
      // will not have them, and that is precisely the moment this runs.
      git(repo, ['cat-file', '-e', `${claimed}^{commit}`], timeoutMs);
      full = git(repo, ['rev-parse', claimed], timeoutMs);
    } catch {
      continue;
    }

    // Existing locally is not the same as pushed. A dev clone can hold commits nobody
    // else can see; reporting those as verified would be a lie with a receipt attached.
    if (requireOnOrigin) {
      let onOrigin = false;
      try {
        const refs = git(repo, ['for-each-ref', '--format=%(refname)', '--contains', full, 'refs/remotes/origin/'], timeoutMs);
        onOrigin = refs.length > 0;
      } catch {
        onOrigin = false;
      }
      if (!onOrigin) return { verified: false, reason: 'commit-not-on-origin', repo, commit: full };
    }

    let files = [];
    try {
      const parents = git(repo, ['rev-list', '--parents', '-n', '1', full], timeoutMs).split(/\s+/);
      const isMerge = parents.length > 2;
      // A merge commit's single-argument diff-tree prints nothing, which would quietly
      // record "this merge changed 0 files". Compare against the first parent instead.
      const args = isMerge
        ? ['diff-tree', '--no-commit-id', '--name-only', '-r', '-m', '--first-parent', full]
        : ['diff-tree', '--no-commit-id', '--name-only', '-r', full];
      files = git(repo, args, timeoutMs).split('\n').map((s) => s.trim()).filter(Boolean);
      files = [...new Set(files)];
    } catch (e) {
      return { verified: false, reason: 'diff-failed', repo, commit: full };
    }

    return { verified: true, commit: full, repo, files };
  }

  return { verified: false, reason: 'commit-not-found-locally' };
}

/**
 * A global budget on how often verification may run.
 *
 * The transition endpoint is reachable by anyone who can reach the API, and the legality
 * gate cannot stop a caller from pushing an order back and forth across two legal edges.
 * Each verification forks git synchronously, so an unbounded loop stalls the event loop
 * for everyone. Over budget we record `verify-rate-limited` — still unverified, never a
 * bypass that returns "verified" for free.
 */
function makeVerifyBudget({ limit = 10, windowMs = 60_000 } = {}) {
  let stamps = [];
  return function take(now = Date.now()) {
    stamps = stamps.filter((t) => now - t < windowMs);
    if (stamps.length >= limit) return false;
    stamps.push(now);
    return true;
  };
}

module.exports = { verifyCommit, makeVerifyBudget, SHA_RE };
