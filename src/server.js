#!/usr/bin/env node
// server.js — assembly only. Every rule lives in src/lib; this file just wires it up.

const express = require('express');
const http = require('http');

const configLoader = require('./config');
const { open } = require('./db');
const { createArchive } = require('./lib/archive');
const { buildIdentity } = require('./lib/identity');
const { WorkspaceRules } = require('./lib/workspace');
const { GroupHub } = require('./lib/group-hub');
const { AgentManager } = require('./lib/agent-manager');
const { createDispatcher } = require('./lib/dispatch');
const { createNudger } = require('./lib/nudge');
const { createNotifier } = require('./lib/notify');
const { createRequireToken, readTokenFile, tokenMatches } = require('./lib/require-token');
const { createGroupRouter } = require('./routes/group');
const { createOrdersRouter } = require('./routes/orders');
const { createAgentsRouter } = require('./routes/agents');
const { createRemoteBridge } = require('./ws/remote-bridge');

function build({ config, agents }) {
  const store = open(config.dbPath);
  const archive = createArchive(config.archivePath);
  const identity = buildIdentity(agents);
  const workspace = new WorkspaceRules(agents);
  const notifier = createNotifier(config.notify);
  const hub = new GroupHub({ store, archive, identity, channel: config.groupChannel || 'group' });
  const manager = new AgentManager(agents, { dataDir: require('path').dirname(config.dbPath) });
  const dispatcher = createDispatcher({ manager, identity, hub, workspace, config });
  const nudger = createNudger({ store, identity, notifier, config, workspace });

  const gate = createRequireToken({ tokenFile: config.tokenFile });
  // Express wants (req,res,next); the guard answers true/false and has already written
  // the 401 when it says no.
  const requireToken = (req, res, next) => { if (gate(req, res, req.path)) next(); };

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
    next(err);
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, agents: agents.length }));

  app.use(createGroupRouter({ hub, dispatcher, identity, requireToken }));
  const orders = createOrdersRouter({ store, identity, hub, workspace, notifier, requireToken, config });
  app.use(orders.router);
  app.use(createAgentsRouter({ manager, identity, store, requireToken, config }));

  return { app, store, hub, manager, dispatcher, nudger, identity, workspace, notifier, config, agents };
}

function start(opts = {}) {
  const loaded = opts.loaded || configLoader.load(opts);
  const ctx = build(loaded);
  const { config } = loaded;
  const server = http.createServer(ctx.app);

  if (config.remoteBridge && config.remoteBridge.enabled) {
    const bridge = createRemoteBridge({
      manager: ctx.manager,
      requireTokenValue: (presented) => {
        try { return tokenMatches(presented, readTokenFile(config.tokenFile)); }
        catch { return false; }
      },
    });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/ws/bridge') bridge.handleUpgrade(req, socket, head, url);
      else socket.destroy();
    });
    ctx.bridge = bridge;
  }

  ctx.nudger.start();
  server.listen(config.port, config.host, () => {
    console.log(`agentdesk on http://${config.host}:${config.port} — ${ctx.agents.length} agents registered`);
    for (const a of ctx.agents) {
      console.log(`  @${a.displayName.padEnd(12)} ${a.transport.padEnd(9)} ${a.repos.length ? 'repos: ' + a.repos.join(',') : 'repos: (any)'}${a.canMerge ? '  [merge gate]' : ''}`);
    }
  });

  const shutdown = () => {
    ctx.hub.detach();
    ctx.dispatcher.detach();
    console.log('\nshutting down');
    ctx.nudger.stop();
    ctx.manager.destroyAll();
    if (ctx.bridge) ctx.bridge.stop();
    server.close(() => process.exit(0));
    const t = setTimeout(() => process.exit(0), 3000);
    if (t.unref) t.unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { ...ctx, server };
}

if (require.main === module) {
  try {
    start();
  } catch (e) {
    console.error(`\nstartup refused: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = { build, start };
