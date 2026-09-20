/**
 * Pure helpers for Relay Station production fixes.
 * Kept out of server.js so unit tests can import without starting HTTP.
 */

export const VIP1129_CHAT_URL = 'https://api.vip1129.cc/v1/chat/completions';
export const BEIBEIHAI_CHAT_URL = 'https://sub.beibeihai.xyz/v1/chat/completions';
export const DEFAULT_RECOMMENDED_MODEL = 'gpt-5.6-terra';
export const LEGACY_RECOMMENDED_MODEL = 'gpt-5.6';
export const RETIRED_GPT_DEFAULTS = ['gpt-5.6', 'gpt-5.6-sol'];
export const GPT_RELAY_GROUP_IDS = ['grp_gpt_pro', 'grp_gpt_plus', 'grp_gpt_mix'];
export const GPT_RELAY_PRIORITY = { grp_gpt_pro: 1, grp_gpt_plus: 2, grp_gpt_mix: 3 };

/** Intended model families for seeded groups. Do not re-add Gemini here. */
export const PROVIDER_MODEL_FAMILIES = {
  grp_deepseek: ['deepseek'],
  grp_kimi: ['kimi'],
  grp_glm: ['glm'],
  grp_grok_heavy: ['grok', 'composer'],
  grp_claude_kiro: ['claude'],
  grp_claude_kiro_welfare: ['claude'],
  grp_aws_cc: ['claude'],
  grp_cc_max: ['claude'],
  grp_gpt_pro: ['gpt'],
  grp_gpt_plus: ['gpt'],
  grp_gpt_mix: ['gpt']
};

export const SEEDED_DEFAULT_MODELS = {
  grp_deepseek: 'deepseek-chat',
  grp_gpt_pro: DEFAULT_RECOMMENDED_MODEL,
  grp_gpt_plus: DEFAULT_RECOMMENDED_MODEL,
  grp_gpt_mix: DEFAULT_RECOMMENDED_MODEL,
  grp_cc_max: 'claude-sonnet-4',
  grp_glm: 'glm-5.1',
  grp_kimi: 'kimi-k2.6',
  grp_grok_heavy: 'composer-2.5',
  grp_claude_kiro: 'claude-haiku-4-5-20251001',
  grp_claude_kiro_welfare: 'claude-fable-5',
  grp_aws_cc: 'claude-fable-5'
};

export function modelFamilyToken(name) {
  return String(name || '').toLowerCase().split(/[-_./]/)[0];
}

export function providerModelFamilies(provider, seedDefault = '') {
  const id = String(provider?.id || '');
  if (Object.prototype.hasOwnProperty.call(PROVIDER_MODEL_FAMILIES, id)) {
    return PROVIDER_MODEL_FAMILIES[id];
  }
  const token = modelFamilyToken(seedDefault || provider?.defaultModel);
  return token ? [token] : [];
}

export function modelMatchesFamilies(model, families) {
  const raw = String(model || '').toLowerCase();
  if (!raw) return false;
  if (!Array.isArray(families) || !families.length) return true;
  const tok = modelFamilyToken(raw);
  return families.some((family) => {
    const needle = String(family || '').toLowerCase();
    return needle && (tok === needle || raw.includes(needle));
  });
}

export function filterModelsForProviderFamily(provider, models, seedDefault = '') {
  const list = [...new Set((models || []).map((m) => String(m || '').trim()).filter(Boolean))];
  const families = providerModelFamilies(provider, seedDefault);
  if (!families.length || !list.length) return list;
  const kept = list.filter((m) => modelMatchesFamilies(m, families));
  return kept.length ? kept : list;
}

/** Prefer these over the first family hit from a shared /v1/models mega-list. */
export const PROVIDER_PREFERRED_MODELS = {
  grp_claude_kiro: ['claude-haiku-4-5-20251001', 'claude-haiku-4-5', 'claude-haiku'],
  grp_claude_kiro_welfare: ['claude-fable-5', 'claude-fable-5-1', 'claude-fable'],
  grp_aws_cc: ['claude-fable-5', 'claude-fable-5-1', 'claude-fable'],
  grp_cc_max: ['claude-sonnet-4', 'claude-sonnet-4-20250514', 'claude-sonnet'],
  grp_deepseek: ['deepseek-chat', 'deepseek-v4-flash']
};

export const CLAUDE_CHAT_TIMEOUT_MS = 120000;
export const MIN_CHAT_TIMEOUT_MS = 90000;

export function preferredModelsForProvider(provider) {
  const id = String(provider?.id || '');
  return PROVIDER_PREFERRED_MODELS[id] || [];
}

