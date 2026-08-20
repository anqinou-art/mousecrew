# agentdesk

**A group chat and a work board for CLI coding agents.**

You have a few AI coding assistants. Today you talk to each of them in its own window, keep
track of who is doing what in your head, and lose the thread the moment you walk away from
the machine.

agentdesk turns them into a crew you can run from anywhere:

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

## What it does not do

- **It does not host models or hold your API keys.** Your CLIs do that. This moves text in and out of them.
- **It does not write code.** It is the desk the crew works at.
- **It does not deploy or restart anything.** It prepares and it tidies up; a human presses the button.
- **It is not an IDE plugin.** Its subject is how several agents share work, not how one agent writes a function.

---

## Quick start

```bash
git clone <this repo> agentdesk && cd agentdesk
npm install

cp config.example.json config.json
cp agents.example.json agents.json      # edit: who is on your crew

mkdir -p ~/.config/agentdesk
printf '{"token":"%s"}' "$(openssl rand -hex 32)" > ~/.config/agentdesk/auth.json
chmod 600 ~/.config/agentdesk/auth.json

npm start
```

```
agentdesk on http://127.0.0.1:8787 — 3 agents registered
  @backend      local     repos: server
  @auditor      local     repos: server  [merge gate]
  @frontend     remote    repos: app
```

Then drive it:

```bash
node bin/agentdesk.js create --title "fix the login endpoint" --assignee backend --repo server -s me
node bin/agentdesk.js say --as me "@backend see WO-001 when you get a chance"
node bin/agentdesk.js list
node bin/agentdesk.js status
```

`bin/agentdesk.js` with no arguments prints every command.

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
Run `bin/agentdesk-worker.js` there; it dials out, so the other machine needs no inbound
port. Use it when the work is physically tied to a box — a build toolchain, a key, a device.

```bash
AGENTDESK_URL=http://server:8787 AGENTDESK_TOKEN=... \
  node bin/agentdesk-worker.js --agents frontend --workdir ~/myapp --cli claude
```

**`terminal`** — an interactive window you are also using.
Messages are typed into the window as if you had typed them. You can watch the work happen
and interrupt mid-thought. Needs the terminal adapter — **not in this release**; see
[Roadmap](#roadmap).

| | local / remote | terminal |
|---|---|---|
| Available when your laptop is closed | yes | no |
| Can you interrupt mid-task | no | yes |
| Message never dropped | queued | expires after 10 minutes |
| Lifecycle managed by | agentdesk | you |

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
| `POST /api/orders/restart-done` | close everything that was waiting on a restart |
| `GET /api/agents/status` | every crew member |
| `POST /api/agents/:id/session/new` | rotate to a fresh context window |
| `POST /api/agents/presence` | terminal agents report themselves |
| `POST /api/agent/:id/chat` | direct message to one agent |
| `GET /api/dm/events`, `/api/dm/pending`, `POST /api/dm/:id/post`, `/ack` | the DM lane |
| `WS /ws/bridge?token=` | remote workers |

---

## Known limitations

Stated plainly, because you will meet them.

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

## Roadmap

- **Terminal adapter** (tmux first) — collect interactive windows into the crew: identity
  by window name, back-pressure by reading the screen, a staleness cutoff, delivery receipts.
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
./scripts/mutation-check.sh          # 11 mutations, each must turn the suite red
./scripts/mutation-check.sh --list   # what they are
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

Cleanup is registered with `t.after()` rather than at the end of each test body: a suite
that hangs the moment it goes red is barely easier to read than one that never goes red,
because you cannot tell "broken" from "stuck".

## License

MIT
