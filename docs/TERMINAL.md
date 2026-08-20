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
| Message never dropped | queued | expires after 10 minutes |
| Lifecycle managed by | mousecrew | you |

## Setting one up

```jsonc
// agents.json
{ "id": "scout", "displayName": "scout", "transport": "terminal",
  "terminal": { "adapter": "tmux", "target": "scout", "busyPattern": "esc to interrupt" } }
```

Then, **inside the window you want to use**:

```bash
mousecrew identity scout
```

and somewhere on the same machine:

```bash
mousecrew-sidecar
```

`identity` claims the window. It also *releases* the name from any other window holding it,
because two windows answering to one name is not a tie — it is a message typed into
whichever one the resolver happened to pick, and after a session restore that is often the
dead one.

## How a message gets there

```
group message
   → who is addressed?          (ids normalised first — see below)
   → which window claims them?  (looked up fresh, never cached)
   → is that window busy?       (read the screen)
        busy  → wait, retry, and give up after 10 minutes
        free  → type it in, press Enter
```

**Busy is decided by reading the screen** and looking for the CLI's own marker
(`busyPattern`). That sounds crude next to asking the tool how it is doing, and it is more
reliable: measured side by side for twenty minutes, one CLI's "am I busy" field never
returned to idle after finishing while another's did. Same field, two behaviours. A status
that is wrong in the *still working* direction is worse than no status, because it looks
like work.

The status a dashboard shows comes from the same reading, so it cannot contradict what
delivery is doing.

**Messages expire after ten minutes.** Not tidiness: a window busy for an hour comes back
to twenty instructions from twenty minutes ago and starts answering questions that were
settled long since — worse than silence, because it looks like engagement. The group
history is the source of truth and can be re-read on demand. An instruction that was
followed cannot be un-followed.

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

**Structured events** carry every decision the sidecar makes — queued, busy-wait, injected,
expired, no-window. Assertions and mutations all target this layer, against an in-memory
adapter. A screen assertion answers two questions at once (did we do the right thing, and
did the terminal render it) and a red one cannot tell you which.

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

**tmux** stores identity in a pane option (`@mousecrew_identity`) rather than the window
name. Window names belong to the person using the terminal; their shell rewrites them, their
editor sets them back. Writing identity there means fighting the user for a field they own,
and losing intermittently.

**cmux** stores it in the workspace description. One caveat that does not generalise and
will bite anyone porting this: cmux authorises its control socket by *process ancestry*, not
by environment. A sidecar started outside cmux connects to the bus, receives everything, and
then fails to type a single character — while still consuming the messages. It must be
started from inside cmux.

## Known limitations

- **A window that is always busy never receives anything.** Injection happens only when the
  window is free, and a window doing continuous work is never free; those messages expire.
  Group history still has them and undelivered direct messages are reported — but *"your
  message was dropped because you were working"* is not solved.
- **`@mentions` are matched as plain substrings.** Quoting a chat log or a code sample that
  contains `@name` really will wake that person. It bites hardest when discussing this
  mechanism, since any worked example contains mentions.
- **One sidecar drives one multiplexer.** A roster mixing adapters needs a second sidecar;
  the process refuses to start rather than silently ignoring half the crew.
