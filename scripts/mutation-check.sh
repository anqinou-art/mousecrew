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
#
# Exits non-zero if any mutation survives, so this can gate a merge.
#
# Nothing is applied to your working tree. Every mutation runs in a throwaway copy —
# an earlier version of this check edited the real tree, timed out mid-run, and left a
# security gate deleted on disk. Do not "simplify" that away.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

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

export WORK="$(mktemp -d)"   # exported: the mutation snippets read it
trap 'rm -rf "$WORK"' EXIT
cp -R src test scripts package.json "$WORK"/ 2>/dev/null   # scripts/ too: a test requires from it
[ -f .npmrc ] && cp .npmrc "$WORK"/
ln -s "$ROOT/node_modules" "$WORK/node_modules"

run_suite() {
  (cd "$WORK" && node --test --test-timeout=15000 test/*.test.js 2>&1 \
    | grep -E '^. (pass|fail) ' | awk '{print $2"="$3}' | tr '\n' ' ')
}

restore() { cp -R "$ROOT/src" "$WORK"/; }

echo "baseline (must be fail=0):"
echo "  $(run_suite)"
BASE="$(run_suite)"
case "$BASE" in
  *"fail=0"*) ;;
  *) echo "the suite is not green before mutating — fix that first"; exit 2 ;;
esac

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
  case "$result" in
    *"fail=0"*)
      echo "  SURVIVED $name"
      echo "           $result  <-- nothing failed. This rule is unguarded."
      survivors=$((survivors + 1))
      ;;
    *)
      echo "  killed   $name  ($result)"
      ;;
  esac
  restore
done

echo ""
if [ "$survivors" -gt 0 ]; then
  echo "$survivors mutation(s) survived — every one is a rule with no test holding it down."
  exit 1
fi
echo "all ${#MUTATIONS[@]} mutations killed. The gates are load-bearing."
