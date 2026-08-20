// cmux.js — second implementation, kept honest by the same contract.
//
// It exists mostly to prove the interface is an interface: if tmux were the only adapter,
// "the abstraction" would just be tmux with extra steps. cmux stores identity in a
// workspace description rather than a pane option, addresses windows as `workspace:N`
// rather than `%pane`, and returns JSON rather than a format string — enough difference to
// catch a leaky contract.
//
// ⚠️ One thing that does NOT generalise, and would bite anyone porting this: cmux
// authorises its control socket by process ancestry, not by environment. A sidecar started
// outside cmux can connect to the message bus and receive everything, then fail to inject
// a single character — while still consuming the messages. Any supervisor for a cmux
// sidecar has to be started from inside cmux itself.

const { execFile } = require('child_process');

function run(args, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('cmux', args, {
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, CMUX_QUIET: '1' },
    }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '').trim();
        return reject(err);
      }
      resolve(String(stdout));
    });
  });
}

function createCmuxAdapter({ exec = run } = {}) {
  return {
    name: 'cmux',

    async available() {
      try { await exec(['--version']); return true; } catch { return false; }
    },

    async listWindows() {
      let out;
      try {
        out = await exec(['workspace', 'list', '--json']);
      } catch {
        return [];
      }
      let parsed;
      try { parsed = JSON.parse(out); } catch { return []; }
      return (parsed.workspaces || []).map((w) => ({
        ref: w.ref,
        identity: w.description || null,
        title: w.custom_title || null,
      }));
    },

    async setIdentity(ref, identity) {
      await exec(['workspace-action', '--action', 'set-description', '--workspace', ref, '--description', identity]);
    },

    async clearIdentity(ref) {
      await exec(['workspace-action', '--action', 'clear-description', '--workspace', ref]);
    },

    async readScreen(ref, lines = 12) {
      const out = await exec(['read-screen', '--workspace', ref, '--lines', String(Math.max(1, lines))]);
      return out.replace(/\s+$/, '');
    },

    async sendText(ref, text) {
      await exec(['send', '--workspace', ref, text]);
    },

    async sendKey(ref, key) {
      const named = { enter: 'enter', escape: 'escape', tab: 'tab' }[String(key).toLowerCase()];
      if (!named) throw new Error(`cmux adapter: unsupported key "${key}"`);
      await exec(['send-key', '--workspace', ref, named]);
    },
  };
}

module.exports = { createCmuxAdapter };
