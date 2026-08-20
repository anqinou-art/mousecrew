// notify.js — how the system reaches the human.
//
// Pluggable because the interesting part of this project is the crew, not the push
// provider. `none` is a first-class choice: plenty of setups just want the group log.

function createNotifier(cfg = {}) {
  const type = cfg.type || 'none';

  if (type === 'none') {
    return {
      type,
      async send(title, body) {
        console.log(`[notify:none] ${title}: ${String(body).slice(0, 120)}`);
        return { ok: true, skipped: true };
      },
    };
  }

  if (type === 'webhook') {
    if (!cfg.url) throw new Error('notify.type=webhook needs notify.url');
    return {
      type,
      async send(title, body) {
        try {
          const res = await fetch(cfg.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, body }),
            signal: AbortSignal.timeout(10_000),
          });
          return { ok: res.ok, status: res.status };
        } catch (e) {
          // A notification that fails must not take a request down with it.
          console.error('[notify:webhook] failed:', e.message);
          return { ok: false, error: e.message };
        }
      },
    };
  }

  throw new Error(`unknown notify.type "${type}" (want: none | webhook)`);
}

module.exports = { createNotifier };
