// paseo.js — terminal adapter for Paseo's public command-line interface.
//
// Paseo: https://github.com/getpaseo/paseo — not vendored here. This adapter uses only
// `paseo terminal ls`, `capture`, and `send-keys`; it does not depend on the daemon's
// internal WebSocket protocol.
//
// A Paseo terminal's name is fixed when the terminal is created. That makes it suitable
// for identity, unlike a title that a shell or coding CLI may rewrite at any time.

const { execFile } = require('child_process');

function run(args, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('paseo', args, {
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '').trim();
        return reject(err);
      }
      resolve(String(stdout));
    });
  });
}

function parseJson(out, action) {
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`paseo adapter: ${action} returned invalid JSON`);
  }
}

function createPaseoAdapter({ exec = run } = {}) {
  async function terminals() {
    const out = await exec(['terminal', 'ls', '--all', '--json']);
    const parsed = parseJson(out, 'terminal ls');
    if (!Array.isArray(parsed)) throw new Error('paseo adapter: terminal ls did not return an array');
    return parsed;
  }

  return {
    name: 'paseo',

    async available() {
      try { await exec(['--version']); return true; } catch { return false; }
    },

    async listWindows() {
      let listed;
      try {
        listed = await terminals();
      } catch {
        return [];
      }
      return listed.map((terminal) => ({
        ref: terminal.id,
        identity: terminal.name || null,
        title: null,
      }));
    },

    async setIdentity(ref, identity) {
      const terminal = (await terminals()).find((entry) => entry.id === ref);
      if (!terminal) throw new Error(`paseo adapter: terminal "${ref}" was not found`);
      if (terminal.name !== identity) {
        throw new Error(
          `paseo adapter: terminal names are fixed when created; create a new terminal named "${identity}"`,
        );
      }
    },

    async clearIdentity() {
      throw new Error('paseo adapter: terminal names cannot be cleared; close the terminal to release its identity');
    },

    async readScreen(ref, lines = 12) {
      const count = Math.max(1, lines);
      const out = await exec(['terminal', 'capture', ref, '--start', `-${count}`, '--json']);
      const parsed = parseJson(out, 'terminal capture');
      if (!Array.isArray(parsed.lines)) {
        throw new Error('paseo adapter: terminal capture did not return lines');
      }
      return parsed.lines.join('\n').replace(/\s+$/, '');
    },

    async sendText(ref, text) {
      const normalized = String(text).replace(/\r\n?/g, '\n');
      await exec(['terminal', 'send-keys', ref, '--literal', '--', normalized]);
    },

    async sendKey(ref, key) {
      const named = { enter: 'Enter', escape: 'Escape', tab: 'Tab' }[String(key).toLowerCase()];
      if (!named) throw new Error(`paseo adapter: unsupported key "${key}"`);
      await exec(['terminal', 'send-keys', ref, named]);
    },
  };
}

module.exports = { createPaseoAdapter };
