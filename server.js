import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { epaySign, epayVerify, normalizeGateway, gatewayReady, buildEpaySubmitUrl, publicGatewayView } from './payment/epay.js';
import {
  login as vip1129Login,
  createKey as vip1129CreateKey,
  deleteKey as vip1129DeleteKey,
  listKeys as vip1129ListKeys,
  listAvailableGroups as vip1129ListGroups,
  extractCreatedSecret as vip1129ExtractSecret,
  fetchAccount as vip1129FetchAccount,
  isVip1129Provider,
  defaultGroupMap as vip1129DefaultGroupMap,
  normalizeBase as vip1129NormalizeBase,
  DEFAULT_BASE as VIP1129_DEFAULT_BASE
} from './upstream/vip1129.js';
import {
  login as beibeihaiLogin,
  createKey as beibeihaiCreateKey,
  deleteKey as beibeihaiDeleteKey,
  listKeys as beibeihaiListKeys,
  listAvailableGroups as beibeihaiListGroups,
  extractCreatedSecret as beibeihaiExtractSecret,
  fetchAccount as beibeihaiFetchAccount,
  isBeibeihaiProvider,
  defaultGroupMap as beibeihaiDefaultGroupMap,
  normalizeBase as beibeihaiNormalizeBase,
  DEFAULT_BASE as BEIBEIHAI_DEFAULT_BASE
} from './upstream/beibeihai.js';
import { ensureSiteErrors, recordSiteError, clearSiteErrors, tipsForCode, failPayload, SITE_ERROR_CAP } from './diagnostics/site-errors.js';
import { runDiagnosticSuite } from './diagnostics/run-suite.js';
import { claimCheckIn, checkInStatus, checkInAdminStats, CHECKIN_LOG_STATUS, money2 } from './lib/checkin.js';
import { buildMobileInbox, parseUpstreamAccount } from './lib/admin-mobile.js';
import { pushPaymentEvent, waitForEvents, currentSeq, publicPaymentEvent } from './lib/payment-events.js';
import {
  compactGroupMap,
  normalizeAvailableGroups,
  suggestGroupMap,
  wireAllProviders,
  resolveProxyApiKey as resolveProxyApiKeyPure,
  findListedSecret,
  validateInviteCode,
  insufficientBalanceMessage,
  BEIBEIHAI_GROUP_HINTS,
  VIP1129_GROUP_HINTS,
  BEIBEIHAI_CHAT_URL,
  VIP1129_CHAT_URL,
  DEFAULT_RECOMMENDED_MODEL,
  resolveRecommendedModel,
  normalizeRecommendedModel,
  AVATAR_IDS,
  DEFAULT_AVATAR,
  normalizeAvatar,
  normalizeBillingMultiplier,
  DEFAULT_BILLING_MULTIPLIER,
  defaultDisplayMultiplier,
  resolveDisplayMultiplier
} from './lib/relay-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const dataDir = process.env.RELAY_DATA_DIR || (process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data'));
const dbFile = process.env.RELAY_DB_FILE || path.join(dataDir, 'db.json');
const SKIP_BOOT_JOBS = process.env.RELAY_SKIP_BOOT_JOBS === '1' || String(process.env.SKIP_BOOT_JOBS || '') === '1';
const PORT = Number(process.env.PORT || 8787);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || process.env.SITE_URL || '').trim().replace(/\/$/, '');
const VIP1129_EMAIL = String(process.env.VIP1129_EMAIL || '').trim();
const VIP1129_PASSWORD = String(process.env.VIP1129_PASSWORD || '');
const VIP1129_BASE_URL = String(process.env.VIP1129_BASE_URL || VIP1129_DEFAULT_BASE).trim();
const BEIBEIHAI_EMAIL = String(process.env.BEIBEIHAI_EMAIL || '').trim();
const BEIBEIHAI_PASSWORD = String(process.env.BEIBEIHAI_PASSWORD || '');
const BEIBEIHAI_BASE_URL = String(process.env.BEIBEIHAI_BASE_URL || BEIBEIHAI_DEFAULT_BASE).trim();


const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';
const ADMIN_USERNAME = (() => {
  const raw = String(process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{2,31}$/.test(raw) ? raw : 'admin';
})();
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || '3845440106@qq.com';
const CONTACT_WECHAT = process.env.CONTACT_WECHAT || '';
const CONTACT_QQ = process.env.CONTACT_QQ || '3845440106';
const CONTACT_QQ_GROUP = process.env.CONTACT_QQ_GROUP || '1061247399';
const PAYMENT_QR = process.env.PAYMENT_QR || '/payment-qr/10.png';
const PAYMENT_AMOUNTS = [10, 30, 50, 100];
const PAYMENT_METHODS = [
  { id: 'wechat', label: '微信支付' },
  { id: 'alipay', label: '支付宝' }
];

function normalizePaymentQrs(raw) {
  const empty = () => Object.fromEntries(PAYMENT_AMOUNTS.map(a => [String(a), '']));
  const out = { wechat: empty(), alipay: empty() };
  if (!raw || typeof raw !== 'object') return out;
  if (raw.wechat || raw.alipay) {
    for (const method of ['wechat', 'alipay']) {
      const src = raw[method] || {};
      for (const amount of PAYMENT_AMOUNTS) {
        const key = String(amount);
        out[method][key] = String(src[key] || src[amount] || '').trim();
      }
    }
    return out;
  }
  // legacy flat map = wechat only
  for (const amount of PAYMENT_AMOUNTS) {
    const key = String(amount);
    out.wechat[key] = String(raw[key] || raw[amount] || '').trim();
  }
  return out;
}

function ensurePaymentQrs(db) {
  const next = normalizePaymentQrs(db.settings?.paymentQrs);
  for (const amount of PAYMENT_AMOUNTS) {
    const key = String(amount);
    if (!next.wechat[key]) next.wechat[key] = `/payment-qr/${amount}.png`;
    if (!next.alipay[key]) next.alipay[key] = `/payment-qr/alipay/${amount}.png`;
  }
  db.settings = db.settings || {};
  db.settings.paymentQrs = next;
  return next;
}


function makePayNote(db) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 40; attempt++) {
    let note = '';
    for (let i = 0; i < 6; i++) note += alphabet[crypto.randomInt(0, alphabet.length)];
    const exists = (db.paymentOrders || []).some(o => String(o.payNote || '').toUpperCase() === note);
    if (!exists) return note;
  }
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function resolvePublicBaseUrl(db, req) {
  const fromSettings = String(db.settings?.publicBaseUrl || '').trim().replace(/\/$/, '');
  if (fromSettings) return fromSettings;
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  if (req) {
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (host) return `${proto}://${host}`;
  }
  return '';
}

function getPaymentGateway(db) {
  return normalizeGateway(db.settings?.paymentGateway || {});
}

function fulfillPaymentOrder(db, order, meta = {}) {
  if (!order) return { ok: false, error: '订单不存在' };
  if (order.status === 'confirmed' && order.code) return { ok: true, order, already: true };
  if (order.status === 'rejected') return { ok: false, error: '订单已拒绝' };
  const day = localDay();
  const issuedToday = (db.rechargeCodes || []).filter(c => c.issuedTo === order.userId && c.issuedAt && localDay(new Date(c.issuedAt)) === day).length;
  if (issuedToday >= CLAIM_DAILY_LIMIT) return { ok: false, error: `该用户今日发卡已达上限（${CLAIM_DAILY_LIMIT}）` };
  let card = (db.rechargeCodes || []).find(c => Number(c.amount) === Number(order.amount) && codeAvailable(c));
  if (!card) {
    topUpCodePools(db, CODE_POOL_TARGET);
    card = (db.rechargeCodes || []).find(c => Number(c.amount) === Number(order.amount) && codeAvailable(c));
  }
  if (!card) return { ok: false, error: '该金额卡密暂时售罄' };
  card.issuedAt = new Date().toISOString();
  card.issuedTo = order.userId;
  order.status = 'confirmed';
  order.code = card.code;
  order.confirmedAt = new Date().toISOString();
  order.confirmedBy = meta.confirmedBy || 'gateway';
  order.gatewayTradeNo = meta.tradeNo || order.gatewayTradeNo || null;
  order.payChannel = meta.payChannel || order.payChannel || null;
  if (!order.userReportedAt) order.userReportedAt = order.confirmedAt;
  audit(db, { actorId: meta.confirmedBy || 'gateway', action: 'payment.order.confirm', target: order.id, detail: { amount: order.amount, method: order.method, code: card.code, userId: order.userId, tradeNo: order.gatewayTradeNo, via: meta.via || 'gateway' } });
  return { ok: true, order, card };
}

function emitPayment(order, kind) {
  if (!order) return;
  pushPaymentEvent({
    kind,
    orderId: order.id,
    userId: order.userId,
    username: order.username || '',
    amount: order.amount,
    method: order.method,
    payNote: order.payNote,
    status: order.status,
    code: kind === 'confirmed' ? (order.code || null) : null
  });
}

function mobileInboxPayload(db, user) {
  const inbox = buildMobileInbox(db);
  const meta = paymentQrMeta(db);
  return {
    ...inbox,
    finance: poolStats(db),
    me: safeUser(user),
    paymentQr: {
      wechat: paymentQrStatus(meta.wechatExpiresAt),
      alipay: paymentQrStatus(meta.alipayExpiresAt),
      note: meta.note || ''
    }
  };
}


function paymentQrMeta(db) {
  const m = (db.settings && db.settings.paymentQrMeta) || {};
  return {
    wechatExpiresAt: m.wechatExpiresAt || null,
    alipayExpiresAt: m.alipayExpiresAt || null,
    note: String(m.note || '个人静态收款码一般长期有效；若扫码提示已过期/无法支付，请换另一种付款方式或联系客服更换收款码。')
  };
}

function paymentQrStatus(expiresAt) {
  if (!expiresAt) {
    return { expiresAt: null, expired: false, daysLeft: null, tip: '未设置到期日（个人静态码通常长期有效，仍可能因风控/换号失效）' };
  }
  const end = new Date(expiresAt);
  if (Number.isNaN(end.getTime())) {
    return { expiresAt, expired: false, daysLeft: null, tip: '到期日格式无效，请管理员重新设置' };
  }
  const now = new Date();
  const ms = end.getTime() - now.getTime();
  const daysLeft = Math.ceil(ms / 86400000);
  if (ms <= 0) {
    return { expiresAt, expired: true, daysLeft: 0, tip: '该付款码已到设置的有效期，可能已失效，请勿继续付款，并联系客服更换收款码' };
  }
  if (daysLeft <= 3) {
    return { expiresAt, expired: false, daysLeft, tip: `该付款码将在约 ${daysLeft} 天后到期，若扫码失败请联系客服` };
  }
  return { expiresAt, expired: false, daysLeft, tip: `管理员登记有效期至 ${end.toISOString().slice(0, 10)}` };
}

const PAYMENT_QR_UPLOAD_DIR = path.join(publicDir, 'payment-qr', 'uploads');
const PAYMENT_QR_MAX_BYTES = 4 * 1024 * 1024;

function sniffImageExt(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  const gif = buf.slice(0, 6).toString('ascii');
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'gif';
  return null;
}

function decodePaymentQrImage(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, error: '请选择收款码图片' };
  const m = s.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  const b64 = m ? m[2].replace(/\s/g, '') : (s.startsWith('data:') ? '' : s.replace(/\s/g, ''));
  if (!b64) return { ok: false, error: '请上传 png/jpg/webp 图片' };
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch { return { ok: false, error: '图片数据无效' }; }
  if (!buf.length) return { ok: false, error: '图片数据无效' };
  if (buf.length > PAYMENT_QR_MAX_BYTES) return { ok: false, error: '图片太大，请压缩到 4MB 以内' };
  const ext = sniffImageExt(buf);
  if (!ext) return { ok: false, error: '无法识别图片格式，请换一张收款码截图' };
  return { ok: true, buf, ext };
}

function savePaymentQrFile(method, amountKey, buf, ext) {
  fs.mkdirSync(PAYMENT_QR_UPLOAD_DIR, { recursive: true });
  const name = `${method}-${amountKey}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(PAYMENT_QR_UPLOAD_DIR, name), buf);
  return `/payment-qr/uploads/${name}`;
}

function paymentPlans(db) {
  const map = ensurePaymentQrs(db);
  const meta = paymentQrMeta(db);
  const wechatStatus = paymentQrStatus(meta.wechatExpiresAt);
  const alipayStatus = paymentQrStatus(meta.alipayExpiresAt);
  return PAYMENT_AMOUNTS.map(amount => {
    const key = String(amount);
    return {
      amount,
      label: `¥${amount}`,
      qr: map.wechat[key] || '',
      wechat: map.wechat[key] || '',
      alipay: map.alipay[key] || '',
      methods: {
        wechat: map.wechat[key] || '',
        alipay: map.alipay[key] || ''
      },
      status: {
        wechat: wechatStatus,
        alipay: alipayStatus
      },
      tip: meta.note
    };
  });
}

const CODE_POOL_TARGET = Number(process.env.CODE_POOL_TARGET || 10000);
const CLAIM_DAILY_LIMIT = Number(process.env.CLAIM_DAILY_LIMIT || 20);
const REFERRAL_REBATE_RATE = 0.05;

function localDay(d = new Date()) {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function quotaForAmount(amount, db) {
  const perYuan = Number(db.settings?.quotaTokensPerYuan || 10000);
  const map = db.settings?.quotaByAmount || {};
  if (map[String(amount)] != null) return Math.max(0, Math.floor(Number(map[String(amount)]) || 0));
  return Math.max(0, Math.floor(Number(amount) * (Number.isFinite(perYuan) ? perYuan : 10000)));
}

function codeAvailable(c) {
  return c && !c.usedAt && !c.issuedAt && !c.issuedTo;
}

const REDEEM_FAIL = '卡密无效、已使用或无权兑换';
const REDEEM_RATE_LIMIT = 12;

function normalizeRedeemCode(raw) {
  return String(raw || '').trim().toUpperCase();
}

function findCodeRecord(db, raw) {
  const needle = normalizeRedeemCode(raw);
  if (!needle || needle.length < 6) return null;
  return (db.rechargeCodes || []).find(x => normalizeRedeemCode(x.code) === needle) || null;
}

function redeemAccess(codeRec, userId) {
  if (!codeRec || codeRec.usedAt) return { ok: false, reason: 'used_or_missing' };
  if (codeRec.issuedTo) {
    return codeRec.issuedTo === userId ? { ok: true } : { ok: false, reason: 'not_owner' };
  }
  if (codeRec.source === 'manual') return { ok: true, reason: 'manual' };
  return { ok: false, reason: 'unissued_stock' };
}

function topUpCodePools(db, target = CODE_POOL_TARGET) {
  db.rechargeCodes ??= [];
  let added = 0;
  for (const amount of PAYMENT_AMOUNTS) {
    const available = db.rechargeCodes.filter(c => Number(c.amount) === Number(amount) && codeAvailable(c)).length;
    const need = Math.max(0, target - available);
    const quota = quotaForAmount(amount, db);
    for (let i = 0; i < need; i++) {
      db.rechargeCodes.push({
        code: `R${amount}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
        amount: Number(amount),
        quotaTokens: quota,
        usedAt: null,
        userId: null,
        issuedAt: null,
        issuedTo: null,
        source: 'pool',
        createdAt: new Date().toISOString(),
        source: 'pool'
      });
      added += 1;
    }
  }
  return added;
}

function poolStats(db) {
  const day = localDay();
  const byAmount = {};
  for (const amount of PAYMENT_AMOUNTS) {
    byAmount[amount] = { amount, available: 0, issuedToday: 0, issuedTodaySum: 0, redeemedToday: 0, redeemedTodaySum: 0 };
  }
  for (const c of db.rechargeCodes || []) {
    const amount = Number(c.amount);
    if (!byAmount[amount]) continue;
    if (codeAvailable(c)) byAmount[amount].available += 1;
    if (c.issuedAt && localDay(new Date(c.issuedAt)) === day) {
      byAmount[amount].issuedToday += 1;
      byAmount[amount].issuedTodaySum += amount;
    }
    if (c.usedAt && localDay(new Date(c.usedAt)) === day) {
      byAmount[amount].redeemedToday += 1;
      byAmount[amount].redeemedTodaySum += amount;
    }
  }
  const list = PAYMENT_AMOUNTS.map(a => byAmount[a]);
  const issuedTodaySum = list.reduce((s, x) => s + x.issuedTodaySum, 0);
  const redeemedTodaySum = list.reduce((s, x) => s + x.redeemedTodaySum, 0);

  // 上游 API 开销：当日成功请求的 upstreamCost 合计（按渠道拆分）
  const upstreamByProvider = {};
  let upstreamCostToday = 0;
  let chargedToday = 0;
  let requestCountToday = 0;
  let upstreamCostEstimatedCount = 0;
  let upstreamCostReportedCount = 0;
  for (const log of db.logs || []) {
    if (!log?.createdAt || localDay(new Date(log.createdAt)) !== day) continue;
    if (log.status === 'referral_rebate' || log.status === CHECKIN_LOG_STATUS) continue;
    requestCountToday += 1;
    const up = Number(log.upstreamCost || 0);
    const charged = Number(log.chargedAmount || 0);
    if (Number.isFinite(up)) {
      upstreamCostToday += up;
      const pid = log.providerId || 'unknown';
      if (!upstreamByProvider[pid]) upstreamByProvider[pid] = { providerId: pid, providerName: log.providerName || pid, upstreamCost: 0, chargedAmount: 0, requests: 0 };
      upstreamByProvider[pid].upstreamCost += up;
      upstreamByProvider[pid].chargedAmount += Number.isFinite(charged) ? charged : 0;
      upstreamByProvider[pid].requests += 1;
    }
    if (log.upstreamCostSource === 'reported') upstreamCostReportedCount += 1;
    else if (Number.isFinite(up) && up > 0) upstreamCostEstimatedCount += 1;
    if (Number.isFinite(charged) && charged > 0) chargedToday += charged;
  }

  return {
    day,
    target: CODE_POOL_TARGET,
    byAmount: list,
    issuedTodayCount: list.reduce((s, x) => s + x.issuedToday, 0),
    issuedTodaySum,
    redeemedTodayCount: list.reduce((s, x) => s + x.redeemedToday, 0),
    redeemedTodaySum,
    // 财务口径（仅管理员接口返回）
    incomeToday: issuedTodaySum,          // 今日收入：用户付款领取卡密的面额合计
    cardSpendToday: redeemedTodaySum,     // 卡密支出：今日兑换成余额的卡密面额合计
    upstreamCostToday: Math.round(upstreamCostToday * 10000) / 10000,
    chargedToday: Math.round(chargedToday * 10000) / 10000,
    requestCountToday,
    upstreamCostEstimatedCount,
    upstreamCostReportedCount,
    upstreamCostIsEstimate: upstreamCostReportedCount === 0,
    upstreamByProvider: Object.values(upstreamByProvider).sort((a, b) => b.upstreamCost - a.upstreamCost)
  };
}

const DEFAULT_MAX_TOKENS = Number(process.env.DEFAULT_MAX_TOKENS || 1024);
const DEFAULT_MULTIPLIER = Number(process.env.BILLING_MULTIPLIER || DEFAULT_BILLING_MULTIPLIER);
const BALANCE_SAFETY_BUFFER = Number(process.env.BALANCE_SAFETY_BUFFER || 0);
const LEGACY_UPSTREAM = { url: process.env.UPSTREAM_URL || '', apiKey: process.env.UPSTREAM_API_KEY || '', model: process.env.UPSTREAM_MODEL || 'gpt-4o-mini', price: Number(process.env.UPSTREAM_PRICE_PER_1K || 0.01) };
const sessions = new Map();
const rateBuckets = new Map();
const AUTH_RATE_LIMIT = 60;
const CHAT_RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;
const AUDIT_CAP = 5000;

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(dbFile)) fs.writeFileSync(dbFile, JSON.stringify({ users: [], rechargeCodes: [], logs: [], auditLogs: [], sessions: {}, settings: {}, checkIns: [] }, null, 2));

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
const keyRateBuckets = new Map();
const MAX_USER_KEYS = 20;

function catalogModels(db) {
  const set = new Set();
  for (const p of db.settings?.providers || []) {
    if (p.enabled === false) continue;
    for (const m of p.models || []) if (m) set.add(String(m));
    if (p.defaultModel) set.add(String(p.defaultModel));
  }
  return [...set];
}

function resolveGroupModels(db, groupId) {
  if (!groupId) return null;
  const provider = (db.settings?.providers || []).find(p => p.id === groupId && p.enabled !== false);
  if (!provider) return null;
  return [...new Set((provider.models || []).map(m => String(m).trim()).filter(Boolean))];
}



function isMaintenanceProvider(provider) {
  return !!(provider && (provider.maintenance === true || provider.status === 'maintenance'));
}

function getBeibeihaiConfig(db) {
  db.settings ??= {};
  const raw = db.settings.upstreamBeibeihai && typeof db.settings.upstreamBeibeihai === 'object'
    ? db.settings.upstreamBeibeihai
    : {};
  // Drop stored nulls so they cannot wipe later auto-filled IDs.
  const groupMap = { ...compactGroupMap(beibeihaiDefaultGroupMap()), ...compactGroupMap(raw.groupMap) };
  return {
    enabled: raw.enabled !== false,
    baseUrl: beibeihaiNormalizeBase(raw.baseUrl || BEIBEIHAI_BASE_URL || BEIBEIHAI_DEFAULT_BASE),
    email: String(raw.email || BEIBEIHAI_EMAIL || '').trim(),
    password: String(raw.password || BEIBEIHAI_PASSWORD || ''),
    accessToken: String(raw.accessToken || '').trim(),
    tokenExpiresAt: Number(raw.tokenExpiresAt || 0) || 0,
    groupMap,
    lastError: raw.lastError || null
  };
}

function saveBeibeihaiConfig(db, cfg) {
  db.settings ??= {};
  db.settings.upstreamBeibeihai = {
    enabled: cfg.enabled !== false,
    baseUrl: beibeihaiNormalizeBase(cfg.baseUrl || BEIBEIHAI_DEFAULT_BASE),
    email: String(cfg.email || '').trim(),
    password: String(cfg.password || ''),
    accessToken: String(cfg.accessToken || '').trim(),
    tokenExpiresAt: Number(cfg.tokenExpiresAt || 0) || 0,
    groupMap: compactGroupMap(cfg.groupMap || beibeihaiDefaultGroupMap()),
    lastError: cfg.lastError || null
  };
  return db.settings.upstreamBeibeihai;
}

