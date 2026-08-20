// group-hub.js — the single entry point for anything that becomes a group message.
//
// Every path that puts words in the group goes through post(). Not "should"; there is no
// other function that writes to the messages table for this channel.
//
// The version of this that had seven scattered write sites ended up with three different
// spellings of the same sender, which made one agent look like three participants. The
// cost was not noise — someone read the log and concluded the system had agents running
// that had been retired months earlier. Wrong beliefs about your own topology are
// expensive.

const bus = require('./event-bus');

class GroupHub {
  constructor({ store, archive, identity, channel = 'group' }) {
    this.store = store;
    this.archive = archive;
    this.identity = identity;
    this.channel = channel;
    this.clients = new Set();

    // Kept as fields so they can be removed again. A module that subscribes to a global
    // bus with no way to unsubscribe cannot be instantiated twice — the second instance
    // does not replace the first, it joins it, and every emit then also reaches the hub
    // whose database is already closed. Long-lived servers never notice; anything that
    // builds the app more than once (tests, an embedded instance) hits it immediately.
    this._onPost = (payload) => this.post(payload);
    this._onBroadcast = (data) => this.broadcast(data);
    bus.on('group:post', this._onPost);
    bus.on('group:broadcast', this._onBroadcast);
  }

  /** Unsubscribe from the bus and drop stream clients. Safe to call twice. */
  detach() {
    bus.off('group:post', this._onPost);
    bus.off('group:broadcast', this._onBroadcast);
    this.clients.clear();
  }

  broadcast(data) {
    const json = JSON.stringify(data);
    for (const res of this.clients) {
      try { res.write(`data: ${json}\n\n`); } catch { /* client is gone; close handler cleans up */ }
    }
  }

  addClient(res) {
    this.clients.add(res);
    return () => this.clients.delete(res);
  }

  /**
   * Write one message: database, archive, live stream. In that order, once.
   * @returns {string} the canonical sender id — use THIS for self-dispatch comparisons,
   *   never the raw value the caller passed in.
   */
  post({ role = 'assistant', content, sender: rawSender, error = false, ts = new Date().toISOString(),
         archive: doArchive = true, archiveType = 'message', extraMeta = null, broadcast = null }) {
    const sender = this.identity.normalizeAgentId(rawSender);
    const displayName = this.identity.displayNameOf(sender) || rawSender;
    const meta = { sender, displayName, ...(extraMeta || {}) };
    if (error) meta.error = true;

    this.store.msg.insert.run(this.channel, role, String(content), ts, JSON.stringify(meta));
    if (doArchive) this.archive.append(sender, content, archiveType);
    this.broadcast(broadcast || {
      type: 'message', sender, displayName, content, role, ts,
      ...(error ? { error: true } : {}),
    });
    return sender;
  }

  history(limit = 50) {
    const capped = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    return this.store.msg.recent.all(this.channel, capped).reverse();
  }
}

module.exports = { GroupHub };
