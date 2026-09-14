import assert from 'node:assert/strict';
import {
  compactGroupMap,
  mappedGroupCount,
  normalizeAvailableGroups,
  matchUpstreamGroupId,
  suggestGroupMap,
  intendedUpstreamSync,
  applyProviderWiring,
  wireAllProviders,
  isUsableUpstreamSecret,
  findSyncedKeyRecord,
  resolveProxyApiKey,
  flattenListedKeys,
  findListedSecret,
  validateInviteCode,
  insufficientBalanceMessage,
  resolveRecommendedModel,
  normalizeRecommendedModel,
  DEFAULT_RECOMMENDED_MODEL,
  BEIBEIHAI_CHAT_URL,
  VIP1129_CHAT_URL,
  AVATAR_IDS,
  DEFAULT_AVATAR,
  normalizeAvatar,
  normalizeBillingMultiplier,
  formatBillingMultiplier,
  DEFAULT_BILLING_MULTIPLIER,
  defaultDisplayMultiplier,
  resolveDisplayMultiplier
} from '../lib/relay-core.js';

const isVip1129 = (p) => p?.upstreamSync === 'vip1129' || String(p?.url || '').includes('vip1129.cc');
const isBeibeihai = (p) => p?.upstreamSync === 'beibeihai' || String(p?.url || '').includes('beibeihai.xyz');
const detectors = { isVip1129, isBeibeihai };

// --- group map ---
assert.deepEqual(compactGroupMap({ grp_deepseek: null, grp_grok: '', grp_cc_max: 12 }), { grp_cc_max: 12 });
assert.equal(mappedGroupCount({ grp_deepseek: null, grp_grok: 3 }, ['grp_deepseek', 'grp_grok']), 1);

const groups = normalizeAvailableGroups({
  data: [
    { id: 4, name: 'DeepSeek 官方', platform: 'deepseek' },
    { id: 8, name: 'Grok Fast', platform: 'xai' },
    { id: 15, name: 'CC-MAX', platform: 'claude' },
    { id: 21, name: 'Claude-Cursor', platform: 'cursor' }
  ]
});
assert.equal(groups.length, 4);
assert.equal(matchUpstreamGroupId('grp_deepseek', groups), 4);
assert.equal(matchUpstreamGroupId('grp_grok', groups), 8);
assert.equal(matchUpstreamGroupId('grp_cc_max', groups), 15);
assert.equal(matchUpstreamGroupId('grp_claude_cursor', groups), null);

const suggested = suggestGroupMap({ grp_deepseek: null }, groups, ['grp_deepseek', 'grp_grok']);
assert.equal(suggested.grp_deepseek, 4);
assert.equal(suggested.grp_grok, 8);

// --- provider wiring ---
assert.equal(intendedUpstreamSync({ id: 'grp_gpt_pro' }), 'vip1129');
assert.equal(intendedUpstreamSync({ id: 'grp_deepseek' }), 'beibeihai');
assert.equal(intendedUpstreamSync({ id: 'grp_cursor_pool' }), null);
assert.equal(intendedUpstreamSync({ id: 'grp_glm' }), 'beibeihai');
assert.equal(intendedUpstreamSync({ id: 'grp_aws_cc' }), 'vip1129');
assert.equal(intendedUpstreamSync({ id: 'grp_gemini' }), 'beibeihai');

const wired = wireAllProviders([
  { id: 'grp_deepseek', name: 'DeepSeek', url: 'https://api.deepseek.com/v1/chat/completions', apiKey: '' },
  { id: 'grp_gpt_pro', name: 'GPT PRO', url: 'https://api.vip1129.cc/v1/chat/completions', apiKey: '' },
  { id: 'grp_grok', name: 'Grok', url: 'https://api.x.ai/v1/chat/completions', apiKey: '' },
  { id: 'grp_cursor_pool', name: 'Cursor账号池', url: 'https://api2.cursor.sh/v1/chat/completions' }
]);
assert.equal(wired[0].upstreamSync, 'beibeihai');
assert.equal(wired[0].url, BEIBEIHAI_CHAT_URL);
assert.equal(wired[1].upstreamSync, 'vip1129');
assert.equal(wired[1].url, VIP1129_CHAT_URL);
assert.equal(applyProviderWiring({ id: 'grp_gpt_pro', url: VIP1129_CHAT_URL, defaultModel: 'gpt-5.6' }).defaultModel, 'gpt-5.6-sol');
assert.equal(wired[2].upstreamSync, 'beibeihai');
assert.equal(wired[3].maintenance, true);

const custom = applyProviderWiring({
  id: 'grp_deepseek',
  url: 'https://custom.example.com/v1/chat/completions',
  upstreamSync: 'beibeihai'
});
assert.equal(custom.url, 'https://custom.example.com/v1/chat/completions', 'do not overwrite custom admin URL');

// --- proxy key injection ---
const gpt = { id: 'grp_gpt_pro', url: VIP1129_CHAT_URL, apiKey: '', upstreamSync: 'vip1129' };
const syncedKey = {
  id: 'key_1',
  key: 'sk-upstream-gpt',
  groupId: 'grp_gpt_pro',
  enabled: true,
  upstream: { provider: 'vip1129', id: 'u1' }
};
const localRk = { id: 'key_2', key: 'rk_local_only', groupId: 'grp_gpt_pro', enabled: true };
const otherGroup = {
  id: 'key_3',
  key: 'sk-other',
  groupId: 'grp_deepseek',
  enabled: true,
  upstream: { provider: 'beibeihai', id: 'u2' }
};

assert.equal(isUsableUpstreamSecret(gpt, syncedKey, isVip1129, isBeibeihai), true);
assert.equal(isUsableUpstreamSecret(gpt, localRk, isVip1129, isBeibeihai), false);