function publicBeibeihaiView(cfg) {
  return {
    enabled: cfg.enabled !== false,
    baseUrl: cfg.baseUrl,
    email: cfg.email,
    hasPassword: !!cfg.password,
    hasToken: !!cfg.accessToken,
    tokenExpiresAt: cfg.tokenExpiresAt || null,
    groupMap: compactGroupMap(cfg.groupMap),
    lastError: cfg.lastError || null,
    ready: !!(cfg.enabled !== false && cfg.email && (cfg.password || cfg.accessToken))
  };
}

async function ensureBeibeihaiToken(db) {
  const cfg = getBeibeihaiConfig(db);
  if (!cfg.enabled) return { ok: false, error: 'upstream_disabled', cfg };
  const now = Date.now();
  if (cfg.accessToken && cfg.tokenExpiresAt && cfg.tokenExpiresAt - 60_000 > now) {
    return { ok: true, token: cfg.accessToken, cfg };
  }
  if (!cfg.email || !cfg.password) return { ok: false, error: 'missing_credentials', cfg };
  const logged = await beibeihaiLogin(cfg.baseUrl, cfg.email, cfg.password);
  if (!logged.ok) {
    cfg.lastError = `login_failed:${logged.status || logged.error || ''}`;
    saveBeibeihaiConfig(db, cfg);
    return { ok: false, error: 'login_failed', detail: logged, cfg };
  }
  cfg.accessToken = logged.token;
  const expiresIn = Number(logged.expiresIn || 3600);
  cfg.tokenExpiresAt = Date.now() + Math.max(60, expiresIn) * 1000;
  cfg.lastError = null;
  saveBeibeihaiConfig(db, cfg);
  return { ok: true, token: cfg.accessToken, cfg };
}

function resolveBeibeihaiGroupId(db, localGroupId) {
  if (!localGroupId) return null;
  const cfg = getBeibeihaiConfig(db);
  const mapped = cfg.groupMap?.[String(localGroupId)];
  if (mapped == null || mapped === '') return null;
  return Number(mapped);
}

function providerNeedsBeibeihaiSync(db, groupId) {
  if (!groupId) return false;
  const provider = (db.settings?.providers || []).find(p => p.id === groupId);
  if (!provider || provider.enabled === false || isMaintenanceProvider(provider)) return false;
  if (!isBeibeihaiProvider(provider)) return false;
  return resolveBeibeihaiGroupId(db, groupId) != null;
}

function localBeibeihaiGroupIds(db) {
  return (db.settings?.providers || [])
    .filter(p => isBeibeihaiProvider(p) && !isMaintenanceProvider(p))
    .map(p => p.id);
}

function localVip1129GroupIds(db) {
  return (db.settings?.providers || [])
    .filter(p => isVip1129Provider(p) && !isMaintenanceProvider(p))
    .map(p => p.id);
}

async function autofillBeibeihaiGroupMap(db, token = null) {
  const cfg = getBeibeihaiConfig(db);
  if (!cfg.enabled) return cfg;
  let authToken = token;
  if (!authToken) {
    const auth = await ensureBeibeihaiToken(db);
    if (!auth.ok) return getBeibeihaiConfig(db);
    authToken = auth.token;
  }
  const listed = await beibeihaiListGroups(cfg.baseUrl, authToken);
  if (!listed.ok) return cfg;
  const groups = normalizeAvailableGroups(listed.data);
  const nextMap = suggestGroupMap(cfg.groupMap, groups, localBeibeihaiGroupIds(db), BEIBEIHAI_GROUP_HINTS);
  if (JSON.stringify(nextMap) !== JSON.stringify(compactGroupMap(cfg.groupMap))) {
    cfg.groupMap = nextMap;
    saveBeibeihaiConfig(db, cfg);
  }
  applyUpstreamGroupRates(db, 'beibeihai', groups);
  return cfg;
}

function applyUpstreamGroupRates(db, kind, groups) {
  const list = Array.isArray(groups) ? groups : [];
  const byId = new Map(list.map(g => [Number(g.id), g]));
  const cfg = kind === 'vip1129' ? getVip1129Config(db) : getBeibeihaiConfig(db);
  const map = cfg?.groupMap || {};
  let changed = 0;
  for (const provider of db.settings?.providers || []) {
    const sync = provider.upstreamSync || (kind === 'vip1129' && isVip1129Provider(provider) ? 'vip1129' : (kind === 'beibeihai' && isBeibeihaiProvider(provider) ? 'beibeihai' : null));
    if (sync !== kind) continue;
    const upId = map[provider.id];
    if (upId == null || upId === '') continue;
    const g = byId.get(Number(upId));
    if (!g) continue;
    const rate = Number(g.rate_multiplier);
    if (!Number.isFinite(rate) || rate < 0) continue;
    if (Number(provider.upstreamRateMultiplier) !== rate) {
      provider.upstreamRateMultiplier = rate;
      changed += 1;
    }
  }
  return changed;
}

async function autofillVip1129GroupMap(db, token = null) {
  const cfg = getVip1129Config(db);
  if (!cfg.enabled) return cfg;
  let authToken = token;
  if (!authToken) {
    const auth = await ensureVip1129Token(db);
    if (!auth.ok) return getVip1129Config(db);
    authToken = auth.token;
  }
  const listed = await vip1129ListGroups(cfg.baseUrl, authToken);
  if (!listed.ok) return cfg;
  const groups = normalizeAvailableGroups(listed.data);
  const nextMap = suggestGroupMap(cfg.groupMap, groups, localVip1129GroupIds(db), VIP1129_GROUP_HINTS);
  if (JSON.stringify(nextMap) !== JSON.stringify(compactGroupMap(cfg.groupMap))) {
    cfg.groupMap = nextMap;
    saveVip1129Config(db, cfg);
  }
  applyUpstreamGroupRates(db, 'vip1129', groups);
  return cfg;
}

async function syncCreateBeibeihaiKey(db, user, localKey) {
  const upstreamGroupId = resolveBeibeihaiGroupId(db, localKey.groupId);
  if (upstreamGroupId == null) return { ok: false, error: 'no_group_map' };
  const auth = await ensureBeibeihaiToken(db);
  if (!auth.ok) return { ok: false, error: auth.error, detail: auth.detail };
  const name = `${user.username || user.name || 'user'}-${String(localKey.name || 'key').slice(0, 24)}`.slice(0, 60);
  const body = { name, group_id: upstreamGroupId };
  if (localKey.spendLimit > 0) body.quota = Number(localKey.spendLimit);
  const created = await beibeihaiCreateKey(auth.cfg.baseUrl, auth.token, body);
  if (!created.ok) {
    auth.cfg.lastError = `create_failed:${created.status}`;
    saveBeibeihaiConfig(db, auth.cfg);
    return { ok: false, error: 'create_failed', detail: created };
  }
  const secret = beibeihaiExtractSecret(created.data);
  if (!secret.key) return { ok: false, error: 'create_no_secret', detail: created.data };
  localKey.key = secret.key;
  localKey.upstream = {
    provider: 'beibeihai',
    id: secret.id,
    groupId: upstreamGroupId,
    syncedAt: new Date().toISOString()
  };
  auth.cfg.lastError = null;
  saveBeibeihaiConfig(db, auth.cfg);
  return { ok: true, key: secret.key, upstreamId: secret.id };
}

async function syncDeleteBeibeihaiKey(db, localKey) {
  const upstreamId = localKey?.upstream?.id;
  if (!upstreamId || localKey?.upstream?.provider !== 'beibeihai') return { ok: true, skipped: true };
  const auth = await ensureBeibeihaiToken(db);
  if (!auth.ok) return { ok: false, error: auth.error };
  const deleted = await beibeihaiDeleteKey(auth.cfg.baseUrl, auth.token, upstreamId);
  return { ok: deleted.ok || deleted.status === 404, detail: deleted };
}


function getVip1129Config(db) {
  db.settings ??= {};
  const raw = db.settings.upstreamVip1129 && typeof db.settings.upstreamVip1129 === 'object'
    ? db.settings.upstreamVip1129
    : {};
  const groupMap = { ...compactGroupMap(vip1129DefaultGroupMap()), ...compactGroupMap(raw.groupMap) };
  return {
    enabled: raw.enabled !== false,
    baseUrl: vip1129NormalizeBase(raw.baseUrl || VIP1129_BASE_URL || VIP1129_DEFAULT_BASE),
    email: String(raw.email || VIP1129_EMAIL || '').trim(),
    password: String(raw.password || VIP1129_PASSWORD || ''),
    accessToken: String(raw.accessToken || '').trim(),
    tokenExpiresAt: Number(raw.tokenExpiresAt || 0) || 0,
    groupMap,
    lastError: raw.lastError || null
  };
}

function saveVip1129Config(db, cfg) {
  db.settings ??= {};
  db.settings.upstreamVip1129 = {
    enabled: cfg.enabled !== false,
    baseUrl: vip1129NormalizeBase(cfg.baseUrl || VIP1129_DEFAULT_BASE),
    email: String(cfg.email || '').trim(),
    password: String(cfg.password || ''),
    accessToken: String(cfg.accessToken || '').trim(),
    tokenExpiresAt: Number(cfg.tokenExpiresAt || 0) || 0,
    groupMap: compactGroupMap(cfg.groupMap || vip1129DefaultGroupMap()),
    lastError: cfg.lastError || null
  };
  return db.settings.upstreamVip1129;
}

function publicVip1129View(cfg) {
  return {
    enabled: cfg.enabled !== false,
    baseUrl: cfg.baseUrl,
    email: cfg.email,
    hasPassword: !!cfg.password,
    hasToken: !!cfg.accessToken,
    tokenExpiresAt: cfg.tokenExpiresAt || null,
    groupMap: compactGroupMap(cfg.groupMap),
    lastError: cfg.lastError || null,
    ready: !!(cfg.enabled !== false && cfg.email && (cfg.password || cfg.accessToken))
  };
}

async function ensureVip1129Token(db) {
  const cfg = getVip1129Config(db);
  if (!cfg.enabled) return { ok: false, error: 'upstream_disabled', cfg };
  const now = Date.now();
  if (cfg.accessToken && cfg.tokenExpiresAt && cfg.tokenExpiresAt - 60_000 > now) {
    return { ok: true, token: cfg.accessToken, cfg };
  }
  if (!cfg.email || !cfg.password) return { ok: false, error: 'missing_credentials', cfg };
  const logged = await vip1129Login(cfg.baseUrl, cfg.email, cfg.password);
  if (!logged.ok) {
    cfg.lastError = `login_failed:${logged.status || logged.error || ''}`;
    saveVip1129Config(db, cfg);
    return { ok: false, error: 'login_failed', detail: logged, cfg };
  }
  cfg.accessToken = logged.token;
  const expiresIn = Number(logged.expiresIn || 3600);
  cfg.tokenExpiresAt = Date.now() + Math.max(60, expiresIn) * 1000;
  cfg.lastError = null;
  saveVip1129Config(db, cfg);
  return { ok: true, token: cfg.accessToken, cfg };
}

function resolveVip1129GroupId(db, localGroupId) {
  if (!localGroupId) return null;
  const cfg = getVip1129Config(db);
  const mapped = cfg.groupMap?.[String(localGroupId)];
  if (mapped != null && mapped !== '') return Number(mapped);
  return null;
}

function providerNeedsVip1129Sync(db, groupId) {
  if (!groupId) return false;
  const provider = (db.settings?.providers || []).find(p => p.id === groupId);
  if (!provider || provider.enabled === false || isMaintenanceProvider(provider)) return false;
  if (!isVip1129Provider(provider)) return false;
  const upstreamGroupId = resolveVip1129GroupId(db, groupId);
  return upstreamGroupId != null;
}

async function snapshotUpstreamAccount(kind, db) {
  const isVip = kind === 'vip1129';
  const auth = isVip ? await ensureVip1129Token(db) : await ensureBeibeihaiToken(db);
  const view = isVip ? publicVip1129View(getVip1129Config(db)) : publicBeibeihaiView(getBeibeihaiConfig(db));
  const name = isVip ? 'vip1129' : 'beibeihai';
  if (!auth.ok) return { name, ok: false, error: auth.error || 'login_failed', account: null, upstream: view };
  const parsed = isVip
    ? await vip1129FetchAccount(auth.cfg.baseUrl, auth.token)
    : await beibeihaiFetchAccount(auth.cfg.baseUrl, auth.token);
  const account = parseUpstreamAccount(parsed);
  if (!parsed.ok || !account) {
    return {
      name,
      ok: false,
      error: parsed?.error || `HTTP ${parsed?.status || 0}`,
      account: null,
      upstream: view
    };
  }
  return { name, ok: true, error: null, account, upstream: view };
}

async function syncCreateVip1129Key(db, user, localKey) {
  const upstreamGroupId = resolveVip1129GroupId(db, localKey.groupId);
  if (upstreamGroupId == null) return { ok: false, error: 'no_group_map' };
  const auth = await ensureVip1129Token(db);
  if (!auth.ok) return { ok: false, error: auth.error, detail: auth.detail };
  const name = `${user.username || user.name || 'user'}-${String(localKey.name || 'key').slice(0, 24)}`.slice(0, 60);
  const body = { name, group_id: upstreamGroupId };
  if (localKey.spendLimit > 0) body.quota = Number(localKey.spendLimit);
  const created = await vip1129CreateKey(auth.cfg.baseUrl, auth.token, body);
  if (!created.ok) {
    auth.cfg.lastError = `create_failed:${created.status}`;
    saveVip1129Config(db, auth.cfg);
    return { ok: false, error: 'create_failed', detail: created };
  }
  const secret = vip1129ExtractSecret(created.data);
  if (!secret.key) return { ok: false, error: 'create_no_secret', detail: created.data };
  localKey.key = secret.key;
  localKey.upstream = {
    provider: 'vip1129',
    id: secret.id,
    groupId: upstreamGroupId,
    syncedAt: new Date().toISOString()
  };
  auth.cfg.lastError = null;
  saveVip1129Config(db, auth.cfg);
  return { ok: true, key: secret.key, upstreamId: secret.id };
}

async function syncDeleteVip1129Key(db, localKey) {
  const upstreamId = localKey?.upstream?.id;
  if (!upstreamId || localKey?.upstream?.provider !== 'vip1129') return { ok: true, skipped: true };
  const auth = await ensureVip1129Token(db);
  if (!auth.ok) return { ok: false, error: auth.error };
  const deleted = await vip1129DeleteKey(auth.cfg.baseUrl, auth.token, upstreamId);
  return { ok: deleted.ok || deleted.status === 404, detail: deleted };
}


function normalizeApiKey(item, previous = null, db = null) {
  let models = Array.isArray(item?.models)
    ? [...new Set(item.models.map(m => String(m).trim()).filter(Boolean))]
    : (previous?.models || []);
  const groupIdRaw = item?.groupId !== undefined ? item.groupId : previous?.groupId;
  const groupId = groupIdRaw ? String(groupIdRaw) : null;
  if (groupId && db) {
    const groupModels = resolveGroupModels(db, groupId);
    if (groupModels) models = groupModels;
  }
  return {
    id: String(item?.id || previous?.id || id('key')),
    name: String(item?.name || previous?.name || '未命名密钥').trim().slice(0, 40) || '未命名密钥',
    key: previous?.key || item?.key || userKey(),
    groupId,
    models,
    spendLimit: Math.max(0, Number(item?.spendLimit ?? previous?.spendLimit ?? 0) || 0),
    // backward-compat fields (not primary UI)
    tokenLimit: Math.max(0, Math.floor(Number(item?.tokenLimit ?? previous?.tokenLimit ?? 0) || 0)),
    rpm: Math.max(0, Math.min(10000, Math.floor(Number(item?.rpm ?? previous?.rpm ?? 0) || 0))),
    tpm: Math.max(0, Math.min(10_000_000, Math.floor(Number(item?.tpm ?? previous?.tpm ?? 0) || 0))),
    spendUsed: Math.max(0, Number(previous?.spendUsed || 0) || 0),
    tokenUsed: Math.max(0, Number(previous?.tokenUsed || 0) || 0),
    reservedSpend: Math.max(0, Number(previous?.reservedSpend || 0) || 0),
    reservedTokens: Math.max(0, Number(previous?.reservedTokens || 0) || 0),
    enabled: item?.enabled !== false,
    createdAt: previous?.createdAt || item?.createdAt || new Date().toISOString(),
    upstream: item?.upstream || previous?.upstream || null
  };
}

function publicApiKey(key) {
  return {
    id: key.id,
    name: key.name,
    key: key.key,
    keyMasked: `${String(key.key).slice(0, 6)}****${String(key.key).slice(-4)}`,
    groupId: key.groupId || null,
    models: key.models || [],
    spendLimit: key.spendLimit || 0,
    tokenLimit: key.tokenLimit || 0,
    rpm: key.rpm || 0,
    tpm: key.tpm || 0,
    spendUsed: Number(key.spendUsed || 0),
    tokenUsed: Number(key.tokenUsed || 0),
    enabled: key.enabled !== false,
    createdAt: key.createdAt,
    upstreamSynced: !!(key.upstream && key.upstream.id),
    upstreamProvider: key.upstream?.provider || null,
    upstreamGroupId: key.upstream?.groupId || null
  };
}

function keyOptionsPayload(db) {
  const groups = (db.settings?.providers || [])
    .filter(p => p.enabled !== false || isMaintenanceProvider(p))
    .map(p => ({
      id: p.id,
      name: p.name,
      displayMultiplier: resolveDisplayMultiplier(p),
      models: [...new Set((p.models || []).map(String))],
      maintenance: isMaintenanceProvider(p),
      maintenanceMessage: p.maintenanceMessage || (isMaintenanceProvider(p) ? '维护中' : null)
    }));
  return { groups, models: catalogModels(db) };
}

function ensureUserKeys(user) {
  user.apiKeys ??= [];
  // No auto-created default key — users create keys themselves.
  // Drop legacy bootstrap keys named 默认密钥.
  user.apiKeys = user.apiKeys.filter(k => (k?.name || '') !== '默认密钥');
  user.apiKeys = user.apiKeys.map(k => normalizeApiKey(k, k));
  if (user.apiKeys.length) {
    if (!user.apiKey || !user.apiKeys.some(k => k.key === user.apiKey)) {
      user.apiKey = user.apiKeys[0].key;
    }
  } else {
    user.apiKey = null;
  }
}

function findByApiSecret(db, secret) {
  if (!secret) return null;
  for (const u of db.users) {
    ensureUserKeys(u);
    const key = u.apiKeys.find(k => k.key === secret);
    if (key) return { user: u, key };
    if (u.apiKey === secret) return { user: u, key: u.apiKeys[0] || null };
  }
  return null;
}

function keyRateOk(res, key, tokensEstimate) {
  const rpm = key.rpm > 0 ? key.rpm : 0;
  const tpm = key.tpm > 0 ? key.tpm : 0;
  if (!rpm && !tpm) return true;
  const now = Date.now();
  let bucket = keyRateBuckets.get(key.id);
  if (!bucket || now - bucket.windowStart >= RATE_WINDOW_MS) {
    bucket = { windowStart: now, requests: 0, tokens: 0 };
    keyRateBuckets.set(key.id, bucket);
  }
  if (rpm && bucket.requests + 1 > rpm) {
    fail(res, 429, '该密钥已达到每分钟请求上限');
    return false;
  }
  if (tpm && bucket.tokens + tokensEstimate > tpm) {
    fail(res, 429, '该密钥已达到每分钟 Token 上限');
    return false;
  }
  bucket.requests += 1;
  bucket.tokens += tokensEstimate;
  return true;
}
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
function fail(res, status, error, opts = null) {
  if (opts && typeof opts === 'object') {
    const { status: _s, body } = failPayload(status, error, opts);
    return json(res, status, body);
  }
  return json(res, status, { error });
}
async function body(req) { let raw = ''; for await (const chunk of req) raw += chunk; try { return raw ? JSON.parse(raw) : {}; } catch { return null; } }
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}
function rateLimit(req, res, limit, bucketName, extra = '') {
  const key = `${clientIp(req)}:${bucketName || 'default'}:${extra}`;
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
function isUnlimited(user) { return !!(user && (user.unlimited || user.role === 'admin')); }
function availableTokens(user) { return Math.max(0, (user.quotaTokens || 0) - (user.usedTokens || 0) - (user.reservedTokens || 0)); }
const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/i;
const RESERVED_USERNAMES = new Set(['admin', 'administrator', 'root', 'system', 'support', 'official', ADMIN_USERNAME.toLowerCase()]);
function isReservedUsername(name) {
  const n = String(name || '').trim().toLowerCase();
  return !n || RESERVED_USERNAMES.has(n) || n === ADMIN_USERNAME.toLowerCase();
}


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
  const lower = String(username || '').trim().toLowerCase();
  if (!lower) return false;
  return db.users.some(u => u.id !== exceptId && (u.username || '').toLowerCase() === lower);
}

function displayNameTaken(db, name, exceptId) {
  const lower = String(name || '').trim().toLowerCase();
  if (!lower) return false;
  return db.users.some(u => u.id !== exceptId && String(u.name || '').trim().toLowerCase() === lower);
}

function userLabelTaken(db, label, exceptId) {
  return usernameTaken(db, label, exceptId) || displayNameTaken(db, label, exceptId);
}