function modelPrefersToken(model, token) {
  const raw = String(model || '').toLowerCase();
  const tok = String(token || '').toLowerCase();
  return tok && raw.includes(tok);
}

export function pickFromPreferredModels(list, preferred) {
  const rows = Array.isArray(list) ? list : [];
  const prefs = (preferred || []).map((m) => String(m || '').trim()).filter(Boolean);
  for (const pref of prefs) {
    const exact = rows.find((m) => String(m).toLowerCase() === pref.toLowerCase());
    if (exact) return exact;
  }
  for (const pref of prefs) {
    const p = pref.toLowerCase();
    const prefix = rows.find((m) => String(m).toLowerCase().startsWith(p));
    if (prefix) return prefix;
  }
  for (const pref of prefs) {
    const parts = pref.toLowerCase().split(/[-_]/).filter((x) => x && !/^\d/.test(x) && x !== 'claude');
    const token = parts[0];
    if (!token) continue;
    const hit = rows.find((m) => modelPrefersToken(m, token));
    if (hit) return hit;
  }
  return '';
}

export function pickSeededDefaultModel(provider, models, seedDefault = '') {
  const list = Array.isArray(models) ? models : [];
  const seed = String(seedDefault || SEEDED_DEFAULT_MODELS[provider?.id] || provider?.defaultModel || '').trim();
  const preferred = [seed, ...preferredModelsForProvider(provider)].filter(Boolean);
  if (seed && list.includes(seed)) return seed;
  const prefHit = pickFromPreferredModels(list, preferred);
  if (prefHit) return prefHit;
  // Keep the seeded default even if a shared catalog omitted it (Beibeihai /v1/models is global).
  if (seed) return seed;
  const families = providerModelFamilies(provider, seed);
  const familyHit = list.find((m) => modelMatchesFamilies(m, families));
  if (familyHit) return familyHit;
  return list[0] || '';
}

export function applySyncedModels(provider, models, seedDefault = '') {
  if (!provider) return false;
  const seed = String(seedDefault || SEEDED_DEFAULT_MODELS[provider.id] || '').trim();
  let filtered = filterModelsForProviderFamily(provider, models, seed);
  const nextDefault = pickSeededDefaultModel(provider, filtered, seed);
  if (nextDefault) {
    filtered = [nextDefault, ...filtered.filter((m) => m !== nextDefault)];
  }
  let changed = false;
  const prevModels = (provider.models || []).map(String).join('\0');
  if (filtered.join('\0') !== prevModels) {
    provider.models = filtered;
    changed = true;
  } else if (!Array.isArray(provider.models)) {
    provider.models = filtered;
    changed = true;
  }
  if (String(provider.defaultModel || '').trim() !== nextDefault) {
    provider.defaultModel = nextDefault;
    changed = true;
  }
  if (GPT_RELAY_GROUP_IDS.includes(String(provider.id || '')) && preferGptTerra(provider)) {
    changed = true;
  }
  return changed;
}

export function isClaudeFamilyModel(model) {
  return /^claude/i.test(String(model || '').trim());
}

export function providerPrefersAnthropicMessages(provider, model = '') {
  const id = String(provider?.id || '');
  if (id === 'grp_claude_kiro' || id === 'grp_claude_kiro_welfare' || id === 'grp_cc_max') return true;
  const url = String(provider?.url || '');
  const beibeihai = String(provider?.upstreamSync || '') === 'beibeihai' || /beibeihai/i.test(url);
  return beibeihai && isClaudeFamilyModel(model || provider?.defaultModel);
}

export function providerFetchTimeoutMs(provider, { stream = false } = {}) {
  const id = String(provider?.id || '');
  const configured = Number(provider?.timeoutMs) || 0;
  let floor = MIN_CHAT_TIMEOUT_MS;
  if (/claude|aws_cc/i.test(id) || isClaudeFamilyModel(provider?.defaultModel)) {
    floor = CLAUDE_CHAT_TIMEOUT_MS;
  }
  if (stream) floor = Math.max(floor, 180000);
  return Math.min(Math.max(configured, floor), 300000);
}

export function ensureProviderTimeouts(providers) {
  const list = Array.isArray(providers) ? providers : [];
  let changed = false;
  for (const provider of list) {
    const next = providerFetchTimeoutMs(provider, { stream: false });
    if (Number(provider.timeoutMs) !== next) {
      provider.timeoutMs = next;
      changed = true;
    }
    if (Number(provider.maxRetries) < 1 && /claude|aws_cc|kimi|grok/i.test(String(provider.id || ''))) {
      provider.maxRetries = 1;
      changed = true;
    }
  }
  return changed;
}

