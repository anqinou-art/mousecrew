// sidecar-core.js — every decision the sidecar makes, as functions with no IO.
//
// The engine next door does the talking to sockets and terminals. Everything that could
// be *wrong* lives here, where a test can ask it directly and a mutation can break it.
//
// The one structural decision worth defending: this file resolves identities with the
// same `buildIdentity()` the server uses, from the same roster. The system this was
// extracted from kept two name tables — canonical ids on the server, display names in the
// bridge — and they disagreed for months in a way that only affected the single crew
// member whose display name differed from its id. One table, both sides, no drift
// possible. See the note on `mentionTargets`.

const crypto = require('crypto');

const DEFAULT_BATCH_GROUP = true;
const DEFAULT_INLINE_LIMIT = 600;
const DEFAULT_FORCE_ON_EXPIRY = true;
const DEFAULT_FORCED_GRACE_MS = 2 * 60 * 1000;
const DEFAULT_WAKE_MAX_CONTENT = 600;
const DEFAULT_WAKE_SETTLE_MS = 5 * 1000;

// The separator is a NUL byte, written as an escape on purpose: a literal one in the
// source makes git treat this whole file as binary, and `git diff` then answers
// "Binary files differ" to the very question docs/AUDIT.md tells readers to ask.
function fingerprint(...parts) {
  return crypto.createHash('sha1').update(parts.map((p) => String(p == null ? '' : p)).join('\u0000')).digest('hex').slice(0, 16);
}

/** A message as it arrives from either channel, flattened to what delivery cares about. */
function normalizeMessage(row) {
  // Both channels feed this, and one of them is a socket. A malformed frame must produce a
  // useless-but-harmless message rather than take the delivery loop down.
  row = row || {};
  let meta = row.metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { meta = {}; }
  }
  meta = meta || {};
  return {
    sender: String(meta.sender || row.sender || ''),
    content: String((row && row.content) || ''),
    ts: String((row && row.ts) || ''),
    type: meta.type || 'message',
  };
}

function messageKey(row) {
  const m = normalizeMessage(row);
  return fingerprint(m.ts, m.sender, m.content);
}

function parseWakeRequest(raw, {
  identity, terminalIds = [], maxContent = DEFAULT_WAKE_MAX_CONTENT,
} = {}) {
  let body;
  try { body = JSON.parse(String(raw)); }
  catch (error) { return { error: `not valid JSON (${error.message})`, notJson: true }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'top level must be an object' };
  }
  if (typeof body.agent !== 'string') {
    const type = Array.isArray(body.agent) ? 'array' : typeof body.agent;
    return { error: `agent must be a string, got ${type}` };
  }
  const agent = identity && identity.normalizeAgentId(body.agent.trim());
  if (!agent || !terminalIds.includes(agent)) {
    return { error: `agent is not a terminal agent: ${JSON.stringify(body.agent)}` };
  }
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!key) return { error: 'key is required' };
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) return { error: 'content is required' };
  if (content.length > maxContent) {
    return { error: `content length ${content.length} exceeds ${maxContent}` };
  }
  const sender = typeof body.sender === 'string' && body.sender.trim()
    ? body.sender.trim()
    : 'local';
  return { agent, sender, content, key: `wake:${key}` };
}

/**
 * Which terminal-hosted crew members are addressed by this message.
 *
 * 🔴 The sender is normalised before comparing, and that is the whole point.
 *
 * The bug this prevents, observed in production: the bus records a sender as its canonical
 * id (`architect`) while the local roster knows it by display name (`架构师`). Comparing
 * the raw strings, `'架构师' !== 'architect'` is always true, so "never deliver a message
 * back to its own author" silently never fires — and an agent's every group post is
 * injected into its own window. It hid for months because two of the three crew members
 * had a display name identical to their id, so it only ever misfired for one of them.
 *
 * A test that feeds a display name as the sender passes either way. Feed the id.
 */
function mentionTargets({ identity, terminalIds }, sender, content) {
  const senderId = identity.normalizeAgentId(sender);
  const body = String(content == null ? '' : content).toLowerCase();
  const hits = [];
  for (const id of terminalIds) {
    if (id === senderId) continue;
    const names = [id, identity.displayNameOf(id)];
    if (names.some((n) => body.includes('@' + String(n).toLowerCase()))) hits.push(id);
  }
  return hits;
}

