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

## What has landed since, and how it was covered

Applying that rule to this repo's own history, rather than leaving the reader to work it
out from the log:

- **The terminal adapter and sidecar** were built after that sha and reviewed on their own
  — the review found two, both fixed in `e2487c7`: a tmux format string that two tmux
  versions render differently (every window read as unclaimed on the older one, with no
  error anywhere), and an expiry receipt that could be lost by a failed send. That review
  is not folded into the sha above, because a sha should name a commit somebody actually
  read end to end.
- **Later feature work now exists after that baseline**, including work-order, delivery, and
  session changes described in [CHANGELOG.md](../CHANGELOG.md). The baseline sha remains
  historical: the `git diff` command above shows exactly what it does not cover.

---

## Knowingly deferred

> The terminal adapter has since been built, and work-order notices now suppress self-wakes
> after normalising identities. The mention-matching limits below remain deferred.

Things found *after* the review closed, deliberately not fixed in place. Each would have
been a small change; making it anyway would quietly invalidate the review, and what gets
invalidated is not the sha — it is the credibility of reviewing at all. The next review
would have to be caveated with "as of the commit I saw, no guarantees since", and a
caveated review is worth much less than a clean one.

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
