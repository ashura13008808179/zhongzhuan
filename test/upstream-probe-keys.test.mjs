import assert from 'node:assert/strict';
import { planUpstreamProbeKeys, upstreamProbeKeyName } from '../lib/relay-core.js';

const probeName = upstreamProbeKeyName('grp_gpt_pro');
assert.equal(probeName, 'relay-probe-grp_gpt_pro');
assert.ok(upstreamProbeKeyName('x'.repeat(80)).length <= 60);

const listed = {
  code: 0,
  data: {
    data: [
      { id: 1, name: 'ashurahen-新密钥', group_id: 10, key: 'sk-business' },
      { id: 2, name: 'relay-probe-grp_gpt_pro', group_id: 10, key: 'sk-probe-old' },
      { id: 3, name: 'relay-probe-grp_gpt_pro', group_id: 10, key: 'sk-probe-dup' },
      { id: 4, name: 'relay-probe-grp_gpt_plus', group_id: 10, key: 'sk-probe-sibling' },
      { id: 5, name: 'relay-probe-grp_gpt_pro', group_id: 34, key: 'sk-probe-other-group' }
    ]
  }
};

const reuse = planUpstreamProbeKeys(listed, { probeName, groupId: 10, forceNew: false });
assert.equal(reuse.create, false);
assert.equal(reuse.keep.key, 'sk-probe-old');
assert.deepEqual(reuse.deleteIds, ['3']);
assert.equal(reuse.deleteIds.includes('1'), false, 'must not delete business keys');
assert.equal(reuse.deleteIds.includes('4'), false, 'must not delete other probe names');
assert.equal(reuse.deleteIds.includes('5'), false, 'must not delete other groups');

const forceNew = planUpstreamProbeKeys(listed, { probeName, groupId: 10, forceNew: true });
assert.equal(forceNew.create, true);
assert.equal(forceNew.keep, null);
assert.deepEqual(forceNew.deleteIds, ['2', '3']);
assert.equal(forceNew.deleteIds.includes('1'), false);
assert.equal(forceNew.deleteIds.includes('4'), false);
assert.equal(forceNew.deleteIds.includes('5'), false);

const namedFallback = planUpstreamProbeKeys({
  data: [
    { id: 1, name: 'ashurahen-新密钥', group_id: 10, key: 'sk-business' },
    { id: 8, name: 'relay-probe-grp_gpt_plus', group_id: 10, key: 'sk-probe-plus' }
  ]
}, { probeName, groupId: 10, forceNew: false });
assert.equal(namedFallback.keep.key, 'sk-probe-plus');
assert.equal(namedFallback.create, false);
assert.deepEqual(namedFallback.deleteIds, []);

const anyFallback = planUpstreamProbeKeys({
  data: [{ id: 9, name: 'ashurahen-新密钥', group_id: 10, key: 'sk-business' }]
}, { probeName, groupId: 10, forceNew: false });
assert.equal(anyFallback.create, false);
assert.equal(anyFallback.keep.key, 'sk-business');
assert.deepEqual(anyFallback.deleteIds, []);

const emptyGroup = planUpstreamProbeKeys({
  data: [{ id: 9, name: 'ashurahen-新密钥', group_id: 99, key: 'sk-business' }]
}, { probeName, groupId: 10, forceNew: true });
assert.equal(emptyGroup.create, true);
assert.deepEqual(emptyGroup.deleteIds, []);

const secretless = planUpstreamProbeKeys({
  data: [
    { id: 11, name: probeName, group_id: 10 },
    { id: 12, name: probeName, group_id: 10 }
  ]
}, { probeName, groupId: 10, forceNew: false });
assert.equal(secretless.create, false, 'never create another if exact probe name already exists');
assert.deepEqual(secretless.deleteIds, ['12']);

// Mirror ensureUpstreamProbeKey: delete planned ids, then create at most once.
function applyProbePlan(store, { forceNew = false, groupId = 10, providerId = 'grp_gpt_pro' } = {}) {
  const name = upstreamProbeKeyName(providerId);
  const plan = planUpstreamProbeKeys({ data: store.keys }, { probeName: name, groupId, forceNew });
  store.keys = store.keys.filter((row) => !plan.deleteIds.includes(String(row.id)));
  if (!plan.create) return plan.keep;
  const id = ++store.seq;
  const created = { id, name, group_id: groupId, key: `sk-new-${id}` };
  store.keys.push(created);
  return { id: String(id), key: created.key };
}

function exactLive(store, groupId = 10) {
  return store.keys.filter((row) => row.name === probeName && Number(row.group_id) === groupId);
}

const store = {
  seq: 20,
  keys: [
    { id: 1, name: 'ashurahen-新密钥', group_id: 10, key: 'sk-business' },
    { id: 2, name: probeName, group_id: 10, key: 'sk-stale' },
    { id: 3, name: probeName, group_id: 10, key: 'sk-stale-2' }
  ]
};
applyProbePlan(store, { forceNew: true });
assert.equal(exactLive(store).length, 1, 'forceNew must leave at most one exact-name probe key');
assert.equal(store.keys.some((row) => row.name === 'ashurahen-新密钥'), true);
applyProbePlan(store, { forceNew: false });
assert.equal(exactLive(store).length, 1, 'reuse must not create another exact-name probe key');
applyProbePlan(store, { forceNew: true });
applyProbePlan(store, { forceNew: true });
assert.equal(exactLive(store).length, 1);
assert.equal(store.keys.filter((row) => row.name === 'ashurahen-新密钥').length, 1);

console.log('upstream-probe-keys.test.mjs: all assertions passed');
