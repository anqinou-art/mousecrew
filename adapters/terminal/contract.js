// contract.js — what a terminal adapter has to do, and nothing more.
//
// The whole point of this layer is that the crew above it never learns which multiplexer
// is underneath. Five verbs cover it:
//
//   listWindows()            what windows exist, and which identity each one claims
//   setIdentity(ref, name)   claim a window for a crew member
//   clearIdentity(ref)       release it
//   readScreen(ref, lines)   the last N lines currently visible
//   sendText(ref, text)      type text into the window
//   sendKey(ref, key)        press a key (currently only 'enter')
//
// Deliberately NOT in the contract:
//
// - "is this window busy". That is a judgement, and it belongs to the sidecar, which knows
//   what marker the CLI in that window prints. An adapter that decides busyness would have
//   to know about every CLI anyone might run.
// - "did the text arrive". An adapter can only report that it issued the command. Whether
//   the characters landed is a different question with a different answer — see the
//   distinction between the event layer and the screen layer in docs/TERMINAL.md.
//
// Every method is async even where the underlying call is synchronous, so a slow adapter
// can never be a breaking change.

const REQUIRED = ['listWindows', 'setIdentity', 'clearIdentity', 'readScreen', 'sendText', 'sendKey'];

/**
 * Check that an object honours the contract. Used at registration time so a broken adapter
 * fails at startup with a list of what is missing, rather than at 3am with `undefined is
 * not a function` inside a delivery loop.
 */
function validateAdapter(adapter) {
  const errors = [];
  if (!adapter || typeof adapter !== 'object') return { ok: false, errors: ['adapter is not an object'] };
  if (!adapter.name) errors.push('adapter has no name');
  for (const m of REQUIRED) {
    if (typeof adapter[m] !== 'function') errors.push(`adapter "${adapter.name || '?'}" is missing ${m}()`);
  }
  if (typeof adapter.available !== 'function') {
    errors.push(`adapter "${adapter.name || '?'}" is missing available()`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * A window as every adapter must describe it.
 * @typedef {{ref: string, identity: string|null, title: string|null}} Window
 *
 * `ref` is whatever the multiplexer uses to address a window, and it is opaque above this
 * layer. It is also allowed to change between calls — the real cmux renumbers workspaces
 * when sessions are restored — so nothing upstream may cache it. Identity is looked up
 * fresh on every delivery for exactly that reason.
 */

module.exports = { validateAdapter, REQUIRED };
