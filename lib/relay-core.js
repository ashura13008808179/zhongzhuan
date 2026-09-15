/**
 * Pure helpers for Relay Station production fixes.
 * Kept out of server.js so unit tests can import without starting HTTP.
 */

export const VIP1129_CHAT_URL = 'https://api.vip1129.cc/v1/chat/completions';
export const BEIBEIHAI_CHAT_URL = 'https://sub.beibeihai.xyz/v1/chat/completions';
export const DEFAULT_RECOMMENDED_MODEL = 'gpt-5.6-sol';
export const LEGACY_RECOMMENDED_MODEL = 'gpt-5.6';

export const BEIBEIHAI_GROUP_HINTS = {
  grp_deepseek: ['deepseek', 'ds'],
  grp_grok: ['grok', 'xai', 'x.ai'],
  grp_cc_max: ['cc-max', 'ccmax', 'cc max', 'claude-max', 'claude max', 'cc_max'],
  grp_glm: ['智普', 'zhipu'],
  grp_kimi: ['kimi'],
  grp_gemini: ['gemini'],
  grp_grok_heavy: ['grok heavy'],
  grp_claude_kiro: ['aws企业号', 'kiro（aws'],
  grp_claude_kiro_welfare: ['kiro（福利'],
  grp_cn_models: ['国产模型', 'minimax']
};

export const VIP1129_GROUP_HINTS = {
  grp_gpt_pro: ['混合池1', 'codex 混合池1'],
  grp_gpt_plus: ['混合池2', 'codex 混合池2'],
  grp_gpt_mix: ['混合池3', '混用', 'codex 混合池3'],
  grp_aws_cc: ['aws-cc', '金额消耗'],
  grp_grok_vip: ['grok 分组']
};

const LEGACY_OFFICIAL_URLS = {
  grp_deepseek: ['https://api.deepseek.com/v1/chat/completions'],
  grp_grok: ['https://api.x.ai/v1/chat/completions'],
  grp_cc_max: ['https://api.anthropic.com/v1/messages']
};

export function compactGroupMap(map) {
  const out = {};
  if (!map || typeof map !== 'object') return out;
  for (const [k, v] of Object.entries(map)) {
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) out[String(k)] = n;
  }
  return out;
}

export function mappedGroupCount(groupMap, localIds = []) {
  const map = compactGroupMap(groupMap);
  if (!localIds.length) return Object.keys(map).length;
  return localIds.filter(id => map[String(id)] != null).length;
}

export function normalizeAvailableGroups(payload) {
  const root = payload && typeof payload === 'object'
    ? (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data) && (payload.data.data || payload.data.groups || payload.data.items || payload.data.list)
      ? payload.data
      : payload)
    : payload;
  const arr = Array.isArray(payload) ? payload
    : Array.isArray(payload?.data) ? payload.data
    : Array.isArray(root?.data) ? root.data
    : Array.isArray(root?.groups) ? root.groups
    : Array.isArray(root?.items) ? root.items
    : Array.isArray(root?.list) ? root.list
    : [];
  return arr.map(g => {
    if (g == null || typeof g !== 'object') return null;
    const id = g.id ?? g.group_id ?? g.groupId ?? g.value;
    if (id == null || id === '') return null;
    return {
      id: Number.isFinite(Number(id)) ? Number(id) : id,
      name: String(g.name || g.group_name || g.title || g.label || ''),
      platform: String(g.platform || g.provider || g.type || ''),
      rate: g.rate_multiplier ?? g.rate ?? null,
      status: g.status ?? null
    };
  }).filter(Boolean);
}

function haystack(group) {
  return `${group.name || ''} ${group.platform || ''}`.toLowerCase();
}

export function matchUpstreamGroupId(localId, availableGroups, hints = BEIBEIHAI_GROUP_HINTS) {
  const list = Array.isArray(availableGroups) ? availableGroups : [];
  const keys = hints[localId] || [];
  for (const key of keys) {
    const needle = String(key).toLowerCase();
    const exact = list.find(g => String(g.name || '').toLowerCase() === needle);
    if (exact && exact.id != null) return Number.isFinite(Number(exact.id)) ? Number(exact.id) : exact.id;
    const hit = list.find(g => haystack(g).includes(needle));
    if (hit && hit.id != null) return Number.isFinite(Number(hit.id)) ? Number(hit.id) : hit.id;
  }
  return null;
}

