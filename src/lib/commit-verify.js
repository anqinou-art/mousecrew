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
const path = require('path');
const os = require('os');

const SHA_RE = /^[0-9a-f]{7,40}$/i;

function git(repoPath, args, timeoutMs) {
  return execFileSync('git', ['-C', repoPath, ...args], {
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function expandTilde(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function normalizeRepoMap(name, value, baseDir, many) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const shape = many ? '{ "repo": ["/path/to/clone"] }' : '{ "repo": "/path/to/deploy-tree" }';
    throw new Error(`${name}: expected an object keyed by repo; use ${shape}`);
  }

  const normalized = {};
  for (const [repo, configured] of Object.entries(value)) {
    if (!repo.trim()) throw new Error(`${name}: repo names must be non-empty`);
    const paths = many ? configured : [configured];
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string' || !p.trim())) {
      throw new Error(`${name}.${repo}: expected ${many ? 'an array of paths' : 'one path string'}`);
    }
    const resolved = paths.map((p) => path.resolve(baseDir || process.cwd(), expandTilde(p)));
    normalized[repo] = many ? resolved : resolved[0];
  }
  return normalized;
}

function normalizeVerifyRepos(value, baseDir) {
  return normalizeRepoMap('verifyRepos', value, baseDir, true);
}

function normalizeDeployTrees(value, baseDir) {
  return normalizeRepoMap('deployTrees', value, baseDir, false);
}

function reposFor(repoName, verifyRepos) {
  if (!repoName || !Object.prototype.hasOwnProperty.call(verifyRepos, repoName)) {
    return { paths: [], reason: 'no-repos-configured' };
  }
  const paths = verifyRepos[repoName];
  if (Object.prototype.hasOwnProperty.call(verifyRepos, repoName) && paths.length === 0) {
    return { paths, reason: 'repo-not-cloned-on-this-machine' };
  }
  return { paths };
}

function verifyCommitForRepo(commit, repoName, verifyRepos, opts = {}) {
  const claimed = String(commit || '').trim();
  if (!SHA_RE.test(claimed)) return { verified: false, reason: 'malformed-commit' };
  const selected = reposFor(repoName, verifyRepos);
  if (selected.reason) return { verified: false, reason: selected.reason };
  return verifyCommit(claimed, selected.paths, opts);
}

function checkDeployTree(tree, opts = {}) {
  const timeoutMs = opts.timeoutMs || 2000;
  try {
    if (git(tree, ['rev-parse', '--is-inside-work-tree'], timeoutMs) !== 'true') {
      return { ok: false, reason: 'invalid-deploy-tree' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'invalid-deploy-tree' };
  }
}

function commitInDeployTree(commit, tree, opts = {}) {
  const claimed = String(commit || '').trim();
  if (!SHA_RE.test(claimed)) return { ok: false, reason: 'malformed-commit' };
  try {
    git(tree, ['merge-base', '--is-ancestor', claimed, 'HEAD'], opts.timeoutMs || 2000);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'commit-not-in-deploy-tree' };
  }
}

function makeDeploymentCheck(deployTrees, opts = {}) {
  const treeChecks = new Map();
  return function checkDeployment(commit, repoName) {
    const noCommit = !String(commit || '').trim();
    if (!repoName || !Object.prototype.hasOwnProperty.call(deployTrees, repoName)) {
      return { ok: true, unchecked: true, noCommit };
    }

    if (!treeChecks.has(repoName)) {
      treeChecks.set(repoName, checkDeployTree(deployTrees[repoName], opts));
    }
    const treeCheck = treeChecks.get(repoName);
    if (!treeCheck.ok) return treeCheck;
    if (noCommit) return { ok: true, noCommit: true };
    return commitInDeployTree(commit, deployTrees[repoName], opts);
  };
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

module.exports = {
  verifyCommit,
  verifyCommitForRepo,
  reposFor,
  checkDeployTree,
  commitInDeployTree,
  makeDeploymentCheck,
  normalizeVerifyRepos,
  normalizeDeployTrees,
  makeVerifyBudget,
  SHA_RE,
};