function isBanned(user) {
  return !!(user && user.banned && user.role !== 'admin');
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


const DEFAULT_MODEL_GROUPS = [
  { id: 'grp_deepseek', name: 'DeepSeek', url: BEIBEIHAI_CHAT_URL, upstreamSync: 'beibeihai', defaultModel: 'deepseek-chat', models: [], priority: 10, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_deepseek') },
  { id: 'grp_gpt_pro', name: 'GPT PRO', url: VIP1129_CHAT_URL, upstreamSync: 'vip1129', defaultModel: DEFAULT_RECOMMENDED_MODEL, models: [], priority: 20, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_gpt_pro') },
  { id: 'grp_gpt_plus', name: 'GPT-PLUS', url: VIP1129_CHAT_URL, upstreamSync: 'vip1129', defaultModel: DEFAULT_RECOMMENDED_MODEL, models: [], priority: 30, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_gpt_plus') },
  { id: 'grp_gpt_mix', name: 'GPT 混用', url: VIP1129_CHAT_URL, upstreamSync: 'vip1129', defaultModel: DEFAULT_RECOMMENDED_MODEL, models: [], priority: 40, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_gpt_mix') },
  { id: 'grp_grok', name: 'Grok', url: BEIBEIHAI_CHAT_URL, upstreamSync: 'beibeihai', defaultModel: 'grok-3', models: [], priority: 50, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_grok') },
  { id: 'grp_cc_max', name: 'CC-MAX', url: BEIBEIHAI_CHAT_URL, upstreamSync: 'beibeihai', defaultModel: 'claude-sonnet-4', models: [], priority: 60, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_cc_max') },
  { id: 'grp_cursor_pool', name: 'Cursor账号池', url: 'https://api2.cursor.sh/v1/chat/completions', defaultModel: 'claude-sonnet-4', models: [], priority: 80, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_cursor_pool'), maintenance: true, maintenanceMessage: '请联系站长购买' },
  { id: 'grp_glm', name: '智普 GLM', url: BEIBEIHAI_CHAT_URL, upstreamSync: 'beibeihai', defaultModel: 'glm-5.1', models: [], priority: 90, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_glm') },
  { id: 'grp_kimi', name: 'Kimi', url: BEIBEIHAI_CHAT_URL, upstreamSync: 'beibeihai', defaultModel: 'kimi-k2.6', models: [], priority: 100, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_kimi') },
  { id: 'grp_gemini', name: 'Gemini', url: BEIBEIHAI_CHAT_URL, upstreamSync: 'beibeihai', defaultModel: 'gemini-2.5-flash', models: [], priority: 110, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_gemini') },
  { id: 'grp_grok_heavy', name: 'Grok Heavy', url: BEIBEIHAI_CHAT_URL, upstreamSync: 'beibeihai', defaultModel: 'composer-2.5', models: [], priority: 120, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_grok_heavy'), timeoutMs: 90000 },
  { id: 'grp_claude_kiro', name: 'Claude-Kiro', url: BEIBEIHAI_CHAT_URL, upstreamSync: 'beibeihai', defaultModel: 'claude-haiku-4-5-20251001', models: [], priority: 130, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_claude_kiro') },
  { id: 'grp_claude_kiro_welfare', name: 'Claude-Kiro 福利', url: BEIBEIHAI_CHAT_URL, upstreamSync: 'beibeihai', defaultModel: 'claude-fable-5', models: [], priority: 140, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_claude_kiro_welfare') },
  { id: 'grp_aws_cc', name: 'AWS-CC', url: VIP1129_CHAT_URL, upstreamSync: 'vip1129', defaultModel: 'claude-fable-5', models: [], priority: 210, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_aws_cc') },
  { id: 'grp_grok_vip', name: 'Grok VIP', url: VIP1129_CHAT_URL, upstreamSync: 'vip1129', defaultModel: 'grok-4.5', models: [], priority: 220, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_grok_vip'), timeoutMs: 90000 },
  { id: 'grp_cn_models', name: '国产模型', url: BEIBEIHAI_CHAT_URL, upstreamSync: 'beibeihai', defaultModel: 'glm-5.2', models: [], priority: 230, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_cn_models') },
];

function seedDefaultProviders(db) {
  db.settings ??= {};
  db.settings.providers ??= [];
  if (db.settings.providers.length) return false;
  db.settings.providers = DEFAULT_MODEL_GROUPS.map(g => ({
    id: g.id,
    name: g.name,
    url: g.url,
    apiKey: '',
    upstreamSync: g.upstreamSync || null,
    defaultModel: g.defaultModel,
    models: [...g.models],
    inputPricePer1K: 0.01,
    outputPricePer1K: 0.03,
    enabled: true,
    priority: g.priority,
    billingMultiplier: Number(g.billingMultiplier) || DEFAULT_BILLING_MULTIPLIER,
    displayMultiplier: resolveDisplayMultiplier(g),
    timeoutMs: Number(g.timeoutMs) || 60000,
    maxRetries: 1,
    modelPrices: {},
    maintenance: !!g.maintenance,
    maintenanceMessage: g.maintenanceMessage || null,
    health: { ok: true, lastCheckedAt: null, lastError: null }
  }));
  db.settings.defaultProviderId = DEFAULT_MODEL_GROUPS[0].id;
  return true;
}

function ensureDefaultModelGroups(db) {
  db.settings ??= {};
  db.settings.providers ??= [];
  const have = new Set(db.settings.providers.map(p => String(p.id)));
  let added = false;
  for (const g of DEFAULT_MODEL_GROUPS) {
    if (have.has(g.id)) continue;
    db.settings.providers.push({
      id: g.id,
      name: g.name,
      url: g.url,
      apiKey: '',
      upstreamSync: g.upstreamSync || null,
      defaultModel: g.defaultModel,
      models: [...g.models],
      inputPricePer1K: 0.01,
      outputPricePer1K: 0.03,
      enabled: true,
      priority: g.priority,
      billingMultiplier: Number(g.billingMultiplier) || DEFAULT_BILLING_MULTIPLIER,
      displayMultiplier: resolveDisplayMultiplier(g),
      timeoutMs: Number(g.timeoutMs) || 60000,
      maxRetries: 1,
      modelPrices: {},
      maintenance: !!g.maintenance,
      maintenanceMessage: g.maintenanceMessage || null,
      health: { ok: true, lastCheckedAt: null, lastError: null }
    });
    added = true;
  }
  return added;
}

function modelFamilyToken(name) {
  return String(name || '').toLowerCase().split(/[-_./]/)[0];
}

function repairSeededDefaultModels(db) {
  let changed = false;
  const providers = db.settings?.providers || [];
  for (const g of DEFAULT_MODEL_GROUPS) {
    const p = providers.find(x => x && x.id === g.id);
    if (!p || !g.defaultModel) continue;
    const current = String(p.defaultModel || '').trim();
    const seed = String(g.defaultModel).trim();
    const curTok = modelFamilyToken(current);
    const seedTok = modelFamilyToken(seed);
    if (!current || (curTok && seedTok && curTok !== seedTok)) {
      p.defaultModel = seed;
      changed = true;
    }
  }
  return changed;
}

const RETIRED_MODEL_GROUP_IDS = [
  'grp_claude_cursor',
  'grp_gpt_ent',
  'grp_gpt_pro_bb',
  'grp_gpt_plus_bb',
  'grp_gpt_pro_mixplus',
  'grp_gpt_pro_welfare',
  'grp_gpt_bomb',
  'grp_gpt_image',
  'grp_nano_banana',
  'grp_nano_banana_pro',
  'grp_grok_image'
];

function pruneRetiredModelGroups(db) {
  db.settings ??= {};
  db.settings.providers ??= [];
  const before = db.settings.providers.length;
  db.settings.providers = db.settings.providers.filter(p => !RETIRED_MODEL_GROUP_IDS.includes(String(p.id)));
  let changed = db.settings.providers.length !== before;
  for (const key of ['upstreamBeibeihai', 'upstreamVip1129']) {
    const map = db.settings[key]?.groupMap;
    if (!map || typeof map !== 'object') continue;
    for (const id of RETIRED_MODEL_GROUP_IDS) {
      if (id in map) {
        delete map[id];
        changed = true;
      }
    }
  }
  const probes = db.settings.upstreamProbeKeys;
  if (probes && typeof probes === 'object') {
    for (const id of RETIRED_MODEL_GROUP_IDS) {
      if (id in probes) {
        delete probes[id];
        changed = true;
      }
    }
  }
  for (const user of db.users || []) {
    for (const k of user.apiKeys || []) {
      if (RETIRED_MODEL_GROUP_IDS.includes(String(k.groupId || ''))) {
        k.groupId = null;
        changed = true;
      }
    }
  }
  return changed;
}

function ensureUsername(user, db) {
  if (user.username && USERNAME_RE.test(user.username) && !usernameTaken(db, user.username, user.id)) return;
  const seed = user.username || user.name || (user.email || '').split('@')[0] || 'user';
  user.username = allocateUsername(db, seed, user.id);
}

function ensureUniqueDisplayNames(db) {
  const used = new Map();
  for (const user of db.users) {
    const uname = (user.username || '').toLowerCase();
    if (uname) used.set(uname, user.id);
  }
  for (const user of db.users) {
    let name = String(user.name || '').trim() || user.username || 'user';
    let lower = name.toLowerCase();
    let n = 0;
    const seed = name;
    while (used.has(lower) && used.get(lower) !== user.id) {
      n += 1;
      name = `${seed.slice(0, 28)}_${n}`;
      lower = name.toLowerCase();
    }
    user.name = name;
    used.set(lower, user.id);
  }
}

function ensureAdminUser(db) {
  const email = ADMIN_EMAIL;
  let admin = db.users.find(x => x.id === 'usr_admin')
    || (email && db.users.find(x => (x.email || '').toLowerCase() === email))
    || db.users.find(x => (x.username || '').toLowerCase() === ADMIN_USERNAME && x.role === 'admin')
    || db.users.find(x => x.role === 'admin');
  for (const u of db.users) {
    if ((!admin || u.id !== admin.id) && (u.username || '').toLowerCase() === ADMIN_USERNAME) {
      u.username = allocateUsername(db, `${u.username || 'user'}_u`, u.id);
    }
  }
  if (!admin) {
    db.users.push({
      id: 'usr_admin',
      email: email || '',
      username: ADMIN_USERNAME,
      name: 'Admin',
      password: hash(ADMIN_PASSWORD),
      apiKey: null,
      apiKeys: [],
      balance: 999999999,
      bonusBalance: 0,
      quotaTokens: 999999999,
      usedTokens: 0,
      reservedTokens: 0,
      reservedBalance: 0,
      accountActive: true,
      banned: false,
      unlimited: true,
      role: 'admin',
      invited: 0,
      inviteCode: 'ADMIN',
      createdAt: new Date().toISOString()
    });
    ensureUserKeys(db.users[db.users.length - 1]);
    return;
  }
  admin.username = ADMIN_USERNAME;
  admin.role = 'admin';
  admin.unlimited = true;
  admin.accountActive = true;
  admin.banned = false;
  if ((admin.balance || 0) < 1000000) admin.balance = 999999999;
  if ((admin.quotaTokens || 0) < 1000000) admin.quotaTokens = 999999999;
  if (email) admin.email = email;
  // Keep local admin password in sync with ADMIN_PASSWORD env (start-local.ps1)
  if (ADMIN_PASSWORD) admin.password = hash(ADMIN_PASSWORD);
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
    checkInBonus: user.checkInBonus || 0,
    quotaTokens: user.quotaTokens || 0,
    usedTokens: user.usedTokens || 0,
    availableTokens: availableTokens(user),
    accountActive: user.accountActive !== false,
    banned: !!user.banned,
    isAdmin: isAdmin(user),
    unlimited: !!(user.unlimited || isAdmin(user)),
    role: user.role || 'user',
    invited: user.invited || 0,
    avatar: normalizeAvatar(user.avatar).avatar,
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
    banned: !!user.banned,
    role: user.role || 'user',
    createdAt: user.createdAt,
    invited: user.invited || 0,
    apiKeyMasked: key ? `****${key.slice(-4)}` : null
  };
}
function multiplier(db) {
  // beibeihai / 北海 上游全局倍率（默认 2.5）。真正扣费用此档或 vip1129 档，见 providerMultiplier。
  const parsed = normalizeBillingMultiplier(db.settings?.billingMultiplier ?? DEFAULT_MULTIPLIER);
  return parsed.ok ? parsed.value : DEFAULT_BILLING_MULTIPLIER;
}
const DEFAULT_VIP1129_BILLING_MULTIPLIER = 1.5;
function multiplierVip1129(db) {
  // vip1129 / Codex 直连中转 上游全局倍率（默认 1.5）
  const parsed = normalizeBillingMultiplier(db.settings?.billingMultiplierVip1129 ?? DEFAULT_VIP1129_BILLING_MULTIPLIER);
  return parsed.ok ? parsed.value : DEFAULT_VIP1129_BILLING_MULTIPLIER;
}
function providerMultiplier(provider, db) {
  // 计费铁律（站长强调，必须写进注释并遵守）：
  // - 渠道侧 displayMultiplier / billingMultiplier UI 数字 = 摆设文字，绝不参与扣费；
  // - 真正扣费只用「上游全局倍率」两档：
  //   * settings.billingMultiplier = beibeihai / 北海 全局倍率（默认 2.5）
  //   * settings.billingMultiplierVip1129 = vip1129 / Codex 直连中转 全局倍率（默认 1.5）
  // - 若 provider 为 vip1129（isVip1129Provider / upstreamSync==='vip1129' / url 含 vip1129）→ multiplierVip1129(db)
  // - 否则（beibeihai 及其他）→ multiplier(db)
  // - 客户花销 = 上游成本(upstreamCost) × 对应上游全局倍率；绝不读 provider.billingMultiplier / displayMultiplier。
  const url = String(provider?.url || '');
  if (typeof isVip1129Provider === 'function' && isVip1129Provider(provider)) return multiplierVip1129(db);
  if (provider?.upstreamSync === 'vip1129') return multiplierVip1129(db);
  if (/vip1129/i.test(url)) return multiplierVip1129(db);
  return multiplier(db);
}
function normalizeProvider(item, previous = null) {
  const modelPrices = {};
  const rawPrices = item.modelPrices && typeof item.modelPrices === 'object' ? item.modelPrices : (previous?.modelPrices || {});
  for (const [model, price] of Object.entries(rawPrices)) {
    if (!price || typeof price !== 'object') continue;
    modelPrices[model] = {
      inputPricePer1K: Math.max(0, Number(price.inputPricePer1K || 0)),
      outputPricePer1K: Math.max(0, Number(price.outputPricePer1K || 0)),
      cacheReadPricePer1K: Math.max(0, Number(price.cacheReadPricePer1K ?? price.cache_read_price_per_1k ?? (Number(price.inputPricePer1K || 0) * 0.1)))
    };
  }
  const upstreamSync = item.upstreamSync || previous?.upstreamSync || null;
  return {
    id: String(item.id),
    name: String(item.name),
    url: String(item.url),
    apiKey: String(item.apiKey || previous?.apiKey || ''),
    upstreamSync: upstreamSync === 'vip1129' || upstreamSync === 'beibeihai' ? upstreamSync : null,
    defaultModel: String(item.defaultModel || previous?.defaultModel || ''),
    models: Array.isArray(item.models) ? item.models.map(String) : (previous?.models || []),
    inputPricePer1K: Math.max(0, Number(item.inputPricePer1K ?? previous?.inputPricePer1K ?? 0)),
    outputPricePer1K: Math.max(0, Number(item.outputPricePer1K ?? previous?.outputPricePer1K ?? 0)),
    cacheReadPricePer1K: Math.max(0, Number(item.cacheReadPricePer1K ?? previous?.cacheReadPricePer1K ?? ((Number(item.inputPricePer1K ?? previous?.inputPricePer1K ?? 0) || 0) * 0.1))),
    upstreamRateMultiplier: (() => {
      const raw = item.upstreamRateMultiplier ?? previous?.upstreamRateMultiplier;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : 1;
    })(),
    enabled: item.enabled !== false,
    priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : (Number(previous?.priority) || 100),
    billingMultiplier: (() => {
      const parsed = normalizeBillingMultiplier(item.billingMultiplier ?? previous?.billingMultiplier ?? DEFAULT_MULTIPLIER);
      return parsed.ok ? parsed.value : DEFAULT_BILLING_MULTIPLIER;
    })(),
    displayMultiplier: resolveDisplayMultiplier({
      id: String(item.id || previous?.id || ''),
      displayMultiplier: item.displayMultiplier ?? previous?.displayMultiplier
    }),
    timeoutMs: Math.max(1000, Number(item.timeoutMs ?? previous?.timeoutMs ?? 60000) || 60000),
    maxRetries: Math.max(0, Math.min(5, Number(item.maxRetries ?? previous?.maxRetries ?? 0) || 0)),
    modelPrices,
    maintenance: !!(item.maintenance ?? previous?.maintenance),
    maintenanceMessage: item.maintenanceMessage || previous?.maintenanceMessage || null,
    status: item.status || previous?.status || null,
    health: previous?.health || { ok: true, lastCheckedAt: null, lastError: null }
  };
}

function modelsEndpointFromChatUrl(url) {
  const raw = String(url || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  if (/\/chat\/completions$/i.test(raw)) return raw.replace(/\/chat\/completions$/i, '/models');
  if (/\/messages$/i.test(raw)) return raw.replace(/\/messages$/i, '/models');
  if (/\/v1$/i.test(raw)) return `${raw}/models`;
  const v1 = raw.indexOf('/v1/');
  if (v1 >= 0) return `${raw.slice(0, v1 + 3)}/models`;
  return `${raw}/models`;
}

async function fetchUpstreamModels(provider, overrideApiKey = null) {
  const apiKey = String(overrideApiKey || provider?.apiKey || '').trim();
  if (!provider?.url || !apiKey) {
    const err = new Error('请先填写上游 HTTPS 地址和 API Key');
    err.status = 400;
    throw err;
  }
  const endpoint = modelsEndpointFromChatUrl(provider.url);
  if (!endpoint || !/^https:\/\//i.test(endpoint)) {
    const err = new Error('无法从上游地址推导 /v1/models');
    err.status = 400;
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(provider.timeoutMs || 20000));
  try {
    const upstream = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal
    });
    const text = await upstream.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!upstream.ok) {
      const err = new Error(`上游返回 ${upstream.status}: ${String(text || '').slice(0, 180)}`);
      err.status = 502;
      throw err;
    }
    const rows = Array.isArray(data?.data) ? data.data
      : (Array.isArray(data?.models) ? data.models
        : (Array.isArray(data) ? data : []));
    const ids = [...new Set(rows.map(x => {
      if (typeof x === 'string') return x.trim();
      return String(x?.id || x?.name || x?.model || '').trim();
    }).filter(Boolean))];
    if (!ids.length) {
      const err = new Error('上游未返回可用模型');
      err.status = 502;
      throw err;
    }
    return { endpoint, models: ids };
  } catch (e) {
    if (e?.name === 'AbortError') {
      const err = new Error('拉取上游模型超时');
      err.status = 504;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}



async function fetchUpstreamModelsRetry(db, provider, bearer) {
  try {
    return await fetchUpstreamModels(provider, bearer);
  } catch (err) {
    if (/401|INVALID_API_KEY/i.test(String(err && err.message || err))) {
      const next = await ensureUpstreamProbeKey(db, provider, { forceNew: true });
      if (next) return fetchUpstreamModels(provider, next);
    }
    throw err;
  }
}

async function syncAllUpstreamModels(db, { onlyStaleMs = 0, ids = null } = {}) {
  db.settings ??= {};
  db.settings.providers ??= [];
  const now = Date.now();
  const results = [];
  const list = db.settings.providers.filter(p => {
    if (ids?.length && !ids.includes(p.id)) return false;
    if (p.enabled === false) return false;
    if (isMaintenanceProvider(p)) return false;
    if (!p.url) return false;
    if (!p.apiKey && !isVip1129Provider(p) && !isBeibeihaiProvider(p)) return false;
    if (onlyStaleMs > 0 && p.modelsSyncedAt) {
      const age = now - new Date(p.modelsSyncedAt).getTime();
      if (Number.isFinite(age) && age < onlyStaleMs) return false;
    }
    return true;
  });
  for (const provider of list) {
    try {
      const bearer = await ensureUpstreamProbeKey(db, provider);
      const { endpoint, models } = await fetchUpstreamModelsRetry(db, provider, bearer);
      provider.models = models;
      if (!provider.defaultModel || !models.includes(provider.defaultModel)) {
        provider.defaultModel = models[0];
      }
      provider.modelsSyncedAt = new Date().toISOString();
      provider.modelsSource = endpoint;
      results.push({ id: provider.id, name: provider.name, ok: true, count: models.length, endpoint });
    } catch (err) {
      results.push({ id: provider.id, name: provider.name, ok: false, error: err.message || String(err) });
    }
  }
  return results;
}

function providers(db) {
  return Array.isArray(db.settings?.providers)
    ? db.settings.providers.filter(p => p.enabled !== false && !isMaintenanceProvider(p) && p.url && (p.apiKey || isVip1129Provider(p) || isBeibeihaiProvider(p)))
    : [];
}
function providersForModel(payload, db) {
  const list = providers(db);
  const model = String(payload.model || '');
  // Exact model match only. Empty models[] must NOT match every request (e.g. Cursor pool).
  const exact = list
    .filter(p => Array.isArray(p.models) && p.models.length && p.models.includes(model))
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  if (exact.length) return exact;
  if (!model) {
    const any = list.slice().sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    if (any.length) return any;
  }
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
  if (kind === 'outputPricePer1K') return Number(provider.outputPricePer1K ?? fallback);
  if (kind === 'cacheReadPricePer1K') {
    const explicit = Number(provider.cacheReadPricePer1K);
    if (Number.isFinite(explicit) && explicit >= 0) return explicit;
    // OpenAI-style cache read ≈ 10% of input when upstream omits a dedicated price.
    return modelPrice(provider, model, 'inputPricePer1K') * 0.1;
  }
  return Number(provider.outputPricePer1K ?? fallback);
}
/** Prefer real upstream bill fields when present (vip1129/beibeihai usage.*_cost). */
function extractReportedUpstreamCost(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const candidates = [
    usage.actual_cost, usage.actualCost,
    usage.total_cost, usage.totalCost,
    usage.cost, usage.upstream_cost, usage.upstreamCost,
    usage.billing_amount, usage.billingAmount,
    usage.quota_cost, usage.quotaCost
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}
/** Group rate_multiplier from vip1129/beibeihai; 1 when unset (prices already effective). */
function providerUpstreamRate(provider) {
  const n = Number(provider?.upstreamRateMultiplier);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}
/**
 * Base token cost BEFORE group rate_multiplier.
 * Uses prompt_tokens_details.cached_tokens when present (chat usage often folds cache into prompt_tokens).
 */
function estimateBaseUpstreamCost(provider, usage, model) {
  const resolvedModel = model || provider.defaultModel || '';
  const inputPrice = modelPrice(provider, resolvedModel, 'inputPricePer1K');
  const outputPrice = modelPrice(provider, resolvedModel, 'outputPricePer1K');
  const cachePrice = modelPrice(provider, resolvedModel, 'cacheReadPricePer1K');
  const cacheWritePrice = modelPrice(provider, resolvedModel, 'cacheWritePricePer1K');
  const prompt = Math.max(0, Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0) || 0);
  const completion = Math.max(0, Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0);
  const cachedRaw = Number(
    usage?.prompt_tokens_details?.cached_tokens ??
    usage?.input_tokens_details?.cached_tokens ??
    usage?.cache_read_input_tokens ??
    usage?.cache_read_tokens ??
    usage?.cached_tokens ??
    0
  ) || 0;
  const cacheWriteRaw = Number(
    usage?.cache_creation_input_tokens ??
    usage?.cache_creation_tokens ??
    usage?.cache_write_tokens ??
    usage?.input_tokens_details?.cache_write_tokens ??
    usage?.input_tokens_details?.cache_creation_tokens ??
    usage?.prompt_tokens_details?.cache_write_tokens ??
    0
  ) || 0;
  // OpenAI-style: cache is folded into prompt/input_tokens → subtract.
  // vip1129 usage-style: input_tokens is fresh-only and cache_read_tokens is separate → add.
  let cacheTokens;
  let freshInput;
  if (cachedRaw > prompt && prompt > 0) {
    freshInput = prompt;
    cacheTokens = cachedRaw;
  } else {
    cacheTokens = Math.min(prompt, Math.max(0, cachedRaw));
    freshInput = Math.max(0, prompt - cacheTokens);
  }
  const writeTokens = Math.max(0, cacheWriteRaw);
  const writePrice = Number.isFinite(Number(cacheWritePrice)) && Number(cacheWritePrice) > 0
    ? Number(cacheWritePrice)
    : inputPrice;
  return (freshInput / 1000) * inputPrice
    + (cacheTokens / 1000) * cachePrice
    + (writeTokens / 1000) * writePrice
    + (completion / 1000) * outputPrice;
}
/** Real upstream bill when reported; else base×upstreamRateMultiplier (NOT displayMultiplier). */
function resolveUpstreamCost(provider, usage, model) {
  const reported = extractReportedUpstreamCost(usage);
  if (reported != null) return { cost: reported, source: 'reported' };
  const cost = estimateBaseUpstreamCost(provider, usage, model) * providerUpstreamRate(provider);
  return { cost, source: 'estimated' };
}
function providerCost(provider, usage, model) {
  return resolveUpstreamCost(provider, usage, model).cost;
}
function estimatedCost(provider, inputTokens, outputTokens, model) {
  return providerCost(provider, { prompt_tokens: inputTokens, completion_tokens: outputTokens }, model);
}
function safetyBuffer(provider, rate, model) {
  const input = modelPrice(provider, model || provider.defaultModel || '', 'inputPricePer1K');
  const output = modelPrice(provider, model || provider.defaultModel || '', 'outputPricePer1K');
  const upRate = providerUpstreamRate(provider);
  const minCost = Math.max(input, output) / 1000 * upRate * rate;
  return Math.max(BALANCE_SAFETY_BUFFER, minCost);
}

// Only treat balance as nearly empty when it cannot cover a tiny reply.
// Do NOT nag / lock accounts while they still have a few yuan left.
const MIN_REPLY_TOKENS = Math.max(32, Number(process.env.MIN_REPLY_TOKENS || 64));
const LOW_BALANCE_FLOOR = Math.max(0.01, Number(process.env.LOW_BALANCE_FLOOR || 0.05));
function minimalReplyCost(provider, rate, model) {
  return estimatedCost(provider, 0, MIN_REPLY_TOKENS, model) * rate;
}
function isNearlyEmptyBalance(user, provider, rate, model) {
  const bal = Math.max(0, Number(user?.balance || 0));
  const need = Math.max(LOW_BALANCE_FLOOR, minimalReplyCost(provider, rate, model) * 2);
  return bal < need;
}
function requestTooLargeMessage() {
  return '当前余额不够完成本次较大请求，请缩短上下文或稍后再试；余额快用完时才会提示充值。';
}
function scrubStuckReserves(user, apiKeyRec = null) {
  if (!user) return;
  const bal = Math.max(0, Number(user.balance || 0));
  const reservedBal = Math.max(0, Number(user.reservedBalance || 0));
  const reservedTok = Math.max(0, Number(user.reservedTokens || 0));
  // Stuck pre-auth leftovers should not fake "no money".
  if (reservedBal > bal || reservedTok > 20000) {
    user.reservedBalance = 0;
    user.reservedTokens = 0;
  }
  if (apiKeyRec) {
    const rSpend = Math.max(0, Number(apiKeyRec.reservedSpend || 0));
    const rTok = Math.max(0, Number(apiKeyRec.reservedTokens || 0));
    if (rSpend > bal || rTok > 20000) {
      apiKeyRec.reservedSpend = 0;
      apiKeyRec.reservedTokens = 0;
    }
  }
}
function publicProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    url: provider.url || '',
    models: provider.models || [],
    modelsSyncedAt: provider.modelsSyncedAt || null,
    modelsSource: provider.modelsSource || null,
    defaultModel: provider.defaultModel || '',
    enabled: provider.enabled !== false,
    inputPricePer1K: Number(provider.inputPricePer1K ?? provider.pricePer1K ?? 0),
    outputPricePer1K: Number(provider.outputPricePer1K ?? provider.pricePer1K ?? 0),
    cacheReadPricePer1K: Number(provider.cacheReadPricePer1K ?? ((Number(provider.inputPricePer1K ?? provider.pricePer1K ?? 0) || 0) * 0.1)),
    upstreamRateMultiplier: providerUpstreamRate(provider),
    priority: Number(provider.priority ?? 100),
    billingMultiplier: (() => {
      const parsed = normalizeBillingMultiplier(provider.billingMultiplier);
      return parsed.ok ? parsed.value : DEFAULT_BILLING_MULTIPLIER;
    })(),
    displayMultiplier: resolveDisplayMultiplier(provider),
    timeoutMs: Number(provider.timeoutMs ?? 60000),
    maxRetries: Number(provider.maxRetries ?? 0),
    modelPrices: provider.modelPrices || {},
    health: provider.health || { ok: true, lastCheckedAt: null, lastError: null },
    apiKeyConfigured: Boolean(provider.apiKey),
    upstreamSync: provider.upstreamSync || null,
    usesPerKeyUpstream: isVip1129Provider(provider) || isBeibeihaiProvider(provider),
    maintenance: isMaintenanceProvider(provider),
    maintenanceMessage: provider.maintenanceMessage || null
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

async function probeProviderHealth(db, provider) {
  if (!provider) return { id: null, ok: false, error: 'missing_provider' };
  if (provider.enabled === false) {
    updateProviderHealth(db, provider.id, true, null);
    provider.health.skipped = true;
    provider.health.lastError = null;
    provider.health.ok = true;
    provider.health.lastCheckedAt = new Date().toISOString();
    provider.health.note = 'disabled';
    return { id: provider.id, name: provider.name, ok: true, skipped: true, reason: 'disabled' };
  }
  if (isMaintenanceProvider(provider)) {
    updateProviderHealth(db, provider.id, true, null);
    provider.health.skipped = true;
    provider.health.note = 'maintenance';
    return { id: provider.id, name: provider.name, ok: true, skipped: true, reason: 'maintenance' };
  }
  if (!provider.url) {
    updateProviderHealth(db, provider.id, false, '缺少上游地址');
    return { id: provider.id, name: provider.name, ok: false, error: '缺少上游地址', fix: tipsForCode('channel_down') };
  }
  // Per-key upstream sync: channel apiKey is allowed to be empty. Health must
  // still inject a synced sk- (user key or a dedicated probe key).
  if (!provider.apiKey && !isVip1129Provider(provider) && !isBeibeihaiProvider(provider)) {
    updateProviderHealth(db, provider.id, false, '缺少上游地址或 API Key');
    return { id: provider.id, name: provider.name, ok: false, error: '缺少渠道 API Key', fix: tipsForCode('channel_no_key') };
  }
  try {
    const bearer = await ensureUpstreamProbeKey(db, provider);
    if (!bearer) {
      const syncName = isVip1129Provider(provider) ? 'vip1129' : (isBeibeihaiProvider(provider) ? 'Beibeihai' : '上游');
      const mapped = isVip1129Provider(provider)
        ? resolveVip1129GroupId(db, provider.id) != null
        : (isBeibeihaiProvider(provider) ? resolveBeibeihaiGroupId(db, provider.id) != null : true);
      const error = mapped
        ? `${syncName} 已映射但还没有可用的同步密钥，无法探测`
        : `${syncName} 未映射分组，无法探测（渠道级 Key 可为空，请在同步页选择上游分组）`;
      updateProviderHealth(db, provider.id, false, error);
      return { id: provider.id, name: provider.name, ok: false, error, fix: tipsForCode(mapped ? 'channel_no_key' : 'no_group_map') };
    }
    const { endpoint, models } = await fetchUpstreamModelsRetry(db, provider, bearer);
    updateProviderHealth(db, provider.id, true);
    provider.health.probe = 'models';
    provider.health.endpoint = endpoint;
    provider.health.modelCount = models.length;
    // 探测成功时顺带刷新模型列表，保持与上游一致
    provider.models = models;
    if (!provider.defaultModel) provider.defaultModel = models[0];
    provider.modelsSyncedAt = new Date().toISOString();
    provider.modelsSource = endpoint;
    return { id: provider.id, name: provider.name, ok: true, count: models.length, endpoint };
  } catch (err) {
    updateProviderHealth(db, provider.id, false, err.message || String(err));
    return { id: provider.id, name: provider.name, ok: false, error: err.message || String(err) };
  }
}

async function probeAllProviderHealth(db) {
  const list = (db.settings?.providers || []).filter(p => p && p.id);
  const results = [];
  for (const provider of list) {
    results.push(await probeProviderHealth(db, provider));
  }
  return results;
}

function pickChatProbeModel(provider) {
  const seeded = DEFAULT_MODEL_GROUPS.find(g => g.id === provider?.id);
  const seed = String(seeded?.defaultModel || '').trim();
  const current = String(provider?.defaultModel || '').trim();
  const intended = (seed && current && modelFamilyToken(current) !== modelFamilyToken(seed))
    ? seed
    : (current || seed);
  const models = Array.isArray(provider?.models) ? provider.models.map(m => String(m || '').trim()).filter(Boolean) : [];
  if (intended && models.includes(intended)) return intended;
  const token = modelFamilyToken(intended);
  if (token && models.length) {
    const hit = models.find(m => m.toLowerCase().includes(token));
    if (hit) return hit;
  }
  if (intended) return intended;
  return models[0] || '';
}

async function probeProviderChat(db, provider) {
  const started = Date.now();
  const model = pickChatProbeModel(provider);
  if (!model) return { ok: false, error: '无可用模型', ms: Date.now() - started };
  try {
    const bearer = await ensureUpstreamProbeKey(db, provider);
    if (!bearer) return { ok: false, error: '缺少上游同步密钥', ms: Date.now() - started, model };
    const probeProvider = { ...provider, timeoutMs: Math.min(Number(provider.timeoutMs) || 20000, 20000) };
    const upstream = await fetchUpstream(probeProvider, {
      messages: [{ role: 'user', content: 'Reply with the single word PONG.' }],
      model,
      max_tokens: 8
    }, 8, model, bearer);
    const text = await upstream.text().catch(() => '');
    const ms = Date.now() - started;
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!upstream.ok) {
      const err = body?.error?.message || body?.error || body?.message || text.slice(0, 180) || `HTTP ${upstream.status}`;
      return {
        ok: false,
        error: typeof err === 'string' ? err : JSON.stringify(err).slice(0, 180),
        ms,
        status: upstream.status,
        model
      };
    }
    return { ok: true, ms, status: upstream.status, model, usage: body?.usage || null };
  } catch (err) {
    return {
      ok: false,
      error: err?.name === 'AbortError' ? '对话超时' : (err?.message || String(err)),
      ms: Date.now() - started,
      model
    };
  }
}

function settleUsage(db, user, provider, usage, rate, tokenReservation, amountReservation, started, model, status = 'success', apiKeyRec = null) {
  const upstreamTokens = Math.max(0, Number(usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0))));
  const billedTokens = Math.min(upstreamTokens * rate, tokenReservation);
  const resolvedUp = resolveUpstreamCost(provider, usage, model);
  const upstreamCost = resolvedUp.cost;
  const upstreamCostSource = resolvedUp.source;
  // rate 为上游专用全局倍率（beibeihai→billingMultiplier，vip1129→billingMultiplierVip1129），由 providerMultiplier 选出；渠道 displayMultiplier/billingMultiplier 为摆设，不参与。
  // upstreamCost 已对齐上游实扣（reported actual_cost，或 base×upstreamRateMultiplier）。
  const chargedAmount = upstreamCost * rate;
  user.reservedTokens = Math.max(0, (user.reservedTokens || 0) - tokenReservation);
  user.reservedBalance = Math.max(0, (user.reservedBalance || 0) - amountReservation);
  if (isUnlimited(user)) {
    user.usedTokens = (user.usedTokens || 0) + billedTokens;
    // Admin / unlimited: do not deduct local balance; upstream billing is the real limit
    user.accountActive = true;
  } else {
    user.usedTokens = (user.usedTokens || 0) + billedTokens;
    user.balance = Math.max(0, (user.balance || 0) - chargedAmount);
  }
  if (apiKeyRec && !isUnlimited(user)) {
    apiKeyRec.reservedTokens = Math.max(0, (apiKeyRec.reservedTokens || 0) - tokenReservation);
    apiKeyRec.reservedSpend = Math.max(0, (apiKeyRec.reservedSpend || 0) - amountReservation);
    apiKeyRec.tokenUsed = (apiKeyRec.tokenUsed || 0) + billedTokens;
    apiKeyRec.spendUsed = (apiKeyRec.spendUsed || 0) + chargedAmount;
    if (apiKeyRec.tokenLimit > 0) apiKeyRec.tokenUsed = Math.min(apiKeyRec.tokenLimit, apiKeyRec.tokenUsed);
    if (apiKeyRec.spendLimit > 0) apiKeyRec.spendUsed = Math.min(apiKeyRec.spendLimit, apiKeyRec.spendUsed);
  } else if (apiKeyRec) {
    apiKeyRec.reservedTokens = Math.max(0, (apiKeyRec.reservedTokens || 0) - tokenReservation);
    apiKeyRec.reservedSpend = Math.max(0, (apiKeyRec.reservedSpend || 0) - amountReservation);
  }
  // Only lock when nearly empty. Never wipe remaining yuan just to force a top-up.
  if (!isUnlimited(user) && isNearlyEmptyBalance(user, provider, rate, model)) {
    user.accountActive = false;
  }
  db.logs.unshift({
    id: id('log'),
    userId: user.id,
    apiKeyId: apiKeyRec?.id || null,
    model,
    providerId: provider.id,
    tokens: upstreamTokens,
    billedTokens,
    upstreamCost,
    upstreamCostSource,
    chargedAmount,
    multiplier: rate,
    latency: Date.now() - started,
    status,
    createdAt: new Date().toISOString()
  });
  db.logs = db.logs.slice(0, 3000);
  return { billedTokens, chargedAmount, upstreamTokens, upstreamCost, upstreamCostSource };
}
function releaseReserve(user, tokenReservation, amountReservation, apiKeyRec = null) {
  user.reservedTokens = Math.max(0, (user.reservedTokens || 0) - tokenReservation);
  user.reservedBalance = Math.max(0, (user.reservedBalance || 0) - amountReservation);
  if (apiKeyRec) {
    apiKeyRec.reservedTokens = Math.max(0, (apiKeyRec.reservedTokens || 0) - tokenReservation);
    apiKeyRec.reservedSpend = Math.max(0, (apiKeyRec.reservedSpend || 0) - amountReservation);
  }
}
function estimateTokensFromText(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(String(text).length / 4));
}
function proxyDetectors() {
  return { isVip1129: isVip1129Provider, isBeibeihai: isBeibeihaiProvider };
}

/**
 * Inject the upstream sk- used for live chat AND health probes.
 * Designed path: channel-level apiKey stays empty; each local key is synced
 * to vip1129/beibeihai and that sk- is the Bearer we forward.
 */
function resolveProxyApiKey(provider, apiKeyRec, db = null, user = null) {
  return resolveProxyApiKeyPure(provider, apiKeyRec, db, user, proxyDetectors());
}

async function createUpstreamKeyForProvider(db, user, provider, localKey) {
  if (isVip1129Provider(provider) && resolveVip1129GroupId(db, provider.id) != null) {
    return syncCreateVip1129Key(db, user, localKey);
  }
  if (isBeibeihaiProvider(provider) && resolveBeibeihaiGroupId(db, provider.id) != null) {
    return syncCreateBeibeihaiKey(db, user, localKey);
  }
  return { ok: false, error: 'no_group_map' };
}

async function ensureProxyApiKey(db, user, provider, apiKeyRec = null) {
  const existing = resolveProxyApiKey(provider, apiKeyRec, db, user);
  if (existing) return existing;
  if (!isVip1129Provider(provider) && !isBeibeihaiProvider(provider)) {
    return String(provider?.apiKey || '').trim();
  }

  const rec = apiKeyRec && (!apiKeyRec.groupId || String(apiKeyRec.groupId) === String(provider.id))
    ? apiKeyRec
    : (user?.apiKeys || []).find(k => k.enabled !== false && String(k.groupId || '') === String(provider.id)) || null;
  // Only sync when the local key is bound to this model group. Empty-group
  // rk_ keys stay as platform keys; chat injects the station probe sk- below.
  if (user && rec && !rec.upstream && rec.groupId) {
    const synced = await createUpstreamKeyForProvider(db, user, provider, rec);
    if (synced.ok && rec.key) return rec.key;
  }

  const probe = await ensureUpstreamProbeKey(db, provider);
  if (probe) return probe;
  return String(provider?.apiKey || '').trim();
}

async function ensureUpstreamProbeKey(db, provider, { forceNew = false } = {}) {
  db.settings ??= {};
  db.settings.upstreamProbeKeys ??= {};
  if (forceNew) delete db.settings.upstreamProbeKeys[provider.id];
  const cached = db.settings.upstreamProbeKeys[provider.id];
  if (!forceNew && cached?.key) return cached.key;

  const persist = (secret) => {
    if (!secret?.key) return '';
    db.settings.upstreamProbeKeys[provider.id] = {
      key: secret.key,
      id: secret.id || null,
      createdAt: new Date().toISOString()
    };
    return secret.key;
  };

  const probeName = `relay-probe-${provider.id}`.slice(0, 60);
  if (isVip1129Provider(provider)) {
    const groupId = resolveVip1129GroupId(db, provider.id);
    if (groupId == null) return '';
    const auth = await ensureVip1129Token(db);
    if (!auth.ok) return '';
    if (!forceNew) {
      const listed = await vip1129ListKeys(auth.cfg.baseUrl, auth.token, 'page=1&page_size=100');
      if (listed.ok) {
        const exact = findListedSecret(listed.data, { name: probeName, groupId });
        if (exact.key) return persist(exact);
        const named = findListedSecret(listed.data, { nameIncludes: 'relay-probe', groupId });
        if (named.key) return persist(named);
        const any = findListedSecret(listed.data, { groupId });
        if (any.key) return persist(any);
      }
    }
    const created = await vip1129CreateKey(auth.cfg.baseUrl, auth.token, {
      name: probeName,
      group_id: groupId
    });
    if (created.ok) return persist(vip1129ExtractSecret(created.data));
    return '';
  }
  if (isBeibeihaiProvider(provider)) {
    const groupId = resolveBeibeihaiGroupId(db, provider.id);
    if (groupId == null) return '';
    const auth = await ensureBeibeihaiToken(db);
    if (!auth.ok) return '';
    if (!forceNew) {
      const listed = await beibeihaiListKeys(auth.cfg.baseUrl, auth.token, 'page=1&page_size=100');
      if (listed.ok) {
        const exact = findListedSecret(listed.data, { name: probeName, groupId });
        if (exact.key) return persist(exact);
        const named = findListedSecret(listed.data, { nameIncludes: 'relay-probe', groupId });
        if (named.key) return persist(named);
        const any = findListedSecret(listed.data, { groupId });
        if (any.key) return persist(any);
      }
    }
    const created = await beibeihaiCreateKey(auth.cfg.baseUrl, auth.token, {
      name: probeName,
      group_id: groupId
    });
    if (created.ok) return persist(beibeihaiExtractSecret(created.data));
    return '';
  }
  return String(provider?.apiKey || '').trim();
}

async function fetchUpstream(provider, payload, outputBudget, model, overrideApiKey = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), provider.timeoutMs || 60000);
  const bearer = String(overrideApiKey || provider.apiKey || '').trim();
  try {
    const upstream = await fetch(provider.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ ...payload, model: model || payload.model || provider.defaultModel, max_tokens: outputBudget }),
      signal: controller.signal
    });
    return upstream;
  } finally {
    clearTimeout(timeout);
  }
}



function responsesEndpointFromChatUrl(url) {
  const raw = String(url || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  if (/\/chat\/completions$/i.test(raw)) return raw.replace(/\/chat\/completions$/i, '/responses');
  if (/\/responses$/i.test(raw)) return raw;
  if (/\/v1$/i.test(raw)) return `${raw}/responses`;
  const v1 = raw.indexOf('/v1/');
  if (v1 >= 0) return `${raw.slice(0, v1 + 3)}/responses`;
  return `${raw}/responses`;
}

function normalizeResponsesUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const cached = Number(
    usage.prompt_tokens_details?.cached_tokens ??
    usage.input_tokens_details?.cached_tokens ??
    usage.cache_read_input_tokens ??
    usage.cache_read_tokens ??
    usage.cached_tokens ??
    0
  ) || 0;
  const cacheCreation = Number(
    usage.cache_creation_input_tokens ??
    usage.cache_creation_tokens ??
    usage.cache_write_tokens ??
    usage.input_tokens_details?.cache_write_tokens ??
    usage.input_tokens_details?.cache_creation_tokens ??
    usage.prompt_tokens_details?.cache_write_tokens ??
    0
  ) || 0;
  const total = Number(usage.total_tokens ?? (prompt + completion)) || (prompt + completion);
  const out = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    input_tokens: prompt,
    output_tokens: completion,
    // Preserve for estimateBaseUpstreamCost (folded or separate cache).
    cache_read_tokens: cached,
    cached_tokens: cached,
    cache_creation_tokens: cacheCreation,
  };
  if (cached > 0) {
    out.prompt_tokens_details = { cached_tokens: cached, ...(usage.prompt_tokens_details || {}) };
    out.input_tokens_details = { cached_tokens: cached, ...(usage.input_tokens_details || {}) };
  }
  // Pass through reported bill fields if upstream ever includes them.
  for (const k of ['actual_cost', 'actualCost', 'total_cost', 'totalCost', 'cost', 'upstream_cost', 'billing_amount', 'quota_cost']) {
    if (usage[k] != null) out[k] = usage[k];
  }
  return out;
}

async function fetchUpstreamResponses(provider, payload, model, overrideApiKey = null) {
  const controller = new AbortController();
  // Responses tool rounds can be longer than chat, but cap so failover stays responsive.
  const waitMs = Math.min(Math.max(Number(provider.timeoutMs) || 60000, 15000), 90000);
  const timeout = setTimeout(() => controller.abort(), waitMs);
  const bearer = String(overrideApiKey || provider.apiKey || '').trim();
  const endpoint = responsesEndpointFromChatUrl(provider.url);
  if (!endpoint) {
    clearTimeout(timeout);
    throw new Error('missing_responses_endpoint');
  }
  try {
    const body = { ...payload, model: model || payload.model || provider.defaultModel };
    // Never force chat-only fields into responses payload.
    delete body.max_tokens;
    delete body.messages;
    return await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function providerSupportsResponsesPassthrough(provider) {
  const url = String(provider && provider.url || '');
  if (!url) return false;
  // Official OpenAI-compatible responses siblings of chat/completions.
  if (/cursor\.sh/i.test(url)) return false;
  if (typeof isVip1129Provider === 'function' && isVip1129Provider(provider)) return true;
  if (/\/v1\/chat\/completions$/i.test(url)) return true;
  if (/\/v1\/responses$/i.test(url)) return true;
  return false;
}

function responsesContentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (typeof content === 'object') {
      if (typeof content.text === 'string') return content.text;
      if (typeof content.content === 'string') return content.content;
    }
    return '';
  }
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      return typeof part.text === 'string' ? part.text : '';
    }
    if (typeof part.content === 'string') return part.content;
    return '';
  }).join('');
}

function responsesInputToMessages(input, instructions) {
  const messages = [];
  if (instructions != null && String(instructions).length) {
    messages.push({ role: 'system', content: String(instructions) });
  }
  if (typeof input === 'string') {
    if (input.length) messages.push({ role: 'user', content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;
  for (const item of input) {
    if (item == null) continue;
    if (typeof item === 'string') {
      if (item.length) messages.push({ role: 'user', content: item });
      continue;
    }
    if (typeof item !== 'object') continue;
    const type = item.type;
    // Fallback conversion only: keep tool/function items as text so history is not totally dropped.
    if (type === 'function_call') {
      const name = item.name || item.call?.name || 'tool';
      const args = item.arguments != null ? (typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments)) : '';
      messages.push({ role: 'assistant', content: `[function_call ${name}] ${args}`.slice(0, 8000) });
      continue;
    }
    if (type === 'function_call_output' || type === 'tool_result' || type === 'computer_call_output') {
      const out = item.output != null ? (typeof item.output === 'string' ? item.output : JSON.stringify(item.output))
        : responsesContentToText(item.content != null ? item.content : item);
      if (out) messages.push({ role: 'tool', content: String(out).slice(0, 12000) });
      continue;
    }
    if (type && type !== 'message' && type !== 'input_text') continue;
    const role = item.role || 'user';
    const text = responsesContentToText(
      item.content != null ? item.content : (item.text != null ? item.text : item)
    );
    if (!text) continue;
    const normalizedRole =
      role === 'system' || role === 'assistant' || role === 'user' || role === 'tool'
        ? role
        : 'user';
    messages.push({ role: normalizedRole, content: text });
  }
  return messages;
}

function chatCompletionToResponse(result) {
  const choice = result && result.choices && result.choices[0];
  const message = choice && choice.message ? choice.message : null;
  const rawContent = message ? message.content : '';
  const text = responsesContentToText(rawContent);
  const usage = (result && result.usage) || {};
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  const total = Number(usage.total_tokens) || (prompt + completion);
  let responseId;
  if (result && result.id) {
    responseId = String(result.id).replace(/^chatcmpl[-_]?/i, 'resp_');
    if (!/^resp/i.test(responseId)) responseId = 'resp_' + responseId;
  } else {
    responseId = id('resp');
  }
  const output = [];
  const toolCalls = Array.isArray(message && message.tool_calls) ? message.tool_calls : [];
  for (const tc of toolCalls) {
    const fn = tc && tc.function ? tc.function : null;
    output.push({
      id: tc.id || id('fc'),
      type: 'function_call',
      call_id: tc.id || id('call'),
      name: (fn && fn.name) || tc.name || 'tool',
      arguments: (fn && fn.arguments != null) ? (typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments)) : '{}'
    });
  }
  if (text || !output.length) {
    output.push({
      id: id('msg'),
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: text || '' }]
    });
  }
  return {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: (result && result.model) || '',
    output,
    usage: {
      input_tokens: prompt,
      output_tokens: completion,
      total_tokens: total
    }
  };
}


function anthropicContentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (typeof content === 'object' && typeof content.text === 'string') return content.text;
    return '';
  }
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
      return typeof part.text === 'string' ? part.text : '';
    }
    if (typeof part.text === 'string') return part.text;
    return '';
  }).join('');
}

