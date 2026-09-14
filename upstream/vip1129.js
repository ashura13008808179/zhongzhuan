/**
 * vip1129 (Codex 直连中转) management API client.
 * Login: POST /api/v1/auth/login → data.access_token
 * Keys: POST/GET/PUT/DELETE /api/v1/keys
 */
const DEFAULT_BASE = 'https://api.vip1129.cc';

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

export async function updateKey(baseUrl, token, id, body) {
  const base = normalizeBase(baseUrl);
  const res = await fetch(`${base}/api/v1/keys/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify(body || {})
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

export async function fetchAccount(baseUrl, token) {
  const base = normalizeBase(baseUrl);
  const res = await fetch(`${base}/api/v1/auth/me`, { headers: authHeaders(token) });
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

export function isVip1129Provider(provider) {
  const url = String(provider?.url || '').toLowerCase();
  return url.includes('vip1129.cc') || provider?.upstreamSync === 'vip1129';
}

export function defaultGroupMap() {
  return {
    grp_gpt_pro: 10,   // codex 混合池1
    grp_gpt_plus: 34,  // codex 混合池2
    grp_gpt_mix: 65,   // codex 混合池3
    grp_aws_cc: 56,    // aws-cc 金额消耗
    grp_grok_vip: 79   // Grok 分组
  };
}

export { DEFAULT_BASE };
