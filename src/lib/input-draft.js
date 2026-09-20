// input-draft.js — detect recent typing in a supported terminal input box.

const crypto = require('crypto');

const DEFAULT_DRAFT_QUIET_MS = 2 * 60 * 1000;
const DEFAULT_FORCED_DRAFT_HOLD_MS = 90 * 1000;
const RULE_LINE = /^[─━]{20,}$/;
const PROMPT_MARK = '❯';

function readClaudeInputBox(screen) {
  const rows = String(screen == null ? '' : screen)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''));
  let bottom = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (RULE_LINE.test(rows[i].trim())) { bottom = i; break; }
  }
  let top = -1;
  for (let i = bottom - 1; i >= 0; i -= 1) {
    if (RULE_LINE.test(rows[i].trim())) { top = i; break; }
  }
  if (top < 0 || bottom - top < 2) return { state: 'unknown', text: '' };
  const box = rows.slice(top + 1, bottom);
  if (!box[0].startsWith(PROMPT_MARK)) return { state: 'unknown', text: '' };
  const text = [box[0].slice(PROMPT_MARK.length), ...box.slice(1)]
    .map((line) => line.trim())
    .join('\n')
    .trim();
  return text ? { state: 'text', text } : { state: 'empty', text: '' };
}

const READERS = { 'claude-code': readClaudeInputBox };

function readInputBox(type, screen) {
  const reader = READERS[type];
  return reader ? reader(screen) : { state: 'unknown', text: '' };
}

function createDraftWatch({ quietMs = DEFAULT_DRAFT_QUIET_MS } = {}) {
  const seen = new Map();
  return {
    observe(windowRef, box, now = Date.now()) {
      if (!box || box.state !== 'text') {
        seen.delete(windowRef);
        return { hold: false, reason: box ? box.state : 'unknown' };
      }
      // The text may never be submitted, so retain only what is needed to detect change.
      const fingerprint = crypto.createHash('sha256').update(box.text).digest('hex');
      const last = seen.get(windowRef);
      if (!last || last.fingerprint !== fingerprint) {
        seen.set(windowRef, { fingerprint, changedAt: now });
        return { hold: true, reason: 'changed' };
      }
      return now - last.changedAt < quietMs
        ? { hold: true, reason: 'paused' }
        : { hold: false, reason: 'static' };
    },
  };
}

module.exports = {
  DEFAULT_DRAFT_QUIET_MS,
  DEFAULT_FORCED_DRAFT_HOLD_MS,
  readClaudeInputBox,
  readInputBox,
  createDraftWatch,
};
