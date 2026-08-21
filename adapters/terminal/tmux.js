// tmux.js — the reference terminal adapter.
//
// tmux: https://github.com/tmux/tmux — not vendored; this adapter shells out to `tmux`.
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
// Printable, on purpose. The obvious choice is a control character — a pane title can
// contain anything printable, so 0x01 looks unambiguous. It is not: tmux 3.4 renders a
// control character in a format string as its four-character escape (\001), while 3.6
// emits the raw byte. Same code, same format string, a different answer per version.
//
// That failure mode is the worst available: no error, no empty result — a full set of
// structurally valid objects with every field wrong, because the entire line lands in the
// first one. Every window then reads as unclaimed, every delivery waits for a window that
// will never be found, and the dashboard reports the whole crew as stopped.
//
// It was invisible on the machine this was written on, whose tmux happened to be new
// enough. It took running the suite on the other machine to see it at all.
//
// (The old value was also a raw 0x01 byte sitting in the source, invisible in every editor.
// A separator you cannot see is a separator nobody can review.)
const FIELD_SEP = '|:|';
const REF_RE = /^%\d+$/;

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

/**
 * One line of `list-panes` output into a window record.
 *
 * Refuses rather than guesses. A line that does not parse means the format contract with
 * tmux has broken — a version escaping differently, an option someone changed — and that is
 * systemic, not one odd window. One loud error beats a dozen quiet wrong answers, which is
 * precisely what the previous version produced.
 *
 * The title is joined back from whatever remains, so a pane title containing the separator
 * cannot corrupt the two fields that matter.
 */
function parsePaneLine(line) {
  const parts = String(line).split(FIELD_SEP);
  if (parts.length < 3 || !REF_RE.test(parts[0])) {
    throw new Error(
      'tmux adapter: cannot parse a pane line — the format contract has changed.\n' +
      `  got: ${JSON.stringify(line)}\n` +
      `  expected: <pane-id>${FIELD_SEP}<identity>${FIELD_SEP}<title>\n` +
      '  (tmux versions differ in how they render separators — see the note above FIELD_SEP)',
    );
  }
  const [ref, identity] = parts;
  return { ref, identity: identity || null, title: parts.slice(2).join(FIELD_SEP) || null };
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
      return out.split('\n').filter(Boolean).map(parsePaneLine);
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

module.exports = { createTmuxAdapter, parsePaneLine, IDENT_OPT, FIELD_SEP, REF_RE };
