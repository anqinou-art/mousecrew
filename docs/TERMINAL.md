# Crew members that live in a terminal window

Most of the crew runs headless: a process starts, answers, and exits. This document is
about the other kind — an agent running in a terminal window *you are also using*, where
you can watch it work and interrupt it mid-thought.

Messages reach that window by being **typed into it**, the same way you would type them.

## Why bother, when headless is simpler

Headless is better at almost everything: available while your laptop is shut, queued
instead of dropped, restarted when it crashes, resumed when it wakes. Use it by default.

A terminal window buys exactly one thing, and it is not small: **you can see the work
happening and change your mind in the middle of it.** For anything exploratory — where the
answer is arrived at rather than produced — that is worth the fragility.

| | headless (`local` / `remote`) | terminal |
|---|---|---|
| Available with your laptop closed | yes | no |
| Interrupt mid-task | no | yes |
| Busy delivery | queued | one forced attempt after 10 minutes, then expires |
| Lifecycle managed by | mousecrew | you |

## Setting one up

```jsonc
// agents.json
{ "id": "scout", "displayName": "scout", "transport": "terminal",
  "terminal": { "adapter": "tmux", "target": "scout" } }
```

Then, **inside the window you want to use**:

```bash
node bin/mousecrew.js identity scout
```

and somewhere on the same machine:

```bash
node bin/mousecrew-sidecar.js
```

`identity` claims the window. It also *releases* the name from any other window holding it,
because two windows answering to one name is not a tie — it is a message typed into
whichever one the resolver happened to pick, and after a session restore that is often the
dead one. Moving an identity also invalidates a session record tied to the released window.

## Optional session-rotation reminders

For Claude Code, three hooks can tell mousecrew which transcript belongs to this window
and whether the current turn is active. Mousecrew deliberately does not scan processes,
recent files, or working directories to guess the answer: without a `SessionStart` record,
the sidecar does not measure that agent.

Add a hook like this to Claude Code's settings, using absolute paths for your checkout:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "MOUSECREW_ROOT=/absolute/path/to/mousecrew node /absolute/path/to/mousecrew/bin/mousecrew.js session-record --as scout"
      }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "MOUSECREW_ROOT=/absolute/path/to/mousecrew node /absolute/path/to/mousecrew/bin/mousecrew.js session-activity --as scout busy"
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "MOUSECREW_ROOT=/absolute/path/to/mousecrew node /absolute/path/to/mousecrew/bin/mousecrew.js session-activity --as scout idle"
      }]
    }]
  }
}
```

Claude Code passes the hook JSON on stdin. `session-record` requires its `session_id` and
`transcript_path`; malformed or incomplete input exits nonzero, never writes a partial
record, and invalidates an older record for the same window. The window reference comes,
in order, from `--window`, `MOUSECREW_WINDOW`, or
`TMUX_PANE`. tmux supplies `TMUX_PANE`; for another adapter, arrange one of the first two.
The resulting per-agent record lives under `data/sessions/` beside the sidecar state, is
mode `0600`, and is atomically replaced when a new session starts. `UserPromptSubmit` and
`Stop` write activity and its timestamp into that same record only when both the window and
session id still match. They never create a second source of session truth.

Configure one rule or an array of rules on the terminal agent:

```json
{
  "terminal": {
    "adapter": "tmux",
    "target": "scout",
    "rotation": [
      { "kind": "tokens", "limit": 120000 },
      { "kind": "marker", "marker": "\"type\":\"compacted\"", "limit": 10 }
    ]
  }
}
```

`tokens` reads only the final 128 KiB of a Claude-style JSONL transcript and uses the last
reported `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. `marker`
counts whole-file lines containing the configured literal string. With multiple rules, any
one reaching its limit is enough. An unreadable transcript or unrecognised usage is unknown,
not zero and not a reason to guess.

The sidecar checks every `delivery.rotationPollMs` (default five minutes). It measures only
when the record's window is the one currently claiming that identity, keeps at most one
reminder queued for an agent/session, and can remind again in a later hour while the same
session remains over its limit. A reminder waits for the normal busy and input-box gates,
but never expires, never becomes a forced interruption, and never joins a message batch.
Immediately before typing it, the sidecar verifies the recorded `(window, session)` again:
an explicit mismatch discards the stale reminder; temporarily unreadable evidence leaves it
queued. The message names the current measurement, configured limit, and today's handoff
path under `contextWatch.handoffDir/<agent>-handoff/`.

This is only a reminder. Mousecrew does not rotate an interactive terminal session; finish
the current work, write the handoff, and start the new session yourself.

## How a message gets there

