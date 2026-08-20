#!/usr/bin/env bash
#
# mutation-check.sh — prove the tests are load-bearing.
#
# A green suite says the decisions are right. It does not say a handler still asks for one.
# Delete an enforcement point and a suite made only of unit tests stays green with the gate
# wide open — that is not hypothetical, it is how the audit that produced this file found
# the merge gate could be removed from the route with 79/79 still passing.
#
# So: for every rule this project claims to enforce, there is a mutation here that breaks
# it. Each one MUST turn the suite red. A mutation that survives means the rule is
# unguarded — the assertion covering it, if any, is decoration.
#
#   ./scripts/mutation-check.sh          run them all
#   ./scripts/mutation-check.sh --list   just show what would run
#   ./scripts/mutation-check.sh --self-test   check that this checker can still fail
#
# Exits non-zero if any mutation survives, so this can gate a merge.
#
# Nothing is applied to your working tree. Every mutation runs in a throwaway copy —
# an earlier version of this check edited the real tree, timed out mid-run, and left a
# security gate deleted on disk. Do not "simplify" that away.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

# Run the suite in $WORK and report a one-line summary, or the literal TIMEOUT.
#
# Two things this must not do, both found by pointing the "make it fail once" rule at
# this script itself:
#
#   1. Read only pass/fail. A test the runner cancels reports `fail 0 cancelled 1`, so
#      grepping for fail=0 alone calls a stuck suite healthy. On the baseline check that
#      is the expensive direction: every mutation afterwards runs against a suite that was
#      never actually green.
#   2. Wait forever. A test file that leaves a live handle never exits at all — the
#      per-test timeout does not help, because nothing timed out; the process simply has
#      something left to do. Without a wall clock here, the whole check hangs, which is
#      indistinguishable from "still working".
SUITE_TIMEOUT_S="${SUITE_TIMEOUT_S:-180}"

