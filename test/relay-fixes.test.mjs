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
  trialBalanceFromSettings,
  trialQuotaFromSettings,
  validateInviteCode,
  insufficientBalanceMessage,
  BEIBEIHAI_CHAT_URL,
  VIP1129_CHAT_URL
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
assert.equal(matchUpstreamGroupId('grp_claude_cursor', groups), 21);

const suggested = suggestGroupMap({ grp_deepseek: null }, groups, ['grp_deepseek', 'grp_grok']);
assert.equal(suggested.grp_deepseek, 4);
assert.equal(suggested.grp_grok, 8);

// --- provider wiring ---
assert.equal(intendedUpstreamSync({ id: 'grp_gpt_pro' }), 'vip1129');
assert.equal(intendedUpstreamSync({ id: 'grp_deepseek' }), 'beibeihai');
assert.equal(intendedUpstreamSync({ id: 'grp_cursor_pool' }), null);

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

// --- trial / invite ---
assert.equal(trialBalanceFromSettings({}), 1);
assert.equal(trialBalanceFromSettings({ trialBalance: 0 }), 0);
assert.equal(trialBalanceFromSettings({ trialBalance: 2.5 }), 2.5);
assert.equal(trialQuotaFromSettings({}, 1), 10000);
assert.equal(trialQuotaFromSettings({ trialQuotaTokens: 5000 }, 1), 5000);

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

console.log('relay-fixes.test.mjs: all assertions passed');
