const test = require('node:test');
const assert = require('node:assert');
const { readInputBox, createDraftWatch } = require('../src/lib/input-draft');

const RULE = '─'.repeat(80);
const withBox = (...box) => ['earlier output', RULE, ...box, RULE, 'status'].join('\n');

test('the claude-code reader distinguishes empty, text, and unknown input boxes', () => {
  assert.deepEqual(readInputBox('claude-code', withBox('❯ ')), { state: 'empty', text: '' });
  assert.deepEqual(readInputBox('claude-code', withBox('❯ first line', '  second line')),
    { state: 'text', text: 'first line\nsecond line' });
  assert.deepEqual(readInputBox('claude-code', '❯ prompt without rules'), { state: 'unknown', text: '' });
  assert.deepEqual(readInputBox('other-cli', withBox('❯ words')), { state: 'unknown', text: '' });
});

test('recently changing text waits, while static text eventually releases the window', () => {
  const watch = createDraftWatch({ quietMs: 1000 });
  const box = (text) => ({ state: 'text', text });

  assert.deepEqual(watch.observe('%1', box('half'), 0), { hold: true, reason: 'changed' });
  assert.deepEqual(watch.observe('%1', box('half sentence'), 500), { hold: true, reason: 'changed' });
  assert.deepEqual(watch.observe('%1', box('half sentence'), 1400), { hold: true, reason: 'paused' });
  assert.deepEqual(watch.observe('%1', box('half sentence'), 1500), { hold: false, reason: 'static' });
});

test('empty and unknown boxes release and forget one window without affecting another', () => {
  const watch = createDraftWatch({ quietMs: 1000 });
  const text = { state: 'text', text: 'draft' };
  watch.observe('%1', text, 0);
  assert.deepEqual(watch.observe('%1', { state: 'empty', text: '' }, 10), { hold: false, reason: 'empty' });
  assert.deepEqual(watch.observe('%1', text, 5000), { hold: true, reason: 'changed' });
  assert.deepEqual(watch.observe('%1', { state: 'unknown', text: '' }, 5001), { hold: false, reason: 'unknown' });
  assert.deepEqual(watch.observe('%2', text, 9000), { hold: true, reason: 'changed' });
});
