# Changelog

## 0.2.0 - 2026-09-20

This release expands the work board and terminal sidecar while making delayed actions
explicit and reviewable. It contains configuration changes that require attention before
upgrading or downgrading.

### Work orders

- Work orders now have an explicit `assigned` state and explicit acceptance for new work,
  reviews, and rework. Claims are checked against the person who currently owes the next
  action, so a queued hand-off cannot be accepted by the wrong crew member.
- Entering review freezes the branch, commit, and derived file list in an immutable numbered
  snapshot. Audit decisions name that revision, preventing a late decision about an older
  delivery from releasing a newer one; an authorised unfreeze returns the order for changes.
- Configured projects provide independent, validated ID prefixes and project-scoped listing.
  Commit verification is selected by the order's repository. Restart completion can target
  named order IDs or, by default, all pending-restart orders, verifying each recorded commit
  against its configured deployment tree before closing it.
- Work-order notifications target the current action owner and skip self-wakes. Managed local
  and remote delivery rechecks queued notices before they consume an agent turn. Terminal
  notices are ordinary group messages and carry no such work-order freshness check, so a
  notice held in a busy terminal queue can still arrive after the order has moved on.

### Nudging

- Nudges use the same current-owner rules as work-order hand-offs. Unclaimed assignments and
  reviews use a short threshold, active work uses a longer progress threshold, and paused or
  completed work stays quiet.
- Rate limiting is per person rather than per order. Repeated unanswered nudges back off to a
  configurable cap, then return to the baseline as soon as that person records activity.

### Terminal delivery

- Consecutive group messages can share one terminal injection. Long deliveries are stored in
  private full-text files and represented in the terminal by a prefix and path, avoiding
  oversized input without silently truncating it.
- A message held by busy or changing-input gates gets one forced delivery attempt at expiry,
  then expires after a grace period instead of interrupting repeatedly. Direct messages that
  expire together share the forced injection while retaining separate receipts.
- Claude Code input-box detection avoids overwriting an actively edited draft. Local programs
  can also queue durable, deduplicated wake requests through a permission-protected directory
  without holding the server token.
- Terminal activity can be recorded by hooks. Matching hook state is authoritative for busy
  back-pressure; screen matching remains a fallback for terminals without current hook data.

### Sessions

- Managed local agents can rotate gracefully after the current turn and before queued work.
  Rotation status is tied to the request and confirmed only by evidence from the replacement
  process; silence remains pending rather than being reported as failure.
- The first message in a rotated managed session points to the newest eligible handoff file.
  Context watch also supports an optional absolute token threshold alongside its existing
  turns-remaining estimate.
- Interactive terminal agents can receive non-expiring, non-forced rotation reminders based
  on transcript token usage or literal marker counts. Each reminder is tied to the recorded
  window and session and is rechecked immediately before delivery.

### Paseo adapter

- Terminal delivery now supports Paseo through its public `terminal ls`, `capture`, and
  `send-keys` commands. A terminal's fixed Paseo name is its identity; ambiguous or mismatched
  names are refused instead of guessed.

## Upgrade notes

- Replace the old `nudge.idleMs` and `nudge.dedupMs` settings. Use `claimIdleMs` for the wait
  before reminding about an unclaimed hand-off, `progressIdleMs` for work with no progress,
  and `baseIntervalMs` for the initial per-person reminder interval. `backoffAfter` and
  `backoffCapMs` control repeated unanswered reminders. The removed keys are no longer read.
- Orders already in `auditing` when the database is upgraded receive the new columns with
  revision `0`, but no review snapshot is fabricated. Move the order out of review and enter
  review again to freeze revision `1` before making a revision-bound audit decision.
- A new order number is the greatest currently stored numeric suffix for that prefix plus
  one. Deleting the highest-numbered order can therefore allow that number to be reused;
  numbering is not a permanent sequence ledger.
- `verifyRepos` must now be an object keyed by the order's `repo`, with an array of clone
  paths for each key. The former top-level array is rejected at startup. `deployTrees` uses
  the same repository keys with one path per repository. A successful deployment check only
  proves that the recorded commit is an ancestor of the deployment tree's current `HEAD`;
  it does not prove that a running process has reloaded that tree.
- Full-text files created for deliveries over `delivery.inlineLimit` are not removed
  automatically. A failed send may create another file on retry, and rolling back mousecrew
  does not delete existing files under the sidecar state's `inbox/` directory.
- Restart the terminal sidecar after changing terminal delivery code or configuration.
  Restart the mousecrew service after changing server code or server-side configuration;
  merging or updating a checkout alone does not reload either process.
- Before downgrading to a version without the new delivery state, drain or explicitly discard
  pending entries carrying `forcedAt`, `forcedTriedAt`, or `mergedFrom`. Also settle pending
  local wakes and their source JSON files before removing `delivery.wakeDir`; the sidecar's
  shared deduplication history retains only the latest 2,000 seen keys. Settle or discard
  pending rotation reminders and remove or repoint the CLI hooks before the older
  `session-record` and `session-activity` commands disappear.
- Install `SessionStart` before relying on either hook-based activity or terminal rotation
  reminders: it creates the per-window session record that the other hooks must match.
  Reliable busy back-pressure on current Claude Code requires all three configured hooks —
  `SessionStart`, `UserPromptSubmit`, and `Stop` — because streamed output has no reliable
  screen marker. Without matching hook data, screen matching is only a fallback. See
  [the terminal hook configuration](docs/TERMINAL.md#optional-session-rotation-reminders).
- Rotation reminders use that same `SessionStart` record to locate the transcript. Without
  it, mousecrew deliberately does not guess which transcript belongs to the terminal and
  does not measure a rotation rule.
