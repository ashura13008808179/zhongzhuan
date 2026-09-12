import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const dataDir = path.join(__dirname, 'data');
const dbFile = path.join(dataDir, 'db.json');
const PORT = Number(process.env.PORT || 8787);
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-this-password';
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'support@example.com';
const CONTACT_WECHAT = process.env.CONTACT_WECHAT || 'RelaySupport';
const PAYMENT_QR = process.env.PAYMENT_QR || '/payment-qr.svg';
const DEFAULT_MAX_TOKENS = Number(process.env.DEFAULT_MAX_TOKENS || 1024);
const DEFAULT_MULTIPLIER = Number(process.env.BILLING_MULTIPLIER || 2);
const BALANCE_SAFETY_BUFFER = Number(process.env.BALANCE_SAFETY_BUFFER || 0);
const LEGACY_UPSTREAM = { url: process.env.UPSTREAM_URL || '', apiKey: process.env.UPSTREAM_API_KEY || '', model: process.env.UPSTREAM_MODEL || 'gpt-4o-mini', price: Number(process.env.UPSTREAM_PRICE_PER_1K || 0.01) };
const sessions = new Map();
const rateBuckets = new Map();
const AUTH_RATE_LIMIT = 60;
const CHAT_RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;
const AUDIT_CAP = 5000;

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(dbFile)) fs.writeFileSync(dbFile, JSON.stringify({ users: [], rechargeCodes: [], logs: [], auditLogs: [], sessions: {}, settings: {} }, null, 2));