```
group or direct message → resolve its recipient ┐
local wake JSON → validate and persist it       ┘
    → which window claims them?  (looked up fresh, never cached)
    → is that window busy?       (matching hook activity, else screen fallback)
        busy  → wait; after 10 minutes, force one delivery attempt (except local wakes)
        free  → is input text changing?  (same screen read; configured agents only)
                  yes → wait for it to become quiet
                  no  → batch consecutive group messages, type once, press Enter
```

Direct messages are never included in a group batch: each one has its own delivery receipt.
When several direct messages for one agent expire together, they do share one forced
injection to avoid repeated interruptions, but each original message still gets its own
receipt. Set `delivery.batchGroup` to `false` for the previous group-message behaviour.

If one message body or a combined batch body exceeds `delivery.inlineLimit` (default 600
characters), the sidecar stores the full delivery in a private `0600` file under its state
directory. It types only the prefix and file path into the window, with an instruction to
read the file before replying. A storage failure falls back to the complete inline delivery,
so shortening the terminal input can never become message loss.

**Busy uses matching hook activity first.** The `UserPromptSubmit` / `Stop` pair above is
the reliable path for current Claude Code. During streamed prose, Claude Code 2.1.278 does
not keep a busy marker on screen; the only visible change may be that the answer grows, so
no fixed screen regular expression can cover the whole turn.

If there is no matching hook activity, mousecrew falls back to reading the screen and
looking for `busyPattern`. This remains useful for older versions and the first instant of
thinking, but a layout change can make it miss work. An agent-specific
`terminal.busyPattern` overrides the built-in Claude Code default. `mousecrew status`
labels each terminal agent's activity source as `hook` or `screen`, and the dashboard uses
the same verdict as delivery. After changing hooks or upgrading a CLI, run a slow turn and
confirm that status reports `busy activity hook`; with a message waiting, the sidecar
should also emit `busy-wait` with source `hook`.

If Claude Code exits after the busy hook and never runs `Stop`, the record remains busy.
Mousecrew does not add a second activity timeout: the existing rule still makes one forced
delivery attempt after ten minutes.

**Input-box protection is opt-in per terminal agent.** Set `terminal.inputBox` to
`"claude-code"` to recognise the prompt between Claude Code's bottom two horizontal rules.
Changing text delays injection; unchanged text is released after `delivery.draftQuietMs`
(default two minutes), so placeholder text or an abandoned draft cannot block forever.
Empty and unrecognised layouts do not block. A different CLI or a TUI layout change therefore
degrades to the previous behaviour instead of guessing. This check reuses the screen already
read for the busy decision; it does not extend the terminal-adapter contract.

**A message blocked by a busy window gets one forced attempt after ten minutes.** This can
interrupt work, deliberately: one interruption is preferable to a continuously busy agent
never receiving anything. The attempt is recorded before text is sent, so a failure or
restart cannot turn the two-minute `delivery.forcedGraceMs` window into a retry loop. Once
that grace period ends, the message expires. A message with no window, or one that remained
queued while the window was idle for reasons other than the input-box gate, expires without
a forced attempt. A persisted input-box hold earns the same one attempt as a busy window. Set
`delivery.forceOnExpiry` to `false` to expire every message at the original cutoff.
Forced delivery still checks the input box, but waits there for at most
`delivery.forcedDraftHoldMs` (default 90 seconds) before deliberately interrupting.

## Local wake directory

Set `delivery.wakeDir` to let another program on the same machine ask a terminal agent to
look at something without holding an API token. Each `.json` file contains `agent`, `key`,
`content`, and optional `sender`. The sidecar resolves agent aliases through the configured
roster, caps content at `delivery.wakeMaxContent` (default 600 characters), and uses the key
for durable deduplication. Requests from the same `(agent, sender)` merge while one fresh
wake is already queued.

Write elsewhere and rename into the directory so the sidecar never sees a partial file:

```sh
tmp=$(mktemp ./state/wake/.request.XXXXXX)
printf '%s\n' '{"agent":"scout","key":"build-42","content":"check the local build","sender":"build"}' > "$tmp"
mv "$tmp" ./state/wake/build-42.json
```

The sidecar creates the directory with mode `0700`. There is no application-level
authentication: directory permissions are the boundary, so this entrance is only for local
programs running as the same user. A wake is persisted before its source file is removed.
Invalid files are rejected with an event; malformed JSON younger than
`delivery.wakeSettleMs` (default five seconds) waits for the next pass in case a writer did
not use atomic rename. Wakes are standalone, have no receipt, wait for both the busy and
input-box gates, and expire without forced delivery.

