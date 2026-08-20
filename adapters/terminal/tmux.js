// tmux.js — the reference terminal adapter.
//
// tmux first, deliberately: it is the multiplexer that is actually on other people's
// machines. Everything else is a second implementation of an interface tmux already
// proved.
//
// Identity lives in a pane-level user option (`@mousecrew_identity`) rather than in the
// window name. Window names belong to the person using the terminal — they rename things,
// their shell rewrites the title, their editor sets it back. Writing identity there means
// fighting the user for a field they own, and losing intermittently. A user option is
// storage nobody else touches.

const { execFile } = require('child_process');

const IDENT_OPT = '@mousecrew_identity';
const FIELD_SEP = '';   // pane titles can contain anything printable; this cannot

function run(args, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '').trim();
        return reject(err);
      }
      resolve(String(stdout));
    });
  });
}

function createTmuxAdapter({ exec = run } = {}) {
  return {
    name: 'tmux',

    async available() {
      try {
        await exec(['-V']);
        return true;
      } catch {
        return false;
      }
    },

    /**
     * Every pane on the server, with whatever identity it claims.
     * `-a` spans sessions on purpose: a crew member's window may live in a session nobody
     * is currently attached to, and it is still perfectly able to work.
     */
    async listWindows() {
      let out;
      try {
        out = await exec(['list-panes', '-a', '-F', ['#{pane_id}', `#{${IDENT_OPT}}`, '#{pane_title}'].join(FIELD_SEP)]);
      } catch (e) {
        // No server running means no windows — not an error worth propagating, since the
        // sidecar's answer is the same either way: nothing to deliver to.
        if (/no server running/i.test(e.stderr || e.message)) return [];
        throw e;
      }
      return out.split('\n').filter(Boolean).map((line) => {
        const [ref, identity, title] = line.split(FIELD_SEP);
        return { ref, identity: identity || null, title: title || null };
      });
    },

    async setIdentity(ref, identity) {
      await exec(['set-option', '-p', '-t', ref, IDENT_OPT, identity]);
    },

    async clearIdentity(ref) {
      // -u unsets rather than setting empty, so listWindows sees a real absence.
      await exec(['set-option', '-p', '-t', ref, '-u', IDENT_OPT]);
    },

    /**
     * The last `lines` lines of what is on screen right now.
     * `-p` prints to stdout, `-S -N` starts N lines back from the bottom.
     */
    async readScreen(ref, lines = 12) {
      const out = await exec(['capture-pane', '-p', '-t', ref, '-S', `-${Math.max(1, lines)}`]);
      return out.replace(/\s+$/, '');
    },

    /**
     * `-l` sends the text literally. Without it tmux interprets the payload as key names,
     * and a message containing the word "Enter" would press Enter in the middle of itself.
     */
    async sendText(ref, text) {
      await exec(['send-keys', '-t', ref, '-l', text]);
    },

    async sendKey(ref, key) {
      const named = { enter: 'Enter', escape: 'Escape', tab: 'Tab' }[String(key).toLowerCase()];
      if (!named) throw new Error(`tmux adapter: unsupported key "${key}"`);
      await exec(['send-keys', '-t', ref, named]);
    },
  };
}

module.exports = { createTmuxAdapter, IDENT_OPT, FIELD_SEP };