export function suggestGroupMap(currentMap, availableGroups, localIds, hints = BEIBEIHAI_GROUP_HINTS) {
  const next = compactGroupMap(currentMap);
  const used = new Set(Object.values(next).map(Number).filter(Number.isFinite));
  for (const localId of localIds || []) {
    if (next[localId] != null) continue;
    const remaining = (availableGroups || []).filter(g => !used.has(Number(g.id)));
    const suggested = matchUpstreamGroupId(localId, remaining, hints);
    if (suggested != null) {
      next[localId] = suggested;
      used.add(Number(suggested));
    }
  }
  return next;
}

export function intendedUpstreamSync(provider) {
  const id = String(provider?.id || '');
  if (Object.prototype.hasOwnProperty.call(VIP1129_GROUP_HINTS, id)) return 'vip1129';
  if (Object.prototype.hasOwnProperty.call(BEIBEIHAI_GROUP_HINTS, id)) return 'beibeihai';
  if (provider?.upstreamSync === 'vip1129' || provider?.upstreamSync === 'beibeihai') return provider.upstreamSync;
  return null;
}

export function intendedChatUrl(provider, beibeihaiBase, vip1129Base) {
  const sync = intendedUpstreamSync(provider);
  const chatFromBase = (base, fallback) => `${String(base || fallback).replace(/\/+$/, '')}/v1/chat/completions`;
  if (sync === 'beibeihai') return chatFromBase(beibeihaiBase, 'https://sub.beibeihai.xyz');
  if (sync === 'vip1129') return chatFromBase(vip1129Base, 'https://api.vip1129.cc');
  return provider?.url || '';
}

export function shouldRewriteProviderUrl(provider, nextUrl) {
  const id = String(provider?.id || '');
  const current = String(provider?.url || '').replace(/\/+$/, '');
  if (!current) return true;
  const legacy = (LEGACY_OFFICIAL_URLS[id] || []).map(u => u.replace(/\/+$/, ''));
  if (legacy.includes(current)) return true;
  if (current === nextUrl.replace(/\/+$/, '')) return false;
  // Keep admin-custom URLs unless they still point at the unused official vendor host.
  return false;
}

export function applyProviderWiring(provider, opts = {}) {
  const next = { ...provider };
  const id = String(next.id || '');
  const sync = next.upstreamSync || intendedUpstreamSync(next);
  if (sync) next.upstreamSync = sync;

  if (id === 'grp_cursor_pool') {
    next.maintenance = true;
    next.maintenanceMessage = next.maintenanceMessage || '请联系站长购买';
    next.status = 'maintenance';
    return next;
  }

  if (sync === 'beibeihai' || sync === 'vip1129') {
    const target = intendedChatUrl(next, opts.beibeihaiBase, opts.vip1129Base);
    if (shouldRewriteProviderUrl(next, target)) next.url = target;
  }
  if (sync === 'vip1129' && String(next.defaultModel || '').trim() === LEGACY_RECOMMENDED_MODEL) {
    next.defaultModel = DEFAULT_RECOMMENDED_MODEL;
  }
  return next;
}

export function wireAllProviders(providers, opts = {}) {
  return (providers || []).map(p => applyProviderWiring(p, opts));
}

/**
 * A local API key is usable as the upstream Bearer when it was synced
 * (key.upstream.provider) or the secret itself is an upstream sk- for that path.
 * Channel-level provider.apiKey may be empty — that is the designed path.
 */
export function isUsableUpstreamSecret(provider, keyRec, isVip1129, isBeibeihai) {
  if (!keyRec?.key) return false;
  if (keyRec.enabled === false) return false;
  const secret = String(keyRec.key);
  const vip = typeof isVip1129 === 'function' ? isVip1129(provider) : !!isVip1129;
  const bb = typeof isBeibeihai === 'function' ? isBeibeihai(provider) : !!isBeibeihai;
  if (vip) {
    if (keyRec.upstream?.provider === 'vip1129') return true;
    if (secret.startsWith('sk-') && (!keyRec.groupId || keyRec.groupId === provider.id)) return true;
  }
  if (bb) {
    if (keyRec.upstream?.provider === 'beibeihai') return true;
    if (secret.startsWith('sk-') && (!keyRec.groupId || keyRec.groupId === provider.id)) return true;
  }
  return false;
}

function keyMatchesProvider(keyRec, provider) {
  if (!keyRec) return false;
  if (!keyRec.groupId) return true;
  return String(keyRec.groupId) === String(provider.id);
}