/**
 * Is the window busy? The marker is per-agent config, because it is a property of the CLI
 * running in that window, not of the terminal.
 *
 * Screen-derived on purpose. The CLIs' own "I am busy" signals were measured against the
 * screen for twenty minutes and disagreed with it: one never returned to idle after
 * finishing, the other did. Same field, two behaviours. A status that is wrong in the
 * "still working" direction is worse than none, because it looks like work.
 */
function isBusy(screen, pattern) {
  if (!screen) return false;
  const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i');
  return re.test(screen);
}

/**
 * Which queued items are still worth delivering.
 *
 * Dropping old messages is not tidiness. A window that was busy for an hour comes back to
 * twenty instructions from twenty minutes ago and starts answering questions that were
 * settled long since — worse than silence, because it looks like engagement. The group
 * history is the source of truth and can be re-read on demand; a stale instruction cannot
 * be un-followed.
 *
 * A broken timestamp is kept rather than dropped: "I cannot tell how old this is" must not
 * become "therefore throw it away". The size cap catches those.
 */
function filterFresh(pending, now = Date.now(), ttlMs = 10 * 60 * 1000, forcedGraceMs = DEFAULT_FORCED_GRACE_MS) {
  return pending.filter((item) => {
    const forced = Boolean(item && item.forcedAt);
    const t = Date.parse(forced ? item.forcedAt : item && item.queuedAt);
    if (!Number.isFinite(t)) return true;
    return now - t < (forced ? forcedGraceMs : ttlMs);
  });
}

/** Items that filterFresh would drop — needed because expiry has to be reported, not just done. */
function selectExpired(pending, now = Date.now(), ttlMs = 10 * 60 * 1000, forcedGraceMs = DEFAULT_FORCED_GRACE_MS) {
  const fresh = new Set(filterFresh(pending, now, ttlMs, forcedGraceMs));
  return pending.filter((item) => !fresh.has(item));
}

function capPending(pending, max = 200) {
  if (pending.length <= max) return { kept: pending, dropped: [] };
  const overflow = pending.length - max;
  return { kept: pending.slice(overflow), dropped: pending.slice(0, overflow) };
}

/**
 * What actually gets typed into the window.
 *
 * The reply instruction is part of the message because the window has no other way to know
 * where the answer goes. Getting it wrong is quiet and confusing in a specific way: a
 * private message answered with the group command means the human sits watching an empty
 * thread while the reply appears in front of the whole crew.
 */
function envelope({ kind, agent, sender, content, cli = 'mousecrew' }) {
  if (kind === 'wake') return `[local wake · ${sender}] ${content}`;
  if (kind === 'dm') {
    return `[direct] ${sender}: ${content}\n  — reply with: ${cli} reply --as ${agent} "..."`;
  }
  return `[group] ${sender}: ${content}\n  — reply with: ${cli} say --as ${agent} "..."`;
}

/** Take the next deliverable run for one agent without letting a direct message join it. */
function nextDeliverableBatch(pending, agent, batchGroup = DEFAULT_BATCH_GROUP) {
  const rows = Array.isArray(pending) ? pending : [];
  const first = rows.find((item) => item && item.agent === agent);
  if (!first || !batchGroup || first.kind !== 'group') return first ? [first] : [];

  const batch = [];
  const forced = Boolean(first.forcedAt);
  let started = false;
  for (const item of rows) {
    if (!item || item.agent !== agent) continue;
    if (!started) started = item === first;
    if (!started) continue;
    if (item.kind !== 'group') break;
    if (Boolean(item.forcedAt) !== forced) break;
    batch.push(item);
  }
  return batch;
}

function batchBody(items) {
  const batch = Array.isArray(items) ? items : [];
  if (batch.length === 1) return String(batch[0].content || '');
  return batch.map((item, index) => {
    const sender = item.sender || '?';
    const at = item.queuedAt || 'time unavailable';
    return `--- ${index + 1}/${batch.length} · ${sender} · ${at} ---\n${item.content || ''}`;
  }).join('\n\n');
}