function anthropicToChatPayload(raw) {
  const messages = [];
  if (raw && raw.system != null) {
    const sys = anthropicContentToText(raw.system);
    if (sys) messages.push({ role: 'system', content: sys });
  }
  const src = Array.isArray(raw && raw.messages) ? raw.messages : [];
  for (const m of src) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : (m.role === 'system' ? 'system' : 'user');
    const text = anthropicContentToText(m.content);
    if (!text) continue;
    messages.push({ role, content: text });
  }
  const payload = {
    model: raw && raw.model,
    messages,
    stream: raw && raw.stream === true
  };
  if (raw && raw.temperature !== undefined) payload.temperature = raw.temperature;
  if (raw && raw.max_tokens != null) payload.max_tokens = raw.max_tokens;
  return payload;
}

function chatCompletionToAnthropic(result) {
  const choice = result && result.choices && result.choices[0];
  const text = anthropicContentToText(choice && choice.message ? choice.message.content : '');
  const usage = (result && result.usage) || {};
  const stop = (choice && choice.finish_reason === 'length') ? 'max_tokens' : 'end_turn';
  return {
    id: (result && result.id) ? String(result.id).replace(/^chatcmpl[-_]?/i, 'msg_') : id('msg'),
    type: 'message',
    role: 'assistant',
    model: (result && result.model) || '',
    content: [{ type: 'text', text }],
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens) || 0,
      output_tokens: Number(usage.completion_tokens) || 0
    }
  };
}

