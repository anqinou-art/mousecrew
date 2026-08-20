// dispatch.js — turn "@someone, do X" into exactly one delivery.
//
// Two invariants worth defending in review:
//
// 1. One agent, one route. A crew member is local, remote, or terminal — never two at
//    once. Double-delivery means the same instruction arrives twice and the agent answers
//    twice, and the second answer usually contradicts the first.
//
// 2. Re-dispatch stops after one hop. An agent's reply may @ someone else, and that
//    someone gets woken — but their reply does not chain further. There is deliberately
//    no cooldown timer instead: a previous version suppressed "second @mention within
//    120s", which silently swallowed *different* messages in a busy discussion. Sender
//    thought it landed; it never arrived. Deliver twice before dropping once.

const bus = require('./event-bus');

function createDispatcher({ manager, identity, hub, workspace, config }) {
  const reconnectWaitMs = (config.remoteBridge && config.remoteBridge.reconnectWaitMs) || 60_000;

  // Terminal agents are not pushed to from here. They pull: their sidecar subscribes to
  // the group stream and injects into the window. All this side has to do is make sure
  // the message exists in the group — which post() already did.
  function isPulled(cfg) { return cfg.transport === 'terminal'; }

  /**
   * Has this instruction gone stale while it waited? Same fail-open contract as the local
   * queue: only an explicit "skip" drops it, and anything unexpected delivers.
   */
  function isStale(freshness, id) {
    if (typeof freshness !== 'function') return false;
    let verdict;
    try { verdict = freshness(); }
    catch (e) {
      console.error(`[dispatch] ${id} freshness check threw, delivering anyway: ${e.message}`);
      return false;
    }
    if (verdict && verdict.skip) {
      console.log(`[dispatch] ${id} dropping stale message: ${verdict.reason || 'stale'}`);
      return true;
    }
    return false;
  }

  async function dispatchRemote(id, cfg, text, senderDisplay, reDispatch) {
    const remote = manager.remotes.get(id);
    const formatted = `[group] ${senderDisplay}: ${text}`;
    let result;
    try {
      result = await remote.sendFn(formatted, { source: 'group' });
    } catch (e) {
      // Surface it in the group. A transport failure that only reaches the log looks
      // exactly like an agent choosing not to answer.
      const notice = `(${cfg.displayName} link did not respond: ${e.message})`;
      hub.post({ role: 'assistant', content: notice, sender: id, error: true });
      return notice;
    }
    const reply = (result && result.text) || `(${cfg.displayName} returned nothing)`;
    hub.post({ role: 'assistant', content: reply, sender: id });
    if (reDispatch) fireReplyDispatches(reply, id);
    return reply;
  }

  async function dispatchLocal(id, cfg, text, senderDisplay, reDispatch, freshness) {
    const rt = manager.runtime(id);
    const formatted = `[group] ${senderDisplay}: ${text}`;
    const result = await rt.send(formatted, { source: 'group', freshness });

    // A dropped-as-stale turn ends here: no group message, no re-dispatch. Letting the
    // empty string fall through to the "returned nothing" fallback would post what looks
    // like a failure report for an agent that was never asked. Noise is annoying; a fake
    // outage sends someone hunting a problem that does not exist.
    if (result && result.skipped === 'stale') return '';

    const reply = result.text || `(${cfg.displayName} returned nothing)`;
    hub.post({ role: 'assistant', content: reply, sender: id });
    if (reDispatch) fireReplyDispatches(reply, id);
    return reply;
  }

  /**
   * Deliver one message to one agent.
   * @param {object} opts { reDispatch = true, freshness }
   */
  async function dispatchTo(id, text, senderDisplay, opts = {}) {
    const cfg = manager.get(id);
    if (!cfg) throw new Error(`unknown agent "${id}"`);
    const { reDispatch = true, freshness } = opts;

    if (isPulled(cfg)) return '';                   // already in the group; its sidecar takes it

    if (cfg.transport === 'remote') {
      // Remote is a push transport, so the staleness check has to happen here — there is
      // no local queue to do it on the way out. Skipping it would leave exactly one
      // transport delivering instructions that everyone else knows are dead.
      if (isStale(freshness, id)) return '';

      const remote = manager.remotes.get(id);
      if (remote && remote.online && remote.sendFn) {
        return dispatchRemote(id, cfg, text, senderDisplay, reDispatch);
      }
      hub.broadcast({ type: 'waiting', sender: id });
      const back = await manager.waitForRemote(id, reconnectWaitMs);
      // Check again after the wait. This is the window that actually produces stale
      // wake-ups: up to a minute passed while the worker was away, which is plenty of
      // time for the order to have been submitted, reviewed, or cancelled.
      if (isStale(freshness, id)) return '';
      if (back && manager.remotes.get(id) && manager.remotes.get(id).sendFn) {
        return dispatchRemote(id, cfg, text, senderDisplay, reDispatch);
      }
      throw new Error(`${id} did not reconnect within ${Math.round(reconnectWaitMs / 1000)}s`);
    }

    hub.broadcast({ type: 'typing', sender: id });
    return dispatchLocal(id, cfg, text, senderDisplay, reDispatch, freshness);
  }

  /** Wake everyone @mentioned in a reply — one hop only. */
  function fireReplyDispatches(reply, fromAgent) {
    const fromId = identity.normalizeAgentId(fromAgent);
    const fromDisplay = identity.displayNameOf(fromId);
    for (const target of identity.computeMentionTargets(reply, fromAgent)) {
      dispatchTo(target, reply, fromDisplay, { reDispatch: false }).catch((e) => {
        hub.broadcast({
          type: 'message', sender: 'system', displayName: 'system', role: 'system', error: true,
          content: `(re-dispatch to @${identity.displayNameOf(target)} failed: ${e.message})`,
        });
      });
    }
  }

  /** Wake everyone @mentioned in an incoming message. Returns the ids it woke. */
  function dispatchMentions(content, sender, opts = {}) {
    const senderDisplay = identity.displayNameOf(sender) || sender;
    const targets = identity.computeMentionTargets(content, sender);
    for (const id of targets) {
      dispatchTo(id, content, senderDisplay, opts).catch((e) => {
        console.error(`[dispatch] ${id}: ${e.message}`);
        hub.post({
          role: 'assistant', content: `(${identity.displayNameOf(id)} could not be reached: ${e.message})`,
          sender: id, error: true, archiveType: 'error',
        });
      });
    }
    return targets;
  }

  // Same reasoning as GroupHub.detach(): a global subscription needs a way off the bus.
  const onDispatchMentions = ({ content, sender, freshness }) => {
    dispatchMentions(content, sender, { reDispatch: false, freshness });
  };
  bus.on('group:dispatch_mentions', onDispatchMentions);
  const detach = () => bus.off('group:dispatch_mentions', onDispatchMentions);

  return { dispatchTo, dispatchMentions, fireReplyDispatches, detach };
}

module.exports = { createDispatcher };