function batchEnvelope({ items, agent, cli = 'mousecrew', bodyFile = null, inlineLimit = DEFAULT_INLINE_LIMIT }) {
  const batch = Array.isArray(items) ? items : [];
  if (batch.length === 1 && !bodyFile) {
    const item = batch[0];
    return envelope({ kind: item.kind, agent, sender: item.sender, content: item.content, cli });
  }

  const item = batch[0] || {};
  const body = batchBody(batch);
  const rendered = bodyFile
    ? `${body.slice(0, inlineLimit)}\n\n[truncated — read the full message before replying: ${bodyFile}]`
    : body;
  if (item.kind === 'wake') return `[local wake · ${item.sender}] ${rendered}`;
  const heading = batch.length === 1
    ? `[${item.kind === 'dm' ? 'direct' : 'group'}] ${item.sender}: `
    : `[group batch] ${batch.length} messages delivered together\n`;
  const command = item.kind === 'dm' ? 'reply' : 'say';
  return `${heading}${rendered}\n  — reply with: ${cli} ${command} --as ${agent} "..."`;
}

function mergeDmBodies(items) {
  const batch = Array.isArray(items) ? items : [];
  return `[${batch.length} direct messages delivered together after waiting]\n${batchBody(batch)}`;
}

function markForcedDeliveries(items, now = Date.now(), busy = false) {
  const candidates = (Array.isArray(items) ? items : [])
    .filter((item) => item && item.kind !== 'wake' && !item.forcedAt && (busy || item.draftHeldAt));
  const forcedAt = new Date(now).toISOString();
  const forced = [];
  const absorbed = [];
  const byAgent = new Map();
  for (const item of candidates) {
    if (!byAgent.has(item.agent)) byAgent.set(item.agent, []);
    byAgent.get(item.agent).push(item);
  }
  for (const group of byAgent.values()) {
    const dms = group.filter((item) => item.kind === 'dm');
    if (dms.length) {
      const head = dms[0];
      head.mergedFrom = dms.map((item) => ({ dmId: item.dmId }));
      if (dms.length > 1) head.content = mergeDmBodies(dms);
      head.forcedAt = forcedAt;
      forced.push(head);
      absorbed.push(...dms.slice(1));
    }
    for (const item of group.filter((entry) => entry.kind !== 'dm')) {
      item.forcedAt = forcedAt;
      forced.push(item);
    }
  }
  return { forced, absorbed };
}

function hasPendingWake(agent, sender, pending, now = Date.now(), ttlMs = 10 * 60 * 1000,
  forcedGraceMs = DEFAULT_FORCED_GRACE_MS) {
  return filterFresh(Array.isArray(pending) ? pending : [], now, ttlMs, forcedGraceMs)
    .some((item) => item && item.kind === 'wake' && item.agent === agent && item.sender === sender);
}

function planDelivery(item, busy) {
  if (item.forcedTriedAt) return 'wait_forced_expiry';
  if (item.forcedAt) return 'inject_forced';
  return busy ? 'wait_busy' : 'inject';
}

/**
 * Pick the window for an identity. Resolved fresh on every delivery, never cached: window
 * references are renumbered when sessions are restored, and a cached ref points at whatever
 * took the old number — which is how a message ends up typed into a stranger's window.
 */
function resolveWindow(windows, identityName) {
  const claimed = windows.filter((w) => w.identity === identityName);
  if (claimed.length === 1) return { ref: claimed[0].ref, reason: 'identity' };
  if (claimed.length > 1) {
    // Two windows claiming one identity means a session was restored without the old one
    // being cleaned up. Guessing picks the corpse half the time.
    return { ref: null, reason: 'ambiguous', candidates: claimed.map((w) => w.ref) };
  }
  return { ref: null, reason: 'unclaimed' };
}

module.exports = {
  DEFAULT_BATCH_GROUP, DEFAULT_INLINE_LIMIT,
  DEFAULT_FORCE_ON_EXPIRY, DEFAULT_FORCED_GRACE_MS,
  DEFAULT_WAKE_MAX_CONTENT, DEFAULT_WAKE_SETTLE_MS,
  fingerprint, normalizeMessage, messageKey, parseWakeRequest,
  mentionTargets, isBusy,
  filterFresh, selectExpired, capPending,
  envelope, nextDeliverableBatch, batchBody, batchEnvelope,
  mergeDmBodies, markForcedDeliveries, hasPendingWake, planDelivery, resolveWindow,
};
