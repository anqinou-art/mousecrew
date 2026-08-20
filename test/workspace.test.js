const test = require('node:test');
const assert = require('node:assert');
const { WorkspaceRules } = require('../src/lib/workspace');
const { normalizeAgent } = require('../src/config');

const crew = [
  { id: 'backend', repos: ['server'], transport: 'local', workDir: '/tmp/b' },
  { id: 'frontend', repos: ['app'], transport: 'remote', selfManaged: true },
  { id: 'auditor', repos: ['server'], transport: 'local', workDir: '/tmp/a', canMerge: true },
  { id: 'generalist', transport: 'local', workDir: '/tmp/g' },   // no repos = unrestricted
].map(normalizeAgent);

const W = new WorkspaceRules(crew);

test('an agent may work on a repo it owns', () => {
  assert.equal(W.canWork('backend', 'server').ok, true);
  assert.equal(W.canWork('frontend', 'app').ok, true);
});

test('an agent may NOT be handed work in someone else\'s tree', () => {
  // The refusal is the whole feature: two agents editing one tree each finish their own
  // half of the same file, confidently, and unwinding that is measured in days.
  const v = W.canWork('backend', 'app');
  assert.equal(v.ok, false);
  assert.match(v.reason, /does not own repo "app"/);
});

test('the refusal says who should get it instead', () => {
  assert.deepEqual(W.ownersOf('app'), ['frontend']);
  assert.deepEqual(W.ownersOf('server').sort(), ['auditor', 'backend']);
});

test('unscoped work is allowed anywhere', () => {
  // Forcing a repo onto every chore just makes people invent a fake one.
  assert.equal(W.canWork('backend', null).ok, true);
  assert.equal(W.canWork('backend', undefined).ok, true);
});

test('an agent with no repos list is unrestricted — the single-repo default', () => {
  assert.equal(W.canWork('generalist', 'server').ok, true);
  assert.equal(W.canWork('generalist', 'anything').ok, true);
});

test('unknown agents are refused, not silently allowed', () => {
  assert.equal(W.canWork('ghost', 'server').ok, false);
});

test('only the single merge gate may merge', () => {
  assert.equal(W.canMerge('auditor').ok, true);
  const v = W.canMerge('backend');
  assert.equal(v.ok, false);
  assert.match(v.reason, /only "auditor" may merge/);
});

test('with no merge gate configured, nobody may merge', () => {
  const w = new WorkspaceRules([normalizeAgent({ id: 'solo', transport: 'local', workDir: '/tmp/s' })]);
  assert.equal(w.canMerge('solo').ok, false);
});

test('self-managed lanes are identifiable', () => {
  assert.equal(W.isSelfManaged('frontend'), true);
  assert.equal(W.isSelfManaged('backend'), false);
});