export function findSyncedKeyRecord(db, provider, preferredRec = null, preferredUser = null, detectors = {}) {
  const isVip1129 = detectors.isVip1129 || (() => false);
  const isBeibeihai = detectors.isBeibeihai || (() => false);
  const usable = (rec) => isUsableUpstreamSecret(provider, rec, isVip1129, isBeibeihai);

  if (preferredRec && usable(preferredRec) && keyMatchesProvider(preferredRec, provider)) {
    return { key: preferredRec.key, rec: preferredRec, user: preferredUser || null };
  }

  // Chat: only the requesting user's keys. Health probes pass user=null and may
  // reuse any already-synced sk- for this channel (or create a probe key later).
  const users = preferredUser ? [preferredUser] : (db?.users || []);
  const scan = (requireGroup) => {
    for (const u of users) {
      for (const k of u.apiKeys || []) {
        if (!usable(k)) continue;
        if (requireGroup && String(k.groupId || '') !== String(provider.id)) continue;
        if (!requireGroup && k.groupId && String(k.groupId) !== String(provider.id)) continue;
        return { key: k.key, rec: k, user: u };
      }
    }
    return null;
  };

  return scan(true) || scan(false) || (preferredRec && usable(preferredRec)
    ? { key: preferredRec.key, rec: preferredRec, user: preferredUser || null }
    : null);
}

/**
 * Resolve the Bearer token for /v1/chat/completions and health probes.
 * Priority: request key (if synced sk-) → same-user/group synced key →
 * any user's synced key for this channel → channel-level apiKey (optional).
 */
export function resolveProxyApiKey(provider, apiKeyRec, db = null, user = null, detectors = {}) {
  const found = findSyncedKeyRecord(db, provider, apiKeyRec, user, detectors);
  if (found?.key) return found.key;
  const channel = String(provider?.apiKey || '').trim();
  return channel || '';
}

export function flattenListedKeys(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const candidates = [
    payload.data?.data,
    payload.data?.items,
    payload.data?.list,
    payload.data?.keys,
    payload.data,
    payload.items,
    payload.list,
    payload.keys,
    payload
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && (!c.length || (c[0] && typeof c[0] === 'object'))) return c;
  }
  return [];
}

export function findListedSecret(payload, opts = {}) {
  const rows = flattenListedKeys(payload);
  const wantName = opts.name ? String(opts.name) : '';
  const wantIncludes = opts.nameIncludes ? String(opts.nameIncludes) : '';
  const gid = opts.groupId == null || opts.groupId === '' ? null : Number(opts.groupId);
  const groupOf = (row) => row.group_id ?? row.groupId ?? row.group?.id;
  const secretOf = (row) => {
    const id = row.id ?? row.key_id ?? row.keyId ?? null;
    const key = row.key || row.secret || row.api_key || row.apiKey || null;
    if (!key) return null;
    return { id: id != null ? String(id) : null, key: String(key) };
  };
  const ranked = [];
  for (const row of rows) {
    const g = groupOf(row);
    if (gid != null && Number.isFinite(gid) && Number(g) !== gid) continue;
    const n = String(row.name || '');
    let rank = 9;
    if (wantName && n === wantName) rank = 0;
    else if (wantIncludes && n.includes(wantIncludes)) rank = 1;
    else if (!wantName && !wantIncludes) rank = 2;
    else continue;
    ranked.push({ rank, row });
  }
  ranked.sort((a, b) => a.rank - b.rank);
  for (const item of ranked) {
    const secret = secretOf(item.row);
    if (secret) return secret;
  }
  return { id: null, key: null };
}

export function validateInviteCode(users, rawCode) {
  const code = String(rawCode || '').trim();
  if (!code) return { ok: true, optional: true, inviter: null };
  const upper = code.toUpperCase();
  const inviter = (users || []).find(u => String(u.inviteCode || '').trim().toUpperCase() === upper);
  if (!inviter) {
    return { ok: false, error: '邀请码无效或不存在', code: 'invite_invalid' };
  }
  if (inviter.inviteExpiresAt) {
    const end = new Date(inviter.inviteExpiresAt);
    if (!Number.isNaN(end.getTime()) && end.getTime() < Date.now()) {
      return { ok: false, error: '邀请码已过期', code: 'invite_expired' };
    }
  }
  if (inviter.inviteDisabled === true) {
    return { ok: false, error: '邀请码已失效', code: 'invite_disabled' };
  }
  return { ok: true, inviter };
}