function writeAnthropicSse(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}


function writeResponsesSse(res, type, payload, seqRef) {
  const body = Object.assign({ type }, payload);
  if (seqRef) {
    body.sequence_number = seqRef.n;
    seqRef.n += 1;
  }
  res.write(`event: ${type}\ndata: ${JSON.stringify(body)}\n\n`);
}

async function chat(req, res, db, user, apiKeyRec = null, prePayload = null) {
  const payload = prePayload || await body(req);
  if (!payload || !Array.isArray(payload.messages) || !payload.messages.length) return fail(res, 400, 'messages 不能为空');
  if (apiKeyRec && apiKeyRec.enabled === false) return fail(res, 403, '该 API 密钥已停用');

  const requestedModel = String(payload.model || '');
  if (apiKeyRec && Array.isArray(apiKeyRec.models) && apiKeyRec.models.length && requestedModel && !apiKeyRec.models.includes(requestedModel)) {
    return fail(res, 400, '该密钥无权调用此模型');
  }
  if (isBanned(user)) return fail(res, 403, '账号已被封禁');
  if (!isUnlimited(user) && user.accountActive === false) return fail(res, 402, insufficientBalanceMessage());
  scrubStuckReserves(user, apiKeyRec);

  const candidates = providersForModel(payload, db);
  if (!candidates.length) return fail(res, 503, '模型服务暂不可用，请稍后重试');

  const primary = candidates[0];
  const model = String(payload.model || primary.defaultModel || '');
  if (apiKeyRec && Array.isArray(apiKeyRec.models) && apiKeyRec.models.length && !apiKeyRec.models.includes(model)) {
    return fail(res, 400, '该密钥无权调用此模型');
  }
  const rate = providerMultiplier(primary, db);
  const inputReserve = Math.ceil(JSON.stringify(payload.messages).length * 2) + 256;
  const requestedOutput = Math.max(1, Math.min(Number(payload.max_tokens) || DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS));
  if (apiKeyRec && !keyRateOk(res, apiKeyRec, inputReserve + requestedOutput)) return;

  let tokenReservation = 0;
  let amountReservation = 0;
  let outputBudget = requestedOutput;

  if (isUnlimited(user)) {
    // Admin: skip local balance/quota gates; only upstream availability matters
    outputBudget = requestedOutput;
    tokenReservation = 0;
    amountReservation = 0;
    user.accountActive = true;
    writeDb(db);
  } else {
    // Spending quota is account balance. Token 配额不再单独拦请求。
    let availableBalance = Math.max(0, (user.balance || 0) - (user.reservedBalance || 0));
    if (apiKeyRec && apiKeyRec.spendLimit > 0) {
      availableBalance = Math.min(availableBalance, Math.max(0, apiKeyRec.spendLimit - (apiKeyRec.spendUsed || 0) - (apiKeyRec.reservedSpend || 0)));
    }
    const safety = safetyBuffer(primary, rate, model);
    const inputEstimate = estimatedCost(primary, inputReserve, 0, model) * rate;
    const outputUnitPrice = Math.max(modelPrice(primary, model, 'outputPricePer1K') / 1000 * rate, Number.EPSILON);
    const moneyBudget = Math.floor(Math.max(0, availableBalance - safety - inputEstimate) / outputUnitPrice);
    outputBudget = Math.min(requestedOutput, moneyBudget);
    if (apiKeyRec && apiKeyRec.tokenLimit > 0) {
      const keyLeft = Math.max(0, apiKeyRec.tokenLimit - (apiKeyRec.tokenUsed || 0) - (apiKeyRec.reservedTokens || 0));
      outputBudget = Math.min(outputBudget, Math.max(0, Math.floor(keyLeft / rate) - inputReserve));
    }
    // If the full requested size does not fit, still allow a small reply when balance is not nearly empty.
    if (outputBudget < 1) {
      const minCost = minimalReplyCost(primary, rate, model) + estimatedCost(primary, inputReserve, 0, model) * rate + safety;
      if (availableBalance >= minCost) {
        outputBudget = MIN_REPLY_TOKENS;
      } else {
        const keyTokenBlocked = apiKeyRec?.tokenLimit > 0 && moneyBudget >= 1;
        if (keyTokenBlocked) return fail(res, 402, '该密钥 Token 额度不足');
        if (apiKeyRec?.spendLimit > 0) return fail(res, 402, '该密钥花费额度不足');
        return fail(res, 402, isNearlyEmptyBalance({ balance: availableBalance }, primary, rate, model)
          ? insufficientBalanceMessage()
          : requestTooLargeMessage());
      }
    }

    const upstreamReservation = inputReserve + outputBudget;
    tokenReservation = upstreamReservation * rate;
    amountReservation = estimatedCost(primary, inputReserve, outputBudget, model) * rate;
    if (availableBalance < amountReservation + safety) {
      // Shrink output once more instead of immediately nagging for a top-up.
      const affordOut = Math.max(0, Math.floor(Math.max(0, availableBalance - safety - estimatedCost(primary, inputReserve, 0, model) * rate) / outputUnitPrice));
      if (affordOut >= MIN_REPLY_TOKENS) {
        outputBudget = Math.min(outputBudget, affordOut);
        tokenReservation = (inputReserve + outputBudget) * rate;
        amountReservation = estimatedCost(primary, inputReserve, outputBudget, model) * rate;
      } else if (apiKeyRec?.spendLimit > 0) {
        return fail(res, 402, '该密钥花费额度不足');
      } else {
        return fail(res, 402, isNearlyEmptyBalance({ balance: availableBalance }, primary, rate, model)
          ? insufficientBalanceMessage()
          : requestTooLargeMessage());
      }
    }

    user.reservedTokens = (user.reservedTokens || 0) + tokenReservation;
    user.reservedBalance = (user.reservedBalance || 0) + amountReservation;
    if (apiKeyRec) {
      apiKeyRec.reservedTokens = (apiKeyRec.reservedTokens || 0) + tokenReservation;
      apiKeyRec.reservedSpend = (apiKeyRec.reservedSpend || 0) + amountReservation;
    }
    writeDb(db);
  }

  const started = Date.now();
  const wantStream = payload.stream === true;
  let lastError = null;

  for (const provider of candidates) {
    try {
      const upstreamPayload = { ...payload, stream: wantStream };
      const proxyKey = await ensureProxyApiKey(db, user, provider, apiKeyRec);
      if (!proxyKey) {
        updateProviderHealth(db, provider.id, false, '缺少可用的上游同步密钥');
        recordSiteError(db, {
          source: 'chat',
          code: 'channel_no_key',
          message: `无法解析 ${provider.name} 的上游同步密钥`,
          detail: 'channel apiKey 为空且没有匹配的已同步 sk-',
          fix: tipsForCode('channel_no_key'),
          context: { providerId: provider.id, userId: user.id }
        });
        writeDb(db);
        lastError = new Error('missing_proxy_key');
        continue;
      }
      const upstream = await fetchUpstream(provider, upstreamPayload, outputBudget, model || provider.defaultModel, proxyKey);
      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => '');
        updateProviderHealth(db, provider.id, false, `HTTP ${upstream.status}: ${errText.slice(0, 120)}`);
      recordSiteError(db, { source: 'chat', code: 'channel_down', message: `上游对话失败 HTTP ${upstream.status}（${provider.name}）`, detail: errText.slice(0, 300), fix: tipsForCode('channel_down'), context: { providerId: provider.id, userId: user.id } });
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
          inputReserve,
          apiKeyRec,
          responsesApi: !!req._responsesApi,
          anthropicApi: !!req._anthropicApi
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
      settleUsage(db, user, provider, usage, providerMultiplier(provider, db), tokenReservation, amountReservation, started, result.model || model || provider.defaultModel, 'success', apiKeyRec);
      writeDb(db);
      if (req._responsesApi) return json(res, 200, chatCompletionToResponse(result));
      if (req._anthropicApi) return json(res, 200, chatCompletionToAnthropic(result));
      if (req._geminiApi) {
        const choice = result && result.choices && result.choices[0];
        const text = responsesContentToText(choice && choice.message ? choice.message.content : '');
        return json(res, 200, {
          candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
          usageMetadata: {
            promptTokenCount: Number(result && result.usage && result.usage.prompt_tokens) || 0,
            candidatesTokenCount: Number(result && result.usage && result.usage.completion_tokens) || 0,
            totalTokenCount: Number(result && result.usage && result.usage.total_tokens) || 0
          }
        });
      }
      return json(res, 200, result);
    } catch (err) {
      updateProviderHealth(db, provider.id, false, err?.message || 'fetch_failed');
      writeDb(db);
      lastError = err;
    }
  }

  releaseReserve(user, tokenReservation, amountReservation, apiKeyRec);
  writeDb(db);
  return fail(res, 502, '模型服务暂时不可用，请稍后重试');
}

