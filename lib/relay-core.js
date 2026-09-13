/**
 * Pure helpers for Relay Station production fixes.
 * Kept out of server.js so unit tests can import without starting HTTP.
 */

export const VIP1129_CHAT_URL = 'https://api.vip1129.cc/v1/chat/completions';
export const BEIBEIHAI_CHAT_URL = 'https://sub.beibeihai.xyz/v1/chat/completions';

export const BEIBEIHAI_GROUP_HINTS = {
  grp_deepseek: ['deepseek', 'ds'],
  grp_grok: ['grok', 'xai', 'x.ai'],
  grp_cc_max: ['cc-max', 'ccmax', 'cc max', 'claude-max', 'claude max', 'cc_max'],
  grp_claude_cursor: ['claude-cursor', 'claude cursor', 'cursor', 'claude_cursor']
};

export const VIP1129_GROUP_HINTS = {
  grp_gpt_pro: ['混合池1', 'pro', 'codex 混合池1'],
  grp_gpt_plus: ['混合池2', 'plus', 'codex 混合池2'],
  grp_gpt_mix: ['混合池3', '混用', 'mix', 'codex 混合池3']
};

const LEGACY_OFFICIAL_URLS = {
  grp_deepseek: ['https://api.deepseek.com/v1/chat/completions'],
  grp_grok: ['https://api.x.ai/v1/chat/completions'],
  grp_cc_max: ['https://api.anthropic.com/v1/messages'],
  grp_claude_cursor: ['https://api.anthropic.com/v1/messages']
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
    const hit = list.find(g => haystack(g).includes(needle));
    if (hit && hit.id != null) return Number.isFinite(Number(hit.id)) ? Number(hit.id) : hit.id;
  }
  return null;
}

export function suggestGroupMap(currentMap, availableGroups, localIds, hints = BEIBEIHAI_GROUP_HINTS) {
  const next = compactGroupMap(currentMap);
  for (const localId of localIds || []) {
    if (next[localId] != null) continue;
    const suggested = matchUpstreamGroupId(localId, availableGroups, hints);
    if (suggested != null) next[localId] = suggested;
  }
  return next;
}

export function intendedUpstreamSync(provider) {
  const id = String(provider?.id || '');
  if (id === 'grp_gpt_pro' || id === 'grp_gpt_plus' || id === 'grp_gpt_mix') return 'vip1129';
  if (id === 'grp_deepseek' || id === 'grp_grok' || id === 'grp_cc_max' || id === 'grp_claude_cursor') return 'beibeihai';
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

export function trialBalanceFromSettings(settings, fallback = 1) {
  const raw = settings?.trialBalance;
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export function trialQuotaFromSettings(settings, trialAmount, quotaForAmountFn) {
  const explicit = settings?.trialQuotaTokens;
  if (explicit != null && explicit !== '') {
    const n = Number(explicit);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  if (typeof quotaForAmountFn === 'function') return Math.max(0, Math.floor(quotaForAmountFn(trialAmount) || 0));
  return trialAmount > 0 ? 10000 : 0;
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
