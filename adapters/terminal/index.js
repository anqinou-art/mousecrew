// index.js — adapter registry.
//
// Adding a multiplexer means adding a file here and nothing else. If that stops being
// true, the contract has leaked.

const { validateAdapter } = require('./contract');
const { createTmuxAdapter } = require('./tmux');
const { createCmuxAdapter } = require('./cmux');
const { createFakeAdapter } = require('./fake');

const BUILTIN = {
  tmux: createTmuxAdapter,
  cmux: createCmuxAdapter,
  fake: createFakeAdapter,
};

/**
 * @param {string} name  adapter name from an agent's `terminal.adapter`
 * @param {object} opts  passed through to the factory
 * @throws if the adapter is unknown or does not honour the contract
 */
function createAdapter(name, opts = {}) {
  const factory = BUILTIN[name];
  if (!factory) {
    throw new Error(`unknown terminal adapter "${name}" (have: ${Object.keys(BUILTIN).join(', ')})`);
  }
  const adapter = factory(opts);
  const { ok, errors } = validateAdapter(adapter);
  if (!ok) throw new Error(`adapter "${name}" is incomplete:\n  - ${errors.join('\n  - ')}`);
  return adapter;
}

module.exports = { createAdapter, BUILTIN, validateAdapter };
