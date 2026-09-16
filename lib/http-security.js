import crypto from 'node:crypto';
import path from 'node:path';

export const MAX_JSON_BODY = Number(process.env.MAX_JSON_BODY || 256 * 1024);
export const MAX_UPLOAD_BODY = Number(process.env.MAX_UPLOAD_BODY || 6 * 1024 * 1024);
export const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 7 * 24 * 60 * 60 * 1000);
export const LOGIN_RATE_LIMIT = Number(process.env.AUTH_LOGIN_RATE_LIMIT || 20);
export const REGISTER_RATE_LIMIT = Number(process.env.AUTH_REGISTER_RATE_LIMIT || 12);
export const REGISTER_DAILY_LIMIT = Number(process.env.REGISTER_DAILY_LIMIT || 8);
export const LOGIN_FAIL_LIMIT = Number(process.env.LOGIN_FAIL_LIMIT || 10);
export const LOGIN_FAIL_WINDOW_MS = Number(process.env.LOGIN_FAIL_WINDOW_MS || 15 * 60 * 1000);
export const CONFIG_RATE_LIMIT = Number(process.env.CONFIG_RATE_LIMIT || 90);
export const API_RATE_LIMIT = Number(process.env.API_RATE_LIMIT || 180);

const TRUST_PROXY = String(process.env.TRUST_PROXY || '').trim() === '1';
const loginFails = new Map();
const registerDays = new Map();
const lockChains = new Map();

function todayStamp(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function trustProxyEnabled() {
  return TRUST_PROXY;
}

export function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim().slice(0, 128);
  }
  return req.socket?.remoteAddress || 'unknown';
}

export function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "script-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ')
  };
}

export function attachSecurityHeaders(res) {
  if (res._securityHeadersAttached) return;
  res._securityHeadersAttached = true;
  const orig = res.writeHead;
  res.writeHead = function writeHeadPatched(statusCode, statusMessage, headers) {
    let code = statusCode;
    let msg = statusMessage;
    let hdrs = headers;
    if (typeof statusMessage === 'object' && statusMessage != null) {
      hdrs = statusMessage;
      msg = undefined;
    }
    const extra = securityHeaders();
    if (hdrs == null) hdrs = extra;
    else if (Array.isArray(hdrs)) hdrs = hdrs;
    else hdrs = { ...extra, ...hdrs };
    if (msg === undefined) return orig.call(this, code, hdrs);
    return orig.call(this, code, msg, hdrs);
  };
}

export function parseJsonSafe(raw) {
  if (!raw) return {};
  const value = JSON.parse(raw, (key, val) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
    return val;
  });
  return value && typeof value === 'object' ? value : {};
}

export async function readLimitedBody(req, maxBytes = MAX_JSON_BODY) {
  const len = Number(req.headers['content-length']);
  if (Number.isFinite(len) && len > maxBytes) {
    const err = new Error('payload_too_large');
    err.code = 'PAYLOAD_TOO_LARGE';
    throw err;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      req.destroy();
      const err = new Error('payload_too_large');
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

const BLOCKED_NAME = /(?:^|[/\\])(\.env|\.git|package\.json|server\.js|run\.bat|\.master\.key|\.tmp-.*|.*\.(bak|tmp|log|ps1|env|pem|key)(?:-.*)?)$/i;

export function isBlockedPublicPath(pathname) {
  const raw = String(pathname || '');
  if (!raw || raw.includes('\0')) return true;
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { return true; }
  const norm = decoded.replace(/\\/g, '/');
  if (norm.split('/').includes('..')) return true;
  if (BLOCKED_NAME.test(norm)) return true;
  if (/(^|\/)data(\/|$)/i.test(norm)) return true;
  if (/(^|\/)\./.test(norm.replace(/^\/+/, '/'))) return true;
  return false;
}

export function resolvePublicFile(publicDir, pathname) {
  const raw = String(pathname || '/');
  if (isBlockedPublicPath(raw)) return null;
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  const rel = decoded.replace(/^\/+/, '');
  const root = path.resolve(publicDir);
  const file = !rel || rel === '' ? path.join(root, 'index.html') : path.resolve(root, rel);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (file !== root && !file.startsWith(prefix)) return null;
  return file;
}

export function robotsTxt() {
  return [
    'User-agent: *',
    'Disallow: /api/',
    'Disallow: /v1/',
    'Disallow: /admin-app/',
    'Disallow: /payment-qr/uploads/',
    ''
  ].join('\n');
}

export function sessionRecord(userId, now = Date.now()) {
  return {
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString()
  };
}

export function sessionExpired(rec, now = Date.now()) {
  if (!rec || typeof rec !== 'object') return true;
  if (!rec.expiresAt) return false;
  const ts = Date.parse(rec.expiresAt);
  return Number.isFinite(ts) && ts < now;
}

export function noteLoginFailure(ip) {
  const key = String(ip || 'unknown');
  const now = Date.now();
  let rec = loginFails.get(key);
  if (!rec || now - rec.windowStart >= LOGIN_FAIL_WINDOW_MS) rec = { windowStart: now, count: 0 };
  rec.count += 1;
  loginFails.set(key, rec);
  return rec.count;
}

export function clearLoginFailures(ip) {
  loginFails.delete(String(ip || 'unknown'));
}

export function loginBlocked(ip) {
  const rec = loginFails.get(String(ip || 'unknown'));
  if (!rec) return false;
  if (Date.now() - rec.windowStart >= LOGIN_FAIL_WINDOW_MS) {
    loginFails.delete(String(ip || 'unknown'));
    return false;
  }
  return rec.count >= LOGIN_FAIL_LIMIT;
}

export function noteRegisterSuccess(ip) {
  const key = String(ip || 'unknown');
  const day = todayStamp();
  let rec = registerDays.get(key);
  if (!rec || rec.day !== day) rec = { day, count: 0 };
  rec.count += 1;
  registerDays.set(key, rec);
  return rec.count;
}

export function registerDailyBlocked(ip) {
  const rec = registerDays.get(String(ip || 'unknown'));
  if (!rec) return false;
  if (rec.day !== todayStamp()) {
    registerDays.delete(String(ip || 'unknown'));
    return false;
  }
  return rec.count >= REGISTER_DAILY_LIMIT;
}

export function withKeyedLock(key, fn) {
  const id = String(key || 'default');
  const prev = lockChains.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  lockChains.set(id, next);
  return next;
}

export function privilegeFieldsPresent(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return ['balance', 'bonusBalance', 'quotaTokens', 'role', 'unlimited', 'isAdmin', 'banned', 'accountActive', 'reservedBalance']
    .some((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

export function timingSafeHexEqual(a, b) {
  const left = Buffer.from(String(a || '').toLowerCase(), 'utf8');
  const right = Buffer.from(String(b || '').toLowerCase(), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
