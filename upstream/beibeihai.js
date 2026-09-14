/**
 * Beibeihai (sub.beibeihai.xyz) management API — same shape as vip1129.
 */
const DEFAULT_BASE = 'https://sub.beibeihai.xyz';

export function normalizeBase(url) {
  return String(url || DEFAULT_BASE).replace(/\/+$/, '');
}

async function readJson(res) {
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data, text };
}

function authHeaders(token) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`
  };
}

export async function login(baseUrl, email, password) {
  const base = normalizeBase(baseUrl);
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const parsed = await readJson(res);
  if (!parsed.ok) return { ok: false, error: 'login_http', ...parsed };
  const d = parsed.data || {};
  const token =
    d?.data?.access_token ||
    d?.access_token ||
    d?.data?.token ||
    d?.token ||
    null;
  if (!token) return { ok: false, error: 'login_no_token', ...parsed };
  return {
    ok: true,
    token: String(token),
    refreshToken: d?.data?.refresh_token || d?.refresh_token || null,
    expiresIn: d?.data?.expires_in || d?.expires_in || null,
    raw: d
  };
}

export async function listAvailableGroups(baseUrl, token) {
  const base = normalizeBase(baseUrl);
  const res = await fetch(`${base}/api/v1/groups/available`, { headers: authHeaders(token) });
  return readJson(res);
}

export async function listKeys(baseUrl, token, query = 'page=1&page_size=50') {
  const base = normalizeBase(baseUrl);
  const q = query ? (query.startsWith('?') ? query : `?${query}`) : '';
  const res = await fetch(`${base}/api/v1/keys${q}`, { headers: authHeaders(token) });
  return readJson(res);
}

export async function createKey(baseUrl, token, body = {}) {
  const base = normalizeBase(baseUrl);
  const payload = { name: String(body.name || 'relay').slice(0, 64) };
  if (body.group_id != null) payload.group_id = Number(body.group_id);
  if (body.custom_key) payload.custom_key = String(body.custom_key);
  if (body.ip_whitelist) payload.ip_whitelist = body.ip_whitelist;
  if (body.ip_blacklist) payload.ip_blacklist = body.ip_blacklist;
  if (body.quota != null && Number(body.quota) > 0) payload.quota = Number(body.quota);
  if (body.expires_in_days != null) payload.expires_in_days = Number(body.expires_in_days);
  if (body.rate_limit_5h != null) payload.rate_limit_5h = Number(body.rate_limit_5h);
  if (body.rate_limit_1d != null) payload.rate_limit_1d = Number(body.rate_limit_1d);
  if (body.rate_limit_7d != null) payload.rate_limit_7d = Number(body.rate_limit_7d);
  const res = await fetch(`${base}/api/v1/keys`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return readJson(res);
}

export async function deleteKey(baseUrl, token, id) {
  const base = normalizeBase(baseUrl);
  const res = await fetch(`${base}/api/v1/keys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(token)
  });
  return readJson(res);
}

export function extractCreatedSecret(data) {
  if (!data || typeof data !== 'object') return { id: null, key: null, raw: null };
  const root = data.data && typeof data.data === 'object' ? data.data : data;
  const nested = root.key || root.id != null ? root : (root.data && typeof root.data === 'object' ? root.data : root);
  const id = nested.id ?? nested.key_id ?? nested.keyId ?? null;
  const key = nested.key || nested.secret || nested.api_key || nested.apiKey || null;
  return { id: id != null ? String(id) : null, key: key ? String(key) : null, raw: nested };
}

export function isBeibeihaiProvider(provider) {
  const url = String(provider?.url || '').toLowerCase();
  return url.includes('beibeihai.xyz') || provider?.upstreamSync === 'beibeihai';
}

/**
 * Default local→upstream group map.
 * IDs differ per Beibeihai account, so defaults stay empty (not null placeholders).
 * After login we call listAvailableGroups and fill via suggestGroupMap().
 * Null/empty values must NOT count as mapped channels.
 */
export function defaultGroupMap() {
  return {
    grp_deepseek: 77,
    grp_grok: 43,
    grp_cc_max: 56,
    grp_glm: 79,
    grp_kimi: 81,
    grp_gemini: 55,
    grp_nano_banana: 53,
    grp_nano_banana_pro: 76,
    grp_grok_heavy: 80,
    grp_grok_image: 68,
    grp_claude_kiro: 89,
    grp_claude_kiro_welfare: 33,
    grp_cn_models: 47
  };
}

export { DEFAULT_BASE };