function readDb() { return JSON.parse(fs.readFileSync(dbFile, 'utf8')); }
function writeDb(db) { fs.writeFileSync(dbFile, JSON.stringify(db, null, 2)); }
function id(prefix) { return `${prefix}_${crypto.randomBytes(7).toString('hex')}`; }
function hash(password, salt = crypto.randomBytes(16).toString('hex')) { return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`; }
function verify(password, stored) {
  const [salt, secret] = stored.split(':');
  try {
    return crypto.timingSafeEqual(Buffer.from(secret, 'hex'), crypto.scryptSync(password, salt, 64));
  } catch {
    return false;
  }
}
function userKey() { return `rk_${crypto.randomBytes(20).toString('hex')}`; }
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
function fail(res, status, error) { return json(res, status, { error }); }
async function body(req) { let raw = ''; for await (const chunk of req) raw += chunk; try { return raw ? JSON.parse(raw) : {}; } catch { return null; } }
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}
function rateLimit(req, res, limit, bucketName) {
  const key = `${clientIp(req)}:${bucketName || 'default'}`;
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.windowStart >= RATE_WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    fail(res, 429, '请求过于频繁，请稍后再试');
    return false;
  }
  return true;
}
function persistSession(db, token, userId) {
  db.sessions ??= {};
  db.sessions[token] = { userId, createdAt: new Date().toISOString() };
}
function clearSession(db, token) {
  db.sessions ??= {};
  delete db.sessions[token];
}
function userFrom(req, db) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  let userId = sessions.get(token);
  if (!userId && db.sessions?.[token]) {
    userId = db.sessions[token].userId;
    sessions.set(token, userId);
  }
  return userId ? db.users.find(u => u.id === userId) : null;
}
function isAdmin(user) { return user?.role === 'admin'; }
function availableTokens(user) { return Math.max(0, (user.quotaTokens || 0) - (user.usedTokens || 0) - (user.reservedTokens || 0)); }
const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/i;

function slugifyUsername(raw) {
  let s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .replace(/[_-]{2,}/g, '_')
    .slice(0, 24);
  if (s.length < 3) s = `${s}user`.replace(/[_-]{2,}/g, '_').slice(0, 24);
  if (s.length < 3) s = 'user';
  if (!/^[a-z]/.test(s)) s = `u_${s}`.slice(0, 24);
  return s;
}

function usernameTaken(db, username, exceptId) {
  const lower = String(username || '').toLowerCase();
  if (!lower) return false;
  return db.users.some(u => u.id !== exceptId && (u.username || '').toLowerCase() === lower);
}

function allocateUsername(db, seed, exceptId) {
  const base = slugifyUsername(seed);
  let candidate = base;
  let n = 0;
  while (usernameTaken(db, candidate, exceptId)) {
    n += 1;
    const suffix = String(n);
    candidate = `${base.slice(0, Math.max(3, 24 - suffix.length))}${suffix}`;
  }
  return candidate;
}

function ensureUsername(user, db) {
  if (user.username && USERNAME_RE.test(user.username) && !usernameTaken(db, user.username, user.id)) return;
  const seed = user.username || user.name || (user.email || '').split('@')[0] || 'user';
  user.username = allocateUsername(db, seed, user.id);
}

function findUserByIdentifier(db, identifier) {
  const raw = String(identifier || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const byEmail = db.users.find(x => (x.email || '').toLowerCase() === lower);
  if (byEmail) return byEmail;
  const byUsername = db.users.find(x => x.username && x.username.toLowerCase() === lower);
  if (byUsername) return byUsername;
  return db.users.find(x => x.name && x.name.toLowerCase() === lower) || null;
}

function safeUser(user) {
  return {
    id: user.id,
    email: user.email,
    username: user.username || '',
    name: user.name,
    apiKey: user.apiKey,
    balance: user.balance || 0,
    bonusBalance: user.bonusBalance || 0,
    quotaTokens: user.quotaTokens || 0,
    usedTokens: user.usedTokens || 0,
    availableTokens: availableTokens(user),
    accountActive: user.accountActive !== false,
    isAdmin: isAdmin(user),
    role: user.role || 'user',
    invited: user.invited || 0,
    createdAt: user.createdAt
  };
}
function adminUserView(user) {
  const key = user.apiKey || '';
  return {
    id: user.id,
    email: user.email,
    username: user.username || '',
    name: user.name,
    balance: user.balance || 0,
    quotaTokens: user.quotaTokens || 0,
    usedTokens: user.usedTokens || 0,
    accountActive: user.accountActive !== false,
    role: user.role || 'user',
    createdAt: user.createdAt,
    invited: user.invited || 0,
    apiKeyMasked: key ? `****${key.slice(-4)}` : null
  };
}
function multiplier(db) {
  const value = Number(db.settings?.billingMultiplier ?? DEFAULT_MULTIPLIER);
  return Number.isFinite(value) && value >= 1 && value <= 10 ? value : DEFAULT_MULTIPLIER;
}
function normalizeProvider(item, previous = null) {
  const modelPrices = {};
  const rawPrices = item.modelPrices && typeof item.modelPrices === 'object' ? item.modelPrices : (previous?.modelPrices || {});
  for (const [model, price] of Object.entries(rawPrices)) {
    if (!price || typeof price !== 'object') continue;
    modelPrices[model] = {
      inputPricePer1K: Math.max(0, Number(price.inputPricePer1K || 0)),
      outputPricePer1K: Math.max(0, Number(price.outputPricePer1K || 0))
    };
  }
  return {
    id: String(item.id),
    name: String(item.name),
    url: String(item.url),
    apiKey: String(item.apiKey || previous?.apiKey || ''),
    defaultModel: String(item.defaultModel || previous?.defaultModel || ''),
    models: Array.isArray(item.models) ? item.models.map(String) : (previous?.models || []),
    inputPricePer1K: Math.max(0, Number(item.inputPricePer1K ?? previous?.inputPricePer1K ?? 0)),
    outputPricePer1K: Math.max(0, Number(item.outputPricePer1K ?? previous?.outputPricePer1K ?? 0)),
    enabled: item.enabled !== false,
    priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : (Number(previous?.priority) || 100),
    timeoutMs: Math.max(1000, Number(item.timeoutMs ?? previous?.timeoutMs ?? 60000) || 60000),
    maxRetries: Math.max(0, Math.min(5, Number(item.maxRetries ?? previous?.maxRetries ?? 0) || 0)),
    modelPrices,
    health: previous?.health || { ok: true, lastCheckedAt: null, lastError: null }
  };
}
function providers(db) {
  return Array.isArray(db.settings?.providers)
    ? db.settings.providers.filter(p => p.enabled !== false && p.url && p.apiKey)
    : [];
}
function providersForModel(payload, db) {
  const list = providers(db);
  const model = String(payload.model || '');
  const matched = list
    .filter(p => Array.isArray(p.models) && p.models.includes(model))
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  if (matched.length) return matched;
  const fallback = list.find(p => p.id === db.settings.defaultProviderId) || list[0];
  return fallback ? [fallback] : [];
}
function providerFor(payload, db) {
  return providersForModel(payload, db)[0] || null;
}
function modelPrice(provider, model, kind) {
  const prices = provider.modelPrices?.[model];
  if (prices) {
    const value = Number(prices[kind]);
    if (Number.isFinite(value)) return value;
  }
  const fallback = Number(provider.pricePer1K || 0);
  if (kind === 'inputPricePer1K') return Number(provider.inputPricePer1K ?? fallback);
  return Number(provider.outputPricePer1K ?? fallback);
}
function providerCost(provider, usage, model) {
  const resolvedModel = model || provider.defaultModel || '';
  const inputPrice = modelPrice(provider, resolvedModel, 'inputPricePer1K');
  const outputPrice = modelPrice(provider, resolvedModel, 'outputPricePer1K');
  return ((Number(usage.prompt_tokens || 0) / 1000) * inputPrice) + ((Number(usage.completion_tokens || 0) / 1000) * outputPrice);
}
function estimatedCost(provider, inputTokens, outputTokens, model) {
  return providerCost(provider, { prompt_tokens: inputTokens, completion_tokens: outputTokens }, model);
}
function safetyBuffer(provider, rate, model) {
  const input = modelPrice(provider, model || provider.defaultModel || '', 'inputPricePer1K');
  const output = modelPrice(provider, model || provider.defaultModel || '', 'outputPricePer1K');
  const minCost = Math.max(input, output) / 1000 * rate;
  return Math.max(BALANCE_SAFETY_BUFFER, minCost);
}
function publicProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    models: provider.models || [],
    defaultModel: provider.defaultModel || '',
    enabled: provider.enabled !== false,
    inputPricePer1K: Number(provider.inputPricePer1K ?? provider.pricePer1K ?? 0),
    outputPricePer1K: Number(provider.outputPricePer1K ?? provider.pricePer1K ?? 0),
    priority: Number(provider.priority ?? 100),
    timeoutMs: Number(provider.timeoutMs ?? 60000),
    maxRetries: Number(provider.maxRetries ?? 0),
    modelPrices: provider.modelPrices || {},
    health: provider.health || { ok: true, lastCheckedAt: null, lastError: null },
    apiKeyConfigured: Boolean(provider.apiKey)
  };
}
function audit(db, { actorId, action, target, detail }) {
  db.auditLogs ??= [];
  db.auditLogs.unshift({
    id: id('aud'),
    actorId: actorId || null,
    action: String(action || 'unknown'),
    target: target ? String(target) : null,
    detail: detail || null,
    createdAt: new Date().toISOString()
  });
  db.auditLogs = db.auditLogs.slice(0, AUDIT_CAP);
}
function updateProviderHealth(db, providerId, ok, errorMessage = null) {
  const provider = (db.settings.providers || []).find(p => p.id === providerId);
  if (!provider) return;
  provider.health = {
    ok: Boolean(ok),
    lastCheckedAt: new Date().toISOString(),
    lastError: ok ? null : String(errorMessage || 'upstream_error').slice(0, 300)
  };
}
function settleUsage(db, user, provider, usage, rate, tokenReservation, amountReservation, started, model, status = 'success') {
  const upstreamTokens = Math.max(0, Number(usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0))));
  const billedTokens = Math.min(upstreamTokens * rate, tokenReservation);
  const upstreamCost = providerCost(provider, usage, model);
  const chargedAmount = upstreamCost * rate;
  user.reservedTokens = Math.max(0, (user.reservedTokens || 0) - tokenReservation);
  user.reservedBalance = Math.max(0, (user.reservedBalance || 0) - amountReservation);
  user.usedTokens = Math.min(user.quotaTokens || 0, (user.usedTokens || 0) + billedTokens);
  user.balance = Math.max(0, (user.balance || 0) - chargedAmount);
  if (user.balance <= safetyBuffer(provider, rate, model)) {
    user.balance = 0;
    user.accountActive = false;
  }
  db.logs.unshift({
    id: id('log'),
    userId: user.id,
    model,
    providerId: provider.id,
    tokens: upstreamTokens,
    billedTokens,
    upstreamCost,
    chargedAmount,
    multiplier: rate,
    latency: Date.now() - started,
    status,
    createdAt: new Date().toISOString()
  });
  db.logs = db.logs.slice(0, 3000);
  return { billedTokens, chargedAmount, upstreamTokens, upstreamCost };
}
function releaseReserve(user, tokenReservation, amountReservation) {
  user.reservedTokens = Math.max(0, (user.reservedTokens || 0) - tokenReservation);
  user.reservedBalance = Math.max(0, (user.reservedBalance || 0) - amountReservation);
}
function estimateTokensFromText(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(String(text).length / 4));
}
async function fetchUpstream(provider, payload, outputBudget, model) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), provider.timeoutMs || 60000);
  try {
    const upstream = await fetch(provider.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({ ...payload, model: model || payload.model || provider.defaultModel, max_tokens: outputBudget }),
      signal: controller.signal
    });
    return upstream;
  } finally {
    clearTimeout(timeout);
  }
}

async function chat(req, res, db, user) {
  const payload = await body(req);
  if (!payload || !Array.isArray(payload.messages) || !payload.messages.length) return fail(res, 400, 'messages 不能为空');
  if (user.accountActive === false) return fail(res, 402, '账户余额不足，API 已暂停，请充值后继续使用');

  const candidates = providersForModel(payload, db);
  if (!candidates.length) return fail(res, 503, '模型服务暂不可用，请稍后重试');

  const primary = candidates[0];
  const model = String(payload.model || primary.defaultModel || '');
  const rate = multiplier(db);
  const inputReserve = Math.ceil(JSON.stringify(payload.messages).length * 2) + 256;
  const requestedOutput = Math.max(1, Math.min(Number(payload.max_tokens) || DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS));
  const tokenBudget = Math.floor(availableTokens(user) / rate);
  if (tokenBudget <= inputReserve) return fail(res, 402, 'API 配额不足，无法发起请求');

  const availableBalance = Math.max(0, (user.balance || 0) - (user.reservedBalance || 0));
  const safety = safetyBuffer(primary, rate, model);
  const inputEstimate = estimatedCost(primary, inputReserve, 0, model) * rate;
  const outputUnitPrice = Math.max(modelPrice(primary, model, 'outputPricePer1K') / 1000 * rate, Number.EPSILON);
  const moneyBudget = Math.floor(Math.max(0, availableBalance - safety - inputEstimate) / outputUnitPrice);
  const outputBudget = Math.min(requestedOutput, tokenBudget - inputReserve, moneyBudget);
  if (outputBudget < 1) {
    user.balance = 0;
    user.accountActive = false;
    writeDb(db);
    return fail(res, 402, '账户余额接近用尽，API 已暂停，请充值后继续使用');
  }

  const upstreamReservation = inputReserve + outputBudget;
  const tokenReservation = upstreamReservation * rate;
  const amountReservation = estimatedCost(primary, inputReserve, outputBudget, model) * rate;
  if (availableBalance < amountReservation + safety) {
    user.balance = 0;
    user.accountActive = false;
    writeDb(db);
    return fail(res, 402, '账户余额接近用尽，API 已暂停，请充值后继续使用');
  }

  user.reservedTokens = (user.reservedTokens || 0) + tokenReservation;
  user.reservedBalance = (user.reservedBalance || 0) + amountReservation;
  writeDb(db);

  const started = Date.now();
  const wantStream = payload.stream === true;
  let lastError = null;

  for (const provider of candidates) {
    try {
      const upstreamPayload = { ...payload, stream: wantStream };
      const upstream = await fetchUpstream(provider, upstreamPayload, outputBudget, model || provider.defaultModel);
      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => '');
        updateProviderHealth(db, provider.id, false, `HTTP ${upstream.status}: ${errText.slice(0, 120)}`);
        writeDb(db);
        lastError = new Error('provider_error');
        continue;
      }

      updateProviderHealth(db, provider.id, true);
      writeDb(db);

      if (wantStream) {
        return streamChat(req, res, db, user, provider, upstream, {
          model: model || provider.defaultModel,
          rate,
          tokenReservation,
          amountReservation,
          started,
          inputReserve
        });
      }

      const text = await upstream.text();
      let result;
      try {
        result = JSON.parse(text);
      } catch {
        updateProviderHealth(db, provider.id, false, 'invalid_json');
        writeDb(db);
        lastError = new Error('invalid_json');
        continue;
      }

      const usage = result.usage || {};
      settleUsage(db, user, provider, usage, rate, tokenReservation, amountReservation, started, result.model || model || provider.defaultModel);
      writeDb(db);
      return json(res, 200, result);
    } catch (err) {
      updateProviderHealth(db, provider.id, false, err?.message || 'fetch_failed');
      writeDb(db);
      lastError = err;
    }
  }

  releaseReserve(user, tokenReservation, amountReservation);
  writeDb(db);
  return fail(res, 502, '模型服务暂时不可用，请稍后重试');
}

async function streamChat(req, res, db, user, provider, upstream, ctx) {
  const { model, rate, tokenReservation, amountReservation, started, inputReserve } = ctx;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive'
  });

  let settled = false;
  let aborted = false;
  let usage = null;
  let completionText = '';
  let buffer = '';

  const cleanup = (reason = 'abort') => {
    if (settled) return;
    settled = true;
    aborted = true;
    releaseReserve(user, tokenReservation, amountReservation);
    db.logs.unshift({
      id: id('log'),
      userId: user.id,
      model,
      providerId: provider.id,
      tokens: 0,
      billedTokens: 0,
      upstreamCost: 0,
      chargedAmount: 0,
      multiplier: rate,
      latency: Date.now() - started,
      status: reason,
      createdAt: new Date().toISOString()
    });
    db.logs = db.logs.slice(0, 3000);
    writeDb(db);
    try { res.end(); } catch { /* ignore */ }
  };

  req.on('close', () => { if (!settled) cleanup('client_abort'); });
  req.on('aborted', () => { if (!settled) cleanup('client_abort'); });

  try {
    const reader = upstream.body?.getReader?.();
    if (!reader) {
      // Fallback for environments without getReader: read as text stream via async iterator
      for await (const chunk of upstream.body) {
        if (aborted) break;
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        buffer += text;
        res.write(text);
        processSseBuffer();
      }
    } else {
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (aborted) break;
        const text = decoder.decode(value, { stream: true });
        buffer += text;
        res.write(text);
        processSseBuffer();
      }
    }
  } catch {
    if (!settled) cleanup('stream_error');
    return;
  }

  function processSseBuffer() {
    const parts = buffer.split('\n');
    buffer = parts.pop() || '';
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.usage) usage = parsed.usage;
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') completionText += delta;
        const messageContent = parsed.choices?.[0]?.message?.content;
        if (typeof messageContent === 'string') completionText += messageContent;
      } catch { /* ignore partial json */ }
    }
  }

  // Flush remaining buffer
  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith('data:')) {
      const data = trimmed.slice(5).trim();
      if (data && data !== '[DONE]') {
        try {
          const parsed = JSON.parse(data);
          if (parsed.usage) usage = parsed.usage;
          const delta = parsed.choices?.[0]?.delta?.content;
          if (typeof delta === 'string') completionText += delta;
        } catch { /* ignore */ }
      }
    }
  }

  if (settled) return;

  if (!usage) {
    const promptTokens = inputReserve;
    const completionTokens = estimateTokensFromText(completionText);
    usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    };
  }

  settled = true;
  settleUsage(db, user, provider, usage, rate, tokenReservation, amountReservation, started, model);
  writeDb(db);
  try { res.end(); } catch { /* ignore */ }
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const db = readDb();
  db.auditLogs ??= [];
  db.sessions ??= {};
  db.settings ??= {};

  if (req.method === 'GET' && url.pathname === '/api/config') {
    return json(res, 200, { contactEmail: CONTACT_EMAIL, contactWechat: CONTACT_WECHAT, paymentQr: PAYMENT_QR, appName: 'Relay Station' });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    if (!rateLimit(req, res, AUTH_RATE_LIMIT, 'auth')) return;
    const p = await body(req);
    const email = String(p?.email || '').trim().toLowerCase();
    if (!email || !email.includes('@') || !p?.password || p.password.length < 8) return fail(res, 400, '请输入邮箱和至少 8 位密码');
    if (db.users.some(x => x.email === email)) return fail(res, 409, '该邮箱已注册');
    const requestedUsername = String(p.username || '').trim();
    let username;
    if (requestedUsername) {
      if (!USERNAME_RE.test(requestedUsername)) return fail(res, 400, '用户名需为 3–32 位字母、数字、下划线或连字符，并以字母或数字开头');
      if (usernameTaken(db, requestedUsername)) return fail(res, 409, '该用户名已被占用');
      username = requestedUsername.toLowerCase();
    } else {
      username = allocateUsername(db, p.name || email.split('@')[0] || 'user');
    }
    const inviter = p.inviteCode ? db.users.find(x => x.inviteCode === p.inviteCode) : null;
    const user = {
      id: id('usr'),
      email,
      username,
      name: String(p.name || '').trim() || email.split('@')[0],
      password: hash(p.password),
      apiKey: userKey(),
      balance: 0,
      bonusBalance: inviter ? 10 : 0,
      quotaTokens: 0,
      usedTokens: 0,
      reservedTokens: 0,
      reservedBalance: 0,
      accountActive: false,
      role: 'user',
      invited: 0,
      inviteCode: crypto.randomBytes(4).toString('hex').toUpperCase(),
      createdAt: new Date().toISOString()
    };
    if (inviter) { inviter.invited += 1; inviter.bonusBalance += 20; }
    db.users.push(user);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, user.id);
    persistSession(db, token, user.id);
    writeDb(db);
    return json(res, 201, { token, user: safeUser(user) });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    if (!rateLimit(req, res, AUTH_RATE_LIMIT, 'auth')) return;
    const p = await body(req);
    const identifier = String(p?.login ?? p?.username ?? p?.email ?? '').trim();
    const user = findUserByIdentifier(db, identifier);
    if (!user || !p?.password || !verify(p.password, user.password)) return fail(res, 401, '用户名/邮箱或密码错误');
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, user.id);
    persistSession(db, token, user.id);
    writeDb(db);
    return json(res, 200, { token, user: safeUser(user) });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (token) {
      sessions.delete(token);
      clearSession(db, token);
      writeDb(db);
    }
    return json(res, 200, { ok: true });
  }

  const user = userFrom(req, db);

  if (req.method === 'GET' && url.pathname === '/api/me') {
    return user ? json(res, 200, { user: safeUser(user) }) : fail(res, 401, '未登录');
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    if (!user) return fail(res, 401, '未登录');
    const logs = db.logs.filter(x => x.userId === user.id);
    const totalTokens = logs.reduce((sum, x) => sum + (x.billedTokens ?? x.tokens * (x.multiplier || DEFAULT_MULTIPLIER)), 0);
    const avgLatency = logs.length ? Math.round(logs.reduce((sum, x) => sum + x.latency, 0) / logs.length) : 0;
    const displayLogs = logs.slice(0, 30).map(x => ({
      ...x,
      tokens: x.billedTokens ?? x.tokens * (x.multiplier || DEFAULT_MULTIPLIER),
      chargedAmount: x.chargedAmount ?? 0
    }));
    return json(res, 200, {
      user: safeUser(user),
      stats: {
        requests: logs.length,
        tokens: totalTokens,
        avgLatency,
        success: logs.filter(x => x.status === 'success').length,
        quotaTokens: user.quotaTokens || 0,
        usedTokens: user.usedTokens || 0,
        availableTokens: availableTokens(user)
      },
      logs: displayLogs,
      inviteCode: user.inviteCode,
      inviteCount: user.invited
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/recharge/redeem') {
    if (!user) return fail(res, 401, '未登录');
    const p = await body(req);
    const code = db.rechargeCodes.find(x => x.code === p?.code && !x.usedAt);
    if (!code) return fail(res, 400, '卡密无效或已使用');
    const quotaTokens = Number(code.quotaTokens || 100000);
    code.usedAt = new Date().toISOString();
    code.userId = user.id;
    user.balance += Number(code.amount || 0);
    user.quotaTokens = (user.quotaTokens || 0) + quotaTokens;
    user.accountActive = true;
    writeDb(db);
    return json(res, 200, { user: safeUser(user), message: `充值成功，到账 ¥${code.amount}，新增 ${quotaTokens.toLocaleString()} Token 配额` });
  }

  // --- Admin APIs ---
  if (req.method === 'GET' && url.pathname === '/api/admin/pricing') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    return json(res, 200, {
      multiplier: multiplier(db),
      defaultProviderId: db.settings.defaultProviderId || null,
      providers: (db.settings.providers || []).map(publicProvider),
      healthSummary: (db.settings.providers || []).map(p => ({
        id: p.id,
        name: p.name,
        enabled: p.enabled !== false,
        health: p.health || { ok: true, lastCheckedAt: null, lastError: null }
      }))
    });
  }

  if (req.method === 'PUT' && url.pathname === '/api/admin/pricing') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const p = await body(req);
    const value = Number(p?.multiplier);
    if (!Number.isFinite(value) || value < 1 || value > 10) return fail(res, 400, '倍率必须在 1 到 10 之间');
    const prev = db.settings.billingMultiplier;
    db.settings.billingMultiplier = value;
    audit(db, { actorId: user.id, action: 'pricing.change', target: 'billingMultiplier', detail: { from: prev, to: value } });
    writeDb(db);
    return json(res, 200, { multiplier: value });
  }

  if (req.method === 'PUT' && url.pathname === '/api/admin/providers') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const p = await body(req);
    if (!Array.isArray(p?.providers) || !p.providers.length) return fail(res, 400, '至少保留一个渠道');
    const existing = new Map((db.settings.providers || []).map(x => [x.id, x]));
    const next = [];
    for (const item of p.providers) {
      if (!item?.id || !item?.name || !item?.url || !/^https:\/\//.test(item.url)) {
        return fail(res, 400, '渠道名称和 HTTPS 地址不能为空');
      }
      const previous = existing.get(item.id);
      const apiKey = item.apiKey || previous?.apiKey;
      if (!apiKey) return fail(res, 400, `渠道 ${item.name} 缺少 API Key`);
      const normalized = normalizeProvider({ ...item, apiKey }, previous);
      next.push(normalized);
    }
    db.settings.providers = next;
    db.settings.defaultProviderId = next.some(x => x.id === p.defaultProviderId) ? p.defaultProviderId : next[0].id;
    audit(db, {
      actorId: user.id,
      action: 'providers.save',
      target: 'providers',
      detail: { count: next.length, ids: next.map(x => x.id), defaultProviderId: db.settings.defaultProviderId }
    });
    writeDb(db);
    return json(res, 200, { providers: next.map(publicProvider), defaultProviderId: db.settings.defaultProviderId });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/users') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    return json(res, 200, { users: db.users.map(adminUserView) });
  }

  if (req.method === 'PUT' && url.pathname.startsWith('/api/admin/users/')) {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const targetId = decodeURIComponent(url.pathname.slice('/api/admin/users/'.length));
    if (!targetId) return fail(res, 400, '缺少用户 ID');
    const target = db.users.find(x => x.id === targetId);
    if (!target) return fail(res, 404, '用户不存在');
    const p = await body(req);
    if (!p || typeof p !== 'object') return fail(res, 400, '无效请求体');
    const changes = {};
    if ('accountActive' in p) {
      if (typeof p.accountActive !== 'boolean') return fail(res, 400, 'accountActive 必须为布尔值');
      changes.accountActive = { from: target.accountActive !== false, to: p.accountActive };
      target.accountActive = p.accountActive;
    }
    if ('balance' in p) {
      const balance = Number(p.balance);
      if (!Number.isFinite(balance) || balance < 0) return fail(res, 400, 'balance 必须为非负数字');
      changes.balance = { from: target.balance || 0, to: balance };
      target.balance = balance;
    }
    if ('quotaTokens' in p) {
      const quota = Number(p.quotaTokens);
      if (!Number.isFinite(quota) || quota < 0 || !Number.isInteger(quota)) return fail(res, 400, 'quotaTokens 必须为非负整数');
      changes.quotaTokens = { from: target.quotaTokens || 0, to: quota };
      target.quotaTokens = quota;
    }
    if ('role' in p) {
      if (p.role !== 'admin' && p.role !== 'user') return fail(res, 400, 'role 只能是 admin 或 user');
      if (target.id === user.id && p.role !== 'admin') return fail(res, 400, '不能取消自己的管理员角色');
      changes.role = { from: target.role || 'user', to: p.role };
      target.role = p.role;
    }
    if (!Object.keys(changes).length) return fail(res, 400, '没有可更新的字段');
    audit(db, { actorId: user.id, action: 'user.update', target: target.id, detail: changes });
    writeDb(db);
    return json(res, 200, { user: adminUserView(target) });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/codes') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const codes = (db.rechargeCodes || []).map(c => ({
      code: c.code,
      amount: Number(c.amount || 0),
      quotaTokens: Number(c.quotaTokens || 0),
      usedAt: c.usedAt || null,
      userId: c.userId || null
    }));
    return json(res, 200, { codes });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/codes') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const p = await body(req);
    const count = Number(p?.count);
    const amount = Number(p?.amount);
    const quotaTokens = Number(p?.quotaTokens);
    const prefix = typeof p?.prefix === 'string' ? p.prefix.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) : 'RELAY';
    if (!Number.isInteger(count) || count < 1 || count > 200) return fail(res, 400, 'count 必须为 1-200 的整数');
    if (!Number.isFinite(amount) || amount < 0) return fail(res, 400, 'amount 必须为非负数字');
    if (!Number.isInteger(quotaTokens) || quotaTokens < 0) return fail(res, 400, 'quotaTokens 必须为非负整数');
    const created = [];
    for (let i = 0; i < count; i++) {
      const code = `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const entry = { code, amount, quotaTokens, usedAt: null, userId: null, createdAt: new Date().toISOString() };
      db.rechargeCodes.push(entry);
      created.push({ code: entry.code, amount: entry.amount, quotaTokens: entry.quotaTokens, usedAt: null, userId: null });
    }
    audit(db, { actorId: user.id, action: 'codes.generate', target: 'rechargeCodes', detail: { count, amount, quotaTokens, prefix } });
    writeDb(db);
    return json(res, 201, { codes: created });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/audit') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    return json(res, 200, { entries: (db.auditLogs || []).slice(0, 200) });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/orders') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const orders = (db.rechargeCodes || [])
      .filter(c => c.usedAt)
      .map(c => ({
        id: `ord_${c.code}`,
        code: c.code,
        amount: Number(c.amount || 0),
        quotaTokens: Number(c.quotaTokens || 0),
        userId: c.userId || null,
        redeemedAt: c.usedAt,
        type: 'recharge_code'
      }))
      .sort((a, b) => String(b.redeemedAt).localeCompare(String(a.redeemedAt)));
    return json(res, 200, { orders });
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    if (!user) return fail(res, 401, '请先登录');
    if (!rateLimit(req, res, CHAT_RATE_LIMIT, 'chat')) return;
    return chat(req, res, db, user);
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    if (!rateLimit(req, res, CHAT_RATE_LIMIT, 'chat')) return;
    const apiKey = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const apiUser = db.users.find(x => x.apiKey === apiKey);
    if (!apiUser) return fail(res, 401, '无效的 Relay API Key');
    return chat(req, res, db, apiUser);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed');

  let file = url.pathname === '/' ? path.join(publicDir, 'index.html') : path.join(publicDir, url.pathname);
  file = path.normalize(file);
  if (!file.startsWith(publicDir)) return fail(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return fail(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    if (req.method !== 'HEAD') res.end(data);
    else res.end();
  });
});

