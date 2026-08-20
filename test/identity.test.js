const test = require('node:test');
const assert = require('node:assert');
const { buildIdentity } = require('../src/lib/identity');
const { normalizeAgent } = require('../src/config');

const roster = [
  { id: 'backend', displayName: 'backend', aliases: ['be'] },
  { id: 'auditor', displayName: 'reviewer', aliases: ['audit'] },
  { id: 'frontend', displayName: 'frontend', aliases: [] },
].map(normalizeAgent);

const ID = buildIdentity(roster);

test('every name for an agent resolves to its canonical id', () => {
  assert.equal(ID.normalizeAgentId('reviewer'), 'auditor');
  assert.equal(ID.normalizeAgentId('audit'), 'auditor');
  assert.equal(ID.normalizeAgentId('auditor'), 'auditor');
  assert.equal(ID.normalizeAgentId('AUDITOR'), 'auditor');
  assert.equal(ID.normalizeAgentId('  reviewer  '), 'auditor');
});

test('an unknown name passes through untouched', () => {
  assert.equal(ID.normalizeAgentId('alice'), 'alice');
  assert.equal(ID.normalizeAgentId(null), null);
});

test('mentions resolve to canonical ids', () => {
  assert.deepEqual(ID.computeMentionTargets('@backend please look', 'human').sort(), ['backend']);
  assert.deepEqual(ID.computeMentionTargets('@be quick one', 'human'), ['backend']);
});

test('an agent is never woken by its own message — the display-name trap', () => {
  // This is the whole reason ids are normalized before comparing. Comparing the raw
  // sender string 'reviewer' against the id 'auditor' always says "different agent",
  // so the guard silently fails and the agent re-wakes itself in a loop.
  assert.deepEqual(ID.computeMentionTargets('@reviewer noting this for myself', 'reviewer'), []);
  assert.deepEqual(ID.computeMentionTargets('@audit see above', 'auditor'), []);
  assert.deepEqual(ID.computeMentionTargets('@reviewer take a look', 'auditor'), []);
});

test('one message can wake several agents, without duplicates', () => {
  const t = ID.computeMentionTargets('@backend and @frontend and @be again', 'human').sort();
  assert.deepEqual(t, ['backend', 'frontend']);
});

test('a bare name is not a mention — the @ is required', () => {
  assert.deepEqual(ID.computeMentionTargets('backend is fine', 'human'), []);
});

test('displayNameOf survives being handed an id or any alias', () => {
  assert.equal(ID.displayNameOf('auditor'), 'reviewer');
  assert.equal(ID.displayNameOf('audit'), 'reviewer');
  assert.equal(ID.displayNameOf('nobody'), 'nobody');
});

test('empty and non-string content does not throw', () => {
  assert.deepEqual(ID.computeMentionTargets('', 'human'), []);
  assert.deepEqual(ID.computeMentionTargets(null, 'human'), []);
  assert.deepEqual(ID.computeMentionTargets(undefined, 'human'), []);
});