const user = { id: 'usr_a', apiKeys: [localRk, syncedKey] };
assert.equal(resolveProxyApiKey(gpt, localRk, { users: [user] }, user, detectors), 'sk-upstream-gpt');
assert.equal(resolveProxyApiKey(gpt, syncedKey, { users: [user] }, user, detectors), 'sk-upstream-gpt');

const emptyUser = { id: 'usr_b', apiKeys: [localRk, otherGroup] };
const otherUser = { id: 'usr_c', apiKeys: [syncedKey] };
assert.equal(
  resolveProxyApiKey(gpt, localRk, { users: [emptyUser, otherUser] }, emptyUser, detectors),
  '',
  'live chat must not borrow another user\'s upstream key'
);
assert.equal(
  resolveProxyApiKey(gpt, null, { users: [emptyUser, otherUser] }, null, detectors),
  'sk-upstream-gpt',
  'health probes may reuse any synced sk- for the same channel'
);
assert.equal(resolveProxyApiKey(gpt, localRk, { users: [emptyUser] }, emptyUser, detectors), '');
assert.equal(resolveProxyApiKey({ ...gpt, apiKey: 'sk-channel' }, localRk, { users: [emptyUser] }, emptyUser, detectors), 'sk-channel');

const found = findSyncedKeyRecord({ users: [user] }, gpt, localRk, user, detectors);
assert.equal(found.key, 'sk-upstream-gpt');

const listedPayload = {
  code: 0,
  data: {
    data: [
      { id: 1, name: 'other', group_id: 10, key: 'sk-other' },
      { id: 6086, name: 'relay-probe-grp_gpt_pro', group_id: 10, key: 'sk-probe-pro' },
      { id: 34, name: 'relay-probe-grp_gpt_plus', group_id: 34, key: 'sk-probe-plus' }
    ]
  }
};
assert.equal(flattenListedKeys(listedPayload).length, 3);
assert.equal(findListedSecret(listedPayload, { name: 'relay-probe-grp_gpt_pro', groupId: 10 }).key, 'sk-probe-pro');
assert.equal(findListedSecret(listedPayload, { nameIncludes: 'relay-probe', groupId: 34 }).key, 'sk-probe-plus');
assert.equal(findListedSecret(listedPayload, { groupId: 99 }).key, null);

// --- invite / 402 copy ---
const users = [
  { id: 'u1', inviteCode: 'ABCD1234' },
  { id: 'u2', inviteCode: 'OLDCODE', inviteExpiresAt: '2000-01-01T00:00:00.000Z' }
];
assert.equal(validateInviteCode(users, '').ok, true);
assert.equal(validateInviteCode(users, '   ').optional, true);
assert.equal(validateInviteCode(users, 'abcd1234').ok, true);
assert.equal(validateInviteCode(users, 'abcd1234').inviter.id, 'u1');
assert.equal(validateInviteCode(users, 'NOPE').ok, false);
assert.match(validateInviteCode(users, 'NOPE').error, /邀请码无效/);
assert.equal(validateInviteCode(users, 'OLDCODE').ok, false);
assert.match(validateInviteCode(users, 'OLDCODE').error, /过期/);
assert.match(insufficientBalanceMessage(), /卡密充值/);

assert.equal(DEFAULT_RECOMMENDED_MODEL, 'gpt-5.6-sol');
assert.equal(resolveRecommendedModel({}), 'gpt-5.6-sol');
assert.equal(resolveRecommendedModel({ recommendedModel: 'gpt-5.6' }), 'gpt-5.6-sol');
assert.equal(resolveRecommendedModel({ recommendedModel: 'gpt-5.6-terra' }), 'gpt-5.6-terra');
assert.equal(normalizeRecommendedModel('gpt-5.6-sol').ok, true);
assert.equal(normalizeRecommendedModel('bad model!').ok, false);

assert.equal(DEFAULT_AVATAR, 'letter');
assert.ok(AVATAR_IDS.includes('mint'));
assert.equal(normalizeAvatar('mint').ok, true);
assert.equal(normalizeAvatar('mint').avatar, 'mint');
assert.equal(normalizeAvatar('').avatar, 'letter');
assert.equal(normalizeAvatar('nope').ok, false);

assert.equal(DEFAULT_BILLING_MULTIPLIER, 2.5);
assert.equal(normalizeBillingMultiplier(1.1).ok, true);
assert.equal(normalizeBillingMultiplier(1.1).value, 1.1);
assert.equal(normalizeBillingMultiplier(1.4).value, 1.4);
assert.equal(normalizeBillingMultiplier('1.40').value, 1.4);
assert.equal(normalizeBillingMultiplier(0).ok, false);
assert.equal(normalizeBillingMultiplier(11).ok, false);
assert.equal(formatBillingMultiplier(1.4), '1.4');

assert.equal(defaultDisplayMultiplier('grp_gemini'), 0.2);
assert.equal(defaultDisplayMultiplier('grp_aws_cc'), 0.5);
assert.equal(defaultDisplayMultiplier('grp_deepseek'), 0.5);
assert.equal(defaultDisplayMultiplier('grp_gpt_mix'), 0.05);
assert.equal(resolveDisplayMultiplier({ id: 'grp_gpt_pro' }), 0.2);
assert.equal(resolveDisplayMultiplier({ id: 'grp_gpt_pro', displayMultiplier: 0.2, billingMultiplier: 2.5 }), 0.2);
assert.equal(resolveDisplayMultiplier({ id: 'grp_gpt_pro', displayMultiplier: 0.8 }), 0.8);

console.log('relay-fixes.test.mjs: all assertions passed');