async function streamChat(req, res, db, user, provider, upstream, ctx) {
  const {
    model, rate, tokenReservation, amountReservation, started, inputReserve,
    apiKeyRec = null, responsesApi = false, anthropicApi = false
  } = ctx;
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
  const responseId = id('resp');
  const itemId = id('msg');
  const seqRef = { n: 0 };
  let responsesStarted = false;
  let anthropicStarted = false;

  const cleanup = (reason = 'abort') => {
    if (settled) return;
    settled = true;
    aborted = true;
    releaseReserve(user, tokenReservation, amountReservation, apiKeyRec);
    db.logs.unshift({
      id: id('log'),
      userId: user.id,
      apiKeyId: apiKeyRec?.id || null,
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

  function ensureResponsesHeaders() {
    if (!responsesApi || responsesStarted) return;
    responsesStarted = true;
    writeResponsesSse(res, 'response.created', {
      response: {
        id: responseId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'in_progress',
        model,
        output: []
      }
    }, seqRef);
    writeResponsesSse(res, 'response.output_item.added', {
      output_index: 0,
      item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] }
    }, seqRef);
    writeResponsesSse(res, 'response.content_part.added', {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '' }
    }, seqRef);
  }

  function emitResponsesDelta(delta) {
    if (!delta) return;
    ensureResponsesHeaders();
    writeResponsesSse(res, 'response.output_text.delta', {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta
    }, seqRef);
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
        if (typeof delta === 'string') {
          completionText += delta;
          if (responsesApi) emitResponsesDelta(delta);
          if (anthropicApi) {
            if (!anthropicStarted) {
              anthropicStarted = true;
              writeAnthropicSse(res, 'message_start', {
                type: 'message_start',
                message: { id: responseId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
              });
              writeAnthropicSse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
            }
            writeAnthropicSse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } });
          }
        }
        const messageContent = parsed.choices?.[0]?.message?.content;
        if (typeof messageContent === 'string') {
          completionText += messageContent;
          if (responsesApi) emitResponsesDelta(messageContent);
        }
      } catch { /* ignore partial json */ }
    }
  }

  try {
    if (responsesApi) ensureResponsesHeaders();
    if (anthropicApi && !anthropicStarted) {
      anthropicStarted = true;
      writeAnthropicSse(res, 'message_start', {
        type: 'message_start',
        message: { id: responseId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
      });
      writeAnthropicSse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    }
    const reader = upstream.body?.getReader?.();
    if (!reader) {
      for await (const chunk of upstream.body) {
        if (aborted) break;
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        buffer += text;
        if (!responsesApi && !anthropicApi) res.write(text);
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
        if (!responsesApi && !anthropicApi) res.write(text);
        processSseBuffer();
      }
    }
  } catch {
    if (!settled) cleanup('stream_error');
    return;
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
          if (typeof delta === 'string') {
            completionText += delta;
            if (responsesApi) emitResponsesDelta(delta);
          }
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
  settleUsage(db, user, provider, usage, providerMultiplier(provider, db), tokenReservation, amountReservation, started, model, 'success', apiKeyRec);
  writeDb(db);

  if (anthropicApi) {
    writeAnthropicSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    const outTok = Number(usage.completion_tokens) || 0;
    const inTok = Number(usage.prompt_tokens) || 0;
    writeAnthropicSse(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: outTok }
    });
    writeAnthropicSse(res, 'message_stop', { type: 'message_stop' });
  }

  if (responsesApi) {
    writeResponsesSse(res, 'response.output_text.done', {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text: completionText
    }, seqRef);
    writeResponsesSse(res, 'response.content_part.done', {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: completionText }
    }, seqRef);
    writeResponsesSse(res, 'response.output_item.done', {
      output_index: 0,
      item: {
        id: itemId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: completionText }]
      }
    }, seqRef);
    const prompt = Number(usage.prompt_tokens) || 0;
    const completion = Number(usage.completion_tokens) || 0;
    const total = Number(usage.total_tokens) || (prompt + completion);
    writeResponsesSse(res, 'response.completed', {
      response: {
        id: responseId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'completed',
        model,
        output: [{
          id: itemId,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: completionText }]
        }],
        usage: {
          input_tokens: prompt,
          output_tokens: completion,
          total_tokens: total
        }
      }
    }, seqRef);
    try { res.write('data: [DONE]\n\n'); } catch { /* ignore */ }
  }

  try { res.end(); } catch { /* ignore */ }
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
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
    return json(res, 200, { contactEmail: CONTACT_EMAIL, contactWechat: CONTACT_WECHAT, contactQq: CONTACT_QQ, contactQqGroup: CONTACT_QQ_GROUP, paymentQr: PAYMENT_QR, paymentPlans: paymentPlans(db), paymentMethods: PAYMENT_METHODS, paymentGateway: publicGatewayView(getPaymentGateway(db)), publicBaseUrl: resolvePublicBaseUrl(db, req), recommendedModel: resolveRecommendedModel(db.settings),
      apiBaseUrl: `${resolvePublicBaseUrl(db, req)}/v1`, paymentQrMeta: (() => { const meta = paymentQrMeta(db); return { ...meta, wechat: paymentQrStatus(meta.wechatExpiresAt), alipay: paymentQrStatus(meta.alipayExpiresAt) }; })(), appName: 'Relay Station' });
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
      if (isReservedUsername(requestedUsername)) return fail(res, 400, '该用户名不可用');
      if (userLabelTaken(db, requestedUsername)) return fail(res, 409, '该用户名已被占用');
      username = requestedUsername.toLowerCase();
    } else {
      username = allocateUsername(db, p.name || email.split('@')[0] || 'user');
      if (isReservedUsername(username) || userLabelTaken(db, username)) username = allocateUsername(db, 'user');
    }
    let displayName = String(p.name || '').trim();
    if (!displayName) displayName = username;
    if (displayName.length > 32) return fail(res, 400, '名称最多 32 个字符');
    if (displayName.toLowerCase() !== username && userLabelTaken(db, displayName)) {
      return fail(res, 409, '该名称已被占用');
    }
    const invite = validateInviteCode(db.users, p?.inviteCode);
    if (!invite.ok) return fail(res, 400, invite.error, { code: invite.code });
    const inviter = invite.inviter;
    const user = {
      id: id('usr'),
      email,
      username,
      name: displayName,
      password: hash(p.password),
      apiKey: null,
      apiKeys: [],
      balance: 0,
      bonusBalance: 0,
      checkInBonus: 0,
      invitedBy: inviter ? inviter.id : null,
      quotaTokens: 0,
      usedTokens: 0,
      reservedTokens: 0,
      reservedBalance: 0,
      accountActive: false,
      banned: false,
      role: 'user',
      avatar: DEFAULT_AVATAR,
      invited: 0,
      inviteCode: crypto.randomBytes(4).toString('hex').toUpperCase(),
      createdAt: new Date().toISOString()
    };
    if (inviter) { inviter.invited = (inviter.invited || 0) + 1; }
    db.users.push(user);
    ensureUserKeys(user);
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
    if (isBanned(user)) return fail(res, 403, '账号已被封禁');
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

  if ((req.method === 'PATCH' || req.method === 'PUT') && url.pathname === '/api/me') {
    if (!user) return fail(res, 401, '未登录');
    const p = await body(req);
    if (!p || typeof p !== 'object') return fail(res, 400, '无效请求体');
    if (!('avatar' in p)) return fail(res, 400, '没有可更新的字段');
    const parsed = normalizeAvatar(p.avatar);
    if (!parsed.ok || !AVATAR_IDS.includes(String(p.avatar || ''))) return fail(res, 400, parsed.error || '无效的头像');
    user.avatar = parsed.avatar;
    writeDb(db);
    return json(res, 200, { user: safeUser(user) });
  }

  if (req.method === 'GET' && url.pathname === '/api/models') {
    if (!user) return fail(res, 401, '未登录');
    return json(res, 200, { models: catalogModels(db) });
  }

  if (req.method === 'GET' && url.pathname === '/api/key-options') {
    if (!user) return fail(res, 401, '未登录');
    return json(res, 200, keyOptionsPayload(db));
  }

  if (req.method === 'GET' && url.pathname === '/api/keys') {
    if (!user) return fail(res, 401, '未登录');
    ensureUserKeys(user);
    writeDb(db);
    return json(res, 200, { keys: user.apiKeys.map(publicApiKey) });
  }

  if (req.method === 'POST' && url.pathname === '/api/keys') {
    if (!user) return fail(res, 401, '未登录');
    ensureUserKeys(user);
    if (user.apiKeys.length >= MAX_USER_KEYS) return fail(res, 400, `每个账户最多 ${MAX_USER_KEYS} 把密钥`);
    const p = await body(req);
    if (!p || typeof p !== 'object') return fail(res, 400, '无效的请求');
    if (p.groupId) {
      const provider = (db.settings?.providers || []).find(x => x.id === String(p.groupId));
      if (provider && isMaintenanceProvider(provider)) {
        return fail(res, 503, provider.maintenanceMessage || '该模型组维护中，暂不可用', { code: 'maintenance', fix: tipsForCode('maintenance') });
      }
      const groupModels = resolveGroupModels(db, String(p.groupId));
      if (!groupModels) return fail(res, 400, '模型组不存在或已停用');
    }
    const created = normalizeApiKey({
      name: p.name,
      groupId: p.groupId || null,
      models: p.models,
      spendLimit: p.spendLimit,
      enabled: p.enabled !== false
    }, null, db);
    if (providerNeedsVip1129Sync(db, created.groupId)) {
      const synced = await syncCreateVip1129Key(db, user, created);
      if (!synced.ok) {
        const fix = tipsForCode(synced.error || 'create_failed');
        recordSiteError(db, { source: 'key_sync', code: synced.error || 'create_failed', message: `vip1129 同步建钥失败: ${synced.error}`, detail: JSON.stringify(synced.detail || {}).slice(0, 500), fix, context: { groupId: created.groupId, userId: user.id } });
        writeDb(db);
        return fail(res, 502, `上游同步建钥失败: ${synced.error}`, { code: synced.error || 'create_failed', fix });
      }
    } else if (providerNeedsBeibeihaiSync(db, created.groupId)) {
      const synced = await syncCreateBeibeihaiKey(db, user, created);
      if (!synced.ok) {
        const fix = tipsForCode(synced.error || 'create_failed');
        recordSiteError(db, { source: 'key_sync', code: synced.error || 'create_failed', message: `Beibeihai 同步建钥失败: ${synced.error}`, detail: JSON.stringify(synced.detail || {}).slice(0, 500), fix, context: { groupId: created.groupId, userId: user.id } });
        writeDb(db);
        return fail(res, 502, `上游同步建钥失败: ${synced.error}`, { code: synced.error || 'create_failed', fix });
      }
    }
    user.apiKeys.push(created);
    if (!user.apiKey) user.apiKey = created.key;
    writeDb(db);
    return json(res, 201, { key: publicApiKey(created) });
  }

  if ((req.method === 'PUT' || req.method === 'DELETE' || req.method === 'POST') && url.pathname.startsWith('/api/keys/')) {
    if (!user) return fail(res, 401, '未登录');
    ensureUserKeys(user);
    const rest = decodeURIComponent(url.pathname.slice('/api/keys/'.length));
    const [keyId, action] = rest.split('/');
    const rec = user.apiKeys.find(k => k.id === keyId);
    if (!rec) return fail(res, 404, '密钥不存在');
    if (req.method === 'DELETE') {
      await syncDeleteVip1129Key(db, rec);
      await syncDeleteBeibeihaiKey(db, rec);
      user.apiKeys = user.apiKeys.filter(k => k.id !== keyId);
      user.apiKey = user.apiKeys[0]?.key || null;
      writeDb(db);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && action === 'rotate') {
      const wasPrimary = user.apiKey === rec.key;
      rec.key = userKey();
      if (wasPrimary) user.apiKey = rec.key;
      writeDb(db);
      return json(res, 200, { key: publicApiKey(rec) });
    }
    if (req.method === 'PUT') {
      const p = await body(req);
      if (!p || typeof p !== 'object') return fail(res, 400, '无效请求体');
      if ('groupId' in p && p.groupId) {
        const groupModels = resolveGroupModels(db, String(p.groupId));
        if (!groupModels) return fail(res, 400, '模型组不存在或已停用');
      }
      const next = normalizeApiKey({
        ...rec,
        name: p.name ?? rec.name,
        groupId: 'groupId' in p ? (p.groupId || null) : rec.groupId,
        models: Array.isArray(p.models) ? p.models : rec.models,
        spendLimit: p.spendLimit ?? rec.spendLimit,
        enabled: 'enabled' in p ? p.enabled !== false : rec.enabled
      }, rec, db);
      Object.assign(rec, next);
      writeDb(db);
      return json(res, 200, { key: publicApiKey(rec) });
    }
    return fail(res, 404, 'Not found');
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    if (!user) return fail(res, 401, '未登录');
    const logs = db.logs.filter(x => x.userId === user.id && x.status !== 'referral_rebate' && x.status !== CHECKIN_LOG_STATUS);
    const totalTokens = logs.reduce((sum, x) => sum + Number(x.tokens || 0), 0);
    // 累计花销 = 该用户 API 日志 chargedAmount 合计（已是上游成本×对应上游全局倍率后的实扣）
    const totalSpent = logs.reduce((sum, x) => {
      const c = Number(x.chargedAmount || 0);
      return sum + (Number.isFinite(c) && c > 0 ? c : 0);
    }, 0);
    const avgLatency = logs.length ? Math.round(logs.reduce((sum, x) => sum + x.latency, 0) / logs.length) : 0;
    const displayLogs = logs.slice(0, 30).map(x => ({
      id: x.id,
      model: x.model,
      tokens: Number(x.tokens || 0),
      latency: x.latency,
      status: x.status,
      createdAt: x.createdAt
    }));
    return json(res, 200, {
      user: safeUser(user),
      stats: {
        requests: logs.length,
        tokens: totalTokens,
        avgLatency,
        success: logs.filter(x => x.status === 'success').length,
        quotaTokens: user.quotaTokens || 0,
        usedTokens: totalTokens,
        availableTokens: availableTokens(user),
        totalSpent: Math.round(totalSpent * 10000) / 10000
      },
      logs: displayLogs,
      inviteCode: user.inviteCode,
      inviteCount: user.invited
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/checkin') {
    if (!user) return fail(res, 401, '未登录');
    if (isBanned(user)) return fail(res, 403, '账号已被封禁');
    if (!rateLimit(req, res, 30, 'checkin')) return;
    db.checkIns ??= [];
    const result = claimCheckIn(db, user);
    if (!result.ok) {
      return json(res, result.status || 409, {
        error: result.error,
        alreadyCheckedIn: result.alreadyCheckedIn === true,
        date: result.date,
        amount: result.amount,
        balance: result.balance
      });
    }
    audit(db, { actorId: user.id, action: 'checkin.claim', target: user.id, detail: { date: result.date, amount: result.amount } });
    writeDb(db);
    return json(res, 200, {
      amount: result.amount,
      balance: result.balance,
      alreadyCheckedIn: false,
      date: result.date
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/checkin/status') {
    if (!user) return fail(res, 401, '未登录');
    db.checkIns ??= [];
    const status = checkInStatus(db, user);
    return json(res, 200, {
      checkedInToday: status.checkedInToday,
      todayAmount: status.todayAmount,
      streak: status.streak,
      date: status.date,
      timezone: status.timezone,
      checkInBonus: status.checkInBonus,
      recent: status.recent
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/checkin') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    db.checkIns ??= [];
    return json(res, 200, checkInAdminStats(db));
  }


  if (req.method === 'POST' && url.pathname === '/api/recharge/prepare') {
    if (!user) return fail(res, 401, '未登录');
    if (isBanned(user)) return fail(res, 403, '账号已被封禁');
    if (!rateLimit(req, res, 30, 'pay-prepare')) return;
    const p = await body(req);
    const amount = Number(p?.amount);
    if (!PAYMENT_AMOUNTS.includes(amount)) return fail(res, 400, '金额无效');
    const method = String(p?.method || 'wechat').toLowerCase();
    if (!['wechat', 'alipay'].includes(method)) return fail(res, 400, '付款方式无效');
    db.paymentOrders ??= [];
    const payNote = String(user.username || user.name || '').trim() || makePayNote(db);
    const order = {
      id: id('pay'),
      userId: user.id,
      username: user.username || '',
      email: user.email || '',
      amount,
      method,
      payNote,
      status: 'awaiting_payment',
      code: null,
      createdAt: new Date().toISOString(),
      userReportedAt: null,
      confirmedAt: null,
      confirmedBy: null,
      rejectedAt: null,
      rejectReason: null
    };
    const gw = getPaymentGateway(db);
    const useGateway = gatewayReady(gw);
    if (useGateway) {
      order.payMode = 'gateway';
      order.gateway = gw.type;
      order.payNote = null;
      order.payUrl = buildEpaySubmitUrl(gw, order);
    } else {
      order.payMode = 'manual_qr';
    }
    db.paymentOrders.unshift(order);
    audit(db, { actorId: user.id, action: 'payment.order.prepare', target: order.id, detail: { amount, method, payNote: order.payNote, payMode: order.payMode } });
    writeDb(db);
    emitPayment(order, 'placed');
    if (useGateway) {
      return json(res, 200, {
        orderId: order.id,
        status: order.status,
        amount,
        method,
        payMode: 'gateway',
        payUrl: order.payUrl,
        message: `请完成在线支付 ¥${amount}，支付成功后自动发卡`
      });
    }
    return json(res, 200, {
      orderId: order.id,
      status: order.status,
      amount,
      method,
      payMode: 'manual_qr',
      payNote,
      message: `请扫码支付 ¥${amount}，付款备注请填写你的用户名`
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/recharge/claim') {
    if (!user) return fail(res, 401, '未登录');
    if (isBanned(user)) return fail(res, 403, '账号已被封禁');
    if (!rateLimit(req, res, 30, 'claim')) return;
    const p = await body(req);
    db.paymentOrders ??= [];
    const orderId = String(p?.orderId || '').trim();
    let order = orderId ? db.paymentOrders.find(o => o.id === orderId && o.userId === user.id) : null;
    if (!order) {
      // fallback: latest awaiting_payment for amount+method
      const amount = Number(p?.amount);
      const method = String(p?.method || 'wechat').toLowerCase();
      order = db.paymentOrders.find(o => o.userId === user.id && o.status === 'awaiting_payment' && Number(o.amount) === amount && o.method === method);
    }
    if (!order) return fail(res, 400, '请先确认购买生成付款备注，再提交付款确认');
    if (order.status === 'confirmed') return fail(res, 400, '该订单已确认并发放过卡密');
    if (order.status === 'rejected') return fail(res, 400, '该订单已被拒绝，请重新确认购买');
    if (order.status === 'pending') {
      return json(res, 200, {
        orderId: order.id,
        status: order.status,
        amount: order.amount,
        method: order.method,
        payNote: order.payNote,
        message: '已通知管理员，请等待按备注核对到账'
      });
    }
    if (order.status !== 'awaiting_payment') return fail(res, 400, '订单状态不可提交');
    order.status = 'pending';
    order.userReportedAt = new Date().toISOString();
    audit(db, { actorId: user.id, action: 'payment.order.claim', target: order.id, detail: { amount: order.amount, method: order.method, payNote: order.payNote } });
    writeDb(db);
    emitPayment(order, 'paid');
    return json(res, 200, {
      orderId: order.id,
      status: order.status,
      amount: order.amount,
      method: order.method,
      payNote: order.payNote,
      message: `已提交付款确认通知（备注 ${order.payNote}），请等待管理员核对`
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/recharge/orders') {
    if (!user) return fail(res, 401, '未登录');
    if (isBanned(user)) return fail(res, 403, '账号已被封禁');
    db.paymentOrders ??= [];
    const orders = db.paymentOrders
      .filter(o => o.userId === user.id)
      .slice(0, 50)
      .map(o => ({
        id: o.id,
        amount: o.amount,
        method: o.method,
        payNote: o.payNote || null,
        status: o.status,
        code: o.status === 'confirmed' ? o.code : null,
        createdAt: o.createdAt,
        userReportedAt: o.userReportedAt || null,
        confirmedAt: o.confirmedAt || null,
        rejectedAt: o.rejectedAt || null,
        rejectReason: o.rejectReason || null
      }));
    return json(res, 200, { orders });
  }

  if (req.method === 'GET' && url.pathname === '/api/recharge/wait') {
    if (!user) return fail(res, 401, '未登录');
    if (isBanned(user)) return fail(res, 403, '账号已被封禁');
    const rawAfter = url.searchParams.get('after');
    const after = rawAfter == null || rawAfter === '' ? -1 : Number(rawAfter);
    const timeoutMs = Number(url.searchParams.get('timeoutMs') || 25000);
    const evs = await waitForEvents(after, { userId: user.id, timeoutMs });
    return json(res, 200, {
      seq: currentSeq(),
      events: evs.map(e => publicPaymentEvent(e, { includeCode: true }))
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/payment-orders') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    db.paymentOrders ??= [];
    const status = String(url.searchParams.get('status') || '').trim();
    let list = db.paymentOrders.slice();
    if (status) list = list.filter(o => o.status === status);
    return json(res, 200, {
      orders: list.slice(0, 200).map(o => ({
        id: o.id,
        userId: o.userId,
        username: o.username,
        email: o.email,
        amount: o.amount,
        method: o.method,
        payNote: o.payNote || null,
        status: o.status,
        code: o.code,
        createdAt: o.createdAt,
        userReportedAt: o.userReportedAt,
        confirmedAt: o.confirmedAt,
        confirmedBy: o.confirmedBy,
        rejectedAt: o.rejectedAt,
        rejectReason: o.rejectReason
      })),
      pendingCount: db.paymentOrders.filter(o => o.status === 'pending').length
    });
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/admin/payment-orders/') && url.pathname.endsWith('/confirm')) {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const orderId = decodeURIComponent(url.pathname.slice('/api/admin/payment-orders/'.length, -'/confirm'.length));
    const p = await body(req);
    db.paymentOrders ??= [];
    const order = db.paymentOrders.find(o => o.id === orderId);
    if (!order) return fail(res, 404, '订单不存在');
    if (order.status !== 'pending' && order.status !== 'awaiting_payment') return fail(res, 400, '订单已处理');
    // 人工确认：按用户名备注在账单核对，不再强制回填随机备注码

    const day = localDay();
    const issuedToday = (db.rechargeCodes || []).filter(c => c.issuedTo === order.userId && c.issuedAt && localDay(new Date(c.issuedAt)) === day).length;
    if (issuedToday >= CLAIM_DAILY_LIMIT) return fail(res, 429, `该用户今日发卡已达上限（${CLAIM_DAILY_LIMIT}）`);
    let card = (db.rechargeCodes || []).find(c => Number(c.amount) === Number(order.amount) && codeAvailable(c));
    if (!card) {
      const added = topUpCodePools(db, CODE_POOL_TARGET);
      if (added) writeDb(db);
      card = (db.rechargeCodes || []).find(c => Number(c.amount) === Number(order.amount) && codeAvailable(c));
    }
    if (!card) return fail(res, 503, '该金额卡密暂时售罄，请稍后重试');
    card.issuedAt = new Date().toISOString();
    card.issuedTo = order.userId;
    order.status = 'confirmed';
    order.code = card.code;
    order.confirmedAt = new Date().toISOString();
    order.confirmedBy = user.id;
    if (!order.userReportedAt) order.userReportedAt = order.confirmedAt;
    audit(db, { actorId: user.id, action: 'payment.order.confirm', target: order.id, detail: { amount: order.amount, method: order.method, code: card.code, userId: order.userId, payNote: order.payNote } });
    writeDb(db);
    emitPayment(order, 'confirmed');
    return json(res, 200, { order, message: '已确认到账并发放卡密' });
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/admin/payment-orders/') && url.pathname.endsWith('/reject')) {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const orderId = decodeURIComponent(url.pathname.slice('/api/admin/payment-orders/'.length, -'/reject'.length));
    const p = await body(req);
    db.paymentOrders ??= [];
    const order = db.paymentOrders.find(o => o.id === orderId);
    if (!order) return fail(res, 404, '订单不存在');
    if (!['pending', 'awaiting_payment'].includes(order.status)) return fail(res, 400, '订单已处理');
    order.status = 'rejected';
    order.rejectedAt = new Date().toISOString();
    order.rejectReason = String(p?.reason || '未确认到账').slice(0, 200);
    order.confirmedBy = user.id;
    audit(db, { actorId: user.id, action: 'payment.order.reject', target: order.id, detail: { reason: order.rejectReason, payNote: order.payNote } });
    writeDb(db);
    emitPayment(order, 'rejected');
    return json(res, 200, { order, message: '已拒绝该付款确认' });
  }



  
  
  
  if (req.method === 'GET' && url.pathname === '/api/admin/site-errors') {
    if (!user || !isAdmin(user)) return fail(res, 403, '需要管理员');
    const list = ensureSiteErrors(db);
    return json(res, 200, { errors: list.slice(0, 100), total: list.length, cap: SITE_ERROR_CAP });
  }

  if (req.method === 'DELETE' && url.pathname === '/api/admin/site-errors') {
    if (!user || !isAdmin(user)) return fail(res, 403, '需要管理员');
    clearSiteErrors(db);
    writeDb(db);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/diagnostics/run') {
    if (!user || !isAdmin(user)) return fail(res, 403, '需要管理员');
    const report = await runDiagnosticSuite({
      db,
      ensureVip1129Token,
      getVip1129Config,
      ensureBeibeihaiToken,
      getBeibeihaiConfig,
      isVip1129Provider,
      isBeibeihaiProvider,
      isMaintenanceProvider,
      probeProviderHealth,
      probeProviderChat,
      providerMultiplier,
      resolveDisplayMultiplier,
      poolStats,
      codeAvailable,
      findCodeRecord,
      redeemAccess,
      PAYMENT_AMOUNTS,
      REFERRAL_REBATE_RATE,
      gatewayReady,
      getPaymentGateway,
      paymentQrMeta,
      paymentQrStatus,
      resolvePublicBaseUrl,
      fs,
      dbFile,
      tipsForCode
    });
    // persist failed items into site errors for the 网站错误栏
    for (const r of report.results.filter(x => !x.ok)) {
      recordSiteError(db, {
        source: 'diagnostics',
        code: r.id,
        message: `${r.name}: ${r.message}`,
        detail: r.detail,
        fix: r.fix,
        level: 'error'
      });
    }
    db.settings ??= {};
    db.settings.lastDiagnostics = { at: report.at, summary: report.summary, results: report.results };
    writeDb(db);
    return json(res, 200, report);
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/diagnostics/last') {
    if (!user || !isAdmin(user)) return fail(res, 403, '需要管理员');
    return json(res, 200, { last: db.settings?.lastDiagnostics || null });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/mobile/inbox/wait') {
    if (!user || !isAdmin(user)) return fail(res, 403, '需要管理员');
    const rawAfter = url.searchParams.get('after');
    const after = rawAfter == null || rawAfter === '' ? -1 : Number(rawAfter);
    const timeoutMs = Number(url.searchParams.get('timeoutMs') || 25000);
    const evs = await waitForEvents(after, { timeoutMs });
    const dbNow = readDb();
    return json(res, 200, {
      seq: currentSeq(),
      events: evs.map(e => publicPaymentEvent(e, { includeCode: false })),
      inbox: mobileInboxPayload(dbNow, user)
    });
  }

  if (req.method === 'GET' && (url.pathname === '/api/admin/mobile/inbox' || url.pathname === '/api/admin/inbox')) {
    if (!user || !isAdmin(user)) return fail(res, 403, '需要管理员');
    return json(res, 200, mobileInboxPayload(db, user));
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/upstream-accounts') {
    if (!user || !isAdmin(user)) return fail(res, 403, '需要管理员');
    const [vip1129, beibeihai] = await Promise.all([
      snapshotUpstreamAccount('vip1129', db),
      snapshotUpstreamAccount('beibeihai', db)
    ]);
    writeDb(db);
    return json(res, 200, { vip1129, beibeihai });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/upstream-beibeihai') {
    if (!user || !isAdmin(user)) return fail(res, 403, '需要管理员');
    const cfg = getBeibeihaiConfig(db);
    let groups = [];
    if (cfg.email && (cfg.password || cfg.accessToken)) {
      const auth = await ensureBeibeihaiToken(db);
      if (auth.ok) {
        const listed = await beibeihaiListGroups(auth.cfg.baseUrl, auth.token);
        if (listed.ok) groups = normalizeAvailableGroups(listed.data);
        await autofillBeibeihaiGroupMap(db, auth.token);
        writeDb(db);
      }
    }
    const localGroups = (db.settings?.providers || []).filter(p => isBeibeihaiProvider(p) && !isMaintenanceProvider(p)).map(p => ({ id: p.id, name: p.name, url: p.url }));
    return json(res, 200, { upstream: publicBeibeihaiView(getBeibeihaiConfig(db)), groups, localGroups });
  }

  if (req.method === 'PUT' && url.pathname === '/api/admin/upstream-beibeihai') {
    if (!user || !isAdmin(user)) return fail(res, 403, '需要管理员');
    const p = await body(req);
    const cur = getBeibeihaiConfig(db);
    if ('enabled' in (p || {})) cur.enabled = p.enabled !== false;
    if (p?.baseUrl != null) cur.baseUrl = beibeihaiNormalizeBase(p.baseUrl);
    if (p?.email != null) cur.email = String(p.email || '').trim();
    if (p?.password != null && String(p.password) !== '') cur.password = String(p.password);
    if (p?.groupMap && typeof p.groupMap === 'object') {
      const nextMap = { ...cur.groupMap };
      for (const [k, v] of Object.entries(p.groupMap)) {
        if (v === null || v === '') delete nextMap[k];
        else nextMap[k] = Number(v);
      }
      cur.groupMap = nextMap;
    }
    if (p?.clearToken) {
      cur.accessToken = '';
      cur.tokenExpiresAt = 0;
    }
    saveBeibeihaiConfig(db, cur);
    writeDb(db);
    let probe = null;
    if (cur.enabled && cur.email && cur.password) {
      const auth = await ensureBeibeihaiToken(db);
      probe = { ok: auth.ok, error: auth.ok ? null : auth.error };
      if (auth.ok) await autofillBeibeihaiGroupMap(db, auth.token);
      writeDb(db);
    }
    return json(res, 200, { upstream: publicBeibeihaiView(getBeibeihaiConfig(db)), probe });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/upstream-vip1129') {
    if (!user || !isAdmin(user)) return fail(res, 403, '需要管理员');
    const cfg = getVip1129Config(db);
    let groups = [];
    if (cfg.email && (cfg.password || cfg.accessToken)) {
      const auth = await ensureVip1129Token(db);
      if (auth.ok) {
        const listed = await vip1129ListGroups(auth.cfg.baseUrl, auth.token);
        if (listed.ok) groups = normalizeAvailableGroups(listed.data);
        await autofillVip1129GroupMap(db, auth.token);
        writeDb(db);
      }
    }
    const localGroups = (db.settings?.providers || []).filter(p => isVip1129Provider(p) && !isMaintenanceProvider(p)).map(p => ({ id: p.id, name: p.name, url: p.url }));
    return json(res, 200, { upstream: publicVip1129View(getVip1129Config(db)), groups, localGroups });
  }

  if (req.method === 'PUT' && url.pathname === '/api/admin/upstream-vip1129') {
    if (!user || !isAdmin(user)) return fail(res, 403, '需要管理员');
    const p = await body(req);
    const cur = getVip1129Config(db);
    if ('enabled' in (p || {})) cur.enabled = p.enabled !== false;
    if (p?.baseUrl != null) cur.baseUrl = vip1129NormalizeBase(p.baseUrl);
    if (p?.email != null) cur.email = String(p.email || '').trim();
    if (p?.password != null && String(p.password) !== '') cur.password = String(p.password);
    if (p?.groupMap && typeof p.groupMap === 'object') {
      const nextMap = { ...cur.groupMap };
      for (const [k, v] of Object.entries(p.groupMap)) {
        if (v === null || v === '') delete nextMap[k];
        else nextMap[k] = Number(v);
      }
      cur.groupMap = nextMap;
    }
    if (p?.clearToken) {
      cur.accessToken = '';
      cur.tokenExpiresAt = 0;
    }
    saveVip1129Config(db, cur);
    writeDb(db);
    // probe login
    let probe = null;
    if (cur.enabled && cur.email && cur.password) {
      const auth = await ensureVip1129Token(db);
      probe = { ok: auth.ok, error: auth.ok ? null : auth.error };
      if (auth.ok) await autofillVip1129GroupMap(db, auth.token);
      writeDb(db);
    }
    return json(res, 200, { upstream: publicVip1129View(getVip1129Config(db)), probe });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/site-settings') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    return json(res, 200, {
      publicBaseUrl: db.settings.publicBaseUrl || PUBLIC_BASE_URL || '',
      resolvedBaseUrl: resolvePublicBaseUrl(db, req),
      apiBaseUrl: `${resolvePublicBaseUrl(db, req)}/v1`,
      recommendedModel: resolveRecommendedModel(db.settings)
    });
  }

  if (req.method === 'PUT' && url.pathname === '/api/admin/site-settings') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const p = await body(req);
    if (p?.publicBaseUrl != null) {
      db.settings.publicBaseUrl = String(p.publicBaseUrl || '').trim().replace(/\/$/, '');
    }
    if (p?.recommendedModel != null) {
      const parsed = normalizeRecommendedModel(p.recommendedModel);
      if (!parsed.ok) return fail(res, 400, parsed.error);
      db.settings.recommendedModel = parsed.model;
    }
    const next = String(db.settings.publicBaseUrl || '').trim().replace(/\/$/, '');
    audit(db, {
      actorId: user.id,
      action: 'siteSettings.save',
      target: 'siteSettings',
      detail: { publicBaseUrl: next, recommendedModel: resolveRecommendedModel(db.settings) }
    });
    writeDb(db);
    const resolved = resolvePublicBaseUrl(db, req);
    return json(res, 200, {
      publicBaseUrl: next,
      resolvedBaseUrl: resolved,
      apiBaseUrl: `${resolved}/v1`,
      recommendedModel: resolveRecommendedModel(db.settings),
      message: next ? '已保存站点设置' : '已保存（站点网址留空则自动使用当前访问域名）'
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/payment-gateway') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const gw = getPaymentGateway(db);
    return json(res, 200, {
      gateway: {
        ...gw,
        key: gw.key ? '********' : '',
        keySet: !!gw.key,
        ready: gatewayReady(gw)
      }
    });
  }

  if (req.method === 'PUT' && url.pathname === '/api/admin/payment-gateway') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const p = await body(req);
    const cur = getPaymentGateway(db);
    const next = normalizeGateway({
      enabled: p?.enabled ?? cur.enabled,
      type: p?.type || cur.type || 'epay',
      name: p?.name || cur.name || '易支付',
      apiUrl: p?.apiUrl != null ? p.apiUrl : cur.apiUrl,
      pid: p?.pid != null ? p.pid : cur.pid,
      key: (p?.key && p.key !== '********') ? p.key : cur.key,
      siteUrl: p?.siteUrl != null ? p.siteUrl : cur.siteUrl
    });
    db.settings.paymentGateway = next;
    audit(db, { actorId: user.id, action: 'paymentGateway.save', target: 'paymentGateway', detail: { enabled: next.enabled, apiUrl: next.apiUrl, pid: next.pid, siteUrl: next.siteUrl, keySet: !!next.key } });
    writeDb(db);
    return json(res, 200, {
      gateway: { ...next, key: next.key ? '********' : '', keySet: !!next.key, ready: gatewayReady(next) },
      message: gatewayReady(next) ? '聚合支付已就绪' : '已保存（尚未启用或配置不完整）'
    });
  }

  // 易支付异步通知（无需登录）
  if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/pay/epay/notify') {
    const db2 = readDb();
    const gw = getPaymentGateway(db2);
    if (!gatewayReady(gw)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('fail');
      return;
    }
    let params = Object.fromEntries(url.searchParams.entries());
    if (req.method === 'POST') {
      const p = await body(req);
      if (p && typeof p === 'object') params = { ...params, ...p };
    }
    if (!epayVerify(params, gw.key)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('fail');
      return;
    }
    const status = String(params.trade_status || '');
    if (status && status !== 'TRADE_SUCCESS' && status !== 'TRADE_FINISHED') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('success');
      return;
    }
    const outTradeNo = String(params.out_trade_no || '');
    const money = Number(params.money || params.total_amount || 0);
    db2.paymentOrders ??= [];
    const order = db2.paymentOrders.find(o => o.id === outTradeNo);
    if (!order) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('success');
      return;
    }
    if (Math.abs(Number(order.amount) - money) > 0.01 && money > 0) {
      audit(db2, { actorId: 'gateway', action: 'payment.notify.amount_mismatch', target: order.id, detail: { expect: order.amount, got: money } });
      writeDb(db2);
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('fail');
      return;
    }
    const result = fulfillPaymentOrder(db2, order, {
      tradeNo: params.trade_no || params.transaction_id || '',
      payChannel: params.type || order.method,
      via: 'epay_notify',
      confirmedBy: 'epay'
    });
    writeDb(db2);
    if (result.ok && !result.already) emitPayment(order, 'confirmed');
    res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(result.ok ? 'success' : 'fail');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/pay/epay/return') {
    const outTradeNo = String(url.searchParams.get('out_trade_no') || '');
    const html = `<!doctype html><meta charset="utf-8"><title>支付结果</title>
      <body style="font-family:sans-serif;background:#0d1016;color:#f2f4f7;display:grid;place-items:center;min-height:100vh">
      <div style="max-width:420px;padding:24px;border:1px solid #2a303d;border-radius:12px;background:#151922">
        <h2 style="margin:0 0 8px">支付已提交</h2>
        <p style="color:#8b95a7;font-size:13px;line-height:1.6">若付款成功，卡密将自动发放。请返回网站打开「卡密充值 → 我的付款订单」查看或复制卡密。</p>
        <p style="color:#626d80;font-size:11px">订单号：${outTradeNo || '-'}</p>
        <p><a href="/" style="color:#c6f36a">返回首页</a></p>
      </div></body>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/code-pool') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    return json(res, 200, poolStats(db));
  }

  if (req.method === 'POST' && url.pathname === '/api/recharge/redeem') {
    if (!user) return fail(res, 401, '未登录');
    if (isBanned(user)) return fail(res, 403, '账号已被封禁');
    if (!rateLimit(req, res, REDEEM_RATE_LIMIT, 'redeem', user.id)) return;
    const p = await body(req);
    const rec = findCodeRecord(db, p?.code);
    const access = redeemAccess(rec, user.id);
    if (!access.ok) return fail(res, 400, REDEEM_FAIL);
    if (rec.usedAt) return fail(res, 400, REDEEM_FAIL);
    rec.usedAt = new Date().toISOString();
    rec.userId = user.id;
    rec.issuedTo = rec.issuedTo || user.id;
    rec.issuedAt = rec.issuedAt || rec.usedAt;
    const quotaTokens = Number(rec.quotaTokens || 100000);
    const payAmount = Number(rec.amount || 0);
    user.balance = money2((user.balance || 0) + payAmount);
    user.quotaTokens = (user.quotaTokens || 0) + quotaTokens;
    if (!user.banned) user.accountActive = true;
    // Referral: only when invited user pays — inviter gets 5%
    let rebate = 0;
    if (user.invitedBy && payAmount > 0) {
      const inviter = db.users.find(x => x.id === user.invitedBy);
      if (inviter) {
        rebate = Math.round(payAmount * REFERRAL_REBATE_RATE * 100) / 100;
        inviter.bonusBalance = (inviter.bonusBalance || 0) + rebate;
        inviter.balance = (inviter.balance || 0) + rebate;
        db.logs = db.logs || [];
        db.logs.unshift({
          id: id('log'),
          userId: inviter.id,
          model: 'referral',
          tokens: 0,
          billedTokens: 0,
          upstreamCost: 0,
          chargedAmount: -rebate,
          multiplier: 1,
          latency: 0,
          status: 'referral_rebate',
          detail: { fromUserId: user.id, payAmount, rebate, rate: REFERRAL_REBATE_RATE },
          createdAt: new Date().toISOString()
        });
        db.logs = db.logs.slice(0, 3000);
      }
    }
    writeDb(db);
    return json(res, 200, { user: safeUser(user), message: `充值成功，到账 ¥${rec.amount}` });
  }

  // --- Admin APIs ---

  if (req.method === 'POST' && url.pathname === '/api/admin/payment-qrs/upload') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const p = await body(req);
    const method = String(p?.method || '').toLowerCase();
    if (!['wechat', 'alipay'].includes(method)) return fail(res, 400, '付款方式无效');
    const decoded = decodePaymentQrImage(p?.image);
    if (!decoded.ok) return fail(res, 400, decoded.error);
    if (p?.applyAll === true || String(p?.amount || '') === 'all') {
      return fail(res, 400, '每个金额的收款码不同，请按面额分别上传');
    }
    const amount = Number(p?.amount);
    if (!PAYMENT_AMOUNTS.includes(amount)) return fail(res, 400, '金额无效');
    const publicPath = savePaymentQrFile(method, String(amount), decoded.buf, decoded.ext);
    const next = ensurePaymentQrs(db);
    next[method][String(amount)] = publicPath;
    db.settings.paymentQrs = next;
    if (p?.expiresAt !== undefined) {
      const cur = paymentQrMeta(db);
      const field = method === 'wechat' ? 'wechatExpiresAt' : 'alipayExpiresAt';
      db.settings.paymentQrMeta = {
        ...cur,
        [field]: p.expiresAt === '' || p.expiresAt == null ? null : String(p.expiresAt)
      };
    }
    audit(db, {
      actorId: user.id,
      action: 'paymentQrs.upload',
      target: `${method}:${amount}`,
      detail: { path: publicPath, amount }
    });
    writeDb(db);
    const meta = paymentQrMeta(db);
    return json(res, 200, {
      url: publicPath,
      method,
      amounts: [amount],
      paymentQrs: next,
      plans: paymentPlans(db),
      paymentQrMeta: {
        ...meta,
        wechat: paymentQrStatus(meta.wechatExpiresAt),
        alipay: paymentQrStatus(meta.alipayExpiresAt)
      },
      message: `已替换 ${method === 'wechat' ? '微信' : '支付宝'} ¥${amount} 收款码`
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/payment-qrs') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const paymentQrs = ensurePaymentQrs(db);
    const meta = paymentQrMeta(db);
    return json(res, 200, {
      plans: paymentPlans(db),
      paymentQrs,
      methods: PAYMENT_METHODS,
      paymentQrMeta: {
        ...meta,
        wechat: paymentQrStatus(meta.wechatExpiresAt),
        alipay: paymentQrStatus(meta.alipayExpiresAt)
      }
    });
  }

  if (req.method === 'PUT' && url.pathname === '/api/admin/payment-qrs') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const p = await body(req);
    const next = ensurePaymentQrs(db);
    const incoming = p?.paymentQrs || {};
    for (const method of ['wechat', 'alipay']) {
      const src = incoming[method];
      if (!src || typeof src !== 'object') continue;
      for (const amount of PAYMENT_AMOUNTS) {
        const key = String(amount);
        if (Object.prototype.hasOwnProperty.call(src, key)) {
          next[method][key] = String(src[key] || '').trim();
        }
      }
    }
    // legacy flat body still updates wechat
    for (const amount of PAYMENT_AMOUNTS) {
      const key = String(amount);
      if (Object.prototype.hasOwnProperty.call(incoming, key) && typeof incoming[key] !== 'object') {
        next.wechat[key] = String(incoming[key] || '').trim();
      }
    }
    db.settings.paymentQrs = next;
    if (p?.paymentQrMeta && typeof p.paymentQrMeta === 'object') {
      const cur = paymentQrMeta(db);
      const incoming = p.paymentQrMeta;
      db.settings.paymentQrMeta = {
        wechatExpiresAt: incoming.wechatExpiresAt === '' || incoming.wechatExpiresAt == null
          ? null
          : String(incoming.wechatExpiresAt),
        alipayExpiresAt: incoming.alipayExpiresAt === '' || incoming.alipayExpiresAt == null
          ? null
          : String(incoming.alipayExpiresAt),
        note: incoming.note != null ? String(incoming.note) : cur.note
      };
    }
    const meta = paymentQrMeta(db);
    audit(db, { actorId: user.id, action: 'paymentQrs.save', target: 'paymentQrs', detail: { methods: Object.keys(next), meta } });
    writeDb(db);
    return json(res, 200, {
      plans: paymentPlans(db),
      paymentQrs: next,
      methods: PAYMENT_METHODS,
      paymentQrMeta: {
        ...meta,
        wechat: paymentQrStatus(meta.wechatExpiresAt),
        alipay: paymentQrStatus(meta.alipayExpiresAt)
      }
    });
  }

  if (req.method === 'GET' && (url.pathname === '/api/admin/pricing' || url.pathname === '/api/admin/providers')) {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    return json(res, 200, {
      multiplier: multiplier(db),
      multiplierVip1129: multiplierVip1129(db),
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
    const out = {};
    const hasBeibei = p?.multiplier != null || p?.billingMultiplier != null;
    const hasVip = p?.multiplierVip1129 != null || p?.billingMultiplierVip1129 != null;
    if (!hasBeibei && !hasVip) return fail(res, 400, '请提供 multiplier 和/或 multiplierVip1129');
    if (hasBeibei) {
      const parsed = normalizeBillingMultiplier(p?.multiplier ?? p?.billingMultiplier);
      if (!parsed.ok) return fail(res, 400, parsed.error);
      const value = parsed.value;
      const prev = db.settings.billingMultiplier;
      db.settings.billingMultiplier = value;
      audit(db, { actorId: user.id, action: 'pricing.change', target: 'billingMultiplier', detail: { from: prev, to: value } });
      out.multiplier = value;
    }
    if (hasVip) {
      const parsedVip = normalizeBillingMultiplier(p?.multiplierVip1129 ?? p?.billingMultiplierVip1129);
      if (!parsedVip.ok) return fail(res, 400, parsedVip.error);
      const valueVip = parsedVip.value;
      const prevVip = db.settings.billingMultiplierVip1129;
      db.settings.billingMultiplierVip1129 = valueVip;
      audit(db, { actorId: user.id, action: 'pricing.change', target: 'billingMultiplierVip1129', detail: { from: prevVip, to: valueVip } });
      out.multiplierVip1129 = valueVip;
    }
    writeDb(db);
    if (out.multiplier == null) out.multiplier = multiplier(db);
    if (out.multiplierVip1129 == null) out.multiplierVip1129 = multiplierVip1129(db);
    return json(res, 200, out);
  }



  if (req.method === 'POST' && url.pathname === '/api/admin/providers/health-check') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const results = await probeAllProviderHealth(db);
    audit(db, { actorId: user.id, action: 'providers.healthCheck', target: 'providers', detail: { results: results.map(r => ({ id: r.id, ok: r.ok, error: r.error })) } });
    writeDb(db);
    const bad = results.filter(r => !r.ok);
    return json(res, 200, {
      results,
      providers: (db.settings.providers || []).map(publicProvider),
      healthSummary: (db.settings.providers || []).map(p => ({
        id: p.id,
        name: p.name,
        enabled: p.enabled !== false,
        health: p.health || { ok: true, lastCheckedAt: null, lastError: null }
      })),
      message: bad.length ? `探测完成：异常 ${bad.length} 个渠道` : '探测完成：渠道全部可用'
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/providers/sync-models') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const p = await body(req);
    const ids = Array.isArray(p?.ids) ? p.ids.map(String) : (p?.id ? [String(p.id)] : null);
    const results = await syncAllUpstreamModels(db, { ids });
    audit(db, { actorId: user.id, action: 'providers.syncModels', target: 'providers', detail: { results: results.map(r => ({ id: r.id, ok: r.ok, count: r.count, error: r.error })) } });
    writeDb(db);
    const failed = results.filter(r => !r.ok);
    return json(res, failed.length && failed.length === results.length ? 502 : 200, {
      results,
      providers: (db.settings.providers || []).map(publicProvider),
      message: failed.length ? `同步完成：成功 ${results.length - failed.length}，失败 ${failed.length}` : `已从上游同步 ${results.length} 个渠道的模型`
    });
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
      const apiKey = item.apiKey || previous?.apiKey || '';
      // apiKey 可为空：vip1129/beibeihai 走 per-key 同步 sk-，对话和健康检查会注入，不必强制渠道级 Key
      const normalized = normalizeProvider({ ...item, apiKey }, previous);
      // 模型列表以上游 /v1/models 为准，允许先保存渠道再同步
      if (normalized.enabled !== false && (!normalized.models || !normalized.models.length)) {
        normalized.models = previous?.models || [];
      }
      next.push(normalized);
    }
    db.settings.providers = next;
    db.settings.defaultProviderId = next.some(x => x.id === p.defaultProviderId) ? p.defaultProviderId : next[0].id;
    // 保存后自动同步有 Key 的渠道模型
    const syncResults = await syncAllUpstreamModels(db);
    audit(db, {
      actorId: user.id,
      action: 'providers.save',
      target: 'providers',
      detail: { count: next.length, ids: next.map(x => x.id), defaultProviderId: db.settings.defaultProviderId, sync: syncResults.map(r => ({ id: r.id, ok: r.ok, count: r.count })) }
    });
    writeDb(db);
    return json(res, 200, {
      providers: next.map(publicProvider),
      defaultProviderId: db.settings.defaultProviderId,
      syncResults,
      message: syncResults.length ? `已保存，并自动同步 ${syncResults.filter(r => r.ok).length}/${syncResults.length} 个渠道模型` : '已保存'
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/users') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    let users = db.users.map(adminUserView);
    if (q) {
      users = users.filter(u => [u.username, u.name, u.email, u.id].some(x => String(x || '').toLowerCase().includes(q)));
    }
    return json(res, 200, { users, total: db.users.length });
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
    if ('balance' in p && 'balanceDelta' in p) return fail(res, 400, '不能同时设置余额和增减额');
    if ('banned' in p) {
      if (typeof p.banned !== 'boolean') return fail(res, 400, 'banned 必须为布尔值');
      if (target.id === user.id && p.banned) return fail(res, 400, '不能封禁自己');
      if (isAdmin(target) && p.banned) return fail(res, 400, '不能封禁管理员');
      changes.banned = { from: !!target.banned, to: p.banned };
      target.banned = p.banned;
    }
    if ('accountActive' in p) {
      if (typeof p.accountActive !== 'boolean') return fail(res, 400, 'accountActive 必须为布尔值');
      changes.accountActive = { from: target.accountActive !== false, to: p.accountActive };
      target.accountActive = p.accountActive;
    }
    if ('balanceDelta' in p) {
      const delta = money2(p.balanceDelta);
      if (!Number.isFinite(delta) || delta === 0) return fail(res, 400, '增减额必须是非零数字');
      const from = money2(target.balance || 0);
      const to = money2(from + delta);
      if (to < 0) return fail(res, 400, '余额不足，不能减到负数');
      changes.balance = { from, to, delta };
      target.balance = to;
      if (to > 0 && !target.banned) target.accountActive = true;
    }
    if ('balance' in p) {
      const balance = money2(p.balance);
      if (!Number.isFinite(balance) || balance < 0) return fail(res, 400, 'balance 必须为非负数字');
      changes.balance = { from: money2(target.balance || 0), to: balance };
      target.balance = balance;
      if (balance > 0 && !target.banned) target.accountActive = true;
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
    const all = db.rechargeCodes || [];
    const total = all.length;
    const limitRaw = Number(url.searchParams.get('limit'));
    const offsetRaw = Number(url.searchParams.get('offset'));
    const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, Math.floor(limitRaw))) : 200;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : Math.max(0, total - limit);
    const mapCode = (c) => ({
      code: c.code,
      amount: Number(c.amount || 0),
      quotaTokens: Number(c.quotaTokens || 0),
      usedAt: c.usedAt || null,
      userId: c.userId || null,
      issuedTo: c.issuedTo || null,
      source: c.source || (c.issuedTo ? 'issued' : 'pool')
    });
    // Default offset to the newest slice (end of array) so UI reverse().slice still shows recent codes.
    const codes = all.slice(offset, offset + limit).map(mapCode);
    return json(res, 200, { codes, total, limit, offset });
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
      const entry = { code, amount, quotaTokens, usedAt: null, userId: null, issuedAt: null, issuedTo: null, source: 'manual', createdAt: new Date().toISOString() };
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
    ensureUserKeys(user);
    const keyId = url.searchParams.get('keyId');
    const rec = (keyId && user.apiKeys.find(k => k.id === keyId)) || user.apiKeys.find(k => k.enabled !== false) || user.apiKeys[0] || null;
    if (!rec && !isUnlimited(user)) return fail(res, 400, '请先在控制台创建 API 密钥');
    return chat(req, res, db, user, rec);
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    const apiKey = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const found = findByApiSecret(db, apiKey);
    if (!found) return fail(res, 401, '无效的 Relay API Key');
    const allowed = (found.key && Array.isArray(found.key.models) && found.key.models.length)
      ? found.key.models
      : catalogModels(db);
    return json(res, 200, {
      object: 'list',
      data: allowed.map(id => ({ id, object: 'model', owned_by: 'relay-station' }))
    });
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    if (!rateLimit(req, res, CHAT_RATE_LIMIT, 'chat')) return;
    const apiKey = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const found = findByApiSecret(db, apiKey);
    if (!found) return fail(res, 401, '无效的 Relay API Key');
    return chat(req, res, db, found.user, found.key);
  }


  if (req.method === 'POST' && (url.pathname === '/v1/messages' || url.pathname === '/v1/messages/')) {
    if (!rateLimit(req, res, CHAT_RATE_LIMIT, 'chat')) return;
    const apiKey = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const found = findByApiSecret(db, apiKey);
    if (!found) return fail(res, 401, '无效的 Relay API Key');
    const raw = await body(req);
    if (raw == null) return fail(res, 400, 'invalid json');
    const payload = anthropicToChatPayload(raw);
    if (!payload.messages.length) return fail(res, 400, 'messages 不能为空');
    req._anthropicApi = true;
    return chat(req, res, db, found.user, found.key, payload);
  }


  if (req.method === 'POST' && /^\/v1beta\/models\/[^/]+:(generateContent|streamGenerateContent)$/.test(url.pathname)) {
    if (!rateLimit(req, res, CHAT_RATE_LIMIT, 'chat')) return;
    const apiKey = req.headers['x-api-key'] || req.headers['x-goog-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const found = findByApiSecret(db, apiKey);
    if (!found) return fail(res, 401, '无效的 Relay API Key');
    const m = url.pathname.match(/^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent)$/);
    const model = decodeURIComponent(m[1]);
    const stream = m[2] === 'streamGenerateContent';
    const raw = await body(req);
    const contents = (raw && raw.contents) || [];
    const messages = [];
    const sys = raw && raw.systemInstruction && anthropicContentToText(raw.systemInstruction.parts || raw.systemInstruction);
    if (sys) messages.push({ role: 'system', content: sys });
    for (const c of contents) {
      const role = (c.role === 'model') ? 'assistant' : 'user';
      const text = anthropicContentToText(c.parts || c);
      if (text) messages.push({ role, content: text });
    }
    if (!messages.length) return fail(res, 400, 'messages 不能为空');
    req._geminiApi = true;
    return chat(req, res, db, found.user, found.key, { model, messages, stream: false });
  }

  if (req.method === 'POST' && url.pathname === '/v1/responses') {
    if (!rateLimit(req, res, CHAT_RATE_LIMIT, 'chat')) return;
    const apiKey = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const found = findByApiSecret(db, apiKey);
    if (!found) return fail(res, 401, '无效的 Relay API Key');
    const raw = await body(req);
    if (raw == null) return fail(res, 400, 'invalid json');
    const user = found.user;
    const apiKeyRec = found.key;
    if (apiKeyRec && apiKeyRec.enabled === false) return fail(res, 403, '该 API 密钥已停用');
    if (isBanned(user)) return fail(res, 403, '账号已被封禁');
    if (!isUnlimited(user) && user.accountActive === false) return fail(res, 402, insufficientBalanceMessage());
    scrubStuckReserves(user, apiKeyRec);

    // Prefer native /v1/responses passthrough (keeps tools / function_call for Codex).
    // Fall back to lossy chat/completions conversion only if every upstream rejects responses.
    const pseudoPayload = { model: raw.model, messages: [{ role: 'user', content: 'x' }] };
    const allCandidates = providersForModel(pseudoPayload, db);
    // Codex/tools need native /v1/responses — prefer vip1129 / OpenAI-compatible only.
    const passthroughCandidates = allCandidates.filter(providerSupportsResponsesPassthrough).slice(0, 2);
    const candidates = passthroughCandidates.length ? passthroughCandidates : allCandidates.slice(0, 1);
    if (!candidates.length) return fail(res, 503, '模型服务暂不可用，请稍后再试');
    const primary = candidates[0];
    const model = String(raw.model || primary.defaultModel || '');
    if (apiKeyRec && Array.isArray(apiKeyRec.models) && apiKeyRec.models.length && model && !apiKeyRec.models.includes(model)) {
      return fail(res, 400, '该密钥未授权使用此模型');
    }
    const rate = providerMultiplier(primary, db);
    const inputReserve = Math.ceil(JSON.stringify(raw).length / 3) + 256;
    const requestedOutput = Math.max(1, Math.min(Number(raw.max_output_tokens || raw.max_tokens) || DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS));
    if (apiKeyRec && !keyRateOk(res, apiKeyRec, inputReserve + requestedOutput)) return;

    let tokenReservation = 0;
    let amountReservation = 0;
    let outputBudget = requestedOutput;
    if (isUnlimited(user)) {
      outputBudget = requestedOutput;
      user.accountActive = true;
      writeDb(db);
    } else {
      let availableBalance = Math.max(0, (user.balance || 0) - (user.reservedBalance || 0));
      if (apiKeyRec && apiKeyRec.spendLimit > 0) {
        availableBalance = Math.min(availableBalance, Math.max(0, apiKeyRec.spendLimit - (apiKeyRec.spendUsed || 0) - (apiKeyRec.reservedSpend || 0)));
      }
      const safety = safetyBuffer(primary, rate, model);
      const inputEstimate = estimatedCost(primary, inputReserve, 0, model) * rate;
      const outputUnitPrice = Math.max(modelPrice(primary, model, 'outputPricePer1K') / 1000 * rate, Number.EPSILON);
      const moneyBudget = Math.floor(Math.max(0, availableBalance - safety - inputEstimate) / outputUnitPrice);
      outputBudget = Math.min(requestedOutput, moneyBudget);
      if (apiKeyRec && apiKeyRec.tokenLimit > 0) {
        const keyLeft = Math.max(0, apiKeyRec.tokenLimit - (apiKeyRec.tokenUsed || 0) - (apiKeyRec.reservedTokens || 0));
        outputBudget = Math.min(outputBudget, Math.max(0, Math.floor(keyLeft / rate) - inputReserve));
      }
      // If the full requested size does not fit, still allow a small reply when balance is not nearly empty.
    if (outputBudget < 1) {
      const minCost = minimalReplyCost(primary, rate, model) + estimatedCost(primary, inputReserve, 0, model) * rate + safety;
      if (availableBalance >= minCost) {
        outputBudget = MIN_REPLY_TOKENS;
      } else {
        const keyTokenBlocked = apiKeyRec?.tokenLimit > 0 && moneyBudget >= 1;
        if (keyTokenBlocked) return fail(res, 402, '该密钥 Token 额度不足');
        if (apiKeyRec?.spendLimit > 0) return fail(res, 402, '该密钥花费额度不足');
        return fail(res, 402, isNearlyEmptyBalance({ balance: availableBalance }, primary, rate, model)
          ? insufficientBalanceMessage()
          : requestTooLargeMessage());
      }
    }

    const upstreamReservation = inputReserve + outputBudget;
    tokenReservation = upstreamReservation * rate;
    amountReservation = estimatedCost(primary, inputReserve, outputBudget, model) * rate;
    if (availableBalance < amountReservation + safety) {
      // Shrink output once more instead of immediately nagging for a top-up.
      const affordOut = Math.max(0, Math.floor(Math.max(0, availableBalance - safety - estimatedCost(primary, inputReserve, 0, model) * rate) / outputUnitPrice));
      if (affordOut >= MIN_REPLY_TOKENS) {
        outputBudget = Math.min(outputBudget, affordOut);
        tokenReservation = (inputReserve + outputBudget) * rate;
        amountReservation = estimatedCost(primary, inputReserve, outputBudget, model) * rate;
      } else if (apiKeyRec?.spendLimit > 0) {
        return fail(res, 402, '该密钥花费额度不足');
      } else {
        return fail(res, 402, isNearlyEmptyBalance({ balance: availableBalance }, primary, rate, model)
          ? insufficientBalanceMessage()
          : requestTooLargeMessage());
      }
    }
      user.reservedTokens = (user.reservedTokens || 0) + tokenReservation;
      user.reservedBalance = (user.reservedBalance || 0) + amountReservation;
      if (apiKeyRec) {
        apiKeyRec.reservedTokens = (apiKeyRec.reservedTokens || 0) + tokenReservation;
        apiKeyRec.reservedSpend = (apiKeyRec.reservedSpend || 0) + amountReservation;
      }
      writeDb(db);
    }

    const started = Date.now();
    const wantStream = raw.stream === true;
    const forward = { ...raw };
    forward.model = model;
    forward.max_output_tokens = outputBudget;
    delete forward.max_tokens;
    let lastError = null;

    for (const provider of candidates) {
      try {
        const proxyKey = await ensureProxyApiKey(db, user, provider, apiKeyRec);
        if (!proxyKey) {
          lastError = new Error('missing_proxy_key');
          continue;
        }
        const upstream = await fetchUpstreamResponses(provider, forward, model, proxyKey);
        if (!upstream.ok) {
          const errText = await upstream.text().catch(() => '');
          updateProviderHealth(db, provider.id, false, `responses HTTP ${upstream.status}: ${errText.slice(0, 120)}`);
          writeDb(db);
          lastError = new Error(`responses_${upstream.status}`);
          // No responses endpoint on this upstream — stop passthrough and use chat fallback.
          if (upstream.status === 404 || upstream.status === 405) break;
          continue;
        }
        updateProviderHealth(db, provider.id, true);
        writeDb(db);

        if (wantStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive'
          });
          let settled = false;
          let usage = null;
          let buffer = '';
          const cleanup = (reason = 'abort') => {
            if (settled) return;
            settled = true;
            releaseReserve(user, tokenReservation, amountReservation, apiKeyRec);
            db.logs.unshift({
              id: id('log'), userId: user.id, apiKeyId: apiKeyRec?.id || null, model,
              providerId: provider.id, tokens: 0, billedTokens: 0, upstreamCost: 0, chargedAmount: 0,
              multiplier: rate, latency: Date.now() - started, status: reason, createdAt: new Date().toISOString()
            });
            db.logs = db.logs.slice(0, 3000);
            writeDb(db);
            try { res.end(); } catch { /* ignore */ }
          };
          req.on('close', () => { if (!settled) cleanup('client_abort'); });
          const scrapeUsage = (chunkText) => {
            buffer += chunkText;
            const parts = buffer.split('\n');
            buffer = parts.pop() || '';
            for (const line of parts) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const data = trimmed.slice(5).trim();
              if (!data || data === '[DONE]') continue;
              try {
                const parsed = JSON.parse(data);
                const u = parsed.response?.usage || parsed.usage || (parsed.type === 'response.completed' ? parsed.response?.usage : null);
                if (u) usage = normalizeResponsesUsage(u);
              } catch { /* ignore */ }
            }
          };
          try {
            const reader = upstream.body?.getReader?.();
            if (!reader) {
              for await (const chunk of upstream.body) {
                if (settled) break;
                const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
                scrapeUsage(text);
                res.write(typeof chunk === 'string' ? chunk : Buffer.from(chunk));
              }
            } else {
              const decoder = new TextDecoder();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (settled) break;
                const text = decoder.decode(value, { stream: true });
                scrapeUsage(text);
                res.write(Buffer.from(value));
              }
            }
          } catch {
            if (!settled) cleanup('stream_error');
            return;
          }
          if (settled) return;
          if (!usage) {
            usage = {
              prompt_tokens: inputReserve,
              completion_tokens: estimateTokensFromText(buffer),
              total_tokens: inputReserve + estimateTokensFromText(buffer)
            };
          } else {
            usage = normalizeResponsesUsage(usage);
          }
          settled = true;
          settleUsage(db, user, provider, usage, providerMultiplier(provider, db), tokenReservation, amountReservation, started, model, 'success', apiKeyRec);
          writeDb(db);
          try { res.end(); } catch { /* ignore */ }
          return;
        }

        const text = await upstream.text();
        let result;
        try { result = JSON.parse(text); } catch {
          lastError = new Error('invalid_json');
          continue;
        }
        const usage = normalizeResponsesUsage(result.usage || {});
        settleUsage(db, user, provider, usage, providerMultiplier(provider, db), tokenReservation, amountReservation, started, result.model || model, 'success', apiKeyRec);
        writeDb(db);
        return json(res, 200, result);
      } catch (err) {
        lastError = err;
        continue;
      }
    }

    // Fallback: old lossy chat conversion. Release reservation then re-enter chat().
    releaseReserve(user, tokenReservation, amountReservation, apiKeyRec);
    writeDb(db);
    const messages = responsesInputToMessages(raw.input, raw.instructions);
    if (!messages.length) return fail(res, 400, lastError?.message || 'messages 不能为空');
    const payload = {
      model: raw.model,
      messages,
      stream: raw.stream === true
    };
    if (raw.temperature !== undefined) payload.temperature = raw.temperature;
    if (Array.isArray(raw.tools)) payload.tools = raw.tools;
    if (raw.tool_choice !== undefined) payload.tool_choice = raw.tool_choice;
    const maxTok = raw.max_output_tokens != null ? raw.max_output_tokens : raw.max_tokens;
    if (maxTok != null) payload.max_tokens = maxTok;
    req._responsesApi = true;
    return chat(req, res, db, found.user, found.key, payload);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed');

  if (url.pathname === '/admin-app' || url.pathname === '/admin-app/') {
    url.pathname = '/admin-app/index.html';
  }


  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/payment-qr.svg') {
    res.writeHead(302, { Location: '/payment-qr/10.png' });
    return res.end();
  }
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
initial.paymentOrders ??= [];
initial.checkIns ??= [];
initial.siteErrors ??= [];
ensureSiteErrors(initial);
initial.settings.billingMultiplier ??= DEFAULT_MULTIPLIER;
initial.settings.billingMultiplierVip1129 ??= DEFAULT_VIP1129_BILLING_MULTIPLIER;
initial.settings.paymentQrs ??= {};
ensurePaymentQrs(initial);
initial.settings.paymentQrMeta ??= {
  wechatExpiresAt: null,
  alipayExpiresAt: null,
  note: '个人静态收款码一般长期有效；若扫码提示已过期/无法支付，请换另一种付款方式或联系客服更换收款码。'
};
initial.settings.publicBaseUrl ??= PUBLIC_BASE_URL || '';
initial.settings.recommendedModel = resolveRecommendedModel(initial.settings);
initial.settings.upstreamBeibeihai ??= {
  enabled: true,
  baseUrl: BEIBEIHAI_BASE_URL || BEIBEIHAI_DEFAULT_BASE,
  email: BEIBEIHAI_EMAIL || '',
  password: BEIBEIHAI_PASSWORD || '',
  accessToken: '',
  tokenExpiresAt: 0,
  groupMap: beibeihaiDefaultGroupMap(),
  lastError: null
};
initial.settings.upstreamVip1129 ??= {
  enabled: true,
  baseUrl: VIP1129_BASE_URL || VIP1129_DEFAULT_BASE,
  email: VIP1129_EMAIL || '',
  password: VIP1129_PASSWORD || '',
  accessToken: '',
  tokenExpiresAt: 0,
  groupMap: vip1129DefaultGroupMap(),
  lastError: null
};
initial.settings.paymentGateway ??= {
  enabled: false,
  type: 'epay',
  name: '易支付',
  apiUrl: '',
  pid: '',
  key: '',
  siteUrl: ''
};

initial.settings.providers ??= [];
if (seedDefaultProviders(initial)) writeDb(initial);
ensureDefaultModelGroups(initial);
repairSeededDefaultModels(initial);
pruneRetiredModelGroups(initial);
initial.settings.providers = wireAllProviders(initial.settings.providers, {
  beibeihaiBase: BEIBEIHAI_BASE_URL || BEIBEIHAI_DEFAULT_BASE,
  vip1129Base: VIP1129_BASE_URL || VIP1129_DEFAULT_BASE
});
{
  const bb = getBeibeihaiConfig(initial);
  bb.groupMap = { ...compactGroupMap(beibeihaiDefaultGroupMap()), ...compactGroupMap(bb.groupMap) };
  saveBeibeihaiConfig(initial, bb);
  const vip = getVip1129Config(initial);
  vip.groupMap = { ...compactGroupMap(vip1129DefaultGroupMap()), ...compactGroupMap(vip.groupMap) };
  saveVip1129Config(initial, vip);
}

for (const user of initial.users) {
  user.quotaTokens ??= 0;
  user.usedTokens ??= 0;
  user.reservedTokens ??= 0;
  user.reservedBalance ??= 0;
  user.accountActive ??= (user.balance || 0) > 0;
  user.banned ??= false;
  user.checkInBonus ??= 0;
  user.avatar = normalizeAvatar(user.avatar).avatar;
  user.role ??= (ADMIN_EMAIL && user.email === ADMIN_EMAIL) ? 'admin' : 'user';
  ensureUsername(user, initial);
  ensureUserKeys(user);
}
ensureUniqueDisplayNames(initial);
for (const provider of initial.settings.providers) {
  if (provider.id === 'grp_cursor_pool') { provider.maintenance = true; provider.maintenanceMessage = '请联系站长购买'; }
  provider.maintenance ??= (provider.id === 'grp_cursor_pool');
  if (provider.id === 'grp_cursor_pool') provider.maintenanceMessage ??= '请联系站长购买';
  provider.priority ??= 100;
  provider.timeoutMs ??= 60000;
  provider.maxRetries ??= 0;
  provider.modelPrices ??= {};
  provider.health ??= { ok: true, lastCheckedAt: null, lastError: null };
  provider.displayMultiplier = resolveDisplayMultiplier(provider);
  if (!Number.isFinite(Number(provider.upstreamRateMultiplier))) provider.upstreamRateMultiplier = 1;
  if (!Number.isFinite(Number(provider.cacheReadPricePer1K))) {
    provider.cacheReadPricePer1K = Math.max(0, Number(provider.inputPricePer1K || 0) * 0.1);
  }
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
ensureAdminUser(initial);
const envCodes = (process.env.RECHARGE_CODES || '').split(',').map(x => x.trim()).filter(Boolean);
for (const item of envCodes) {
  const [code, amount, quotaTokens] = item.split(':');
  if (code && !initial.rechargeCodes.some(x => x.code === code)) {
    initial.rechargeCodes.push({ code, amount: Number(amount || 10), quotaTokens: Number(quotaTokens || 100000), usedAt: null, issuedAt: null, issuedTo: null, source: 'manual' });
  }
}
for (const [token, session] of Object.entries(initial.sessions || {})) {
  if (session?.userId) sessions.set(token, session.userId);
}
writeDb(initial);
if (process.env.RELAY_TEST_NO_LISTEN !== '1') {
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`[启动失败] 端口 ${PORT} 已被占用（EADDRINUSE）。`);
      console.error('解决办法：');
      console.error(`  1) 关掉已在运行的中转站进程（任务管理器结束 node，或执行: Get-NetTCPConnection -LocalPort ${PORT} | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }）`);
      console.error('  2) 或换端口启动: $env:PORT="8788"; npm start');
      process.exit(1);
    }
    console.error('[启动失败]', err);
    process.exit(1);
  });
  server.listen(PORT, () => {
    const addr = server.address();
    const actual = typeof addr === 'object' && addr ? addr.port : PORT;
    console.log(`Relay Station running at http://localhost:${actual}`);
  });

  if (!SKIP_BOOT_JOBS) {
    setImmediate(async () => {
      try {
        const bootDb = readDb();
        const added = topUpCodePools(bootDb, CODE_POOL_TARGET);
        if (added) console.log(`Code pool topped up: +${added} (target ${CODE_POOL_TARGET}/amount)`);
        else console.log(`Code pool ready (target ${CODE_POOL_TARGET}/amount)`);
        try {
          await autofillBeibeihaiGroupMap(bootDb);
          await autofillVip1129GroupMap(bootDb);
        } catch (err) {
          console.warn('Boot upstream group autofill skipped:', err.message || err);
        }
        const healthResults = await probeAllProviderHealth(bootDb);
        writeDb(bootDb);
        const ok = healthResults.filter(r => r.ok && !r.skipped).length;
        const bad = healthResults.filter(r => !r.ok);
        console.log(`Channel health probe: ${ok} ok, ${bad.length} down (of ${healthResults.length})`);
        for (const r of bad) console.warn(`  channel down ${r.name}: ${r.error}`);
      } catch (err) {
        console.error('Boot pool/model sync failed:', err);
      }
    });

    setInterval(async () => {
      try {
        const dbx = readDb();
        let changed = false;
        const added = topUpCodePools(dbx, CODE_POOL_TARGET);
        if (added) {
          changed = true;
          console.log(`[pool] periodic refill +${added}`);
        }
        const healthResults = await probeAllProviderHealth(dbx);
        changed = true;
        const ok = healthResults.filter(r => r.ok && !r.skipped).length;
        const bad = healthResults.filter(r => !r.ok);
        console.log(`[health] hourly probe: ${ok} ok, ${bad.length} down`);
        for (const r of bad) console.warn(`[health] down ${r.name}: ${r.error}`);
        if (changed) writeDb(dbx);
      } catch (err) {
        console.error('[pool/models] periodic job failed:', err);
      }
    }, 60 * 60 * 1000);
  }
}
