// routes/group.js — the group channel: read it, post to it, stream it.

const express = require('express');

function createGroupRouter({ hub, dispatcher, identity, requireToken }) {
  const router = express.Router();
  router.use(requireToken);

  // Live stream. Heartbeats keep proxies from closing an idle connection, but clients
  // must still reconcile against /history — see the note there.
  router.get('/api/group/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('data: {"type":"connected"}\n\n');
    const remove = hub.addClient(res);
    const hb = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { /* closing */ }
    }, 15_000);
    req.on('close', () => { clearInterval(hb); remove(); });
  });

  /**
   * Backfill after a gap. This is not a convenience endpoint — it is the reason the
   * system can promise "no lost messages" without a delivery guarantee on the stream.
   * A client that reconnects re-reads here and de-duplicates by content fingerprint.
   */
  router.get('/api/group/history', (req, res) => {
    res.json({ messages: hub.history(req.query.limit) });
  });

  /** A human (or any outside caller) says something. */
  router.post('/api/group/chat', (req, res) => {
    const { message, sender = 'human' } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });
    const senderId = hub.post({ role: 'user', content: message, sender });
    const mentions = dispatcher.dispatchMentions(message, senderId);
    res.json({ ok: true, mentions });
  });

  /** An agent replies into the group. */
  router.post('/api/group/post', (req, res) => {
    const { sender, content, reDispatch = true } = req.body || {};
    if (!sender || !content) return res.status(400).json({ error: 'sender and content required' });
    const senderId = hub.post({ role: 'assistant', content, sender });
    // Use the canonical id the hub returned, never the raw string: the self-dispatch
    // guard compares ids, and comparing a display name against an id always says
    // "different agent", which is how an agent ends up waking itself in a loop.
    if (reDispatch) dispatcher.fireReplyDispatches(content, senderId);
    res.json({ ok: true, sender: senderId });
  });

  return router;
}

module.exports = { createGroupRouter };