const initial = readDb();
initial.settings ??= {};
initial.auditLogs ??= [];
initial.sessions ??= {};
initial.settings.billingMultiplier ??= DEFAULT_MULTIPLIER;
initial.settings.providers ??= [];
for (const user of initial.users) {
  user.quotaTokens ??= 0;
  user.usedTokens ??= 0;
  user.reservedTokens ??= 0;
  user.reservedBalance ??= 0;
  user.accountActive ??= (user.balance || 0) > 0;
  user.role ??= user.email === ADMIN_EMAIL.toLowerCase() ? 'admin' : 'user';
  ensureUsername(user, initial);
}
for (const provider of initial.settings.providers) {
  provider.priority ??= 100;
  provider.timeoutMs ??= 60000;
  provider.maxRetries ??= 0;
  provider.modelPrices ??= {};
  provider.health ??= { ok: true, lastCheckedAt: null, lastError: null };
}
if (!initial.settings.providers.length && LEGACY_UPSTREAM.url && LEGACY_UPSTREAM.apiKey) {
  initial.settings.providers.push({
    id: 'primary',
    name: 'Primary',
    url: LEGACY_UPSTREAM.url,
    apiKey: LEGACY_UPSTREAM.apiKey,
    defaultModel: LEGACY_UPSTREAM.model,
    models: [LEGACY_UPSTREAM.model],
    inputPricePer1K: LEGACY_UPSTREAM.price,
    outputPricePer1K: LEGACY_UPSTREAM.price,
    enabled: true,
    priority: 100,
    timeoutMs: 60000,
    maxRetries: 0,
    modelPrices: {},
    health: { ok: true, lastCheckedAt: null, lastError: null }
  });
}
initial.settings.defaultProviderId ??= initial.settings.providers[0]?.id ?? null;
if (!initial.users.some(x => x.email === ADMIN_EMAIL.toLowerCase())) {
  const adminUser = {
    id: 'usr_admin',
    email: ADMIN_EMAIL.toLowerCase(),
    name: 'Admin',
    password: hash(ADMIN_PASSWORD),
    apiKey: userKey(),
    balance: 0,
    bonusBalance: 0,
    quotaTokens: 0,
    usedTokens: 0,
    reservedTokens: 0,
    reservedBalance: 0,
    accountActive: false,
    role: 'admin',
    invited: 0,
    inviteCode: 'ADMIN',
    createdAt: new Date().toISOString()
  };
  ensureUsername(adminUser, initial);
  initial.users.push(adminUser);
}
const envCodes = (process.env.RECHARGE_CODES || '').split(',').map(x => x.trim()).filter(Boolean);
for (const item of envCodes) {
  const [code, amount, quotaTokens] = item.split(':');
  if (code && !initial.rechargeCodes.some(x => x.code === code)) {
    initial.rechargeCodes.push({ code, amount: Number(amount || 10), quotaTokens: Number(quotaTokens || 100000), usedAt: null });
  }
}
for (const [token, session] of Object.entries(initial.sessions || {})) {
  if (session?.userId) sessions.set(token, session.userId);
}
writeDb(initial);
server.listen(PORT, () => console.log(`Relay Station running at http://localhost:${PORT}`));
