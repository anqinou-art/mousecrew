# mousecrew

**A group chat and a work board for CLI coding agents.**

*中文版：[人话版说明](docs/README.zh-CN.md) — 同样的内容，写给不看代码的人。*

You have a few AI coding assistants. Today you talk to each of them in its own window, keep
track of who is doing what in your head, and lose the thread the moment you walk away from
the machine.

mousecrew turns them into a crew you can run from anywhere:

```
you (phone, laptop, curl)
        │  "@backend the login endpoint is returning 500s"
        ▼
  ┌───────────────────────────────────────────────┐
  │  group message  →  who was @mentioned?        │
  │  work order     →  what state is this in?     │
  └───────────────────────────────────────────────┘
        │                    │                  │
   headless CLI        another machine     a terminal window
   on the server       over a socket       you also use
```

The top half — the group, the board, the chasing, the merge gate — does not care where a
crew member lives. That separation is the whole design.

---

## What it actually does

| | |
|---|---|
| **One group everybody is in** | You and every agent, one message stream, full history. One write path, so one agent never shows up under three names. |
| **`@name` actually wakes them** | Names are normalised first, so an agent is never woken by its own words (the classic infinite loop). |
| **Work orders with nine states** | `draft → in_progress → submitted → auditing → pending_restart → closed`, plus pause, reject, and a real cancel edge. |
| **Blocking that schedules itself** | Pause order B on order A. When A closes, B goes back to work automatically — nobody has to remember. |
| **Chasing the right person** | Every 5 minutes: whoever currently owes an action. Delivered work is never chased. |
| **Claims are verified** | An agent reports a commit; the server derives the file list from git itself, or records that it could not. |
| **One repo per agent** | Assignment is *checked*. An agent cannot be handed work in a tree it does not own. |
| **A single merge gate** | Exactly one agent may take work past review. Configured, not conventional. |
| **Lifecycle you don't babysit** | Lazy start, queueing, idle shutdown, session resume, crash recovery, hang detection. |
| **Context watch** | Warns an agent when its window is nearly full — measured in *turns remaining*, not percent. |
| **Direct messages** | Talk to one agent privately, with a visible receipt when a message could not be delivered. |
| **Threads for what the board misses** | The half-finished thing, the idea from last night. Five states, an append-only log, and one `next` field holding the handle you left behind. |

## What it does not do

- **It does not host models or hold your API keys.** Your CLIs do that. This moves text in and out of them.
- **It does not write code.** It is the desk the crew works at.
- **It does not deploy or restart anything.** It prepares and it tidies up; a human presses the button.
- **It is not an IDE plugin.** Its subject is how several agents share work, not how one agent writes a function.

---

## Quick start

```bash
git clone <this repo> mousecrew && cd mousecrew
npm install

cp config.example.json config.json
cp agents.example.json agents.json      # edit: who is on your crew

mkdir -p ~/.config/mousecrew
printf '{"token":"%s"}' "$(openssl rand -hex 32)" > ~/.config/mousecrew/auth.json
chmod 600 ~/.config/mousecrew/auth.json

npm start
```

```
mousecrew on http://127.0.0.1:8787 — 3 agents registered
  @backend      local     repos: server
  @auditor      local     repos: server  [merge gate]
  @frontend     remote    repos: app
```

Then drive it:

```bash
node bin/mousecrew.js create --title "fix the login endpoint" --assignee backend --repo server -s me
node bin/mousecrew.js say --as me "@backend see WO-001 when you get a chance"
node bin/mousecrew.js list
node bin/mousecrew.js status
```

`bin/mousecrew.js` with no arguments prints every command.

### Try it without any AI at all

Point an agent at `/bin/cat` and it becomes an echo bot — enough to watch a message travel
all the way through and an order walk the whole lane:

```json
{ "id": "echo", "transport": "local", "runner": "exec",
  "exec": { "command": "/bin/cat" }, "workDir": "/tmp" }
```