export function insufficientBalanceMessage() {
  return '账户余额不足，无法发起请求。请前往「卡密充值」兑换卡密后重试，或联系客服获取充值码。';
}

export const AVATAR_IDS = Object.freeze(['letter', 'lime', 'cyan', 'sunset', 'mint', 'violet', 'ember', 'slate']);
export const DEFAULT_AVATAR = 'letter';

export function normalizeAvatar(raw, fallback = DEFAULT_AVATAR) {
  const id = String(raw == null ? '' : raw).trim();
  if (AVATAR_IDS.includes(id)) return { ok: true, avatar: id };
  if (!id) return { ok: true, avatar: fallback };
  return { ok: false, error: '无效的头像', avatar: fallback };
}

export const BILLING_MULTIPLIER_MIN = 0.01;
export const BILLING_MULTIPLIER_MAX = 10;
// 计费铁律：真正扣费只用上游全局倍率两档（beibeihai=settings.billingMultiplier 默认2.5；vip1129=settings.billingMultiplierVip1129 默认1.5）。渠道 displayMultiplier/billingMultiplier 为摆设。
export const DEFAULT_BILLING_MULTIPLIER = 2.5;
export const DEFAULT_VIP1129_BILLING_MULTIPLIER = 1.5;
/** 展示倍率 = 摆设文字，绝不参与花销/扣费 */
export const DEFAULT_DISPLAY_MULTIPLIER = 0.2;
export const DEFAULT_DISPLAY_MULTIPLIERS = {
  grp_deepseek: 0.5,
  grp_gpt_pro: 0.2,
  grp_gpt_plus: 0.1,
  grp_gpt_mix: 0.05,
  grp_grok: 0.5,
  grp_cc_max: 0.6,
  grp_cursor_pool: 0.1,
  grp_aws_cc: 0.5,
  grp_grok_vip: 0.5,
  grp_glm: 0.5,
  grp_kimi: 0.5,
  grp_gemini: 0.2,
  grp_grok_heavy: 0.1,
  grp_claude_kiro: 0.35,
  grp_claude_kiro_welfare: 0.1,
  grp_cn_models: 0.5
};

export function defaultDisplayMultiplier(providerId) {
  const id = String(providerId || '');
  if (Object.prototype.hasOwnProperty.call(DEFAULT_DISPLAY_MULTIPLIERS, id)) {
    return DEFAULT_DISPLAY_MULTIPLIERS[id];
  }
  return DEFAULT_DISPLAY_MULTIPLIER;
}

export function resolveDisplayMultiplier(provider) {
  const fallback = defaultDisplayMultiplier(provider?.id);
  const parsed = normalizeBillingMultiplier(provider?.displayMultiplier, fallback);
  return parsed.ok ? parsed.value : fallback;
}

export function roundBillingMultiplier(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return NaN;
  return Math.round(value * 10000) / 10000;
}

export function formatBillingMultiplier(raw, fallback = '1') {
  const rounded = roundBillingMultiplier(raw);
  if (!Number.isFinite(rounded)) return fallback;
  return String(rounded);
}

export function normalizeBillingMultiplier(raw, fallback = DEFAULT_BILLING_MULTIPLIER) {
  const rounded = roundBillingMultiplier(raw);
  if (!Number.isFinite(rounded) || rounded < BILLING_MULTIPLIER_MIN || rounded > BILLING_MULTIPLIER_MAX) {
    return {
      ok: false,
      error: `倍率必须是 ${BILLING_MULTIPLIER_MIN}–${BILLING_MULTIPLIER_MAX} 之间的数字，支持小数（如 1.1、1.4）`,
      value: roundBillingMultiplier(fallback)
    };
  }
  return { ok: true, value: rounded };
}

export function resolveRecommendedModel(settings, fallback = DEFAULT_RECOMMENDED_MODEL) {
  const raw = String(settings?.recommendedModel || '').trim();
  if (!raw || raw === LEGACY_RECOMMENDED_MODEL) return fallback;
  return raw;
}

export function normalizeRecommendedModel(raw, fallback = DEFAULT_RECOMMENDED_MODEL) {
  const model = String(raw == null ? fallback : raw).trim();
  if (!model) return { ok: false, error: '推荐模型不能为空' };
  if (model.length > 80) return { ok: false, error: '推荐模型名称过长' };
  if (!/^[\w./:+-]+$/.test(model)) return { ok: false, error: '推荐模型名称含非法字符' };
  return { ok: true, model };
}
