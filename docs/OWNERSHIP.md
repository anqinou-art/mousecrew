# One agent, one repo

This is the rule that decides whether a crew of agents is still workable in month two.

## The rules

1. **One agent, one repo.** Each crew member works in its own tree and does not enter
   anyone else's.
2. **One writer per codebase.** Frontend work goes to the frontend agent. Even when the
   backend agent is idle. Even when it is one line.
3. **One merge gate.** Exactly one agent may take work past review into the main branch.
4. **Deployment trees are read-only.** They fast-forward and nothing else. Nobody edits
   them, ever, not even to fix something small.

Rules 1–3 are enforced by the code. Rule 4 cannot be — it lives outside this system — so
it is the one you have to hold yourself.

## Why, concretely

### Agents do not hesitate

A person editing code they do not own feels it. They slow down, they check, they ask. That
hesitation is doing real work: it is the thing that stops two people quietly rewriting the
same file in different directions.

Agents have no such reflex. Point two of them at one tree and each will finish its own half
of the same file, completely and confidently, with a tidy commit message. Neither will
mention any doubt, because neither had any. You then get to work out which half is real,
usually while something is broken.

They also forget. A fresh context window does not remember editing that file yesterday, so
"I already changed this" is not information the system has.

### A deployment tree that gets edited stops accepting deployments

A tree that only fast-forwards can be edited exactly once before it refuses to pull. After
that every deployment fails.

The failure is not loud and it is not immediate. What you see, days later, is one order that
cannot ship, then a second order blocked behind it, then a whole lane stopped — and the
cause is a one-line edit somebody made directly on the deployment machine because it was
faster than opening a branch.

The rule that comes out of that: **merged is not the same as shipped.** After merging,
check that the target tree can still fast-forward. Watching a merge succeed proves nothing
about whether it can be deployed.

### The variant that bites twice

An agent writes a file directly into a working tree. Somewhere else, that file gets
committed into git. Nobody removes the original. Now two copies exist, both live, drifting.

The convention that fixes it: **whoever commits it, removes the original.** And when you
find an untracked file, ask which case you are in before doing anything — is it already in
the repository (then it is leftover, remove it after comparing), or is this the only copy
that exists (then it needs committing, not deleting)? Those two look identical in
`git status` and the wrong guess destroys work.

## How it is enforced

Each agent declares what it owns:

```json
{ "id": "backend",  "repos": ["server"], "canMerge": false }
{ "id": "auditor",  "repos": ["server"], "canMerge": true  }
{ "id": "frontend", "repos": ["app"],    "canMerge": false, "selfManaged": true }
```

Each order names its repo. Assigning across that boundary is refused, and the refusal says
who should have it:

```
$ agentdesk create --title "..." --assignee frontend --repo server
HTTP 409
{
  "error": "\"frontend\" does not own repo \"server\" (owns: app) — assign it to whoever
            does instead of letting it edit a tree it doesn't manage",
  "owners": ["backend", "auditor"]
}
```

The merge gate is checked the same way:

```
$ agentdesk audit-pass WO-001 -s backend
HTTP 403
{ "error": "only \"auditor\" may merge (single gate); \"backend\" may not" }
```

A roster with two merge gates is refused at startup rather than at the moment it matters.

### Escape hatches, on purpose

- An agent with **no `repos` list** is unrestricted. In a single-repo setup the whole
  feature would be noise, and a rule that gets in the way for no benefit is a rule people
  route around.
- An order with **no repo** is unscoped and can go to anyone. Forcing a repo onto every
  chore just teaches everyone to type a fake one.
- **`selfManaged: true`** marks a lane that ends at human acceptance instead of the audit
  gate — for work the reviewing agent physically cannot reach, like a build on someone
  else's laptop. Sending it to review would park it in a queue nobody can clear.

## Dispatching follows ownership

Give the work to whoever owns the repo, not to whoever happens to be free.

The cost of misdirecting work is not that it comes back slightly worse. It is that changes
now exist in a tree that nobody expected them in — and that is the kind of thing you spend
days unwinding, not minutes.