---

## The three kinds of crew member

Set `transport` per agent. Everything above this layer is identical for all three.

**`local`** — a CLI process on this machine, managed for you.
Runs on demand and exits when idle; the session id is kept so the next wake resumes the
same conversation. Two runners: `claude` (a CLI speaking newline-delimited JSON both ways)
and `exec` (any command that reads a prompt on stdin and prints a reply — one process per
message, no session continuity).

**`remote`** — a CLI on another machine.
Run `bin/mousecrew-worker.js` there; it dials out, so the other machine needs no inbound
port. Use it when the work is physically tied to a box — a build toolchain, a key, a device.

```bash
MOUSECREW_URL=http://server:8787 MOUSECREW_TOKEN=... \
  node bin/mousecrew-worker.js --agents frontend --workdir ~/myapp --cli claude
```

**`terminal`** — an interactive window you are also using.
Messages are typed into the window as if you had typed them. You can watch the work happen
and interrupt mid-thought. Needs a terminal multiplexer — [tmux](https://github.com/tmux/tmux)
or [cmux](https://cmux.com) — and one sidecar process on that machine:

```bash
node bin/mousecrew.js identity scout   # run inside the window that answers to @scout
node bin/mousecrew-sidecar.js          # anywhere on the same machine
```

[docs/TERMINAL.md](docs/TERMINAL.md) covers what a window buys you over headless, how busy
is decided, why messages expire, and what an adapter is and is not responsible for.

| | local / remote | terminal |
|---|---|---|
| Available when your laptop is closed | yes | no |
| Can you interrupt mid-task | no | yes |
| Message never dropped | queued | expires after 10 minutes |
| Lifecycle managed by | mousecrew | you |

---

## One agent, one repo

The rule that keeps this usable past week one:

1. **One agent, one repo.** Each agent works in its own tree.
2. **One writer.** Frontend work goes to the frontend agent — even when the backend agent
   is free and it is only a one-line change.
3. **One merge gate.** Exactly one agent may push work past review.
4. **Deployment trees are read-only.** They fast-forward. Nobody writes in them.

Rules 1–3 are enforced by this codebase — a misdirected assignment comes back `409` with a
list of who does own that repo. Rule 4 is yours to keep.

Why this matters is in [docs/OWNERSHIP.md](docs/OWNERSHIP.md); the short version is that a
person editing unfamiliar code hesitates and an agent does not. Two agents in one tree will
each complete their own half of the same file, confidently, and you get to work out which
half is real.

---

## Design notes

Things that look like small details and are not. Each of these replaced a version that
failed quietly rather than loudly.

**One write path for group messages.** Every message goes through a single function that
writes the database, the archive, and the live stream. A previous version had seven write
sites and three spellings of one agent's name — and a reader concluded the system was
running agents that had been retired months earlier. Wrong beliefs about your own topology
cost more than duplicate rows.

**Normalise before you compare.** An agent has an id, a display name and aliases. Compare
raw strings and "don't wake the sender with their own message" silently never fires: the
agent wakes itself, replies, and wakes itself again.

**Prefix collisions are refused at startup.** `@arch` matches inside `@architect`, so a
roster containing both is rejected before the server binds. A crew member that wakes for
messages addressed to someone else reads as flakiness, not as misconfiguration.

**Deliver twice before dropping once.** There is no de-duplication window on dispatch. A
previous "ignore a second mention within 120s" rule swallowed genuinely different messages
in busy discussions, and the sender had no way to know.

**Check the door before doing the work.** Order transitions validate legality *before*
running any git subprocess. The endpoint is reachable by anyone holding the token, and a
synchronous fork stalls the entire event loop, not just that request.

**Never store a claim as a fact.** The commit hash is recorded as claimed; the file list is
derived from git or left null. Storing a self-reported list in a column named
`files_changed` does not make it true — it just moves untrusted data somewhere it looks
official and destroys the only use it had.

**Fail open when you might drop work; fail closed when you might leak.** A wake-up whose
freshness cannot be checked is delivered anyway (waking twice is annoying; silence means
work sits untouched). A request whose token cannot be verified is refused. Same codebase,
opposite defaults, both deliberate.

**Turns remaining, not percent full.** An agent at 60% growing 15k per turn has five turns
left. One at 75% growing 2k has twenty-five. Sorted by percentage you help the wrong one.

**Local time in logs.** A timestamp in a timezone the machine does not use makes a healthy
job look like it died hours ago. That cost an investigation once already.

---

## API

All endpoints require `Authorization: Bearer <token>`. There is no grace mode.

| | |
|---|---|
| `GET /api/group/events` | live stream (SSE) |
| `GET /api/group/history?limit=` | backfill after a gap — how clients recover, not a convenience |
| `POST /api/group/chat` | a human speaks |
| `POST /api/group/post` | an agent replies |
| `GET/POST /api/orders` | list / create |
| `GET /api/orders/:id` | one order with timeline and logs |
| `POST /api/orders/:id/transition` | move it; optional `commit_hash`, `git_branch` |
| `POST /api/orders/:id/pause` `/resume` `/assign` | blocking and assignment |
| `POST /api/orders/:id/logs` | append an agent log line to the order |
| `POST /api/orders/restart-done` | close everything that was waiting on a restart |
| `GET/POST /api/threads` | list / open a thread |
| `GET /api/threads/:name` | one thread with its plan and log |
| `PATCH /api/threads/:name` | set one field — `plan` and `snapshot` are refused here by design |
| `POST /api/threads/:name/log` | append a line; must declare one intent |
| `POST /api/threads/:name/plan` `/plan/:n/check` `/uncheck` | rewrite the plan, tick, un-tick |
| `POST /api/threads/:name/finish` | the only road to `done`; requires a snapshot |
| `POST /api/threads/:name/archive` | soft delete; needs a reason if there is no snapshot |
| `GET /api/agents/status` | every crew member |
| `POST /api/agents/:id/session/new` | rotate to a fresh context window |
| `POST /api/agents/presence` | terminal agents report themselves |
| `POST /api/agent/:id/chat` | direct message to one agent |
| `GET /api/dm/events`, `/api/dm/pending`, `POST /api/dm/:id/post`, `/ack` | the DM lane |
| `WS /ws/bridge?token=` | remote workers |

---

## Threads

An order is work that goes through the board. A thread is work that does not — the idea
from last night, the thing you got halfway through, the one you meant to come back to.
Those are the ones that get lost, because nothing was ever opened for them.

```
mousecrew thread new caching --owner backend --goal "cut cold-start latency"
mousecrew thread plan caching "write the schema
write the routes
add tests"
mousecrew thread log caching --who backend --what "schema is in, not deployed" --check 1
mousecrew thread set caching next "wire the router into server.js"

mousecrew thread list
  doing    backend    1/3    caching
                             ↳ wire the router into server.js
```

That last line is the whole point. An agent forgets between windows; a person forgets over
a weekend. `next` is written when the work is put **down**, not when it is picked up.

Five gates, and each one exists because the shape it prevents is one you cannot see:

- **`set` cannot write `plan` or `snapshot`.** Both have their own endpoints. Through a
  generic field-setter, "replace the plan" and "record progress on it" become one call.
- **A log line declares one intent** — ticked item N, plan changed, or progress with the
  plan unchanged. The server does not need to know; the writer does. An agent that never
  has to choose writes *"continuing work on this"* forever.
- **The log cannot be rewritten or deleted**, by anyone, including whoever wrote it five
  seconds ago having realised it was wrong. Corrections go on the next line. This is a
  trigger in the schema, not a check in a handler — a rule in one handler is a rule until
  somebody writes a second handler.
- **The only road to `done` is `finish`, which needs a snapshot.** Otherwise *"mark it
  done, I'll write the snapshot after"* becomes a path, and after is a place nobody goes.
- **Archive is a soft delete**, and archiving without a snapshot needs a stated reason.
  Not refused outright: a thread can be legitimately abandoned or folded into another one,
  and blocking that only teaches people to write a fake snapshot to get through the door.

Ticking is reversible; the log is not. The plan is where you are now, the log is what
happened. Conflating those is what makes plans drift optimistic.

The design write-up, including the version that needs no server at all — a folder, a
two-line header, and one rule about writing down where you left off — is in
[docs/THREADS.zh-CN.md](docs/THREADS.zh-CN.md).

---

## What was reviewed

Two independent reviews ran against commit `2fc5575` — one for leaked private data, one for
whether the logic closes. Everything they found was fixed before that sha was recorded.

```bash
git log --oneline 2fc5575..HEAD    # what landed after the review
```

[docs/AUDIT.md](docs/AUDIT.md) carries that sha and the list of things found afterwards and
knowingly left alone. Writing the sha down is the point: *"nothing changed behind the
reviewers' backs"* is a claim, and the diff is a fact.

The terminal adapter was built after that sha and reviewed separately; the same file says
what that review found and what else has touched `src/` since, rather than quietly moving
the sha forward.

## What an order remembers

`GET /api/orders/:id` (CLI: `mousecrew show <id>`) returns the row plus two records that are
kept separately, because they answer different questions.

**The timeline** — one entry appended on every state change, by the state machine itself, not
by whoever moved it:

```json
{ "from": "submitted", "status": "auditing", "actor": "auditor",
  "ts": "2026-08-20T11:04:22.104Z", "comment": "picked up",
  "commit_hash": "d97462a", "files_changed": 5 }
```

`from` and `status` make each entry readable on its own — you never have to diff against the
previous row to know what moved. Structured fields (`commit_hash`, `git_branch`,
`files_changed`) are merged in *by the transition that wrote the columns*, so the entry and
the row cannot disagree.

This is what makes the review gate checkable rather than assumed. The worst bug found in this
codebase's own review was an order reaching a terminal state with **no audit entry in its
timeline** — the gate was watching one door and the order walked through another. That is a
question you can only ask if every move left a line behind.

**Agent logs** — free-form notes attached to an order, one row each
(`agent_name`, `action`, `detail`, `ts`). The state machine never writes here; agents and
people do, via `POST /api/orders/:id/logs` or `mousecrew comment <id> "…"`. Assignment
changes also land here.

The split is deliberate: **the timeline is what the system did, the logs are what people and
agents said about it.** Mixing them would mean a chatty agent could bury the audit trail, and
that an entry's presence would no longer prove anything.

## Known limitations

Stated plainly, because you will meet them.

- **One sidecar drives one multiplexer.** A roster mixing adapters needs a second sidecar;
  the process refuses to start rather than silently ignoring half the crew.
- **A terminal agent that is always busy misses messages.** Injection only happens when the
  window is idle, and a window doing continuous work is never idle; those messages expire
  after ten minutes. Group history still has them, and undelivered DMs come back with a
  receipt — but "your message was dropped because you were working" is not solved. Headless
  agents queue instead and are unaffected.
- **Transitions record the actor but do not authenticate them.** Anyone with the token can
  act as anyone. Repo ownership and the merge gate *are* enforced — but on a *claimed*
  identity, so the gate stops an honest mistake, not a caller who names someone else.
- **Group history is capped at 200 messages per request.** A client offline long enough to
  fall further behind than that cannot recover the gap from this endpoint.
- **The group stream has no server-side delivery guarantee.** Clients must reconcile
  against `/api/group/history`; that is the design, not an oversight.
- **`exec` agents have no memory between messages.** One process per message. Whatever the
  CLI remembers, it remembers on its own.
- **`@mentions` are matched as plain substrings.** Quoting code or a chat log that contains
  `@name` really will wake that person. Use a placeholder in examples.
- **Filing an order for yourself pings you about it.** Noise, not breakage; the fix is
  scoped in [docs/AUDIT.md](docs/AUDIT.md).

## Built on

- **[tmux](https://github.com/tmux/tmux)** — the first terminal adapter targets it, and the
  live test runs against a real tmux server.
- **[cmux](https://cmux.com)** — the second adapter. Having two implementations is what keeps
  the adapter interface honest: with one, "the abstraction" is just that multiplexer with
  extra steps. The bug that shipped in this package (a format string two tmux versions render
  differently) was caught precisely because the two behave differently.

Neither is vendored here. mousecrew shells out to whichever binary you have.

## Roadmap

- **Actor authentication** — per-agent tokens, so `actor` means something.
- **Word-boundary mentions** — so a prefix collision becomes a non-issue instead of a
  startup refusal.

## Tests

```bash
npm test
```

The suite is the specification for everything above that is stated as a rule: the
self-wake guard, the ownership refusal, the single merge gate, every state edge including
the ones that must be refused, fail-open vs fail-closed, merge-commit file lists, the
lifecycle under a stubbed CLI, and the turns-remaining arithmetic.

**Rules are tested at the route, not only as functions.** A suite of unit tests can prove
every decision is correct while a handler quietly stops asking for one — delete an
enforcement point and a function-only suite stays green with the gate wide open. So
`test/routes.test.js` speaks HTTP.

And that claim is itself checked, rather than asserted:

```bash
./scripts/mutation-check.sh              # 18 mutations, each must turn the suite red
./scripts/mutation-check.sh --list       # what they are
./scripts/mutation-check.sh --self-test  # can this checker still notice failure?
```

Each mutation removes one rule this project claims to enforce — the merge gate, the audit
bypass guard, ownership on assignment, the token guard's fail-closed branch, staleness on
either transport, the self-wake guard, startup refusal of ambiguous mentions. A mutation
that *survives* is the interesting outcome: it means the rule is unguarded and whatever
assertion appeared to cover it was decoration. The script exits non-zero in that case, so
it can gate a merge.

Two rules that came out of running it in anger:

- **Every assertion deserves a mutation that makes it red.** An assertion you cannot make
  fail is not a test, and a check that never goes red is worse than no check at all —
  it spends the credit of "this part has been verified".
- **Nothing is mutated in your working tree.** Everything runs in a throwaway copy. An
  earlier version edited the real tree, timed out mid-run, and left a security gate
  deleted on disk.
- **Run the suite on a second machine, not just yours.** The most expensive bug in this
  package was a terminal format string that two tmux versions render differently. It could
  not appear on the machine it was written on, and no amount of care there would have found
  it. `npm test` elsewhere takes seconds. Keep the mutation loop local, though — it is the
  whole suite times eighteen, a load spike rather than a check.
- **The checker is itself checked.** `--self-test` drives the real pass/fail parsing
  against files whose outcome is known: a clean suite, a cancelled test, a suite that
  never finishes, and a mutation whose pattern has drifted. It found two ways this script
  had been lying:
  - reading only `pass`/`fail` called a *cancelled* suite green — and on the baseline
    check that means all 18 mutations run against a suite that was never green;
  - a test file leaving a live handle never exits at all, so the checker waited forever,
    which from the outside is indistinguishable from working. There is a wall clock now.
    (A newer Node *cancels* that file instead of hanging — the probe asserts the verdict,
    not the mechanism, so it holds on both.)
  - a mutation snippet that failed for any reason left the source untouched, and an
    untouched source always passes: a guarded rule reported as unguarded. Any non-zero exit
    now counts as not-applied.

Cleanup is registered with `t.after()` rather than at the end of each test body: a suite
that hangs the moment it goes red is barely easier to read than one that never goes red,
because you cannot tell "broken" from "stuck".

## License

MIT
