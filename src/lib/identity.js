// identity.js — who is being talked to, and who is talking.
//
// The whole file is pure functions over the roster. That is deliberate: the
// self-dispatch guard lives here, and a guard you cannot unit-test is a guard you
// find out about from production.
//
// The bug this shape exists to prevent: an agent may appear under several names —
// its canonical id (written by the dispatcher), the display name a human types, and
// whatever alias another agent used. Compare raw strings and `'auditor' !== 'review'`
// is always true, so "don't re-dispatch a message to its own sender" silently fails.
// The agent then wakes itself with its own reply, replies again, and you have a loop
// that looks like enthusiasm.

/**
 * Build the lookup tables once from the roster.
 * @param {Array} agents normalized agent configs
 */
function buildIdentity(agents) {
  const displayNames = {};   // id -> name humans read
  const triggers = [];       // { text, id } every name that counts as an @mention
  const aliasToId = {};      // lowercased any-name -> id

  for (const a of agents) {
    displayNames[a.id] = a.displayName;
    const names = new Set([a.id, a.displayName, ...(a.aliases || [])]);
    for (const n of names) {
      aliasToId[String(n).toLowerCase()] = a.id;
      triggers.push({ text: String(n), id: a.id });
    }
  }

  // Longest first: when two triggers can both match a span, the more specific one wins.
  // (config.js already refuses rosters where that ambiguity spans two different agents,
  // so this only settles same-agent overlaps like "fe" inside "frontend".)
  triggers.sort((x, y) => y.text.length - x.text.length);

  function normalizeAgentId(name) {
    if (name == null) return name;
    const key = String(name).trim();
    return aliasToId[key.toLowerCase()] || key;
  }

  /**
   * Which agents are @mentioned in `content`, excluding the sender.
   * @returns {string[]} canonical ids, no duplicates, roster order-independent
   */
  function computeMentionTargets(content, rawSender) {
    const senderId = normalizeAgentId(rawSender);
    const body = String(content == null ? '' : content).toLowerCase();
    const hits = new Set();
    for (const t of triggers) {
      if (t.id === senderId) continue;              // never wake someone with their own words
      if (body.includes('@' + t.text.toLowerCase())) hits.add(t.id);
    }
    return [...hits];
  }

  function displayNameOf(id) {
    return displayNames[normalizeAgentId(id)] || id;
  }

  return { normalizeAgentId, computeMentionTargets, displayNameOf, displayNames, triggers, aliasToId };
}

module.exports = { buildIdentity };