run_suite() {
  local out="$WORK/.suite-out"
  rm -f "$out"
  # exec: the subshell is replaced by node, so $! is node's own pid and can be killed.
  (cd "$WORK" && exec node --test --test-timeout=15000 test/*.test.js > "$out" 2>&1) &
  local pid=$! waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$SUITE_TIMEOUT_S" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null
    pkill -9 -f "$WORK/test" 2>/dev/null      # per-file children the runner spawned
    wait "$pid" 2>/dev/null
    echo "TIMEOUT(${SUITE_TIMEOUT_S}s)"
    return
  fi
  wait "$pid" 2>/dev/null
  grep -E '^. (pass|fail|cancelled) ' "$out" | awk '{print $2"="$3}' | tr '\n' ' '
}

# A suite counts as green only if nothing failed AND nothing was cancelled AND it finished.
healthy() {
  case "$1" in *TIMEOUT*) return 1 ;; esac
  case "$1" in *"fail=0"*) ;; *) return 1 ;; esac
  case "$1" in *"cancelled=0"*) return 0 ;; *) return 1 ;; esac
}

# name|file|python snippet that mutates it
MUTATIONS=(
"merge gate removed from the route|src/routes/orders.js|
old = \"\"\"    if (to_status === 'pending_restart' || (o.status === 'auditing' && to_status === 'closed')) {
      const verdict = workspace.canMerge(identity.normalizeAgentId(actor));
      if (!verdict.ok) return res.status(403).json({ error: verdict.reason });
    }\"\"\"
s = s.replace(old, '', 1)
"
"audit lane bypass reopened (accepted guard removed)|src/routes/orders.js|
i = s.index(\"    if (to_status === 'accepted'\")
j = s.index('\n    }\n', i) + len('\n    }\n')
s = s[:i] + s[j:]
"
"review becomes a one-way door (no-merge-gate guard removed)|src/routes/orders.js|
i = s.index(\"    if (to_status === 'auditing' && !workspace.mergeGate)\")
j = s.index('\n    }\n', i) + len('\n    }\n')
s = s[:i] + s[j:]
"
"self-managed lane allowed into review|src/routes/orders.js|
i = s.index(\"    if (to_status === 'auditing' && workspace.isSelfManaged\")
j = s.index('\n    }\n', i) + len('\n    }\n')
s = s[:i] + s[j:]
"
"ownership check removed from create|src/routes/orders.js|
old = \"\"\"    if (assignee) {
      const verdict = workspace.canWork(assignee, repo);
      if (!verdict.ok) {
        return res.status(409).json({
          error: verdict.reason,
          owners: workspace.ownersOf(repo),
        });
      }
    }\"\"\"
s = s.replace(old, '', 1)
"
"restart queue left ungated|src/routes/orders.js|
old = \"\"\"    if (isAgent && !workspace.canMerge(actorId).ok) {\"\"\"
s = s.replace(old, '    if (false) {', 1)
"
"token guard fails OPEN when the token file is unreadable|src/lib/require-token.js|
i = s.index('} catch (e) {')
j = s.index('return false;', i)
s = s[:j] + 'return true;' + s[j + len('return false;'):]
"
"staleness no longer checked on local dispatch|src/lib/dispatch.js|
s = s.replace(\"const result = await rt.send(formatted, { source: 'group', freshness });\",
              \"const result = await rt.send(formatted, { source: 'group' });\", 1)
"
"staleness no longer checked on remote dispatch|src/lib/dispatch.js|
s = s.replace(\"      if (isStale(freshness, id)) return '';\n\n      const remote\", '      const remote', 1)
s = s.replace(\"      if (isStale(freshness, id)) return '';\n      if (back\", '      if (back', 1)
"
"self-dispatch guard removed (an agent can wake itself)|src/lib/identity.js|
s = s.replace('      if (t.id === senderId) continue;', '', 1)
"
"sidecar stops normalising the sender (an agent gets its own messages)|src/lib/sidecar-core.js|
s = s.replace('const senderId = identity.normalizeAgentId(sender);', 'const senderId = sender;', 1)
"
"sidecar stops taking a baseline (a restart replays the whole backlog)|src/lib/sidecar.js|
s = s.replace('      if (bootstrapping) continue;', '      // baseline removed', 1)
"
"sidecar stops checking whether the window is busy|src/lib/sidecar.js|
s = s.replace('if (core.isBusy(screen, pattern)) {', 'if (false) {', 1)
"
"an expired direct message is no longer reported back|src/lib/sidecar.js|
i = s.index('for (const item of expired) {')
j = s.index('this._saveState();', i)
seg = s[i:j]
seg2 = seg.replace(\"if (item.kind === 'dm' && item.dmId) this._ack(item.dmId, item.agent, 'expired');\", '')
assert seg != seg2
s = s[:i] + seg2 + s[j:]
"
"two windows claiming one identity is silently guessed|src/lib/sidecar-core.js|
s = s.replace('if (claimed.length > 1) {', 'if (false) {', 1)
s = s.replace('const claimed = windows.filter((w) => w.identity === identityName);', 'const claimed = windows.filter((w) => w.identity === identityName).slice(0, 1);', 1)
"
"mention prefix collisions no longer refused at startup|src/config.js|
i = s.index('  const all = [...triggers.keys()];')
j = s.index('  const mergers =', i)
s = s[:i] + s[j:]
"
)

if [ "${1:-}" = "--list" ]; then
  printf 'mutations (%d):\n' "${#MUTATIONS[@]}"
  for m in "${MUTATIONS[@]}"; do printf '  - %s\n' "${m%%|*}"; done
  exit 0
fi

# --self-test: point the "make it fail once" rule at this script.
#
# A mutation checker that cannot fail is exactly the thing it exists to catch. These
# probes drive the real run_suite/healthy functions — not copies of them — against test
# files whose outcome is known in advance.
if [ "${1:-}" = "--self-test" ]; then
  fails=0
  probe() {   # probe <name> <expect-healthy:yes|no> <heredoc body written to test file>
    local name="$1" expect="$2"
    export WORK="$(mktemp -d)"
    mkdir -p "$WORK/test"
    cat > "$WORK/test/probe.test.js"
    local out; out="$(SUITE_TIMEOUT_S=20 run_suite)"
    local got=no
    healthy "$out" && got=yes
    if [ "$got" = "$expect" ]; then
      printf '  ok       %-42s (%s)\n' "$name" "$out"
    else
      printf '  BROKEN   %-42s expected healthy=%s got=%s (%s)\n' "$name" "$expect" "$got" "$out"
      fails=$((fails + 1))
    fi
    rm -rf "$WORK"
  }

  echo "self-test: does this checker actually notice things?"
  probe "a clean suite reads as green" yes <<'PROBE'
const test = require('node:test');
test('fine', () => {});
PROBE

  # fail 0 / cancelled 1 — the shape that used to read as healthy.
  probe "a cancelled test is NOT green" no <<'PROBE'
const test = require('node:test');
test('never resolves', () => new Promise(() => {}));
test('fine', () => {});
PROBE

  # The runner never exits: nothing failed, nothing was cancelled, it just never ends.
  probe "a suite that never finishes is NOT green" no <<'PROBE'
const test = require('node:test');
setInterval(() => {}, 1000);          // a live handle nobody cleans up
test('fine', () => {});
PROBE

  # A mutation whose pattern has drifted must announce itself, not pass silently.
  export WORK="$(mktemp -d)"; mkdir -p "$WORK/src"
  echo "const a = 1;" > "$WORK/src/x.js"
  MUT_FILE="src/x.js" MUT_SNIPPET="s = s.replace('this text is not in the file', 'y', 1)" python3 - <<'PY2' >/dev/null 2>&1
import io, os, sys
p = os.path.join(os.environ['WORK'], os.environ['MUT_FILE'])
s = io.open(p, encoding='utf-8').read()
before = s
exec(os.environ['MUT_SNIPPET'])
if s == before:
    sys.exit(3)
io.open(p, 'w', encoding='utf-8').write(s)
PY2
  if [ $? -eq 3 ]; then
    printf '  ok       %-42s (exit 3)\n' "a drifted mutation reports itself"
  else
    printf '  BROKEN   %-42s a stale pattern passed silently\n' "a drifted mutation reports itself"
    fails=$((fails + 1))
  fi
  rm -rf "$WORK"

  echo ""
  if [ "$fails" -gt 0 ]; then
    echo "$fails self-test(s) BROKEN — this checker cannot be trusted until they pass."
    exit 1
  fi
  echo "self-test passed: the checker notices failure, cancellation, hanging, and its own drift."
  exit 0
fi

export WORK="$(mktemp -d)"   # exported: the mutation snippets read it
trap 'rm -rf "$WORK"' EXIT
cp -R src test scripts adapters package.json "$WORK"/ 2>/dev/null   # scripts/ and adapters/: tests require from both
[ -f .npmrc ] && cp .npmrc "$WORK"/
ln -s "$ROOT/node_modules" "$WORK/node_modules"

restore() { cp -R "$ROOT/src" "$ROOT/adapters" "$WORK"/; }

echo "baseline (must be fail=0 cancelled=0, and must finish):"
BASE="$(run_suite)"
echo "  $BASE"
if ! healthy "$BASE"; then
  echo "the suite is not green before mutating — fix that first."
  echo "(a cancelled test or a run that never finishes counts as not green: every mutation"
  echo " after this point would be measured against a suite that was already broken)"
  exit 2
fi

survivors=0
echo ""
for entry in "${MUTATIONS[@]}"; do
  name="${entry%%|*}"; rest="${entry#*|}"
  file="${rest%%|*}"; snippet="${rest#*|}"

  MUT_FILE="$file" MUT_SNIPPET="$snippet" python3 - <<'PY' >/dev/null 2>&1
import io, os, sys
p = os.path.join(os.environ['WORK'], os.environ['MUT_FILE'])
s = io.open(p, encoding='utf-8').read()
before = s
exec(os.environ['MUT_SNIPPET'])
if s == before:
    sys.exit(3)          # the snippet no longer matches the source
io.open(p, 'w', encoding='utf-8').write(s)
PY
  rc=$?
  if [ $rc -eq 3 ]; then
    echo "  SKIPPED  $name"
    echo "           (the mutation no longer matches $file — update it or the check is lying)"
    survivors=$((survivors + 1))
    restore
    continue
  fi

  result="$(run_suite)"
  if healthy "$result"; then
    echo "  SURVIVED $name"
    echo "           $result  <-- nothing failed. This rule is unguarded."
    survivors=$((survivors + 1))
  else
    echo "  killed   $name  ($result)"
  fi
  restore
done

echo ""
if [ "$survivors" -gt 0 ]; then
  echo "$survivors mutation(s) survived — every one is a rule with no test holding it down."
  exit 1
fi
echo "all ${#MUTATIONS[@]} mutations killed. The gates are load-bearing."