/**
 * Pinned API keys stay on their group. Cross-group failover (e.g. Claude-Kiro → AWS-CC)
 * mis-attributes logs and finance to the fallback provider.
 */
export function chatCandidatesForRequest({ providers = [], model = '', pinnedProvider = null, allowCrossGroupFailover = false } = {}) {
  const list = Array.isArray(providers) ? providers : [];
  const want = String(model || '').trim();
  if (pinnedProvider) {
    if (!allowCrossGroupFailover) return [pinnedProvider];
    const others = list.filter((p) => p && p.id !== pinnedProvider.id && Array.isArray(p.models) && p.models.includes(want));
    return [pinnedProvider, ...others];
  }
  if (!want) {
    return list.slice().sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  }
  const exact = list
    .filter((p) => Array.isArray(p.models) && p.models.length && p.models.includes(want))
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  if (exact.length) return exact;
  const byDefault = list
    .filter((p) => String(p.defaultModel || '').trim() === want)
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  return byDefault;
}

export function isRetiredGptDefault(model) {
  const raw = String(model || '').trim();
  return !raw || RETIRED_GPT_DEFAULTS.includes(raw);
}

export function preferGptTerra(provider) {
  if (!provider || !GPT_RELAY_GROUP_IDS.includes(String(provider.id || ''))) return false;
  let changed = false;
  const models = [...new Set((provider.models || []).map((m) => String(m).trim()).filter(Boolean))];
  if (models.includes(DEFAULT_RECOMMENDED_MODEL)) {
    const ordered = [DEFAULT_RECOMMENDED_MODEL, ...models.filter((m) => m !== DEFAULT_RECOMMENDED_MODEL)];
    if (ordered.join('\0') !== models.join('\0')) {
      provider.models = ordered;
      changed = true;
    }
  }
  const def = String(provider.defaultModel || '').trim();
  if (def !== DEFAULT_RECOMMENDED_MODEL) {
    provider.defaultModel = DEFAULT_RECOMMENDED_MODEL;
    changed = true;
  }
  const wantPri = GPT_RELAY_PRIORITY[provider.id];
  if (wantPri != null && Number(provider.priority) !== wantPri) {
    provider.priority = wantPri;
    changed = true;
  }
  return changed;
}

export const BEIBEIHAI_GROUP_HINTS = {
  grp_deepseek: ['deepseek', 'ds'],
  grp_cc_max: ['cc-max', 'ccmax', 'cc max', 'claude-max', 'claude max', 'cc_max'],
  grp_glm: ['智普', 'zhipu'],
  grp_kimi: ['kimi'],
  grp_gemini: ['gemini'],
  grp_grok_heavy: ['grok heavy'],
  grp_claude_kiro: ['aws企业号', 'kiro（aws', 'kiro(aws', 'kiro aws', 'claude-kiro', 'claude kiro'],
  grp_claude_kiro_welfare: ['kiro（福利', 'kiro(福利', 'kiro福利', 'kiro 福利']
};

export const VIP1129_GROUP_HINTS = {
  grp_gpt_pro: ['混合池1', 'codex 混合池1'],
  grp_gpt_plus: ['混合池2', 'codex 混合池2'],
  grp_gpt_mix: ['混合池3', '混用', 'codex 混合池3'],
  grp_aws_cc: ['aws-cc', '金额消耗']
};

