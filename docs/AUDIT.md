# What was reviewed, and what was knowingly left

## Last audited

```
2fc5575
```

Two independent reviews were run against that commit: one for whether anything private
leaked, one for whether the logic closes. Everything they found was fixed and re-verified
before that sha was recorded here.

**Check for yourself instead of taking anyone's word:**

```bash
git log --oneline 2fc5575..HEAD      # everything that landed after the review
git diff 2fc5575..HEAD -- src/       # ...and whether any of it touched the code
```

That is the point of writing the sha down. "Nothing was changed behind the reviewers'
backs" is a claim; the diff is a fact. Same rule this codebase applies to commit
verification — a claim gets stored as a claim, and anything that can be derived gets
derived.

The first entry that command shows will be the commit that added this file. That is
expected: annotating a review necessarily happens after it.

**When code changes after a review**, the honest move is to say so and get it re-reviewed,
not to update this sha. A sha here that was never actually reviewed is worse than no sha
at all — it spends credit that was never earned.

---

## Knowingly deferred

> The terminal adapter, listed as deferred while the first review ran, has since been built
> — see [TERMINAL.md](TERMINAL.md). What follows is still deferred.

Things found *after* the review closed, deliberately not fixed in place. Each would have
been a small change; making it anyway would quietly invalidate the review, and what gets
invalidated is not the sha — it is the credibility of reviewing at all. The next review
would have to be caveated with "as of the commit I saw, no guarantees since", and a
caveated review is worth much less than a clean one.

### An order can wake the person who filed it

Filing work for yourself pings you about it. Harmless, but it is noise, and noise in a
notification channel is expensive: it teaches people to skim.

The fix is **not** the one-liner it looks like. Three things, all confirmed by reading the
code rather than assuming:

1. **The signature has to change.** `wakeAssignee(order, text)` never receives the actor,
   and all three call sites pass two arguments.
2. **The existing self-dispatch guard cannot catch this**, because the wake-up is emitted
   with `sender: 'system'` — so the comparison is between `system` and the target, which
   is never equal. The guard in `identity.js` covers a *different* path: an agent's own
   message mentioning itself. Two things both called "self-wake", two separate pipes. The
   mutation in `mutation-check.sh` covers the other one, not this one.
3. **Normalise before comparing.** The actor may arrive as a display name while the
   assignee is stored as a canonical id; `===` on the raw values silently misses.

The criterion is `actor !== assignee`, applied at all three call sites — including resume,
where it matters in both directions: *someone else* un-blocking my order should ping me;
me un-blocking my own should not.

### `@mentions` are matched as plain substrings

Quoting code or a chat log that contains `@name` really does wake that person. It bites
hardest when discussing the dispatch mechanism itself, since any worked example contains
mentions.

A real fix means skipping code fences and quoted spans, which is neither small nor safe to
bolt onto the hottest path in the system. Until then it is a known limitation, listed in
the README, and the workaround is to write examples with a placeholder name.

### Word-boundary mentions

Related but separate: prefix collisions are refused at startup rather than resolved at
match time. That is a deliberate trade — refusing an ambiguous roster is louder than
guessing — but proper boundary matching would remove the restriction entirely.
