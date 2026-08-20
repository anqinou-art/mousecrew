// ws/remote-bridge.js — crew members that live on another machine.
//
// The worker (bin/agentdesk-worker.js) dials in, registers the agent ids it can run, and
// answers dispatches. The bridge holds no process; it holds a promise per in-flight turn.
//
// Auth note: this handshake does NOT pass through the Express middleware stack — upgrade
// requests are handled at the HTTP server level. That means the token check has to be
// repeated here. A rule enforced only on the paths you happened to think of is not
// enforced; check every path the input actually travels.

const { WebSocketServer } = require('ws');

function createRemoteBridge({ manager, requireTokenValue, hangTimeoutMs = 8 * 60 * 1000 }) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => {
    const pending = new Map();     // requestId -> { resolve, reject, timer }
    let registered = [];
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }

      switch (m.type) {
        case 'register': {
          registered = (m.agents || []).filter((id) => {
            const cfg = manager.get(id);
            return cfg && cfg.transport === 'remote';
          });
          for (const id of registered) {
            manager.registerRemote(id, {
              sendFn: (text, opts) => new Promise((resolve, reject) => {
                const requestId = `${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                // A worker that accepts a turn and then goes silent is the worst failure
                // mode here: it neither answers nor dies, and every new mention drags it
                // back to busy. Time it out and let the caller see a failure.
                const timer = setTimeout(() => {
                  pending.delete(requestId);
                  reject(new Error(`no response in ${Math.round(hangTimeoutMs / 60000)}min`));
                }, hangTimeoutMs);
                if (timer.unref) timer.unref();
                pending.set(requestId, { resolve, reject, timer });
                ws.send(JSON.stringify({ type: 'dispatch', requestId, agent: id, text, opts }));
              }),
            });
          }
          ws.send(JSON.stringify({ type: 'registered', agents: registered }));
          console.log(`[bridge] worker registered: ${registered.join(', ') || '(none)'}`);
          break;
        }

        case 'reply': {
          const p = pending.get(m.requestId);
          if (!p) break;      // late answer to a turn that already timed out
          clearTimeout(p.timer);
          pending.delete(m.requestId);
          p.resolve({ text: m.text || '', cost: m.cost || 0 });
          break;
        }

        case 'error': {
          const p = pending.get(m.requestId);
          if (!p) break;
          clearTimeout(p.timer);
          pending.delete(m.requestId);
          p.reject(new Error(m.message || 'remote error'));
          break;
        }

        case 'heartbeat':
          ws.isAlive = true;
          break;
      }
    });

    ws.on('close', () => {
      // Reject everything still waiting. Leaving promises hanging would keep the agent
      // "busy" forever from the caller's point of view.
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error('worker disconnected'));
      }
      pending.clear();
      for (const id of registered) manager.unregisterRemote(id);
      console.log(`[bridge] worker gone: ${registered.join(', ') || '(none)'}`);
    });
  });

  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, 25_000);
  if (ping.unref) ping.unref();

  function handleUpgrade(req, socket, head, url) {
    const presented = url.searchParams.get('token');
    if (!requireTokenValue(presented)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }

  return { wss, handleUpgrade, stop: () => { clearInterval(ping); wss.close(); } };
}

module.exports = { createRemoteBridge };