A dropped *group* message is still in the group history. A dropped *direct* message looks,
from the sender's side, exactly like being ignored — so that one is reported back, and shows
up in the thread as an undelivered notice.

## Identities are normalised before they are compared

The single most expensive bug in the system this was extracted from lived here, undetected
for months.

The message bus records a sender by canonical id (`architect`). The local roster may know
the same crew member by a display name (`lead`) — very often in another script entirely,
which is usually *why* the two differ. Compare the raw strings and `'architect' !== 'lead'`
is always true, so *"never deliver a message back to its own author"* silently never fires,
and every group message that agent posts gets typed straight back into its own window.

It hides well, because it only misfires for entries whose display name differs from their
id. Anywhere the two happen to be equal a naive comparison works by accident, so most of a
roster looks fine. There was even a test, and it was green: it passed a *display name* as
the sender, a shape production never produces.

Here, the sidecar and the server resolve identities through the same `buildIdentity()` over
the same roster. Not a convention — there is no second table to drift.

## Testing something that types into a terminal

Two layers, and they answer different questions.

**Structured events** carry every decision the sidecar makes — queued, busy-wait, forced,
injected, forced-injected, expired, no-window. Assertions and mutations all target this
layer, against an in-memory adapter. A screen assertion answers two questions at once (did
we do the right thing, and did the terminal render it) and a red one cannot tell you which.

**One live test** reads a real screen (`test/terminal-live.test.js`). It exists for the one
question events cannot answer: *do the characters actually arrive*. An adapter reporting "I
issued the command" is a claim — the same shape as an agent reporting which files it
changed — and the rule here is that a claim stays a claim while anything derivable gets
derived.

That test's probe is proved to fail before it is trusted: the first assertion feeds it a
screen holding an *earlier* run's output and requires a negative. A probe that cannot go red
is worse than no probe, because it spends the credit of "this was checked".

It skips itself when tmux is not installed, so the suite stays green on machines that
cannot run it — and says so rather than passing quietly.

## Adapters

Five verbs: `listWindows`, `setIdentity`, `clearIdentity`, `readScreen`, `sendText`,
`sendKey`. Adding a multiplexer means adding one file.

Two things are deliberately *not* an adapter's job. Deciding whether a window is busy — that
depends on the CLI running inside it, and an adapter would have to know about every CLI
anyone might run. And declaring that text arrived — an adapter can only report that it
issued a command.

**[tmux](https://github.com/tmux/tmux)** stores identity in a pane option (`@mousecrew_identity`) rather than the window
name. Window names belong to the person using the terminal; their shell rewrites them, their
editor sets them back. Writing identity there means fighting the user for a field they own,
and losing intermittently.

**[cmux](https://cmux.com)** — an open-source terminal built for coding agents — stores it in the workspace description. One caveat that does not generalise and
will bite anyone porting this: cmux authorises its control socket by *process ancestry*, not
by environment. A sidecar started outside cmux connects to the bus, receives everything, and
then fails to type a single character — while still consuming the messages. It must be
started from inside cmux.

**[Paseo](https://github.com/getpaseo/paseo)** uses a terminal's fixed `name` as its
identity. Create the terminal with the same name as `target`, then start your coding CLI
inside it:

```bash
paseo terminal create --name scout
```

```jsonc
{ "id": "scout", "transport": "terminal",
  "terminal": { "adapter": "paseo", "target": "scout" } }
```

Paseo chooses the name when it creates the terminal and cannot rename or clear it later.
That is intentional here: the terminal title is not identity because shells and coding CLIs
rewrite titles during normal use. If the name is wrong, close that terminal and create one
with the right name. If several terminals have the same name, mousecrew refuses the
ambiguity rather than choosing one. For hooks or `identity`, pass the full terminal ID as
`--window`; `identity` verifies that the existing name already matches `target`.

The adapter depends only on Paseo's public command line (`terminal ls`, `capture`, and
`send-keys`), not its internal WebSocket protocol. It was tested with Paseo 0.7.2 and only
targets the local daemon; it neither creates replacement terminals nor connects with
`--host`.

## Known limitations

- **Forced delivery can interrupt active work.** It happens at most once per queued message
  or eligible batch, after the normal ten-minute wait. Disabling `delivery.forceOnExpiry`
  restores expiry without interruption.
- **`@mentions` are matched as plain substrings.** Quoting a chat log or a code sample that
  contains `@name` really will wake that person. It bites hardest when discussing this
  mechanism, since any worked example contains mentions.
- **One sidecar drives one multiplexer.** A roster mixing adapters needs a second sidecar;
  the process refuses to start rather than silently ignoring half the crew.
