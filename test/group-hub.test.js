const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { open } = require('../src/db');
const { GroupHub } = require('../src/lib/group-hub');
const { buildIdentity } = require('../src/lib/identity');
const { createArchive } = require('../src/lib/archive');
const { normalizeAgent } = require('../src/config');

function makeHub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-hub-'));
  const store = open(path.join(dir, 'test.db'));
  const archive = createArchive(path.join(dir, 'archive.jsonl'));
  const identity = buildIdentity([
    { id: 'auditor', displayName: 'reviewer', aliases: ['audit'] },
    { id: 'backend', displayName: 'backend', aliases: [] },
  ].map(normalizeAgent));
  const hub = new GroupHub({ store, archive, identity, channel: 'group' });
  return { hub, store, dir, archive };
}

test('one post writes the database, the archive, and the live stream — once each', () => {
  const { hub, store, dir } = makeHub();
  const seen = [];
  hub.addClient({ write: (s) => seen.push(s) });

  hub.post({ role: 'assistant', content: 'done', sender: 'backend' });

  const rows = store.msg.recent.all('group', 10);
  assert.equal(rows.length, 1);
  const lines = fs.readFileSync(path.join(dir, 'archive.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(seen.length, 1);
  store.close();
});

test('the sender is stored canonically, with the human name alongside', () => {
  // The version with several write paths produced three spellings of one agent, and a
  // reader concluded the system was running agents that had been retired. Wrong beliefs
  // about your own topology are expensive.
  const { hub, store } = makeHub();
  hub.post({ role: 'assistant', content: 'x', sender: 'reviewer' });      // human name
  hub.post({ role: 'assistant', content: 'y', sender: 'audit' });          // alias
  hub.post({ role: 'assistant', content: 'z', sender: 'auditor' });        // id

  const metas = store.msg.recent.all('group', 10).map((r) => JSON.parse(r.metadata));
  assert.deepEqual([...new Set(metas.map((m) => m.sender))], ['auditor']);
  assert.deepEqual([...new Set(metas.map((m) => m.displayName))], ['reviewer']);
  store.close();
});

test('post returns the canonical id for the caller to compare against', () => {
  const { hub, store } = makeHub();
  assert.equal(hub.post({ content: 'x', sender: 'reviewer' }), 'auditor');
  store.close();
});

test('archiving can be skipped without skipping delivery', () => {
  // Needed for messages the archive itself triggers — archiving those would recurse.
  const { hub, store, dir } = makeHub();
  const seen = [];
  hub.addClient({ write: (s) => seen.push(s) });
  hub.post({ content: 'internal', sender: 'system', archive: false });
  assert.equal(seen.length, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'archive.jsonl')) || fs.readFileSync(path.join(dir, 'archive.jsonl'), 'utf8').trim() === '');
  store.close();
});

test('history returns oldest-first and is capped', () => {
  const { hub, store } = makeHub();
  for (let i = 0; i < 10; i++) {
    hub.post({ content: `m${i}`, sender: 'backend', ts: new Date(Date.now() + i * 1000).toISOString() });
  }
  const rows = hub.history(5);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].content, 'm5');
  assert.equal(rows[4].content, 'm9');
  assert.equal(hub.history(9999).length, 10, 'the cap is applied without erroring');
  store.close();
});

test('a broken stream client does not take the write down with it', () => {
  const { hub, store } = makeHub();
  hub.addClient({ write: () => { throw new Error('socket closed'); } });
  assert.doesNotThrow(() => hub.post({ content: 'still stored', sender: 'backend' }));
  assert.equal(store.msg.recent.all('group', 10).length, 1);
  store.close();
});

test('an unknown sender is kept as-is rather than dropped', () => {
  const { hub, store } = makeHub();
  const id = hub.post({ role: 'user', content: 'hello', sender: 'alice' });
  assert.equal(id, 'alice');
  store.close();
});