const LEGACY_OFFICIAL_URLS = {
  grp_deepseek: ['https://api.deepseek.com/v1/chat/completions'],
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

function groupMatchesHints(group, localId, hints = BEIBEIHAI_GROUP_HINTS) {
  if (!group) return false;
  const keys = hints[localId] || [];
  const hay = haystack(group);
  const name = String(group.name || '').toLowerCase();
  return keys.some((key) => {
    const needle = String(key).toLowerCase();
    return needle && (name === needle || hay.includes(needle));
  });
}

/** Remap local groups whose stored upstream id is missing or no longer matches hints. */
export function reconcileGroupMap(currentMap, availableGroups, localIds, hints = BEIBEIHAI_GROUP_HINTS) {
  const next = compactGroupMap(currentMap);
  const groups = Array.isArray(availableGroups) ? availableGroups : [];
  const byId = new Map(groups.map((g) => [Number(g.id), g]));
  for (const localId of localIds || []) {
    const current = next[localId];
    const mapped = current != null ? byId.get(Number(current)) : null;
    if (mapped && groupMatchesHints(mapped, localId, hints)) continue;
    const used = new Set(
      Object.entries(next)
        .filter(([id]) => id !== localId)
        .map(([, v]) => Number(v))
        .filter(Number.isFinite)
    );
    const remaining = groups.filter((g) => !used.has(Number(g.id)));
    const suggested = matchUpstreamGroupId(localId, remaining.length ? remaining : groups, hints);
    if (suggested != null) next[localId] = suggested;
    else if (mapped == null && current != null) delete next[localId];
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
  if (GPT_RELAY_GROUP_IDS.includes(id)) {
    preferGptTerra(next);
  } else if (sync === 'vip1129' && isRetiredGptDefault(next.defaultModel)) {
    next.defaultModel = DEFAULT_RECOMMENDED_MODEL;
  }
  applySyncedModels(next, next.models, SEEDED_DEFAULT_MODELS[id] || next.defaultModel);
  return next;
}

export function wireAllProviders(providers, opts = {}) {
  return (providers || []).map(p => applyProviderWiring(p, opts));
}

/** Upstream sk- may live on upstream.key; local dashboard key can stay rk_. */
export function upstreamSecretOf(keyRec) {
  const fromUp = String(keyRec?.upstream?.key || '').trim();
  if (fromUp.startsWith('sk-')) return fromUp;
  const local = String(keyRec?.key || '').trim();
  if (local.startsWith('sk-')) return local;
  return '';
}

/** Move a copied-through sk- off the public key before rotating to rk_. */
export function preserveUpstreamSecret(keyRec) {
  if (!keyRec) return keyRec;
  const local = String(keyRec.key || '').trim();
  if (!local.startsWith('sk-')) return keyRec;
  keyRec.upstream = keyRec.upstream && typeof keyRec.upstream === 'object' ? keyRec.upstream : {};
  if (!String(keyRec.upstream.key || '').startsWith('sk-')) keyRec.upstream.key = local;
  return keyRec;
}

/**
 * A local API key is usable as the upstream Bearer when it has a stored sk-
 * (upstream.key or a legacy key field that is still sk-).
 */
export function isUsableUpstreamSecret(provider, keyRec, isVip1129, isBeibeihai) {
  if (!keyRec || keyRec.enabled === false) return false;
  const secret = upstreamSecretOf(keyRec);
  if (!secret) return false;
  const vip = typeof isVip1129 === 'function' ? isVip1129(provider) : !!isVip1129;
  const bb = typeof isBeibeihai === 'function' ? isBeibeihai(provider) : !!isBeibeihai;
  if (vip) {
    if (keyRec.upstream?.provider === 'vip1129') return true;
    if (!keyRec.groupId || keyRec.groupId === provider.id) return true;
  }
  if (bb) {
    if (keyRec.upstream?.provider === 'beibeihai') return true;
    if (!keyRec.groupId || keyRec.groupId === provider.id) return true;
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
    return { key: upstreamSecretOf(preferredRec), rec: preferredRec, user: preferredUser || null };
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
        return { key: upstreamSecretOf(k), rec: k, user: u };
      }
    }
    return null;
  };

  return scan(true) || scan(false) || (preferredRec && usable(preferredRec)
    ? { key: upstreamSecretOf(preferredRec), rec: preferredRec, user: preferredUser || null }
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

export function findListedSecretById(payload, id) {
  const want = String(id || '').trim();
  if (!want) return { id: null, key: null };
  for (const row of flattenListedKeys(payload)) {
    const rid = row.id ?? row.key_id ?? row.keyId ?? null;
    if (rid == null || String(rid) !== want) continue;
    const key = row.key || row.secret || row.api_key || row.apiKey || null;
    if (!key) return { id: String(rid), key: null };
    return { id: String(rid), key: String(key) };
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
  grp_cc_max: 0.6,
  grp_cursor_pool: 0.1,
  grp_aws_cc: 0.5,
  grp_glm: 0.5,
  grp_kimi: 0.5,
  grp_gemini: 0.2,
  grp_grok_heavy: 0.1,
  grp_claude_kiro: 0.35,
  grp_claude_kiro_welfare: 0.1
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
  if (isRetiredGptDefault(raw)) return fallback;
  return raw;
}

export function normalizeRecommendedModel(raw, fallback = DEFAULT_RECOMMENDED_MODEL) {
  let model = String(raw == null ? fallback : raw).trim();
  if (isRetiredGptDefault(model)) model = fallback;
  if (!model) return { ok: false, error: '推荐模型不能为空' };
  if (model.length > 80) return { ok: false, error: '推荐模型名称过长' };
  if (!/^[\w./:+-]+$/.test(model)) return { ok: false, error: '推荐模型名称含非法字符' };
  return { ok: true, model };
}
