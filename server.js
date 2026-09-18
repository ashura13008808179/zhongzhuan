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
  fetchUsage as vip1129FetchUsage,
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
  fetchUsage as beibeihaiFetchUsage,
  isBeibeihaiProvider,
  defaultGroupMap as beibeihaiDefaultGroupMap,
  normalizeBase as beibeihaiNormalizeBase,
  DEFAULT_BASE as BEIBEIHAI_DEFAULT_BASE
} from './upstream/beibeihai.js';
import { ensureSiteErrors, recordSiteError, clearSiteErrors, tipsForCode, failPayload, SITE_ERROR_CAP } from './diagnostics/site-errors.js';
import { runDiagnosticSuite } from './diagnostics/run-suite.js';
import { claimCheckIn, checkInStatus, checkInAdminStats, CHECKIN_LOG_STATUS, money2, publicRechargeHours } from './lib/checkin.js';
import {
  normalizeWelfarePromo,
  isWelfareActive,
  stampIssuedCard,
  redeemCreditAmount,
  publicWelfareBanner,
  applyPaymentPlanWelfare,
  shanghaiTonightEndIso,
  WELFARE_MAX_IMAGES
} from './lib/welfare-promo.js';
import { buildMobileInbox, parseUpstreamAccount } from './lib/admin-mobile.js';
import { pushPaymentEvent, waitForEvents, currentSeq, publicPaymentEvent } from './lib/payment-events.js';
import {
  compactGroupMap,
  normalizeAvailableGroups,
  suggestGroupMap,
  wireAllProviders,
  resolveProxyApiKey as resolveProxyApiKeyPure,
  findSyncedKeyRecord,
  findListedSecret,
  findListedSecretById,
  upstreamSecretOf,
  preserveUpstreamSecret,
  validateInviteCode,
  insufficientBalanceMessage,
  BEIBEIHAI_GROUP_HINTS,
  VIP1129_GROUP_HINTS,
  BEIBEIHAI_CHAT_URL,
  VIP1129_CHAT_URL,
  DEFAULT_RECOMMENDED_MODEL,
  GPT_RELAY_GROUP_IDS,
  GPT_RELAY_PRIORITY,
  preferGptTerra,
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
import {
  modelPrice,
  providerUpstreamRate,
  resolveUpstreamCost,
  estimatedCost,
  billedTokensFromLog,
  extractReportedUpstreamCost,
  usageListFromPayload,
  pickUpstreamUsageRow,
  pickExclusiveUpstreamUsageRow,
  findDuplicateUsageCharges,
  tokenFloorCost,
  applyUpstreamUsageRow,
  allowEstimatedBilling,
  isPendingBillStatus
} from './lib/billing-cost.js';
import { applyLiveMoneyCharge, applyLiveMoneyRefund, settleRemainder, parkPendingHold, releasePendingHold, liveBillTarget, exactUserCharge, LIVE_POLL_INTERVAL_MS } from './lib/live-billing.js';
import { applyUsagePricesToProviders, nextTokenPriceSyncAt, msUntilNextTokenPriceSync, TOKEN_PRICE_RETRY_MS, channelTokenPriceView } from './lib/token-price-sync.js';
import { catalogPrice, channelFallbackPrice } from './lib/upstream-prices.js';
import {
  upstreamUsageId,
  upstreamUsageApiKeyId,
  upstreamUsageCreatedAt,
  upstreamUsageCost,
  upstreamUsageTokens,
  upstreamBillId,
  usagePageHasMore
} from './lib/upstream-billing-ledger.js';
import { rebaseDbSnapshot, snapshotDbForRebase, cloneDbValue } from './lib/db-rebase.js';
import { loadOrCreateDataKey, readDbFile, writeDbFileAtomic, emptyDb } from './lib/db-crypto.js';
import { sanitizeChatCompletion, sanitizeSseDataLine } from './lib/response-mask.js';
import {
  adminPhoneRequired,
  getAdminPhoneHash,
  normalizeCnMobile,
  createPhoneTicket,
  takePhoneTicket,
  noteSignupAndMaybeAlert,
  publicSecurityAlert,
  openSecurityAlerts,
  stripAdminSecrets
} from './lib/admin-guard.js';
import {
  attachSecurityHeaders,
  clientIp as requestClientIp,
  readLimitedBody,
  parseJsonSafe,
  MAX_JSON_BODY,
  MAX_UPLOAD_BODY,
  LOGIN_RATE_LIMIT,
  REGISTER_RATE_LIMIT,
  CONFIG_RATE_LIMIT,
  API_RATE_LIMIT,
  resolvePublicFile,
  robotsTxt,
  sessionRecord,
  sessionExpired,
  noteLoginFailure,
  clearLoginFailures,
  loginBlocked,
  noteRegisterSuccess,
  registerDailyBlocked,
  withKeyedLock,
  privilegeFieldsPresent,
  trustProxyEnabled
} from './lib/http-security.js';
import {
  messagesEndpointFromChatUrl,
  normalizeAnthropicUsage,
  mergeAnthropicStreamUsage,
  anthropicStreamFinished,
  anthropicContentToText,
  anthropicToChatPayload,
  chatCompletionToAnthropic as chatCompletionToAnthropicWire
} from './lib/anthropic-wire.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const dataDir = process.env.RELAY_DATA_DIR || (process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data'));
const dbFile = process.env.RELAY_DB_FILE || path.join(dataDir, 'db.json');
const SKIP_BOOT_JOBS = process.env.RELAY_SKIP_BOOT_JOBS === '1' || String(process.env.SKIP_BOOT_JOBS || '') === '1';
const UPSTREAM_USAGE_SYNC_INTERVAL_MS = Math.max(1_000, Number(process.env.UPSTREAM_USAGE_SYNC_INTERVAL_MS || 2_000));
const UPSTREAM_USAGE_SYNC_PAGE_SIZE = Math.max(20, Math.min(200, Number(process.env.UPSTREAM_USAGE_SYNC_PAGE_SIZE || 100)));
const UPSTREAM_USAGE_SYNC_MAX_PAGES = Math.max(1, Math.min(100, Number(process.env.UPSTREAM_USAGE_SYNC_MAX_PAGES || 25)));
const UPSTREAM_USAGE_ACTIVE_WINDOW_MS = Math.max(10_000, Number(process.env.UPSTREAM_USAGE_ACTIVE_WINDOW_MS || 120_000));
const UPSTREAM_USAGE_INACTIVE_SYNC_MS = Math.max(10_000, Number(process.env.UPSTREAM_USAGE_INACTIVE_SYNC_MS || 60_000));
const PORT = Number(process.env.PORT || 8787);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || process.env.SITE_URL || '').trim().replace(/\/$/, '');
const VIP1129_EMAIL = String(process.env.VIP1129_EMAIL || '').trim();
const VIP1129_PASSWORD = String(process.env.VIP1129_PASSWORD || '');
const VIP1129_BASE_URL = String(process.env.VIP1129_BASE_URL || VIP1129_DEFAULT_BASE).trim();
const BEIBEIHAI_EMAIL = String(process.env.BEIBEIHAI_EMAIL || '').trim();
const BEIBEIHAI_PASSWORD = String(process.env.BEIBEIHAI_PASSWORD || '');
const BEIBEIHAI_BASE_URL = String(process.env.BEIBEIHAI_BASE_URL || BEIBEIHAI_DEFAULT_BASE).trim();


const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD_ENV = process.env.ADMIN_PASSWORD;
const ADMIN_PASSWORD = ADMIN_PASSWORD_ENV || 'change-me';
const ADMIN_USERNAME_ENV = String(process.env.ADMIN_USERNAME || '').trim().toLowerCase();
const ADMIN_USERNAME = (() => {
  const raw = ADMIN_USERNAME_ENV || 'admin';
  return /^[a-z0-9][a-z0-9_-]{2,31}$/.test(raw) ? raw : 'admin';
})();
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || '1064289998@qq.com';
const CONTACT_WECHAT = process.env.CONTACT_WECHAT || '';
const CONTACT_QQ = process.env.CONTACT_QQ || '1064289998';
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
    const proto = trustProxyEnabled()
      ? String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
      : 'http';
    const host = (trustProxyEnabled()
      ? String(req.headers['x-forwarded-host'] || req.headers.host || '')
      : String(req.headers.host || '')).split(',')[0].trim();
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
  markDbRootDirty(db, 'rechargeCodes');
  card.issuedAt = new Date().toISOString();
  card.issuedTo = order.userId;
  Object.assign(card, stampIssuedCard(card, db.settings?.welfarePromo));
  order.status = 'confirmed';
  order.code = card.code;
  order.creditAmount = card.creditAmount;
  order.welfareMultiplier = card.welfareMultiplier || 1;
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

function ensureAdminPhoneHash(db) {
  db.settings ??= {};
  if (getAdminPhoneHash(db)) return false;
  const envPhone = normalizeCnMobile(process.env.ADMIN_PHONE || '');
  if (!envPhone) return false;
  db.settings.adminPhoneHash = hash(envPhone);
  db.settings.adminPhoneBoundAt = new Date().toISOString();
  return true;
}

function emitSignupBurst(alert) {
  if (!alert) return;
  pushPaymentEvent({
    kind: 'signup_burst',
    alertId: alert.id,
    count: alert.count,
    username: '系统',
    title: '注册暴增告警',
    body: `短时间内新注册 ${alert.count} 个账号，请到后台决定是否封号`,
    status: alert.status
  });
}

function banUserFromAlert(db, alert, userId) {
  const target = db.users.find(u => u.id === userId);
  if (!target) return { ok: false, error: '用户不存在' };
  if (isAdmin(target)) return { ok: false, error: '不能封禁管理员' };
  if (!target.banned) {
    target.banned = true;
    target.accountActive = false;
  }
  for (const row of alert.users || []) {
    if (row.userId === userId) row.banned = true;
  }
  const bannedCount = (alert.users || []).filter((row) => {
    const u = db.users.find(x => x.id === row.userId);
    return u && u.banned && !isAdmin(u);
  }).length;
  const remaining = (alert.users || []).filter((row) => {
    const u = db.users.find(x => x.id === row.userId);
    return u && !isAdmin(u) && !u.banned;
  }).length;
  alert.bannedCount = bannedCount;
  if (!remaining) alert.status = 'banned';
  alert.updatedAt = new Date().toISOString();
  return { ok: true, bannedCount, remaining };
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
    },
    securityAlerts: openSecurityAlerts(db)
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
const WELFARE_UPLOAD_DIR = path.join(publicDir, 'welfare', 'uploads');

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

function saveWelfareImage(buf, ext) {
  fs.mkdirSync(WELFARE_UPLOAD_DIR, { recursive: true });
  const name = `welfare-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(WELFARE_UPLOAD_DIR, name), buf);
  return `/welfare/uploads/${name}`;
}

function paymentPlans(db) {
  const map = ensurePaymentQrs(db);
  const meta = paymentQrMeta(db);
  const wechatStatus = paymentQrStatus(meta.wechatExpiresAt);
  const alipayStatus = paymentQrStatus(meta.alipayExpiresAt);
  const plans = PAYMENT_AMOUNTS.map(amount => {
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
  return applyPaymentPlanWelfare(plans, db.settings?.welfarePromo).map(({ welfareMultiplier, welfareActive, ...rest }) => rest);
}

function ensureWelfarePromo(db) {
  db.settings ??= {};
  db.settings.welfarePromo = normalizeWelfarePromo(db.settings.welfarePromo);
  return db.settings.welfarePromo;
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
    if (need > 0) markDbRootDirty(db, 'rechargeCodes');
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
  const ledgerRows = (db.upstreamBills || []).filter((bill) => bill?.createdAt && localDay(new Date(bill.createdAt)) === day);
  // The upstream ledger is authoritative when it is available. Local request
  // logs are only a fallback for installations that have not synced yet.
  const costRows = ledgerRows.length
    ? ledgerRows.map((bill) => ({
        createdAt: bill.createdAt,
        providerId: bill.providerId,
        userId: bill.userId,
        providerName: (db.settings?.providers || []).find((p) => p.id === bill.providerId)?.name || bill.providerId,
        upstreamCost: bill.actualCost,
        chargedAmount: bill.chargedAmount,
        upstreamCostSource: 'reported',
        status: bill.status
      }))
    : (db.logs || []);
  const chargedTodayByUser = {};
  const userLabel = (uid) => {
    const u = (db.users || []).find((x) => x.id === uid);
    return u?.username || u?.name || uid || 'unknown';
  };
  for (const log of costRows) {
    if (!log?.createdAt || localDay(new Date(log.createdAt)) !== day) continue;
    if (log.status === 'referral_rebate' || log.status === CHECKIN_LOG_STATUS) continue;
    requestCountToday += 1;
    const up = Number(log.upstreamCost || 0);
    const charged = Number(log.chargedAmount || 0);
    const uid = log.userId || 'unknown';
    if (!chargedTodayByUser[uid]) {
      chargedTodayByUser[uid] = { userId: uid, username: userLabel(uid), upstreamCost: 0, chargedAmount: 0, requests: 0 };
    }
    chargedTodayByUser[uid].requests += 1;
    if (Number.isFinite(up)) chargedTodayByUser[uid].upstreamCost += up;
    if (Number.isFinite(charged) && charged > 0) chargedTodayByUser[uid].chargedAmount += charged;
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
    upstreamLedgerRows: ledgerRows.length,
    upstreamUsageSync: db.settings?.upstreamUsageSync || null,
    upstreamByProvider: Object.values(upstreamByProvider).sort((a, b) => b.upstreamCost - a.upstreamCost),
    chargedTodayByUser: Object.values(chargedTodayByUser)
      .map((row) => ({
        ...row,
        upstreamCost: Math.round(row.upstreamCost * 10000) / 10000,
        chargedAmount: Math.round(row.chargedAmount * 10000) / 10000
      }))
      .sort((a, b) => b.chargedAmount - a.chargedAmount)
  };
}

const DEFAULT_MAX_TOKENS = Number(process.env.DEFAULT_MAX_TOKENS || 1024);
const DEFAULT_MULTIPLIER = Number(process.env.BILLING_MULTIPLIER || DEFAULT_BILLING_MULTIPLIER);
const BALANCE_SAFETY_BUFFER = Number(process.env.BALANCE_SAFETY_BUFFER || 0);
const LEGACY_UPSTREAM = { url: process.env.UPSTREAM_URL || '', apiKey: process.env.UPSTREAM_API_KEY || '', model: process.env.UPSTREAM_MODEL || 'gpt-4o-mini', price: Number(process.env.UPSTREAM_PRICE_PER_1K || 0.01) };
const sessions = new Map();
const rateBuckets = new Map();
const CHAT_RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;
const AUDIT_CAP = 5000;

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dataKey = loadOrCreateDataKey(dataDir);
if (!fs.existsSync(dbFile)) writeDbFileAtomic(dbFile, emptyDb(), dataKey);

const dbWriteBases = new WeakMap();
function readDbRaw() { return readDbFile(dbFile, dataKey); }
function rememberDbBase(db) {
  dbWriteBases.set(db, { snapshot: snapshotDbForRebase(db), rechargeCodes: null });
  return db;
}
function markDbRootDirty(db, root) {
  if (root !== 'rechargeCodes' || !db) return;
  const state = dbWriteBases.get(db);
  if (state && state.rechargeCodes == null) state.rechargeCodes = cloneDbValue(db.rechargeCodes || []);
}
function readDb() { return rememberDbBase(readDbRaw()); }
function writeDb(db) {
  // Every request can spend time awaiting an upstream response. Rebase the
  // mutations from its original snapshot onto the newest file so a late
  // completion cannot erase another request's balance, log, or ledger update.
  const state = dbWriteBases.get(db);
  const latest = readDbRaw();
  let committed = db;
  if (state) {
    const base = { ...state.snapshot };
    if (state.rechargeCodes != null) base.rechargeCodes = state.rechargeCodes;
    committed = rebaseDbSnapshot(base, db, latest, { logCap: 3000 });
  }
  writeDbFileAtomic(dbFile, committed, dataKey);
  if (state) {
    // Do not replace the caller's object graph here. A handler may retain an
    // order/card/log reference across an intermediate write; swapping the
    // graph would make subsequent mutations hit an orphaned object.
    rememberDbBase(db);
  }
}
function replaceDbContents(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
  return target;
}
function id(prefix) { return `${prefix}_${crypto.randomBytes(7).toString('hex')}`; }
function hash(password, salt = crypto.randomBytes(16).toString('hex')) { return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`; }
function looksLikePasswordHash(stored) {
  const s = String(stored || '');
  return /^[0-9a-f]{32}:[0-9a-f]{128}$/i.test(s);
}
function verify(password, stored) {
  if (!looksLikePasswordHash(stored)) return false;
  const [salt, secret] = stored.split(':');
  try {
    return crypto.timingSafeEqual(Buffer.from(secret, 'hex'), crypto.scryptSync(password, salt, 64));
  } catch {
    return false;
  }
}
function userKey() { return `rk_${crypto.randomBytes(20).toString('hex')}`; }
const keyRateBuckets = new Map();
const MAX_USER_KEYS = 40;

function catalogModels(db) {
  const set = new Set();
  const rec = resolveRecommendedModel(db.settings);
  if (rec) set.add(rec);
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
  const models = [...new Set((provider.models || []).map(m => String(m).trim()).filter(Boolean))];
  const def = String(provider.defaultModel || '').trim();
  if (def && models.includes(def)) return models;
  if (def && !models.length) return [def];
  return models;
}

function snapProviderDefaultModel(provider) {
  if (!provider) return false;
  const before = `${provider.defaultModel}|${(provider.models || []).join(',')}|${provider.priority}`;
  preferGptTerra(provider);
  const models = [...new Set((provider.models || []).map((m) => String(m).trim()).filter(Boolean))];
  if (models.length) {
    const cur = String(provider.defaultModel || '').trim();
    if (!cur || !models.includes(cur)) {
      provider.defaultModel = models[0];
      preferGptTerra(provider);
    }
  }
  return `${provider.defaultModel}|${(provider.models || []).join(',')}|${provider.priority}` !== before;
}

function allowedModelsForKey(db, apiKeyRec) {
  if (!apiKeyRec) return [];
  const group = apiKeyRec.groupId ? resolveGroupModels(db, apiKeyRec.groupId) : null;
  const own = Array.isArray(apiKeyRec.models) ? apiKeyRec.models.map((m) => String(m).trim()).filter(Boolean) : [];
  if (group && group.length) return [...new Set([...group, ...own])];
  return own;
}

function keyAllowsModel(db, apiKeyRec, model) {
  if (!apiKeyRec) return true;
  const want = String(model || '').trim();
  if (!want) return true;
  const allowed = allowedModelsForKey(db, apiKeyRec);
  if (!allowed.length) return true;
  return allowed.includes(want);
}

function resolveAuthorizedModel(db, apiKeyRec, requested, provider) {
  const allowed = allowedModelsForKey(db, apiKeyRec);
  const req = String(requested || '').trim();
  const def = String(provider?.defaultModel || '').trim();
  if (req) {
    if (keyAllowsModel(db, apiKeyRec, req)) return { ok: true, model: req };
    if (req === def && allowed[0]) return { ok: true, model: allowed[0] };
    const listed = (db.settings?.providers || []).some((p) => Array.isArray(p.models) && p.models.includes(req));
    if (!listed && allowed[0]) return { ok: true, model: allowed[0] };
    return { ok: false, model: req };
  }
  if (def && keyAllowsModel(db, apiKeyRec, def)) return { ok: true, model: def };
  if (allowed[0]) return { ok: true, model: allowed[0] };
  return { ok: false, model: def };
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

/** Fill missing modelPrices from measured BASE catalog so estimates match upstream when actual_cost is late. */
function ensureMeasuredPrices(db) {
  let changed = 0;
  for (const provider of db.settings?.providers || []) {
    provider.modelPrices = provider.modelPrices && typeof provider.modelPrices === 'object' ? provider.modelPrices : {};
    const models = [...new Set([provider.defaultModel, ...(provider.models || [])].filter(Boolean))];
    for (const model of models) {
      const current = provider.modelPrices[model];
      const has = current && Number(current.inputPricePer1K) > 0 && Number(current.outputPricePer1K) > 0;
      if (has) continue;
      const cat = catalogPrice(model);
      if (!cat) continue;
      provider.modelPrices[model] = { ...cat };
      changed += 1;
    }
    const generic = Number(provider.inputPricePer1K) === 0.01 && Number(provider.outputPricePer1K) === 0.03;
    if (!Number(provider.inputPricePer1K) || generic) {
      const fb = catalogPrice(provider.defaultModel) || channelFallbackPrice(provider.id);
      if (fb) {
        provider.inputPricePer1K = fb.inputPricePer1K;
        provider.outputPricePer1K = fb.outputPricePer1K;
        provider.cacheReadPricePer1K = fb.cacheReadPricePer1K;
        if (fb.cacheWritePricePer1K) provider.cacheWritePricePer1K = fb.cacheWritePricePer1K;
        changed += 1;
      }
    }
  }
  return changed;
}

/** Snap the old DeepSeek 0.003/0.009 table to live official 0.00015/0.0006. */
function migrateDeepSeekLivePrices(db) {
  const provider = (db.settings?.providers || []).find((p) => p.id === 'grp_deepseek');
  if (!provider) return false;
  const flash = catalogPrice('deepseek-v4-flash');
  const pro = catalogPrice('deepseek-v4-pro');
  if (!flash) return false;
  provider.modelPrices = provider.modelPrices && typeof provider.modelPrices === 'object' ? provider.modelPrices : {};
  const oldIn = Number(provider.modelPrices['deepseek-v4-flash']?.inputPricePer1K ?? provider.inputPricePer1K);
  if (!(oldIn >= 0.002 && oldIn <= 0.004)) return false;
  const nowIso = new Date().toISOString();
  provider.modelPrices['deepseek-v4-flash'] = { ...flash, source: 'official_actual', calibratedAt: nowIso };
  provider.modelPrices['deepseek-chat'] = { ...flash, source: 'official_actual', calibratedAt: nowIso };
  if (pro) {
    const proIn = Number(provider.modelPrices['deepseek-v4-pro']?.inputPricePer1K);
    if (!proIn || proIn >= 0.005) {
      provider.modelPrices['deepseek-v4-pro'] = { ...pro, source: 'official_actual', calibratedAt: nowIso };
    }
  }
  provider.inputPricePer1K = flash.inputPricePer1K;
  provider.outputPricePer1K = flash.outputPricePer1K;
  provider.cacheReadPricePer1K = flash.cacheReadPricePer1K;
  if (flash.cacheWritePricePer1K) provider.cacheWritePricePer1K = flash.cacheWritePricePer1K;
  return true;
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
  attachUpstreamSecret(localKey, secret, 'beibeihai', upstreamGroupId);
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


function attachUpstreamSecret(localKey, secret, providerName, upstreamGroupId) {
  if (!localKey || !secret?.key) return;
  localKey.upstream = {
    ...(localKey.upstream && typeof localKey.upstream === 'object' ? localKey.upstream : {}),
    provider: providerName,
    id: secret.id != null ? String(secret.id) : localKey.upstream?.id || null,
    key: secret.key,
    groupId: upstreamGroupId,
    syncedAt: new Date().toISOString()
  };
}

async function hydrateUpstreamSecret(db, rec) {
  const have = upstreamSecretOf(rec);
  if (have) return have;
  const id = rec?.upstream?.id;
  const kind = rec?.upstream?.provider;
  if (!id || (kind !== 'vip1129' && kind !== 'beibeihai')) return '';
  const auth = kind === 'vip1129' ? await ensureVip1129Token(db) : await ensureBeibeihaiToken(db);
  if (!auth.ok) return '';
  const listed = kind === 'vip1129'
    ? await vip1129ListKeys(auth.cfg.baseUrl, auth.token, 'page=1&page_size=100')
    : await beibeihaiListKeys(auth.cfg.baseUrl, auth.token, 'page=1&page_size=100');
  if (!listed.ok) return '';
  const hit = findListedSecretById(listed.data, id);
  if (!hit?.key) return '';
  rec.upstream = { ...(rec.upstream || {}), key: hit.key };
  writeDb(db);
  return hit.key;
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
  const name = isVip ? 'vip1129' : 'beibeihai';
  const view = isVip ? publicVip1129View(getVip1129Config(db)) : publicBeibeihaiView(getBeibeihaiConfig(db));
  try {
    const auth = isVip ? await ensureVip1129Token(db) : await ensureBeibeihaiToken(db);
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
  } catch (err) {
    const msg = /timeout|abort/i.test(String(err && err.name || '') + String(err && err.message || ''))
      ? 'timeout'
      : (err?.message || String(err));
    return { name, ok: false, error: msg, account: null, upstream: view };
  }
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
  attachUpstreamSecret(localKey, secret, 'vip1129', upstreamGroupId);
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
    createdAt: key.createdAt
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

function syncGptKeyModelsFromGroup(db) {
  let changed = false;
  for (const user of db.users || []) {
    for (const key of user.apiKeys || []) {
      if (!GPT_RELAY_GROUP_IDS.includes(String(key.groupId || ''))) continue;
      const groupModels = (resolveGroupModels(db, key.groupId) || []).map(String).filter(Boolean);
      if (!groupModels.length) continue;
      const cur = (key.models || []).map((m) => String(m).trim()).filter(Boolean);
      const next = groupModels.includes(DEFAULT_RECOMMENDED_MODEL)
        ? [DEFAULT_RECOMMENDED_MODEL, ...groupModels.filter((m) => m !== DEFAULT_RECOMMENDED_MODEL)]
        : [...groupModels];
      if (!next.length) continue;
      if (cur.join('\0') === next.join('\0')) continue;
      key.models = next;
      changed = true;
    }
  }
  return changed;
}

function ensureUserKeys(user) {
  user.apiKeys ??= [];
  // No auto-created default key — users create keys themselves.
  // Drop legacy bootstrap keys named 默认密钥.
  user.apiKeys = user.apiKeys.filter(k => (k?.name || '') !== '默认密钥');
  user.apiKeys = user.apiKeys.map(k => {
    const next = normalizeApiKey(k, k);
    preserveUpstreamSecret(next);
    return next;
  });
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
function json(res, status, body) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (status === 429) headers['Retry-After'] = '60';
  res.writeHead(status, headers);
  res.end(JSON.stringify(stripAdminSecrets(body)));
}
function fail(res, status, error, opts = null) {
  if (opts && typeof opts === 'object') {
    const { status: _s, body } = failPayload(status, error, opts);
    return json(res, status, body);
  }
  return json(res, status, { error });
}
async function body(req, maxBytes = MAX_JSON_BODY) {
  const raw = await readLimitedBody(req, maxBytes);
  try { return raw ? parseJsonSafe(raw) : {}; } catch { return null; }
}
function clientIp(req) {
  return requestClientIp(req);
}
function rateLimit(req, res, limit, bucketName, extra = '') {
  const key = `${clientIp(req)}:${bucketName || 'default'}:${extra}`;
  const now = Date.now();
  if (rateBuckets.size > 20000) {
    for (const [k, v] of rateBuckets) {
      if (now - v.windowStart >= RATE_WINDOW_MS) rateBuckets.delete(k);
    }
  }
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
  db.sessions[token] = sessionRecord(userId);
}
function clearSession(db, token) {
  db.sessions ??= {};
  delete db.sessions[token];
}
function userFrom(req, db) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const rec = db.sessions?.[token];
  if (rec && sessionExpired(rec)) {
    sessions.delete(token);
    clearSession(db, token);
    return null;
  }
  let userId = sessions.get(token);
  if (!userId && rec?.userId) {
    userId = rec.userId;
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
  { id: 'grp_gpt_pro', name: 'GPT PRO', url: VIP1129_CHAT_URL, upstreamSync: 'vip1129', defaultModel: DEFAULT_RECOMMENDED_MODEL, models: [], priority: GPT_RELAY_PRIORITY.grp_gpt_pro, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_gpt_pro') },
  { id: 'grp_gpt_plus', name: 'GPT-PLUS', url: VIP1129_CHAT_URL, upstreamSync: 'vip1129', defaultModel: DEFAULT_RECOMMENDED_MODEL, models: [], priority: GPT_RELAY_PRIORITY.grp_gpt_plus, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_gpt_plus') },
  { id: 'grp_gpt_mix', name: 'GPT 混用', url: VIP1129_CHAT_URL, upstreamSync: 'vip1129', defaultModel: DEFAULT_RECOMMENDED_MODEL, models: [], priority: GPT_RELAY_PRIORITY.grp_gpt_mix, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_gpt_mix') },
  { id: 'grp_cc_max', name: 'CC-MAX', url: BEIBEIHAI_CHAT_URL, upstreamSync: 'beibeihai', defaultModel: 'claude-sonnet-4', models: [], priority: 60, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_cc_max') },
  { id: 'grp_cursor_pool', name: 'Cursor账号池', url: 'https://api2.cursor.sh/v1/chat/completions', defaultModel: 'claude-sonnet-4', models: [], priority: 80, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_cursor_pool'), maintenance: true, maintenanceMessage: '请联系站长购买' },
  { id: 'grp_glm', name: '智普 GLM', url: BEIBEIHAI_CHAT_URL, upstreamSync: 'beibeihai', defaultModel: 'glm-5.1', models: [], priority: 90, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_glm') },
  { id: 'grp_kimi', name: 'Kimi', url: BEIBEIHAI_CHAT_URL, upstreamSync: 'beibeihai', defaultModel: 'kimi-k2.6', models: [], priority: 100, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_kimi') },
  { id: 'grp_gemini', name: 'Gemini', url: BEIBEIHAI_CHAT_URL, upstreamSync: 'beibeihai', defaultModel: 'gemini-2.5-flash', models: [], priority: 110, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_gemini') },
  { id: 'grp_grok_heavy', name: 'Grok Heavy', url: BEIBEIHAI_CHAT_URL, upstreamSync: 'beibeihai', defaultModel: 'composer-2.5', models: [], priority: 120, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_grok_heavy'), timeoutMs: 90000 },
  { id: 'grp_claude_kiro', name: 'Claude-Kiro', url: BEIBEIHAI_CHAT_URL, upstreamSync: 'beibeihai', defaultModel: 'claude-haiku-4-5-20251001', models: [], priority: 130, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_claude_kiro') },
  { id: 'grp_claude_kiro_welfare', name: 'Claude-Kiro 福利', url: BEIBEIHAI_CHAT_URL, upstreamSync: 'beibeihai', defaultModel: 'claude-fable-5', models: [], priority: 140, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_claude_kiro_welfare') },
  { id: 'grp_aws_cc', name: 'AWS-CC', url: VIP1129_CHAT_URL, upstreamSync: 'vip1129', defaultModel: 'claude-fable-5', models: [], priority: 210, billingMultiplier: DEFAULT_BILLING_MULTIPLIER, displayMultiplier: defaultDisplayMultiplier('grp_aws_cc') },
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
    const models = (p.models || []).map((m) => String(m).trim()).filter(Boolean);
    const curTok = modelFamilyToken(current);
    const seedTok = modelFamilyToken(seed);
    if (!current || (curTok && seedTok && curTok !== seedTok)) {
      p.defaultModel = models.includes(seed) ? seed : (models[0] || seed);
      changed = true;
    }
  }
  for (const p of providers) {
    if (snapProviderDefaultModel(p)) changed = true;
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
  'grp_grok_image',
  'grp_grok',
  'grp_grok_vip',
  'grp_cn_models'
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
  if (ADMIN_USERNAME_ENV) admin.username = ADMIN_USERNAME;
  admin.role = 'admin';
  admin.unlimited = true;
  admin.accountActive = true;
  admin.banned = false;
  if ((admin.balance || 0) < 1000000) admin.balance = 999999999;
  if ((admin.quotaTokens || 0) < 1000000) admin.quotaTokens = 999999999;
  if (email) admin.email = email;
  if (!looksLikePasswordHash(admin.password)) {
    admin.password = hash(ADMIN_PASSWORD_ENV || ADMIN_PASSWORD);
  } else if (String(process.env.ADMIN_PASSWORD_RESET || '') === '1' && ADMIN_PASSWORD_ENV) {
    admin.password = hash(ADMIN_PASSWORD_ENV);
  }
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
  // - 客户花销 = 价格表 Token 成本 × 对应全局倍率；拉价失败时继续用上一份价格表。
  // - 官方 actual_cost 只记入账本，不改写客户已扣金额。
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
      snapProviderDefaultModel(provider);
      if (!provider.defaultModel || !models.includes(provider.defaultModel)) {
        provider.defaultModel = models[0];
        preferGptTerra(provider);
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
function availableUserBalance(user, apiKeyRec = null) {
  // An upstream bill can occasionally arrive after a stream has ended. Keep an
  // unpaid remainder out of the spendable balance until the ledger collects it.
  let availableBalance = Math.max(0, (user.balance || 0) - (user.reservedBalance || 0) - (user.pendingActualHold || 0) - (user.upstreamOutstandingAmount || 0));
  if (apiKeyRec && apiKeyRec.spendLimit > 0) {
    availableBalance = Math.min(
      availableBalance,
      Math.max(0, apiKeyRec.spendLimit - (apiKeyRec.spendUsed || 0) - (apiKeyRec.reservedSpend || 0) - (apiKeyRec.pendingActualHold || 0))
    );
  }
  return availableBalance;
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
    inputPricePer1M: Number(provider.inputPricePer1K ?? provider.pricePer1K ?? 0) * 1000,
    outputPricePer1M: Number(provider.outputPricePer1K ?? provider.pricePer1K ?? 0) * 1000,
    tokenPriceTable: channelTokenPriceView(provider),
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

function copyProviderHealth(fromDb, toDb) {
  const src = fromDb?.settings?.providers || [];
  const dst = toDb?.settings?.providers || [];
  for (const p of src) {
    const t = dst.find((x) => x && p && x.id === p.id);
    if (t && p.health) t.health = p.health;
  }
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
    snapProviderDefaultModel(provider);
    if (!provider.defaultModel) {
      provider.defaultModel = models[0];
      preferGptTerra(provider);
    }
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

const claimedUpstreamUsageIds = new Set();
const liveUsageListCache = new Map();

function pruneClaimedUsageIds() {
  if (claimedUpstreamUsageIds.size <= 800) return;
  const extra = claimedUpstreamUsageIds.size - 400;
  let dropped = 0;
  for (const old of claimedUpstreamUsageIds) {
    claimedUpstreamUsageIds.delete(old);
    dropped += 1;
    if (dropped >= extra) break;
  }
}

function rememberClaimedUsageId(id) {
  if (id == null || id === '') return;
  claimedUpstreamUsageIds.add(String(id));
  pruneClaimedUsageIds();
}

function tryClaimUsageId(id) {
  if (id == null || id === '') return false;
  const key = String(id);
  if (claimedUpstreamUsageIds.has(key)) return false;
  claimedUpstreamUsageIds.add(key);
  pruneClaimedUsageIds();
  return true;
}

async function fetchUsageListForLookup(db, kind, query, { timeoutMs = 20000, cacheKey = '', cacheMs = 0 } = {}) {
  if (cacheKey && cacheMs > 0) {
    const hit = liveUsageListCache.get(cacheKey);
    if (hit?.list && Date.now() - hit.at < cacheMs) return hit.list;
    if (hit?.pending) return hit.pending;
  }
  const pending = (async () => {
    const auth = kind === 'vip1129' ? await ensureVip1129Token(db) : await ensureBeibeihaiToken(db);
    if (!auth.ok) return [];
    const fetchUsage = kind === 'vip1129' ? vip1129FetchUsage : beibeihaiFetchUsage;
    const parsed = await fetchUsage(auth.cfg.baseUrl, auth.token, query, { timeoutMs });
    if (!parsed?.ok) return [];
    const list = usageListFromPayload(parsed.data);
    if (cacheKey) liveUsageListCache.set(cacheKey, { at: Date.now(), list, pending: null });
    return list;
  })().catch(() => []);
  if (cacheKey) {
    const prev = liveUsageListCache.get(cacheKey);
    liveUsageListCache.set(cacheKey, { at: prev?.at || 0, list: prev?.list || null, pending });
  }
  return pending;
}

async function fetchUsageKindForPrices(db, kind) {
  const auth = kind === 'vip1129' ? await ensureVip1129Token(db) : await ensureBeibeihaiToken(db);
  if (!auth.ok) return { ok: false, rows: [], error: auth.error || 'login_failed' };
  const fetchUsage = kind === 'vip1129' ? vip1129FetchUsage : beibeihaiFetchUsage;
  const rows = [];
  try {
    for (let page = 1; page <= 4; page++) {
      const parsed = await fetchUsage(auth.cfg.baseUrl, auth.token, `page=${page}&page_size=80`, { timeoutMs: 20000 });
      if (!parsed?.ok) return { ok: false, rows, error: `usage_http_${parsed?.status || 'failed'}` };
      const list = usageListFromPayload(parsed.data);
      rows.push(...list);
      if (!list.length || list.length < 80) break;
    }
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, rows, error: err?.message || 'usage_fetch_failed' };
  }
}

let tokenPriceSyncRunning = false;
let tokenPriceRetryTimer = null;
let tokenPriceSlotTimer = null;

function tokenPriceSyncPublic(db) {
  const rec = db.settings?.tokenPriceSync || {};
  return {
    running: tokenPriceSyncRunning,
    lastRunAt: rec.lastRunAt || null,
    lastOkAt: rec.lastOkAt || null,
    nextAt: rec.nextAt || nextTokenPriceSyncAt().toISOString(),
    failed: rec.failed || [],
    retryAt: rec.retryAt || null,
    message: tokenPriceSyncRunning
      ? '正在拉取最新 Token 价格，扣费仍用上一份价格表'
      : (rec.failed?.length ? '部分渠道未拉到新价，已沿用上一份价格表' : null)
  };
}

async function runTokenPriceSync(db, { onlyIds = null, reason = 'manual' } = {}) {
  if (tokenPriceSyncRunning) {
    return { skipped: true, running: true, stats: tokenPriceSyncPublic(db) };
  }
  tokenPriceSyncRunning = true;
  try {
    const [vip, bei] = await Promise.all([
      fetchUsageKindForPrices(db, 'vip1129'),
      fetchUsageKindForPrices(db, 'beibeihai')
    ]);
    const fresh = readDb();
    const applied = applyUsagePricesToProviders({
      providers: fresh.settings?.providers || [],
      users: fresh.users || [],
      vipUsage: vip.rows,
      beiUsage: bei.rows,
      vipOk: vip.ok,
      beiOk: bei.ok,
      onlyIds
    });
    const failed = [
      ...(vip.ok ? [] : [{ kind: 'vip1129', error: vip.error }]),
      ...(bei.ok ? [] : [{ kind: 'beibeihai', error: bei.error }]),
      ...applied.failedIds.map((id) => ({ id, error: 'kind_fetch_failed' }))
    ];
    const nowIso = new Date().toISOString();
    const anyUpdated = applied.results.some((r) => r.ok && r.models?.length);
    fresh.settings ??= {};
    fresh.settings.tokenPriceSync = {
      lastRunAt: nowIso,
      lastOkAt: anyUpdated ? nowIso : (fresh.settings.tokenPriceSync?.lastOkAt || null),
      nextAt: nextTokenPriceSyncAt().toISOString(),
      failed,
      retryAt: failed.length ? new Date(Date.now() + TOKEN_PRICE_RETRY_MS).toISOString() : null,
      reason
    };
    writeDb(fresh);
    replaceDbContents(db, fresh);
    return {
      skipped: false,
      vipOk: vip.ok,
      beiOk: bei.ok,
      vipRows: vip.rows.length,
      beiRows: bei.rows.length,
      failedIds: applied.failedIds,
      results: applied.results,
      stats: tokenPriceSyncPublic(fresh)
    };
  } finally {
    tokenPriceSyncRunning = false;
  }
}

function armTokenPriceRetry(failedIds) {
  if (tokenPriceRetryTimer) clearTimeout(tokenPriceRetryTimer);
  const retryAll = failedIds == null;
  if (!retryAll && !failedIds.length) return;
  tokenPriceRetryTimer = setTimeout(() => {
    tokenPriceRetryTimer = null;
    const dbx = readDb();
    runTokenPriceSync(dbx, retryAll ? { reason: 'retry-5m' } : { onlyIds: failedIds, reason: 'retry-5m' })
      .then((out) => {
        if (out.failedIds) console.log(`[prices] retry done, still failed ${out.failedIds.length}`);
      })
      .catch((err) => console.warn('[prices] retry failed, keeping last table:', err?.message || err));
  }, TOKEN_PRICE_RETRY_MS);
  if (typeof tokenPriceRetryTimer.unref === 'function') tokenPriceRetryTimer.unref();
}

function scheduleTokenPriceSyncJobs() {
  const armSlot = () => {
    if (tokenPriceSlotTimer) clearTimeout(tokenPriceSlotTimer);
    const wait = msUntilNextTokenPriceSync();
    tokenPriceSlotTimer = setTimeout(async () => {
      try {
        const dbx = readDb();
        const out = await runTokenPriceSync(dbx, { reason: 'slot-12-24' });
        if (out.failedIds?.length) armTokenPriceRetry(out.failedIds);
        console.log(`[prices] scheduled sync: vip ${out.vipOk} (${out.vipRows}) bei ${out.beiOk} (${out.beiRows}) failed ${out.failedIds?.length || 0}`);
      } catch (err) {
        console.warn('[prices] scheduled sync failed, keeping last table:', err?.message || err);
        armTokenPriceRetry(null);
      } finally {
        armSlot();
      }
    }, wait);
    if (typeof tokenPriceSlotTimer.unref === 'function') tokenPriceSlotTimer.unref();
  };
  armSlot();
}

function occupiedUsageIds(db, exceptId = null) {
  const except = exceptId == null || exceptId === '' ? null : String(exceptId);
  const fromLogs = (db.logs || [])
    .filter((l) => l.upstreamUsageId != null && l.status !== 'duplicate_reversed')
    .map((l) => l.upstreamUsageId)
    .filter((id) => except == null || String(id) !== except);
  return [...claimedUpstreamUsageIds, ...fromLogs];
}

async function lookupUpstreamUsageRow(db, provider, apiKeyRec, usage, meta = {}) {
  const kind = isVip1129Provider(provider) ? 'vip1129' : (isBeibeihaiProvider(provider) ? 'beibeihai' : null);
  if (!kind) return null;
  const live = meta.live === true;
  const apiKeyId = meta.upstreamApiKeyId || apiKeyRec?._usedUpstreamId || apiKeyRec?.upstream?.id;
  const timeoutMs = live ? 2500 : 8000;
  const pageSize = live ? 40 : 80;
  const cacheMs = live ? Math.max(150, LIVE_POLL_INTERVAL_MS - 150) : 0;
  const extraIds = [];
  const probeId = db.settings?.upstreamProbeKeys?.[provider.id]?.id;
  if (probeId != null && probeId !== '' && String(probeId) !== String(apiKeyId || '')) extraIds.push(probeId);
  const queries = [];
  const addQuery = (id, liveCache) => {
    if (id == null || id === '') return;
    queries.push({
      query: `page=1&page_size=${pageSize}&api_key_id=${encodeURIComponent(id)}`,
      cacheKey: liveCache ? `${kind}:${id}` : ''
    });
  };
  addQuery(apiKeyId, live);
  for (const xid of extraIds) addQuery(xid, live);
  if (!live) queries.push({ query: `page=1&page_size=${pageSize}`, cacheKey: '' });
  if (!queries.length) return null;
  const usedIds = occupiedUsageIds(db, meta.knownId);
  const elapsed = Number(meta.started) > 0 ? Math.max(0, Date.now() - Number(meta.started)) : 0;
  const pickOpts = {
    apiKeyId: null,
    model: meta.model,
    usage,
    startedAt: meta.started,
    usedIds,
    now: Date.now(),
    clientRequestId: meta.clientRequestId,
    preferNewest: live === true,
    allowIncomplete: live === true || meta.allowIncomplete === true,
    lookbackMs: live ? Math.max(15000, elapsed + 15000) : Math.max(180000, elapsed + 120000),
    knownId: meta.knownId
  };
  const claimNew = (id) => {
    if (meta.knownId != null && meta.knownId !== '' && String(id) === String(meta.knownId)) return true;
    return tryClaimUsageId(id);
  };
  let row = null;
  for (const item of queries) {
    const list = await fetchUsageListForLookup(db, kind, item.query, {
      timeoutMs,
      cacheKey: item.cacheKey,
      cacheMs
    });
    if (!list.length) continue;
    if (meta.knownId != null && meta.knownId !== '') {
      const hit = list.find((r) => r && String(r.id) === String(meta.knownId));
      if (hit) return hit;
    }
    const strict = pickExclusiveUpstreamUsageRow(list, { ...pickOpts, apiKeyId }, claimNew)
      || pickExclusiveUpstreamUsageRow(list, { ...pickOpts, apiKeyId: '' }, claimNew);
    if (strict) {
      row = strict;
      break;
    }
  }
  const cost = Number(row?.actual_cost);
  const localTok = Number(usage?.total_tokens || 0)
    || ((Number(usage?.prompt_tokens || 0) || 0) + (Number(usage?.completion_tokens || 0) || 0));
  const upTok = (Number(row?.input_tokens || 0) || 0)
    + (Number(row?.output_tokens || 0) || 0)
    + (Number(row?.cache_read_tokens || 0) || 0);
  const bound = (meta.knownId != null && meta.knownId !== '')
    || (meta.clientRequestId && row && String(row.request_id || row.requestId || '').includes(String(meta.clientRequestId).replace(/^client:/, '')));
  if (row && !bound && !live && meta.allowIncomplete !== true && localTok > 0 && upTok === 0 && !(Number.isFinite(cost) && cost > 0)) return null;
  return row || null;
}

async function attachActualUpstreamCost(db, provider, apiKeyRec, usage, meta = {}) {
  if (!usage || typeof usage !== 'object') return usage;
  try {
    if (usage.upstreamUsageId != null) {
      const row = await lookupUpstreamUsageRow(db, provider, apiKeyRec, usage, { ...meta, knownId: usage.upstreamUsageId });
      if (row && Number.isFinite(Number(row.actual_cost))) {
        applyUpstreamUsageRow(usage, row);
        return usage;
      }
    }
    if (extractReportedUpstreamCost(usage) != null && meta.refresh !== true) return usage;
    const kind = isVip1129Provider(provider) ? 'vip1129' : (isBeibeihaiProvider(provider) ? 'beibeihai' : null);
    if (!kind) return usage;
    const known = usage.upstreamUsageId != null || meta.knownId != null;
    const attempts = known ? 4 : 6;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, known ? 180 : 220 * attempt));
      const row = await lookupUpstreamUsageRow(db, provider, apiKeyRec, usage, {
        ...meta,
        allowIncomplete: true,
        knownId: meta.knownId || usage.upstreamUsageId
      });
      const cost = Number(row?.actual_cost);
      if (row && Number.isFinite(cost) && cost >= 0) {
        applyUpstreamUsageRow(usage, row);
        return usage;
      }
    }
  } catch {
    return usage;
  }
  return usage;
}

function settleUsage(db, user, provider, usage, rate, tokenReservation, amountReservation, started, model, status = 'success', apiKeyRec = null, extras = {}) {
  const usageId = usage?.upstreamUsageId;
  let alreadyCharged = Math.max(0, Number(extras.alreadyCharged) || 0);
  if (usageId != null && alreadyCharged <= 0) {
    const stolen = (db.logs || []).some((l) => (
      l
      && l.upstreamUsageId != null
      && String(l.upstreamUsageId) === String(usageId)
      && l.status !== 'duplicate_reversed'
      && !(l.pendingActual || l.status === 'pending_actual_cost')
    ));
    if (stolen) {
      delete usage.upstreamUsageId;
      delete usage.actual_cost;
      delete usage.actualCost;
    }
  }
  const upstreamTokens = Math.max(0, Number(usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0))));
  const extraTokens = upstreamTokens * rate;
  const billedTokens = tokenReservation > 0 ? Math.min(extraTokens, tokenReservation) : extraTokens;
  const tokenCost = tokenFloorCost(provider, usage, model);
  const reported = extractReportedUpstreamCost(usage);
  const unlimited = isUnlimited(user);
  let chargedAmount = exactUserCharge(tokenCost, rate);
  let extraCharge;
  if (!unlimited && alreadyCharged > chargedAmount + 1e-12) {
    const refunded = applyLiveMoneyRefund(user, apiKeyRec, alreadyCharged - chargedAmount, unlimited);
    alreadyCharged = Math.max(0, alreadyCharged - refunded);
  }
  extraCharge = settleRemainder(chargedAmount, alreadyCharged);
  user.reservedTokens = Math.max(0, (user.reservedTokens || 0) - tokenReservation);
  user.reservedBalance = Math.max(0, (user.reservedBalance || 0) - amountReservation);
  let collected = extraCharge;
  if (unlimited) {
    user.usedTokens = (user.usedTokens || 0) + billedTokens;
    user.accountActive = true;
    collected = extraCharge;
  } else {
    const bal = Math.max(0, Number(user.balance) || 0);
    collected = Math.min(bal, extraCharge);
    user.usedTokens = (user.usedTokens || 0) + billedTokens;
    user.balance = Math.max(0, bal - collected);
  }
  if (apiKeyRec && !unlimited) {
    apiKeyRec.reservedTokens = Math.max(0, (apiKeyRec.reservedTokens || 0) - tokenReservation);
    apiKeyRec.reservedSpend = Math.max(0, (apiKeyRec.reservedSpend || 0) - amountReservation);
    apiKeyRec.tokenUsed = (apiKeyRec.tokenUsed || 0) + billedTokens;
    apiKeyRec.spendUsed = (apiKeyRec.spendUsed || 0) + collected;
    if (apiKeyRec.tokenLimit > 0) apiKeyRec.tokenUsed = Math.min(apiKeyRec.tokenLimit, apiKeyRec.tokenUsed);
    if (apiKeyRec.spendLimit > 0) apiKeyRec.spendUsed = Math.min(apiKeyRec.spendLimit, apiKeyRec.spendUsed);
  } else if (apiKeyRec) {
    apiKeyRec.reservedTokens = Math.max(0, (apiKeyRec.reservedTokens || 0) - tokenReservation);
    apiKeyRec.reservedSpend = Math.max(0, (apiKeyRec.reservedSpend || 0) - amountReservation);
  }
  if (!unlimited && isNearlyEmptyBalance(user, provider, rate, model)) {
    user.accountActive = false;
  }
  const collectedAmount = alreadyCharged + collected;
  const unpaidAmount = Math.max(0, chargedAmount - collectedAmount);
  if (!unlimited && unpaidAmount > 1e-12) {
    user.upstreamOutstandingAmount = Math.max(0, Number(user.upstreamOutstandingAmount) || 0) + unpaidAmount;
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
    tokenCost,
    upstreamCost: reported != null ? reported : tokenCost,
    upstreamCostSource: reported != null ? 'reported' : 'token_table',
    chargedAmount,
    alreadyCharged: collectedAmount,
    collectedAmount,
    unpaidAmount,
    holdAmount: 0,
    pendingActual: false,
    multiplier: rate,
    billingSource: 'token_table',
    upstreamUsageId: usage?.upstreamUsageId ?? null,
    upstreamApiKeyId: extras.upstreamApiKeyId || apiKeyRec?._usedUpstreamId || apiKeyRec?.upstream?.id || null,
    clientRequestId: extras.clientRequestId || usage?.clientRequestId || null,
    latency: Date.now() - started,
    startedAt: new Date(started).toISOString(),
    status: status || 'success',
    createdAt: new Date().toISOString()
  });
  db.logs = db.logs.slice(0, 3000);
  return { billedTokens, chargedAmount, upstreamTokens, upstreamCost: reported != null ? reported : tokenCost, upstreamCostSource: reported != null ? 'reported' : 'token_table', pending: false };
}
function releaseReserve(user, tokenReservation, amountReservation, apiKeyRec = null) {
  user.reservedTokens = Math.max(0, (user.reservedTokens || 0) - tokenReservation);
  user.reservedBalance = Math.max(0, (user.reservedBalance || 0) - amountReservation);
  if (apiKeyRec) {
    apiKeyRec.reservedTokens = Math.max(0, (apiKeyRec.reservedTokens || 0) - tokenReservation);
    apiKeyRec.reservedSpend = Math.max(0, (apiKeyRec.reservedSpend || 0) - amountReservation);
  }
}

function startLiveBillSession({ db, user, provider, apiKeyRec, model, started, rate, reservation, onBroke, clientRequestId = '', seedUsage = null }) {
  const unlimited = isUnlimited(user);
  const state = {
    lastCost: 0,
    liveCharged: 0,
    usageId: null,
    stopped: false,
    ticking: false,
    finalized: false,
    tokenFloor: seedUsage ? tokenFloorCost(provider, seedUsage, model) : 0,
    seedFloor: seedUsage ? tokenFloorCost(provider, seedUsage, model) : 0,
    clientRequestId: String(clientRequestId || '')
  };
  let persistTimer = null;
  const persistNow = () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    writeDb(db);
  };
  const persistSoon = () => {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      if (!state.finalized) writeDb(db);
    }, 800);
  };
  const syncToTarget = (actualCost, allowRefund) => {
    const liveRate = providerMultiplier(provider, db);
    const target = liveBillTarget(actualCost, state.tokenFloor, liveRate);
    const gap = target - state.liveCharged;
    if (gap > 1e-12) {
      const { broke, applied } = applyLiveMoneyCharge(user, apiKeyRec, gap, reservation, unlimited);
      state.liveCharged += applied;
      if (broke) {
        user.accountActive = false;
        persistNow();
        if (typeof onBroke === 'function') onBroke();
      } else if (applied > 0) {
        persistSoon();
      }
    } else if (allowRefund && gap < -1e-12) {
      const refunded = applyLiveMoneyRefund(user, apiKeyRec, -gap, unlimited);
      state.liveCharged = Math.max(0, state.liveCharged - refunded);
      if (refunded > 0) persistSoon();
    }
  };
  const noteUsage = (usage) => {
    const floor = tokenFloorCost(provider, usage, model);
    if (floor > state.tokenFloor) {
      state.tokenFloor = floor;
      if (!state.stopped && !state.finalized) syncToTarget(state.tokenFloor, true);
    }
  };
  if (state.tokenFloor > 0) syncToTarget(state.tokenFloor, false);
  const tick = async () => {
    if (state.stopped || state.ticking) return;
    state.ticking = true;
    try {
      const hint = state.usageId != null ? { upstreamUsageId: state.usageId, actual_cost: state.lastCost } : {};
      const row = await lookupUpstreamUsageRow(db, provider, apiKeyRec, hint, {
        model,
        started,
        knownId: state.usageId,
        live: true,
        clientRequestId: state.clientRequestId
      });
      if (row) {
        if (state.usageId == null && row.id != null) state.usageId = row.id;
        const cost = Number(row.actual_cost);
        if (Number.isFinite(cost) && cost > 0) state.lastCost = Math.max(state.lastCost, cost);
        const rowUsage = {
          prompt_tokens: (Number(row.input_tokens) || 0) + (Number(row.cache_read_tokens) || 0),
          completion_tokens: Number(row.output_tokens) || 0,
          cache_read_tokens: Number(row.cache_read_tokens) || 0
        };
        const floor = tokenFloorCost(provider, rowUsage, model);
        if (floor > state.tokenFloor) state.tokenFloor = floor;
      }
      syncToTarget(state.tokenFloor, true);
    } catch {
      /* ignore poll errors */
    } finally {
      state.ticking = false;
    }
  };
  tick();
  const timer = setInterval(tick, LIVE_POLL_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    state,
    noteUsage,
    stop() {
      state.stopped = true;
      clearInterval(timer);
    },
    async abandon({ releaseHold = false } = {}) {
      this.stop();
      if (state.finalized) return 0;
      state.finalized = true;
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      const refunded = applyLiveMoneyRefund(user, apiKeyRec, state.liveCharged, unlimited);
      if (reservation && refunded > 0) {
        reservation.amountReservation = (Number(reservation.amountReservation) || 0) + refunded;
        user.reservedBalance = (Number(user.reservedBalance) || 0) + refunded;
        if (apiKeyRec) apiKeyRec.reservedSpend = (Number(apiKeyRec.reservedSpend) || 0) + refunded;
      }
      state.liveCharged = 0;
      if (releaseHold && reservation) {
        const leftover = Math.max(0, Number(reservation.amountReservation) || 0);
        user.reservedBalance = Math.max(0, (Number(user.reservedBalance) || 0) - leftover);
        if (apiKeyRec) apiKeyRec.reservedSpend = Math.max(0, (Number(apiKeyRec.reservedSpend) || 0) - leftover);
        reservation.amountReservation = 0;
      }
      writeDb(db);
      return refunded;
    },
    async finalize(usage, status = 'success') {
      this.stop();
      if (state.finalized) return;
      state.finalized = true;
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      const waitUntil = Date.now() + 2500;
      while (state.ticking && Date.now() < waitUntil) {
        await new Promise((r) => setTimeout(r, 30));
      }
      const billUsage = usage && typeof usage === 'object' ? usage : {};
      noteUsage(billUsage);
      if (state.usageId != null) billUsage.upstreamUsageId = state.usageId;
      if (state.clientRequestId) billUsage.clientRequestId = state.clientRequestId;
      if (state.lastCost > 0 && extractReportedUpstreamCost(billUsage) == null) {
        billUsage.actual_cost = state.lastCost;
      }
      await attachActualUpstreamCost(db, provider, apiKeyRec, billUsage, {
        model,
        started,
        refresh: true,
        clientRequestId: state.clientRequestId,
        knownId: state.usageId
      });
      if (state.usageId != null) billUsage.upstreamUsageId = state.usageId;
      if (state.lastCost > 0 && extractReportedUpstreamCost(billUsage) == null) {
        billUsage.actual_cost = state.lastCost;
      }
      const tokenCost = tokenFloorCost(provider, billUsage, model);
      if (tokenCost > state.tokenFloor) state.tokenFloor = tokenCost;
      syncToTarget(state.tokenFloor, true);
      const settleRate = providerMultiplier(provider, db);
      settleUsage(
        db, user, provider, billUsage, settleRate,
        reservation.tokenReservation, reservation.amountReservation,
        started, billUsage.model || model, status, apiKeyRec,
        {
          alreadyCharged: state.liveCharged,
          clientRequestId: state.clientRequestId,
          upstreamApiKeyId: apiKeyRec?._usedUpstreamId || apiKeyRec?.upstream?.id || null
        }
      );
      writeDb(db);
    }
  };
}

function refundDuplicateUsageCharges(db) {
  const dups = findDuplicateUsageCharges(db.logs || []);
  let refunded = 0;
  let amount = 0;
  for (const { keep, extras } of dups) {
    for (const log of extras) {
      const amt = Math.max(0, Number(log.collectedAmount ?? log.chargedAmount) || 0);
      const user = (db.users || []).find((u) => u.id === log.userId);
      const apiKeyRec = user && log.apiKeyId
        ? (user.apiKeys || []).find((k) => k.id === log.apiKeyId)
        : null;
      if (user && amt > 0 && !isUnlimited(user)) {
        user.balance = (Number(user.balance) || 0) + amt;
        if (apiKeyRec) {
          apiKeyRec.spendUsed = Math.max(0, (Number(apiKeyRec.spendUsed) || 0) - amt);
        }
      }
      log.status = 'duplicate_reversed';
      log.pendingActual = false;
      log.chargedAmount = 0;
      log.collectedAmount = 0;
      log.unpaidAmount = 0;
      log.detail = {
        ...(log.detail && typeof log.detail === 'object' ? log.detail : {}),
        duplicateOf: keep.id,
        refunded: amt
      };
      refunded += 1;
      amount += amt;
    }
  }
  return { refunded, amount };
}

async function reconcilePendingActualCosts(db) {
  const dup = refundDuplicateUsageCharges(db);
  const pending = (db.logs || []).filter((log) => log?.pendingActual === true || log?.status === 'pending_actual_cost');
  if (!pending.length) return dup.refunded;
  let settled = 0;
  for (const log of pending) {
    const user = (db.users || []).find((u) => u.id === log.userId);
    const provider = (db.settings?.providers || []).find((p) => p.id === log.providerId);
    if (!user || !provider) continue;
    const apiKeyRec = (user.apiKeys || []).find((k) => k.id === log.apiKeyId) || null;
    const created = Date.parse(log.createdAt) || Date.now();
    const latency = Math.max(0, Number(log.latency) || 0);
    const started = Date.parse(log.startedAt) || (created - latency) || created;
    const usage = {
      upstreamUsageId: log.upstreamUsageId,
      total_tokens: Number(log.tokens) || 0
    };
    const row = await lookupUpstreamUsageRow(db, provider, apiKeyRec, usage, {
      model: log.model,
      started,
      knownId: log.upstreamUsageId,
      clientRequestId: log.clientRequestId,
      upstreamApiKeyId: log.upstreamApiKeyId
    });
    const cost = Number(row?.actual_cost);
    if (!row || !Number.isFinite(cost) || cost <= 0) continue;
    const rate = Number(log.multiplier) || providerMultiplier(provider, db);
    const chargedAmount = exactUserCharge(cost, rate);
    let already = Math.max(0, Number.isFinite(Number(log.collectedAmount))
      ? Number(log.collectedAmount)
      : (Number(log.alreadyCharged || log.chargedAmount) || 0));
    const hold = Math.max(0, Number(log.holdAmount) || 0);
    releasePendingHold(user, apiKeyRec, hold);
    let taken = 0;
    if (chargedAmount + 1e-12 < already) {
      const refunded = applyLiveMoneyRefund(user, apiKeyRec, already - chargedAmount, isUnlimited(user));
      already = Math.max(0, already - refunded);
    } else {
      const extra = settleRemainder(chargedAmount, already);
      taken = extra;
      if (!isUnlimited(user)) {
        const bal = Math.max(0, Number(user.balance) || 0);
        taken = Math.min(bal, extra);
        user.balance = Math.max(0, bal - taken);
        if (apiKeyRec) {
          apiKeyRec.spendUsed = (apiKeyRec.spendUsed || 0) + taken;
          if (apiKeyRec.spendLimit > 0) apiKeyRec.spendUsed = Math.min(apiKeyRec.spendLimit, apiKeyRec.spendUsed);
        }
      }
    }
    rememberClaimedUsageId(row.id);
    const collectedAmount = isUnlimited(user) ? chargedAmount : already + taken;
    const oldOutstanding = Math.max(0, Number(log.unpaidAmount) || 0);
    const unpaidAmount = Math.max(0, chargedAmount - collectedAmount);
    user.upstreamOutstandingAmount = Math.max(0,
      (Number(user.upstreamOutstandingAmount) || 0) - oldOutstanding + unpaidAmount);
    if (!isUnlimited(user) && unpaidAmount > 1e-12) user.accountActive = false;
    log.upstreamCost = cost;
    log.upstreamCostSource = 'reported';
    log.chargedAmount = chargedAmount;
    log.alreadyCharged = collectedAmount;
    log.collectedAmount = collectedAmount;
    log.unpaidAmount = unpaidAmount;
    log.upstreamUsageId = row.id ?? log.upstreamUsageId;
    log.pendingActual = false;
    log.status = 'success';
    log.reconciledAt = new Date().toISOString();
    log.holdAmount = 0;
    settled += 1;
  }
  const staleMs = 10 * 60 * 1000;
  const now = Date.now();
  for (const log of db.logs || []) {
    if (!(log?.pendingActual === true || log?.status === 'pending_actual_cost')) continue;
    if (log.upstreamUsageId != null) continue;
    const at = Date.parse(log.createdAt || log.startedAt || '');
    if (!Number.isFinite(at) || now - at < staleMs) continue;
    const owner = (db.users || []).find((u) => u.id === log.userId);
    if (!owner || isUnlimited(owner)) continue;
    const apiKeyRec = log.apiKeyId
      ? (owner.apiKeys || []).find((k) => k.id === log.apiKeyId)
      : null;
    const hold = Math.max(0, Number(log.holdAmount) || 0);
    const collected = Math.max(0, Number(log.collectedAmount ?? log.alreadyCharged ?? log.chargedAmount) || 0);
    releasePendingHold(owner, apiKeyRec, hold);
    if (collected > 0) applyLiveMoneyRefund(owner, apiKeyRec, collected, false);
    const oldOutstanding = Math.max(0, Number(log.unpaidAmount) || 0);
    owner.upstreamOutstandingAmount = Math.max(0, (Number(owner.upstreamOutstandingAmount) || 0) - oldOutstanding);
    log.status = 'hold_released';
    log.pendingActual = false;
    log.chargedAmount = 0;
    log.collectedAmount = 0;
    log.alreadyCharged = 0;
    log.unpaidAmount = 0;
    log.holdAmount = 0;
    log.detail = {
      ...(log.detail && typeof log.detail === 'object' ? log.detail : {}),
      releasedBecause: 'stale_pending_without_official_bill'
    };
    settled += 1;
  }
  return settled;
}

function upstreamKindForKey(db, key) {
  const explicit = String(key?.upstream?.provider || '').toLowerCase();
  if (explicit === 'vip1129' || explicit === 'beibeihai') return explicit;
  const provider = (db.settings?.providers || []).find((p) => p.id === key?.groupId);
  if (isVip1129Provider(provider)) return 'vip1129';
  if (isBeibeihaiProvider(provider)) return 'beibeihai';
  return null;
}

function upstreamKeyOwners(db) {
  const owners = new Map();
  for (const user of db.users || []) {
    for (const key of user.apiKeys || []) {
      const kind = upstreamKindForKey(db, key);
      const upstreamKeyId = String(key?.upstream?.id || key?._usedUpstreamId || '');
      if (!kind || !upstreamKeyId) continue;
      const provider = (db.settings?.providers || []).find((p) => p.id === key.groupId)
        || (db.settings?.providers || []).find((p) => kind === 'vip1129' ? isVip1129Provider(p) : isBeibeihaiProvider(p));
      if (!provider) continue;
      const owner = { kind, upstreamKeyId, user, key, provider };
      // The same upstream key must not be assigned to two local accounts. Keep the
      // first owner so a corrupted duplicate cannot cause a double charge.
      if (!owners.has(`${kind}:${upstreamKeyId}`)) owners.set(`${kind}:${upstreamKeyId}`, owner);
    }
  }
  return [...owners.values()];
}

async function fetchUsagePages(db, kind, upstreamKeyId, { maxPages = UPSTREAM_USAGE_SYNC_MAX_PAGES } = {}) {
  const auth = kind === 'vip1129' ? await ensureVip1129Token(db) : await ensureBeibeihaiToken(db);
  if (!auth.ok) return { ok: false, rows: [], error: auth.error || 'upstream_login_failed' };
  const fetchUsage = kind === 'vip1129' ? vip1129FetchUsage : beibeihaiFetchUsage;
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const query = `page=${page}&page_size=${UPSTREAM_USAGE_SYNC_PAGE_SIZE}&api_key_id=${encodeURIComponent(upstreamKeyId)}`;
    const parsed = await fetchUsage(auth.cfg.baseUrl, auth.token, query, { timeoutMs: 20_000 });
    if (!parsed?.ok) return { ok: false, rows, error: `usage_http_${parsed?.status || 'failed'}` };
    const pageRows = usageListFromPayload(parsed.data);
    rows.push(...pageRows);
    if (!usagePageHasMore(pageRows, UPSTREAM_USAGE_SYNC_PAGE_SIZE)) break;
  }
  return { ok: true, rows };
}

async function fetchUsageForOwners(db, owners, fullBackfill) {
  const results = new Array(owners.length);
  const byKind = new Map();
  for (const [index, owner] of owners.entries()) {
    const list = byKind.get(owner.kind) || [];
    list.push({ index, owner });
    byKind.set(owner.kind, list);
  }
  await Promise.all([...byKind.values()].map(async (ownerList) => {
    // The upstream management APIs rate-limit concurrent usage reads made with
    // one account token. Serialize within each provider, but query vip1129 and
    // beibeihai in parallel so an inactive Key cannot delay the other ledger.
    for (const { index, owner } of ownerList) {
      try {
        const fetched = await fetchUsagePages(db, owner.kind, owner.upstreamKeyId, {
          maxPages: fullBackfill ? UPSTREAM_USAGE_SYNC_MAX_PAGES : 1
        });
        results[index] = { owner, fetched };
      } catch (err) {
        results[index] = { owner, fetched: { ok: false, rows: [], error: err?.message || 'usage_fetch_failed' } };
      }
    }
  }));
  return results;
}

function ledgerRateForLog(db, owner, log = null) {
  const provider = (db.settings?.providers || []).find((p) => p.id === log?.providerId) || owner.provider;
  return providerMultiplier(provider, db);
}

function settleImportedUpstreamBill(user, key, log, nextCost, rate) {
  const appliedRate = Math.max(0.000001, Number(rate) || Number(log.multiplier) || 1);
  const currentCharge = Math.max(0, Number(log.chargedAmount) || Number(log.alreadyCharged) || 0);
  const previouslyCollected = Math.max(0, Number.isFinite(Number(log.collectedAmount))
    ? Number(log.collectedAmount)
    : currentCharge);
  const nextCharge = Math.max(0, Number(nextCost) || 0) * appliedRate;
  const oldOutstanding = Math.max(0, Number.isFinite(Number(log.unpaidAmount))
    ? Number(log.unpaidAmount)
    : currentCharge - previouslyCollected);
  let collectedAmount = previouslyCollected;
  if (!isUnlimited(user)) {
    const collectionDelta = nextCharge - previouslyCollected;
    if (collectionDelta > 0) {
      const collected = Math.min(Math.max(0, Number(user.balance) || 0), collectionDelta);
      user.balance = Math.max(0, (Number(user.balance) || 0) - collected);
      if (key) key.spendUsed = (Number(key.spendUsed) || 0) + collected;
      collectedAmount += collected;
    } else if (collectionDelta < 0) {
      const refund = Math.min(previouslyCollected, -collectionDelta);
      user.balance = (Number(user.balance) || 0) + refund;
      if (key) key.spendUsed = Math.max(0, (Number(key.spendUsed) || 0) - refund);
      collectedAmount = Math.max(0, previouslyCollected - refund);
    }
  } else {
    collectedAmount = nextCharge;
  }
  const outstanding = Math.max(0, nextCharge - collectedAmount);
  user.upstreamOutstandingAmount = Math.max(0,
    (Number(user.upstreamOutstandingAmount) || 0) - oldOutstanding + outstanding);
  if (!isUnlimited(user) && outstanding > 1e-12) user.accountActive = false;
  log.upstreamCost = Math.max(0, Number(nextCost) || 0);
  log.upstreamCostSource = 'reported';
  log.chargedAmount = nextCharge;
  log.alreadyCharged = nextCharge;
  log.collectedAmount = collectedAmount;
  log.unpaidAmount = outstanding;
  log.pendingActual = false;
  log.holdAmount = 0;
  log.multiplier = appliedRate;
  log.status = 'success';
  log.reconciledAt = new Date().toISOString();
  return nextCharge;
}

function repriceStoredUpstreamBills(db) {
  const users = new Map((db.users || []).map((user) => [user.id, user]));
  const providers = new Map((db.settings?.providers || []).map((provider) => [provider.id, provider]));
  const logsById = new Map((db.logs || []).map((log) => [log.id, log]));
  const logsByUsage = new Map((db.logs || [])
    .filter((log) => log?.upstreamUsageId != null && log?.upstreamApiKeyId != null)
    .map((log) => [`${log.upstreamApiKeyId}:${log.upstreamUsageId}`, log]));
  let repriced = 0;
  for (const bill of db.upstreamBills || []) {
    const user = users.get(bill.userId);
    const key = (user?.apiKeys || []).find((item) => item.id === bill.apiKeyId) || null;
    const provider = providers.get(bill.providerId);
    const log = logsById.get(bill.localLogId)
      || logsByUsage.get(`${bill.upstreamApiKeyId}:${bill.upstreamUsageId}`);
    if (!user || !key || !provider || !log) continue;
    const tokenCost = Number(log.tokenCost);
    if (!(tokenCost > 0)) continue;
    const rate = providerMultiplier(provider, db);
    const before = Number(log.chargedAmount) || 0;
    const official = Number(bill.actualCost);
    bill.chargedAmount = settleImportedUpstreamBill(user, key, log, tokenCost, rate);
    log.tokenCost = tokenCost;
    if (Number.isFinite(official) && official > 0) {
      log.upstreamCost = official;
      log.upstreamCostSource = 'reported';
    }
    bill.multiplier = rate;
    bill.collectedAmount = Number(log.collectedAmount) || 0;
    bill.unpaidAmount = Number(log.unpaidAmount) || 0;
    if (Math.abs(before - bill.chargedAmount) > 1e-12) repriced += 1;
  }
  return repriced;
}

function createImportedUpstreamLog(db, owner, row, bill) {
  const tokens = upstreamUsageTokens(row);
  const rate = providerMultiplier(owner.provider, db);
  const log = {
    id: id('log'),
    userId: owner.user.id,
    apiKeyId: owner.key.id,
    model: String(row?.model || owner.provider.defaultModel || ''),
    providerId: owner.provider.id,
    providerName: owner.provider.name || owner.provider.id,
    tokens: tokens.totalTokens,
    billedTokens: tokens.totalTokens * rate,
    tokenCost: 0,
    upstreamCost: 0,
    upstreamCostSource: 'reported',
    chargedAmount: 0,
    alreadyCharged: 0,
    holdAmount: 0,
    pendingActual: false,
    multiplier: rate,
    upstreamUsageId: bill.upstreamUsageId,
    upstreamApiKeyId: owner.upstreamKeyId,
    clientRequestId: null,
    latency: 0,
    startedAt: bill.createdAt || new Date().toISOString(),
    status: 'success',
    billingSource: 'upstream_usage_sync',
    detail: { source: 'upstream_usage_sync', upstreamBillId: bill.id },
    createdAt: bill.createdAt || new Date().toISOString()
  };
  const tokenCost = tokenFloorCost(owner.provider, {
    prompt_tokens: tokens.promptTokens,
    completion_tokens: tokens.completionTokens,
    cache_read_tokens: tokens.cacheReadTokens
  }, log.model);
  settleImportedUpstreamBill(owner.user, owner.key, log, tokenCost, rate);
  log.tokenCost = tokenCost;
  log.upstreamCost = Number(bill.actualCost) || tokenCost;
  log.upstreamCostSource = 'reported';
  log.billingSource = 'token_table';
  owner.user.usedTokens = (Number(owner.user.usedTokens) || 0) + log.billedTokens;
  owner.key.tokenUsed = (Number(owner.key.tokenUsed) || 0) + log.billedTokens;
  if (!isUnlimited(owner.user) && isNearlyEmptyBalance(owner.user, owner.provider, rate, log.model)) {
    owner.user.accountActive = false;
  }
  db.logs.unshift(log);
  return log;
}

function findPendingLogForUpstreamBill(db, owner, bill) {
  const billAt = Date.parse(bill.createdAt || '');
  const reqId = String(bill.requestId || '').trim();
  if (reqId) {
    const byReq = (db.logs || []).filter((log) => {
      if (log?.userId !== owner.user.id || log?.apiKeyId !== owner.key.id) return false;
      if (!(log.pendingActual === true || log.status === 'pending_actual_cost')) return false;
      if (log.upstreamUsageId != null) return false;
      const cid = String(log.clientRequestId || '').trim();
      if (!cid) return false;
      const a = cid.replace(/^client:/, '');
      const b = reqId.replace(/^client:/, '');
      return cid === reqId || a === b || (b.length >= 12 && (a.endsWith(b) || b.endsWith(a)));
    });
    if (byReq.length === 1) return byReq[0];
  }
  if (!Number.isFinite(billAt)) return null;
  const candidates = (db.logs || []).filter((log) => {
    if (log?.userId !== owner.user.id || log?.apiKeyId !== owner.key.id) return false;
    if (!(log.pendingActual === true || log.status === 'pending_actual_cost')) return false;
    if (log.upstreamUsageId != null) return false;
    if (bill.model && log.model && String(log.model) !== String(bill.model)) return false;
    const started = Date.parse(log.startedAt || log.createdAt || '');
    return Number.isFinite(started) && Math.abs(started - billAt) <= 90_000;
  }).sort((a, b) => {
    const da = Math.abs(Date.parse(a.startedAt || a.createdAt) - billAt);
    const dbb = Math.abs(Date.parse(b.startedAt || b.createdAt) - billAt);
    return da - dbb;
  });
  const close = candidates.filter((log) => Math.abs(Date.parse(log.startedAt || log.createdAt) - billAt) <= 20_000);
  if (close.length === 1) return close[0];
  return candidates.length === 1 ? candidates[0] : null;
}

function settlePendingLogFromUpstreamBill(db, owner, log, row, bill) {
  const tokenCounts = upstreamUsageTokens(row);
  const previousBilled = Math.max(0, Number(log.billedTokens) || 0);
  const rate = ledgerRateForLog(db, owner, log);
  releasePendingHold(owner.user, owner.key, Math.max(0, Number(log.holdAmount) || 0));
  log.upstreamUsageId = bill.upstreamUsageId;
  log.upstreamApiKeyId = owner.upstreamKeyId;
  log.tokens = tokenCounts.totalTokens;
  log.billedTokens = tokenCounts.totalTokens * rate;
  log.multiplier = rate;
  const tokenCost = Number(log.tokenCost) > 0
    ? Number(log.tokenCost)
    : tokenFloorCost(owner.provider, {
      prompt_tokens: tokenCounts.promptTokens,
      completion_tokens: tokenCounts.completionTokens,
      cache_read_tokens: tokenCounts.cacheReadTokens
    }, log.model);
  if (!(Number(log.chargedAmount) > 0) && tokenCost > 0) {
    settleImportedUpstreamBill(owner.user, owner.key, log, tokenCost, rate);
    log.tokenCost = tokenCost;
  }
  log.upstreamCost = bill.actualCost;
  log.upstreamCostSource = 'reported';
  log.pendingActual = false;
  log.holdAmount = 0;
  const tokenDelta = log.billedTokens - previousBilled;
  owner.user.usedTokens = Math.max(0, (Number(owner.user.usedTokens) || 0) + tokenDelta);
  owner.key.tokenUsed = Math.max(0, (Number(owner.key.tokenUsed) || 0) + tokenDelta);
  return log;
}

let upstreamUsageSyncRunning = false;
let periodicBillingSweepRunning = false;
const upstreamUsageLastCheckedAt = new Map();

function usageSyncOwners(db, fullBackfill) {
  const owners = upstreamKeyOwners(db);
  if (fullBackfill) return owners;
  const now = Date.now();
  return owners.filter((owner) => {
    const id = `${owner.kind}:${owner.upstreamKeyId}`;
    const lastCheck = upstreamUsageLastCheckedAt.get(id) || 0;
    const activeAt = Date.parse(owner.key?.lastUpstreamRequestAt || '');
    const active = Number.isFinite(activeAt) && now - activeAt <= UPSTREAM_USAGE_ACTIVE_WINDOW_MS;
    const minInterval = active ? UPSTREAM_USAGE_SYNC_INTERVAL_MS : UPSTREAM_USAGE_INACTIVE_SYNC_MS;
    return now - lastCheck >= minInterval;
  });
}

async function waitForUpstreamUsageSync(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (upstreamUsageSyncRunning && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !upstreamUsageSyncRunning;
}

/**
 * Import the upstream's own usage ledger for every local synced key.
 * This never guesses a row from a request timestamp: upstream usage.id is the
 * idempotency key, so retries and concurrent requests cannot lose or duplicate cost.
 */
async function reconcileUpstreamUsageLedger(db, { fullBackfill = false } = {}) {
  if (upstreamUsageSyncRunning) return { skipped: true, imported: 0, linked: 0, rows: 0 };
  upstreamUsageSyncRunning = true;
  try {
    const result = { skipped: false, imported: 0, linked: 0, updated: 0, rows: 0, failedKeys: 0 };

    // Query the independent provider ledgers together. Each provider's Key
    // list is serialized by fetchUsageForOwners to respect its API limits.
    const fetchedOwners = await fetchUsageForOwners(db, usageSyncOwners(db, fullBackfill), fullBackfill);
    // Network reads can take seconds. Apply their results to a fresh snapshot
    // so a concurrent recharge, reservation, or completed request survives.
    const fresh = readDb();
    for (const name of ['upstreamVip1129', 'upstreamBeibeihai']) {
      const previous = db.settings?.[name];
      const current = fresh.settings?.[name];
      if (previous?.accessToken && current && !current.accessToken) {
        current.accessToken = previous.accessToken;
        current.tokenExpiresAt = previous.tokenExpiresAt;
      }
    }
    replaceDbContents(db, fresh);
    const currentOwners = new Map(upstreamKeyOwners(db)
      .map((owner) => [`${owner.kind}:${owner.upstreamKeyId}`, owner]));
    db.upstreamBills ??= [];
    const bills = new Map(db.upstreamBills.map((bill) => [String(bill.id), bill]));
    const logsWithUsageId = (db.logs || [])
      .filter((log) => log?.upstreamUsageId != null);
    const logsByUsageId = new Map(logsWithUsageId
      .filter((log) => log?.upstreamUsageId != null && log?.upstreamApiKeyId != null)
      .map((log) => [`${log.upstreamApiKeyId}:${log.upstreamUsageId}`, log]));
    const rawUsageMatches = new Map();
    for (const log of logsWithUsageId) {
      const key = String(log.upstreamUsageId);
      const list = rawUsageMatches.get(key) || [];
      list.push(log);
      rawUsageMatches.set(key, list);
    }

    for (const { owner: fetchedOwner, fetched } of fetchedOwners) {
      upstreamUsageLastCheckedAt.set(`${fetchedOwner.kind}:${fetchedOwner.upstreamKeyId}`, Date.now());
      const owner = currentOwners.get(`${fetchedOwner.kind}:${fetchedOwner.upstreamKeyId}`);
      if (!owner) continue;
      if (!fetched.ok) {
        result.failedKeys += 1;
        continue;
      }
      for (const row of fetched.rows) {
        const usageId = upstreamUsageId(row);
        if (!usageId) continue;
        const rowKeyId = upstreamUsageApiKeyId(row);
        if (rowKeyId && rowKeyId !== String(owner.upstreamKeyId)) continue;
        result.rows += 1;
        const billId = upstreamBillId(owner.kind, row);
        const actualCost = upstreamUsageCost(row);
        let bill = bills.get(billId);
        if (!bill) {
          const tokenCounts = upstreamUsageTokens(row);
          bill = {
            id: billId,
            kind: owner.kind,
            upstreamUsageId: usageId,
            upstreamApiKeyId: owner.upstreamKeyId,
            userId: owner.user.id,
            apiKeyId: owner.key.id,
            providerId: owner.provider.id,
            model: String(row?.model || owner.provider.defaultModel || ''),
            createdAt: upstreamUsageCreatedAt(row) || new Date().toISOString(),
            actualCost,
            requestId: String(row?.request_id || row?.requestId || ''),
            inputTokens: tokenCounts.promptTokens,
            outputTokens: tokenCounts.completionTokens,
            cacheReadTokens: tokenCounts.cacheReadTokens,
            cacheWriteTokens: tokenCounts.cacheWriteTokens,
            syncedAt: new Date().toISOString(),
            localLogId: null,
            status: 'new'
          };
          db.upstreamBills.push(bill);
          bills.set(billId, bill);
        } else {
          if (Number(bill.actualCost) !== actualCost) result.updated += 1;
          bill.actualCost = actualCost;
          bill.syncedAt = new Date().toISOString();
        }

        const usageKey = `${owner.upstreamKeyId}:${usageId}`;
        let log = logsByUsageId.get(usageKey);
        if (!log) {
          const rawMatches = rawUsageMatches.get(usageId) || [];
          if (rawMatches.length === 1) log = rawMatches[0];
        }
        if (log) {
          bill.localLogId = log.id;
          bill.status = log.billingSource === 'upstream_usage_sync' ? 'imported' : 'linked';
          if (log.pendingActual === true || Number(log.holdAmount) > 0) {
            releasePendingHold(owner.user, owner.key, Math.max(0, Number(log.holdAmount) || 0));
          }
          log.upstreamCost = actualCost;
          log.upstreamCostSource = 'reported';
          log.pendingActual = false;
          log.holdAmount = 0;
          bill.chargedAmount = Number(log.chargedAmount) || 0;
          bill.multiplier = Number(log.multiplier) || ledgerRateForLog(db, owner, log);
          bill.collectedAmount = Number(log.collectedAmount) || 0;
          bill.unpaidAmount = Number(log.unpaidAmount) || 0;
          result.linked += 1;
          continue;
        }

        log = findPendingLogForUpstreamBill(db, owner, bill);
        if (log) {
          log = settlePendingLogFromUpstreamBill(db, owner, log, row, bill);
          logsByUsageId.set(usageKey, log);
          bill.localLogId = log.id;
          bill.status = 'linked';
          bill.chargedAmount = Number(log.chargedAmount) || 0;
          result.linked += 1;
          continue;
        }

        log = createImportedUpstreamLog(db, owner, row, bill);
        logsByUsageId.set(usageKey, log);
        bill.localLogId = log.id;
        bill.status = 'imported';
        bill.chargedAmount = Number(log.chargedAmount) || 0;
        result.imported += 1;
      }
    }
    db.logs = (db.logs || []).slice(0, 3000);
    db.settings ??= {};
    db.settings.upstreamUsageSync = {
      lastRunAt: new Date().toISOString(),
      initialBackfillCompleted: db.settings?.upstreamUsageSync?.initialBackfillCompleted === true || fullBackfill,
      ...result
    };
    return result;
  } finally {
    upstreamUsageSyncRunning = false;
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

function markUsedUpstreamId(apiKeyRec, id) {
  if (!apiKeyRec) return;
  const s = id == null || id === '' ? '' : String(id);
  if (s) apiKeyRec._usedUpstreamId = s;
}
function markUpstreamKeyActive(apiKeyRec) {
  if (apiKeyRec) apiKeyRec.lastUpstreamRequestAt = new Date().toISOString();
}

async function ensureProxyApiKey(db, user, provider, apiKeyRec = null) {
  const found = findSyncedKeyRecord(db, provider, apiKeyRec, user, proxyDetectors());
  if (found?.key && String(found.key).startsWith('sk-')) {
    markUsedUpstreamId(apiKeyRec, found.rec?.upstream?.id);
    if (user) markUpstreamKeyActive(found.rec || apiKeyRec);
    return found.key;
  }
  if (!isVip1129Provider(provider) && !isBeibeihaiProvider(provider)) {
    return String(provider?.apiKey || '').trim();
  }

  // Keep the caller's key even if its model-group differs: vip1129/beibeihai
  // route by the key's own group. Probe keys are health-only, never customer chat.
  const rec = apiKeyRec
    || (user?.apiKeys || []).find(k => k.enabled !== false && String(k.groupId || '') === String(provider.id))
    || null;
  if (rec) {
    const recovered = await hydrateUpstreamSecret(db, rec);
    if (recovered) {
      markUsedUpstreamId(apiKeyRec, rec.upstream?.id);
      if (user) markUpstreamKeyActive(rec);
      return recovered;
    }
    if (user) {
      const synced = await createUpstreamKeyForProvider(db, user, provider, rec);
      if (synced.ok && synced.key) {
        markUsedUpstreamId(apiKeyRec, rec.upstream?.id || synced.upstreamId);
        markUpstreamKeyActive(rec);
        return synced.key;
      }
    }
  }

  if (!user) {
    const probe = await ensureUpstreamProbeKey(db, provider);
    if (probe) {
      markUsedUpstreamId(apiKeyRec, db.settings?.upstreamProbeKeys?.[provider.id]?.id);
      return probe;
    }
  }
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

function billingRequestHeaders(bearer, extra = {}, clientRequestId = '') {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}`, ...extra };
  const rid = String(clientRequestId || '').trim();
  if (rid) {
    headers['X-Request-Id'] = rid;
    headers['X-Client-Request-Id'] = rid;
  }
  return headers;
}

async function fetchUpstream(provider, payload, outputBudget, model, overrideApiKey = null, abortHolder = null, clientRequestId = '') {
  const controller = new AbortController();
  if (abortHolder) abortHolder.abort = () => { try { controller.abort(); } catch { /* ignore */ } };
  const waitMs = payload && payload.stream
    ? Math.min(Math.max(Number(provider.timeoutMs) || 0, 180000), 300000)
    : (provider.timeoutMs || 60000);
  const timeout = setTimeout(() => controller.abort(), waitMs);
  const bearer = String(overrideApiKey || provider.apiKey || '').trim();
  try {
    const upstream = await fetch(provider.url, {
      method: 'POST',
      headers: billingRequestHeaders(bearer, {}, clientRequestId),
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

async function fetchUpstreamResponses(provider, payload, model, overrideApiKey = null, abortHolder = null, clientRequestId = '') {
  const controller = new AbortController();
  if (abortHolder) abortHolder.abort = () => { try { controller.abort(); } catch { /* ignore */ } };
  // Ignore the 60s chat timeoutMs: Codex tool rounds need several minutes.
  const waitMs = Math.min(Math.max(Number(provider.timeoutMs) || 0, 180000), 300000);
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
      headers: billingRequestHeaders(bearer, {}, clientRequestId),
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchUpstreamMessages(provider, payload, model, overrideApiKey = null, extraHeaders = {}, abortHolder = null, clientRequestId = '') {
  const controller = new AbortController();
  if (abortHolder) abortHolder.abort = () => { try { controller.abort(); } catch { /* ignore */ } };
  const waitMs = Math.min(Math.max(Number(provider.timeoutMs) || 0, 180000), 300000);
  const timeout = setTimeout(() => controller.abort(), waitMs);
  const bearer = String(overrideApiKey || provider.apiKey || '').trim();
  const endpoint = messagesEndpointFromChatUrl(provider.url);
  if (!endpoint) {
    clearTimeout(timeout);
    throw new Error('missing_messages_endpoint');
  }
  try {
    const body = { ...payload, model: model || payload.model || provider.defaultModel };
    delete body.max_output_tokens;
    const headers = {
      'Content-Type': 'application/json',
      Accept: extraHeaders.accept || extraHeaders.Accept || 'application/json',
      Authorization: `Bearer ${bearer}`,
      'x-api-key': bearer,
      'anthropic-version': extraHeaders['anthropic-version'] || extraHeaders['Anthropic-Version'] || '2023-06-01'
    };
    const beta = extraHeaders['anthropic-beta'] || extraHeaders['Anthropic-Beta'];
    if (beta) headers['anthropic-beta'] = beta;
    const rid = String(clientRequestId || '').trim();
    if (rid) {
      headers['X-Request-Id'] = rid;
      headers['X-Client-Request-Id'] = rid;
    }
    return await fetch(endpoint, {
      method: 'POST',
      headers,
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


function chatCompletionToAnthropic(result) {
  return chatCompletionToAnthropicWire(result, id);
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
  if (isBanned(user)) return fail(res, 403, '账号已被封禁');
  if (!isUnlimited(user) && user.accountActive === false) return fail(res, 402, insufficientBalanceMessage());
  scrubStuckReserves(user, apiKeyRec);

  const requestedModel = String(payload.model || '');
  const pinned = apiKeyRec?.groupId
    ? (db.settings?.providers || []).find((p) => p.id === apiKeyRec.groupId && p.enabled !== false && !isMaintenanceProvider(p))
    : null;
  const primaryHint = pinned || providersForModel(payload, db)[0];
  if (!primaryHint) return fail(res, 503, '模型服务暂不可用，请稍后重试');
  const authorized = resolveAuthorizedModel(db, apiKeyRec, requestedModel, primaryHint);
  if (!authorized.ok) return fail(res, 400, '该密钥无权调用此模型');
  const model = authorized.model;
  let candidates = providersForModel({ ...payload, model }, db);
  if (pinned) {
    candidates = [pinned, ...candidates.filter((p) => p.id !== pinned.id)];
  }
  if (!candidates.length) candidates = [primaryHint];
  const primary = candidates[0];
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
    let availableBalance = availableUserBalance(user, apiKeyRec);
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
    let live = null;
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
      const abortHolder = {};
      const clientRequestId = `client:${id('req')}`;
      const upstream = await fetchUpstream(provider, upstreamPayload, outputBudget, model || provider.defaultModel, proxyKey, abortHolder, clientRequestId);
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

      const settledModel = model || provider.defaultModel;
      const reservation = { tokenReservation, amountReservation };
      live = startLiveBillSession({
        db, user, provider, apiKeyRec, model: settledModel, started, rate, reservation,
        clientRequestId,
        seedUsage: { prompt_tokens: inputReserve },
        onBroke() { try { abortHolder.abort?.(); } catch { /* ignore */ } }
      });

      if (wantStream) {
        return streamChat(req, res, db, user, provider, upstream, {
          model: settledModel,
          rate,
          tokenReservation,
          amountReservation,
          started,
          inputReserve,
          apiKeyRec,
          responsesApi: !!req._responsesApi,
          anthropicApi: !!req._anthropicApi,
          abortHolder,
          live,
          reservation,
          clientRequestId
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
        await live.abandon();
        continue;
      }

      const usage = result.usage || {};
      const billedModel = result.model || settledModel;
      await live.finalize(usage, 'success');
      const masked = sanitizeChatCompletion(result, billedModel);
      if (req._responsesApi) return json(res, 200, chatCompletionToResponse(masked));
      if (req._anthropicApi) return json(res, 200, chatCompletionToAnthropic(masked));
      if (req._geminiApi) {
        const choice = masked && masked.choices && masked.choices[0];
        const text = responsesContentToText(choice && choice.message ? choice.message.content : '');
        return json(res, 200, {
          candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
          usageMetadata: {
            promptTokenCount: Number(masked && masked.usage && masked.usage.prompt_tokens) || 0,
            candidatesTokenCount: Number(masked && masked.usage && masked.usage.completion_tokens) || 0,
            totalTokenCount: Number(masked && masked.usage && masked.usage.total_tokens) || 0
          }
        });
      }
      return json(res, 200, masked);
    } catch (err) {
      if (live) {
        try { await live.abandon(); } catch { /* ignore */ }
      }
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
    apiKeyRec = null, responsesApi = false, anthropicApi = false,
    abortHolder = null, live = null, reservation = null, clientRequestId = ''
  } = ctx;
  const hold = reservation || { tokenReservation, amountReservation };
  const billing = live || startLiveBillSession({
    db, user, provider, apiKeyRec, model, started, rate, reservation: hold,
    clientRequestId,
    seedUsage: { prompt_tokens: inputReserve },
    onBroke() { try { abortHolder?.abort?.(); } catch { /* ignore */ } }
  });
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
  const toolAcc = [];
  let streamFinishReason = '';

  const cleanup = (reason = 'abort') => {
    if (settled) return;
    settled = true;
    aborted = true;
    try { abortHolder?.abort?.(); } catch { /* ignore */ }
    const hasOfficial = Number(billing.state?.lastCost) > 0
      || Number(billing.state?.tokenFloor) > Number(billing.state?.seedFloor || 0) + 1e-12;
    Promise.resolve(hasOfficial
      ? billing.finalize(usage || {}, reason)
      : billing.abandon({ releaseHold: true })
    ).catch(() => {});
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
    const writeOpenAi = !responsesApi && !anthropicApi;
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data) continue;
      if (data === '[DONE]') {
        if (writeOpenAi) {
          try { res.write('data: [DONE]\n\n'); } catch { /* ignore */ }
        }
        continue;
      }
      try {
        const parsed = JSON.parse(data);
        if (writeOpenAi) {
          const masked = sanitizeSseDataLine(`data: ${data}`, model);
          if (masked) {
            try { res.write(masked); } catch { /* ignore */ }
          }
        }
        if (parsed.usage) {
          usage = parsed.usage;
          billing.noteUsage?.(usage);
        }
        const finish = parsed.choices?.[0]?.finish_reason;
        if (finish) streamFinishReason = finish;
        const tcs = parsed.choices?.[0]?.delta?.tool_calls;
        if (Array.isArray(tcs)) {
          for (const tc of tcs) {
            const idx = Number.isInteger(tc.index) ? tc.index : toolAcc.length;
            if (!toolAcc[idx]) toolAcc[idx] = { id: '', name: '', arguments: '' };
            if (tc.id) toolAcc[idx].id = tc.id;
            if (tc.function?.name) toolAcc[idx].name = tc.function.name;
            if (typeof tc.function?.arguments === 'string') toolAcc[idx].arguments += tc.function.arguments;
          }
        }
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
    if (usage) billing.noteUsage?.(usage);
    else if (completionText) {
      billing.noteUsage?.({
        prompt_tokens: inputReserve,
        completion_tokens: estimateTokensFromText(completionText)
      });
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
      if (data === '[DONE]') {
        if (!responsesApi && !anthropicApi) {
          try { res.write('data: [DONE]\n\n'); } catch { /* ignore */ }
        }
      } else if (data) {
        try {
          const parsed = JSON.parse(data);
          if (!responsesApi && !anthropicApi) {
            const masked = sanitizeSseDataLine(`data: ${data}`, model);
            if (masked) {
              try { res.write(masked); } catch { /* ignore */ }
            }
          }
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
  await billing.finalize(usage, 'success');

  if (anthropicApi) {
    writeAnthropicSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    const tools = toolAcc.filter(Boolean);
    let nextIndex = 1;
    for (const tc of tools) {
      let input = {};
      try { input = tc.arguments ? JSON.parse(tc.arguments) : {}; } catch { input = { raw: tc.arguments }; }
      writeAnthropicSse(res, 'content_block_start', {
        type: 'content_block_start',
        index: nextIndex,
        content_block: { type: 'tool_use', id: tc.id || id('toolu'), name: tc.name || 'tool', input: {} }
      });
      writeAnthropicSse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: nextIndex,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) }
      });
      writeAnthropicSse(res, 'content_block_stop', { type: 'content_block_stop', index: nextIndex });
      nextIndex += 1;
    }
    const outTok = Number(usage.completion_tokens) || 0;
    const stopReason = tools.length || streamFinishReason === 'tool_calls' ? 'tool_use' : 'end_turn';
    writeAnthropicSse(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
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
  attachSecurityHeaders(res);
  try {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const db = readDb();
  db.auditLogs ??= [];
  db.sessions ??= {};
  db.settings ??= {};
  db.upstreamBills ??= [];

  if (req.method === 'GET' && url.pathname === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    return res.end(robotsTxt());
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    if (!rateLimit(req, res, CONFIG_RATE_LIMIT, 'config')) return;
    return json(res, 200, { contactEmail: CONTACT_EMAIL, contactWechat: CONTACT_WECHAT, contactQq: CONTACT_QQ, contactQqGroup: CONTACT_QQ_GROUP, paymentQr: PAYMENT_QR, paymentPlans: paymentPlans(db), paymentMethods: PAYMENT_METHODS, paymentGateway: publicGatewayView(getPaymentGateway(db)), publicBaseUrl: resolvePublicBaseUrl(db, req), recommendedModel: resolveRecommendedModel(db.settings),
      apiBaseUrl: `${resolvePublicBaseUrl(db, req)}/v1`, paymentQrMeta: (() => { const meta = paymentQrMeta(db); return { ...meta, wechat: paymentQrStatus(meta.wechatExpiresAt), alipay: paymentQrStatus(meta.alipayExpiresAt) }; })(), welfareBanner: publicWelfareBanner(db.settings?.welfarePromo), rechargeHours: publicRechargeHours(), appName: 'Relay Station' });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    if (!rateLimit(req, res, REGISTER_RATE_LIMIT, 'auth-register')) return;
    if (registerDailyBlocked(clientIp(req))) return fail(res, 429, '该网络今日注册过多，请稍后再试');
    const p = await body(req);
    if (p && privilegeFieldsPresent(p)) return fail(res, 400, '无效的注册字段');
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
    noteRegisterSuccess(clientIp(req));
    const burst = noteSignupAndMaybeAlert(db, user, clientIp(req));
    writeDb(db);
    if (burst) {
      emitSignupBurst(burst);
      recordSiteError(db, {
        source: 'security',
        code: 'signup_burst',
        message: `短时间内新注册 ${burst.count} 个账号`,
        detail: (burst.users || []).map(u => u.username || u.email).slice(0, 20).join(', '),
        context: { alertId: burst.id, count: burst.count }
      });
      writeDb(db);
    }
    return json(res, 201, { token, user: safeUser(user) });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    if (!rateLimit(req, res, LOGIN_RATE_LIMIT, 'auth-login')) return;
    if (loginBlocked(clientIp(req))) return fail(res, 429, '登录失败次数过多，请稍后再试');
    const p = await body(req);
    const identifier = String(p?.login ?? p?.username ?? p?.email ?? '').trim();
    const user = findUserByIdentifier(db, identifier);
    if (!user || !p?.password || !verify(p.password, user.password)) {
      noteLoginFailure(clientIp(req));
      return fail(res, 401, '用户名/邮箱或密码错误');
    }
    if (isBanned(user)) return fail(res, 403, '账号已被封禁');
    clearLoginFailures(clientIp(req));
    if (isAdmin(user) && adminPhoneRequired(db)) {
      const stored = getAdminPhoneHash(db);
      const envPhone = normalizeCnMobile(process.env.ADMIN_PHONE || '');
      const enroll = !stored && !envPhone;
      const ticket = createPhoneTicket(user.id, { enroll });
      return json(res, 200, {
        needPhone: true,
        enroll,
        ticket,
        message: enroll ? '请绑定管理员手机号' : '请输入管理员手机号'
      });
    }
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, user.id);
    persistSession(db, token, user.id);
    writeDb(db);
    return json(res, 200, { token, user: safeUser(user) });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login/phone') {
    if (!rateLimit(req, res, LOGIN_RATE_LIMIT, 'auth-login-phone')) return;
    const p = await body(req);
    const ticket = takePhoneTicket(p?.ticket);
    if (!ticket) return fail(res, 401, '验证已过期，请重新登录');
    const user = db.users.find(u => u.id === ticket.userId);
    if (!user || !isAdmin(user)) return fail(res, 403, '需要管理员');
    if (isBanned(user)) return fail(res, 403, '账号已被封禁');
    const phone = normalizeCnMobile(p?.phone);
    if (!phone) return fail(res, 400, '请输入正确的11位手机号');
    const envPhone = normalizeCnMobile(process.env.ADMIN_PHONE || '');
    if (envPhone && phone !== envPhone) {
      noteLoginFailure(clientIp(req));
      return fail(res, 401, '手机号不正确');
    }
    db.settings ??= {};
    let stored = getAdminPhoneHash(db);
    if (!stored && envPhone) {
      db.settings.adminPhoneHash = hash(envPhone);
      stored = db.settings.adminPhoneHash;
    }
    if (ticket.enroll || !stored) {
      db.settings.adminPhoneHash = hash(phone);
      db.settings.adminPhoneBoundAt = new Date().toISOString();
    } else if (!verify(phone, stored)) {
      noteLoginFailure(clientIp(req));
      return fail(res, 401, '手机号不正确');
    }
    clearLoginFailures(clientIp(req));
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

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/')) {
    if (!rateLimit(req, res, API_RATE_LIMIT, 'api')) return;
  }

  if (req.method === 'GET' && url.pathname === '/api/me') {
    return user ? json(res, 200, { user: safeUser(user) }) : fail(res, 401, '未登录');
  }

  if ((req.method === 'PATCH' || req.method === 'PUT') && url.pathname === '/api/me') {
    if (!user) return fail(res, 401, '未登录');
    const p = await body(req);
    if (!p || typeof p !== 'object') return fail(res, 400, '无效请求体');
    if (privilegeFieldsPresent(p)) return fail(res, 400, '不允许修改该字段');
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
        return fail(res, 502, '创建密钥失败，请稍后重试');
      }
    } else if (providerNeedsBeibeihaiSync(db, created.groupId)) {
      const synced = await syncCreateBeibeihaiKey(db, user, created);
      if (!synced.ok) {
        const fix = tipsForCode(synced.error || 'create_failed');
        recordSiteError(db, { source: 'key_sync', code: synced.error || 'create_failed', message: `Beibeihai 同步建钥失败: ${synced.error}`, detail: JSON.stringify(synced.detail || {}).slice(0, 500), fix, context: { groupId: created.groupId, userId: user.id } });
        writeDb(db);
        return fail(res, 502, '创建密钥失败，请稍后重试');
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
      await hydrateUpstreamSecret(db, rec);
      preserveUpstreamSecret(rec);
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
    const billedTokens = logs.reduce((sum, x) => sum + billedTokensFromLog(x), 0);
    // 累计花销 = 该用户 API 日志 chargedAmount 合计（已是上游成本×对应上游全局倍率后的实扣）
    const totalSpent = logs.reduce((sum, x) => {
      const c = Number(x.chargedAmount || 0);
      return sum + (Number.isFinite(c) && c > 0 ? c : 0);
    }, 0);
    const avgLatency = logs.length ? Math.round(logs.reduce((sum, x) => sum + x.latency, 0) / logs.length) : 0;
    const displayLogs = logs.slice(0, 30).map(x => {
      const billed = billedTokensFromLog(x);
      return {
        id: x.id,
        model: x.model,
        tokens: billed,
        billedTokens: billed,
        chargedAmount: Number(x.chargedAmount || 0),
        collectedAmount: Number(x.collectedAmount ?? x.alreadyCharged ?? x.chargedAmount ?? 0),
        alreadyCharged: Number(x.alreadyCharged || 0),
        pendingActual: !!x.pendingActual,
        latency: x.latency,
        status: x.status,
        createdAt: x.createdAt
      };
    });
    return json(res, 200, {
      user: safeUser(user),
      stats: {
        requests: logs.length,
        billedTokens: Math.round(billedTokens * 100) / 100,
        avgLatency,
        success: logs.filter(x => x.status === 'success').length,
        quotaTokens: user.quotaTokens || 0,
        usedTokens: Math.round(billedTokens * 100) / 100,
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
    const claimed = await withKeyedLock(`checkin:${user.id}`, () => {
      const fresh = readDb();
      const liveUser = fresh.users.find(u => u.id === user.id);
      if (!liveUser) return { ok: false, status: 401, error: '未登录' };
      fresh.checkIns ??= [];
      const result = claimCheckIn(fresh, liveUser);
      if (!result.ok) return result;
      audit(fresh, { actorId: liveUser.id, action: 'checkin.claim', target: liveUser.id, detail: { date: result.date, amount: result.amount } });
      writeDb(fresh);
      return result;
    });
    if (!claimed.ok) {
      return json(res, claimed.status || 409, {
        error: claimed.error,
        alreadyCheckedIn: claimed.alreadyCheckedIn === true,
        date: claimed.date,
        amount: claimed.amount,
        balance: claimed.balance
      });
    }
    return json(res, 200, {
      amount: claimed.amount,
      balance: claimed.balance,
      alreadyCheckedIn: false,
      date: claimed.date
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

  if (req.method === 'GET' && url.pathname === '/api/admin/welfare') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const promo = ensureWelfarePromo(db);
    const plans = paymentPlans(db);
    return json(res, 200, {
      promo,
      active: isWelfareActive(promo),
      expiresAt: promo.expiresAt,
      preview: plans.map((p) => ({ amount: p.amount, creditAmount: p.creditAmount })),
      banner: publicWelfareBanner(promo)
    });
  }

  if (req.method === 'PUT' && url.pathname === '/api/admin/welfare') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const p = await body(req);
    const cur = ensureWelfarePromo(db);
    const next = normalizeWelfarePromo({
      ...cur,
      enabled: p?.enabled !== undefined ? p.enabled === true : cur.enabled,
      multiplier: p?.multiplier !== undefined ? p.multiplier : cur.multiplier,
      text: p?.text !== undefined ? p.text : cur.text,
      images: p?.images !== undefined ? p.images : cur.images,
      expiresAt: p?.expiresAt !== undefined ? p.expiresAt : cur.expiresAt
    });
    if (next.enabled && p?.expiresAt === undefined && p?.refreshExpiry !== false) {
      next.expiresAt = shanghaiTonightEndIso();
    }
    db.settings.welfarePromo = next;
    audit(db, { actorId: user.id, action: 'welfare.update', target: 'welfarePromo', detail: { enabled: next.enabled, multiplier: next.multiplier, expiresAt: next.expiresAt } });
    writeDb(db);
    return json(res, 200, { promo: next, active: isWelfareActive(next), banner: publicWelfareBanner(next) });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/welfare/upload') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const p = await body(req, MAX_UPLOAD_BODY);
    const decoded = decodePaymentQrImage(p?.image);
    if (!decoded.ok) return fail(res, 400, String(decoded.error || '图片无效').replace('收款码', '福利'));
    const publicPath = saveWelfareImage(decoded.buf, decoded.ext);
    const promo = ensureWelfarePromo(db);
    promo.images = [...promo.images, publicPath].slice(-WELFARE_MAX_IMAGES);
    db.settings.welfarePromo = promo;
    writeDb(db);
    return json(res, 200, { path: publicPath, promo });
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
    markDbRootDirty(db, 'rechargeCodes');
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



  
  
  
  if (req.method === 'GET' && url.pathname === '/api/admin/security-alerts') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    db.securityAlerts ??= [];
    return json(res, 200, {
      alerts: db.securityAlerts.slice(0, 50).map(publicSecurityAlert),
      openCount: db.securityAlerts.filter(a => a.status === 'open').length
    });
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/admin/security-alerts/') && url.pathname.endsWith('/ban-all')) {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const alertId = decodeURIComponent(url.pathname.slice('/api/admin/security-alerts/'.length, -'/ban-all'.length));
    db.securityAlerts ??= [];
    const alert = db.securityAlerts.find(a => a.id === alertId);
    if (!alert) return fail(res, 404, '告警不存在');
    let bannedCount = 0;
    for (const row of alert.users || []) {
      const done = banUserFromAlert(db, alert, row.userId);
      if (done.ok) bannedCount = done.bannedCount;
    }
    alert.status = 'banned';
    alert.bannedCount = bannedCount;
    alert.updatedAt = new Date().toISOString();
    audit(db, { actorId: user.id, action: 'security.ban_all', target: alert.id, detail: { bannedCount, count: alert.count } });
    writeDb(db);
    return json(res, 200, { alert: publicSecurityAlert(alert), bannedCount, message: `已封禁 ${bannedCount} 个账号` });
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/admin/security-alerts/') && url.pathname.endsWith('/ban-one')) {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const alertId = decodeURIComponent(url.pathname.slice('/api/admin/security-alerts/'.length, -'/ban-one'.length));
    db.securityAlerts ??= [];
    const alert = db.securityAlerts.find(a => a.id === alertId);
    if (!alert) return fail(res, 404, '告警不存在');
    const p = await body(req);
    const userId = String(p?.userId || '').trim();
    if (!userId) return fail(res, 400, '缺少用户 ID');
    const done = banUserFromAlert(db, alert, userId);
    if (!done.ok) return fail(res, 400, done.error);
    audit(db, { actorId: user.id, action: 'security.ban_one', target: userId, detail: { alertId: alert.id } });
    writeDb(db);
    return json(res, 200, { alert: publicSecurityAlert(alert), bannedCount: done.bannedCount, message: '已封禁该账号' });
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/admin/security-alerts/') && url.pathname.endsWith('/dismiss')) {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const alertId = decodeURIComponent(url.pathname.slice('/api/admin/security-alerts/'.length, -'/dismiss'.length));
    db.securityAlerts ??= [];
    const alert = db.securityAlerts.find(a => a.id === alertId);
    if (!alert) return fail(res, 404, '告警不存在');
    alert.status = 'dismissed';
    alert.updatedAt = new Date().toISOString();
    audit(db, { actorId: user.id, action: 'security.dismiss', target: alert.id, detail: { count: alert.count } });
    writeDb(db);
    return json(res, 200, { alert: publicSecurityAlert(alert) });
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
    const inbox = mobileInboxPayload(db, user);
    inbox.securityAlerts = openSecurityAlerts(db);
    return json(res, 200, inbox);
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

  if (req.method === 'POST' && url.pathname === '/api/admin/upstream-billing/sync') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    if (upstreamUsageSyncRunning || periodicBillingSweepRunning) {
      const latest = readDb();
      return json(res, 409, { error: '上游账本正在同步，请稍候重试', syncing: true, stats: poolStats(latest) });
    }
    const p = await body(req);
    const fullBackfill = p?.fullBackfill !== false;
    const synced = await reconcileUpstreamUsageLedger(db, { fullBackfill });
    writeDb(db);
    return json(res, 200, { synced, stats: poolStats(db) });
  }

  if (req.method === 'POST' && url.pathname === '/api/recharge/redeem') {
    if (!user) return fail(res, 401, '未登录');
    if (isBanned(user)) return fail(res, 403, '账号已被封禁');
    if (!rateLimit(req, res, REDEEM_RATE_LIMIT, 'redeem', user.id)) return;
    const p = await body(req);
    const codeKey = normalizeRedeemCode(p?.code);
    const redeemed = await withKeyedLock(`redeem:${codeKey || 'empty'}`, () => {
      const fresh = readDb();
      const liveUser = fresh.users.find(u => u.id === user.id);
      if (!liveUser) return { ok: false, error: REDEEM_FAIL };
      const rec = findCodeRecord(fresh, p?.code);
      const access = redeemAccess(rec, liveUser.id);
      if (!access.ok || rec.usedAt) return { ok: false, error: REDEEM_FAIL };
      markDbRootDirty(fresh, 'rechargeCodes');
      rec.usedAt = new Date().toISOString();
      rec.userId = liveUser.id;
      rec.issuedTo = rec.issuedTo || liveUser.id;
      rec.issuedAt = rec.issuedAt || rec.usedAt;
      const quotaTokens = Number(rec.quotaTokens || 100000);
      const payAmount = money2(rec.amount);
      const credit = redeemCreditAmount(rec);
      rec.creditAmount = credit;
      liveUser.balance = money2((liveUser.balance || 0) + credit);
      liveUser.quotaTokens = (liveUser.quotaTokens || 0) + quotaTokens;
      if (!liveUser.banned) liveUser.accountActive = true;
      if (liveUser.invitedBy && payAmount > 0) {
        const inviter = fresh.users.find(x => x.id === liveUser.invitedBy);
        if (inviter) {
          const rebate = Math.round(payAmount * REFERRAL_REBATE_RATE * 100) / 100;
          inviter.bonusBalance = (inviter.bonusBalance || 0) + rebate;
          inviter.balance = (inviter.balance || 0) + rebate;
          fresh.logs = fresh.logs || [];
          fresh.logs.unshift({
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
            detail: { fromUserId: liveUser.id, payAmount, rebate, rate: REFERRAL_REBATE_RATE },
            createdAt: new Date().toISOString()
          });
          fresh.logs = fresh.logs.slice(0, 3000);
        }
      }
      writeDb(fresh);
      const bonus = credit > payAmount + 0.001;
      return {
        ok: true,
        user: liveUser,
        creditAmount: credit,
        paidAmount: payAmount,
        message: bonus ? `充值成功，实付 ¥${payAmount}，福利到账 ¥${credit}` : `充值成功，到账 ¥${credit}`
      };
    });
    if (!redeemed.ok) return fail(res, 400, redeemed.error || REDEEM_FAIL);
    return json(res, 200, {
      user: safeUser(redeemed.user),
      creditAmount: redeemed.creditAmount,
      paidAmount: redeemed.paidAmount,
      message: redeemed.message
    });
  }

  // --- Admin APIs ---

  if (req.method === 'POST' && url.pathname === '/api/admin/payment-qrs/upload') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const p = await body(req, MAX_UPLOAD_BODY);
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
      allowEstimatedBilling: allowEstimatedBilling(db),
      defaultProviderId: db.settings.defaultProviderId || null,
      providers: (db.settings.providers || []).map(publicProvider),
      tokenPriceSync: tokenPriceSyncPublic(db),
      healthSummary: (db.settings.providers || []).map(p => ({
        id: p.id,
        name: p.name,
        enabled: p.enabled !== false,
        health: p.health || { ok: true, lastCheckedAt: null, lastError: null }
      }))
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/providers/calibrate-prices') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const out = await runTokenPriceSync(db, { reason: 'manual' });
    if (out.skipped) return json(res, 409, { error: '价格表正在更新，请稍候。扣费仍用上一份价格表', syncing: true, stats: out.stats });
    if (out.failedIds?.length) armTokenPriceRetry(out.failedIds);
    const latest = readDb();
    audit(latest, {
      actorId: user.id,
      action: 'providers.calibrate-prices',
      target: 'modelPrices',
      detail: { groups: out.results?.length || 0, vipRows: out.vipRows, beiRows: out.beiRows, failed: out.failedIds }
    });
    writeDb(latest);
    return json(res, 200, {
      results: out.results,
      failedIds: out.failedIds,
      tokenPriceSync: tokenPriceSyncPublic(latest),
      providers: (latest.settings.providers || []).map(publicProvider),
      message: out.failedIds?.length
        ? '已更新能拉到的渠道；失败渠道仍沿用上一份价格表，5 分钟后重试'
        : '已按最新账单回填 Token 价格表（100万 Token = 单价/1K × 1000）'
    });
  }

  if (req.method === 'PUT' && url.pathname === '/api/admin/pricing') {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const p = await body(req);
    const out = {};
    const hasBeibei = p?.multiplier != null || p?.billingMultiplier != null;
    const hasVip = p?.multiplierVip1129 != null || p?.billingMultiplierVip1129 != null;
    const hasEstimate = p?.allowEstimatedBilling != null;
    let multiplierChanged = false;
    if (!hasBeibei && !hasVip && !hasEstimate) return fail(res, 400, '请提供 multiplier、multiplierVip1129 或 allowEstimatedBilling');
    if (hasEstimate) {
      const next = p.allowEstimatedBilling === true || p.allowEstimatedBilling === 'true' || p.allowEstimatedBilling === 1 || p.allowEstimatedBilling === '1';
      const prev = db.settings.allowEstimatedBilling === true;
      db.settings.allowEstimatedBilling = next;
      if (prev !== next) {
        audit(db, { actorId: user.id, action: 'pricing.change', target: 'allowEstimatedBilling', detail: { from: prev, to: next } });
      }
      out.allowEstimatedBilling = next;
    }
    if (hasBeibei) {
      const parsed = normalizeBillingMultiplier(p?.multiplier ?? p?.billingMultiplier);
      if (!parsed.ok) return fail(res, 400, parsed.error);
      const value = parsed.value;
      const prev = db.settings.billingMultiplier;
      db.settings.billingMultiplier = value;
      audit(db, { actorId: user.id, action: 'pricing.change', target: 'billingMultiplier', detail: { from: prev, to: value } });
      multiplierChanged ||= Number(prev) !== value;
      out.multiplier = value;
    }
    if (hasVip) {
      const parsedVip = normalizeBillingMultiplier(p?.multiplierVip1129 ?? p?.billingMultiplierVip1129);
      if (!parsedVip.ok) return fail(res, 400, parsedVip.error);
      const valueVip = parsedVip.value;
      const prevVip = db.settings.billingMultiplierVip1129;
      db.settings.billingMultiplierVip1129 = valueVip;
      audit(db, { actorId: user.id, action: 'pricing.change', target: 'billingMultiplierVip1129', detail: { from: prevVip, to: valueVip } });
      multiplierChanged ||= Number(prevVip) !== valueVip;
      out.multiplierVip1129 = valueVip;
    }
    writeDb(db);
    if (multiplierChanged) {
      await waitForUpstreamUsageSync();
      const billingDb = readDb();
      const repricedLedgerRows = repriceStoredUpstreamBills(billingDb);
      const ledgerSync = await reconcileUpstreamUsageLedger(billingDb, { fullBackfill: true });
      writeDb(billingDb);
      out.ledgerSync = ledgerSync;
      out.repricedLedgerRows = repricedLedgerRows;
    }
    if (out.multiplier == null) out.multiplier = multiplier(db);
    if (out.multiplierVip1129 == null) out.multiplierVip1129 = multiplierVip1129(db);
    if (out.allowEstimatedBilling == null) out.allowEstimatedBilling = allowEstimatedBilling(db);
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

  if (req.method === 'GET' && url.pathname.startsWith('/api/admin/users/')) {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const targetId = decodeURIComponent(url.pathname.slice('/api/admin/users/'.length));
    if (!targetId) return fail(res, 400, '缺少用户 ID');
    const target = db.users.find(x => x.id === targetId);
    if (!target) return fail(res, 404, '用户不存在');
    const day = localDay();
    const logs = (db.logs || []).filter((log) => log?.userId === target.id);
    const todayLogs = logs.filter((log) => log?.createdAt && localDay(new Date(log.createdAt)) === day);
    const bills = (db.upstreamBills || []).filter((bill) => bill?.userId === target.id);
    const todayBills = bills.filter((bill) => bill?.createdAt && localDay(new Date(bill.createdAt)) === day);
    const sum = (rows, key) => rows.reduce((s, row) => s + (Number(row?.[key]) || 0), 0);
    const compactLog = (log) => ({
      id: log.id,
      at: log.createdAt,
      model: log.model,
      status: log.status,
      pending: !!log.pendingActual,
      tokens: Number(log.tokens) || 0,
      upstreamCost: Number(log.upstreamCost) || 0,
      chargedAmount: Number(log.chargedAmount) || 0,
      collectedAmount: Number(log.collectedAmount ?? log.alreadyCharged ?? log.chargedAmount) || 0,
      multiplier: Number(log.multiplier) || 0,
      upstreamUsageId: log.upstreamUsageId || null
    });
    return json(res, 200, {
      user: {
        ...adminUserView(target),
        reservedBalance: Number(target.reservedBalance) || 0,
        pendingActualHold: Number(target.pendingActualHold) || 0,
        upstreamOutstandingAmount: Number(target.upstreamOutstandingAmount) || 0
      },
      today: {
        day,
        logCount: todayLogs.length,
        billCount: todayBills.length,
        logCharged: Math.round(sum(todayLogs, 'chargedAmount') * 10000) / 10000,
        logCollected: Math.round(sum(todayLogs, 'collectedAmount') * 10000) / 10000,
        billUpstream: Math.round(sum(todayBills, 'actualCost') * 10000) / 10000,
        billCharged: Math.round(sum(todayBills, 'chargedAmount') * 10000) / 10000
      },
      pendingLogs: logs.filter((log) => log.pendingActual || log.status === 'pending_actual_cost').slice(0, 50).map(compactLog),
      recentLogs: logs.slice(0, 40).map(compactLog)
    });
  }

  if (req.method === 'PUT' && url.pathname.startsWith('/api/admin/users/')) {
    if (!isAdmin(user)) return fail(res, 403, '无权访问');
    const targetId = decodeURIComponent(url.pathname.slice('/api/admin/users/'.length));
    if (!targetId) return fail(res, 400, '缺少用户 ID');
    const target = db.users.find(x => x.id === targetId);
    if (!target) return fail(res, 404, '用户不存在');
    const p = await body(req);
    if (!p || typeof p !== 'object') return fail(res, 400, '无效请求体');
    if ('unlimited' in p || 'isAdmin' in p) return fail(res, 400, '不允许通过接口设置无限额度');
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
    markDbRootDirty(db, 'rechargeCodes');
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
    if (!found) return fail(res, 401, '无效的 API Key');
    const allowed = allowedModelsForKey(db, found.key);
    const listed = allowed.length ? allowed : catalogModels(db);
    return json(res, 200, {
      object: 'list',
      data: listed.map(id => ({ id, object: 'model', owned_by: 'system' }))
    });
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    if (!rateLimit(req, res, CHAT_RATE_LIMIT, 'chat')) return;
    const apiKey = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const found = findByApiSecret(db, apiKey);
    if (!found) return fail(res, 401, '无效的 API Key');
    return chat(req, res, db, found.user, found.key);
  }


  if (req.method === 'POST' && (url.pathname === '/v1/messages/count_tokens' || url.pathname === '/v1/messages/count_tokens/')) {
    if (!rateLimit(req, res, CHAT_RATE_LIMIT, 'chat')) return;
    const apiKey = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const found = findByApiSecret(db, apiKey);
    if (!found) return fail(res, 401, '无效的 API Key');
    const raw = await body(req);
    if (raw == null) return fail(res, 400, 'invalid json');
    const pseudoPayload = { model: raw.model, messages: [{ role: 'user', content: 'x' }] };
    const provider = (providersForModel(pseudoPayload, db).filter(providerSupportsResponsesPassthrough)[0])
      || (db.settings.providers || []).find(p => p.enabled !== false && (isBeibeihaiProvider(p) || isVip1129Provider(p)));
    if (!provider) return json(res, 200, { input_tokens: Math.max(1, Math.ceil(JSON.stringify(raw).length / 4)) });
    const proxyKey = await ensureProxyApiKey(db, found.user, provider, found.key);
    const msgEp = messagesEndpointFromChatUrl(provider.url);
    const countEp = String(msgEp).replace(/\/messages$/i, '/messages/count_tokens');
    try {
      const bearer = String(proxyKey || provider.apiKey || '').trim();
      const upstream = await fetch(countEp, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          'x-api-key': bearer,
          'anthropic-version': req.headers['anthropic-version'] || '2023-06-01'
        },
        body: JSON.stringify(raw),
        signal: AbortSignal.timeout(15000)
      });
      const text = await upstream.text();
      if (!upstream.ok) {
        return json(res, 200, { input_tokens: Math.max(1, Math.ceil(JSON.stringify(raw).length / 4)) });
      }
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8' });
      return res.end(text);
    } catch {
      return json(res, 200, { input_tokens: Math.max(1, Math.ceil(JSON.stringify(raw).length / 4)) });
    }
  }

  if (req.method === 'POST' && /\/messages\/?$/.test(url.pathname) && !/count_tokens/.test(url.pathname)) {
    if (!rateLimit(req, res, CHAT_RATE_LIMIT, 'chat')) return;
    const apiKey = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const found = findByApiSecret(db, apiKey);
    if (!found) return fail(res, 401, '无效的 API Key');
    const raw = await body(req);
    if (raw == null) return fail(res, 400, 'invalid json');
    const user = found.user;
    const apiKeyRec = found.key;
    if (apiKeyRec && apiKeyRec.enabled === false) return fail(res, 403, '该 API 密钥已停用');
    if (isBanned(user)) return fail(res, 403, '账号已被封禁');
    if (!isUnlimited(user) && user.accountActive === false) return fail(res, 402, insufficientBalanceMessage());
    scrubStuckReserves(user, apiKeyRec);

    const pseudoPayload = { model: raw.model, messages: [{ role: 'user', content: 'x' }] };
    const allCandidates = providersForModel(pseudoPayload, db);
    const passthroughCandidates = allCandidates.filter(providerSupportsResponsesPassthrough).slice(0, 2);
    const candidates = passthroughCandidates.length ? passthroughCandidates : allCandidates.slice(0, 1);
    if (!candidates.length) return fail(res, 503, '模型服务暂不可用，请稍后再试');
    const primary = candidates[0];
    const authorized = resolveAuthorizedModel(db, apiKeyRec, raw.model, primary);
    if (!authorized.ok) return fail(res, 400, '该密钥未授权使用此模型');
    const model = authorized.model;
    const rate = providerMultiplier(primary, db);
    const inputReserve = Math.ceil(JSON.stringify(raw).length / 3) + 256;
    const requestedOutput = Math.max(1, Math.min(Number(raw.max_tokens) || DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS));
    if (apiKeyRec && !keyRateOk(res, apiKeyRec, inputReserve + requestedOutput)) return;

    let tokenReservation = 0;
    let amountReservation = 0;
    let outputBudget = requestedOutput;
    if (isUnlimited(user)) {
      outputBudget = requestedOutput;
      user.accountActive = true;
      writeDb(db);
    } else {
      let availableBalance = availableUserBalance(user, apiKeyRec);
      const safety = safetyBuffer(primary, rate, model);
      const inputEstimate = estimatedCost(primary, inputReserve, 0, model) * rate;
      const outputUnitPrice = Math.max(modelPrice(primary, model, 'outputPricePer1K') / 1000 * rate, Number.EPSILON);
      const moneyBudget = Math.floor(Math.max(0, availableBalance - safety - inputEstimate) / outputUnitPrice);
      outputBudget = Math.min(requestedOutput, moneyBudget);
      if (apiKeyRec && apiKeyRec.tokenLimit > 0) {
        const keyLeft = Math.max(0, apiKeyRec.tokenLimit - (apiKeyRec.tokenUsed || 0) - (apiKeyRec.reservedTokens || 0));
        outputBudget = Math.min(outputBudget, Math.max(0, Math.floor(keyLeft / rate) - inputReserve));
      }
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
    forward.max_tokens = outputBudget;
    delete forward.max_output_tokens;
    let lastError = null;

    for (const provider of candidates) {
      let live = null;
      try {
        const proxyKey = await ensureProxyApiKey(db, user, provider, apiKeyRec);
        if (!proxyKey) {
          lastError = new Error('missing_proxy_key');
          continue;
        }
        const abortHolder = {};
        const clientRequestId = `client:${id('req')}`;
        const upstream = await fetchUpstreamMessages(provider, forward, model, proxyKey, req.headers, abortHolder, clientRequestId);
        if (!upstream.ok) {
          const errText = await upstream.text().catch(() => '');
          updateProviderHealth(db, provider.id, false, `messages HTTP ${upstream.status}: ${errText.slice(0, 120)}`);
          writeDb(db);
          lastError = new Error(`messages_${upstream.status}`);
          if (upstream.status === 404 || upstream.status === 405) break;
          continue;
        }
        updateProviderHealth(db, provider.id, true);
        writeDb(db);

        const reservation = { tokenReservation, amountReservation };
        live = startLiveBillSession({
          db, user, provider, apiKeyRec, model, started, rate, reservation,
          clientRequestId,
          seedUsage: { prompt_tokens: inputReserve },
          onBroke() { try { abortHolder.abort?.(); } catch { /* ignore */ } }
        });

        if (wantStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive'
          });
          let settled = false;
          let usageAcc = {};
          let buffer = '';
          let sawCompleted = false;
          const cleanup = (reason = 'abort') => {
            if (settled) return;
            settled = true;
            try { abortHolder.abort?.(); } catch { /* ignore */ }
            const hasOfficial = Number(live.state?.lastCost) > 0
              || Number(live.state?.tokenFloor) > Number(live.state?.seedFloor || 0) + 1e-12;
            Promise.resolve(hasOfficial
              ? live.finalize(normalizeAnthropicUsage(usageAcc), reason)
              : live.abandon({ releaseHold: true })
            ).catch(() => {});
            try { res.end(); } catch { /* ignore */ }
          };
          req.on('close', () => { if (!settled) cleanup('client_abort'); });
          const scrape = (chunkText) => {
            buffer += chunkText;
            const parts = buffer.split('\n');
            buffer = parts.pop() || '';
            for (const line of parts) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const data = trimmed.slice(5).trim();
              if (!data) continue;
              try {
                const parsed = JSON.parse(data);
                usageAcc = mergeAnthropicStreamUsage(usageAcc, parsed);
                live.noteUsage?.(normalizeAnthropicUsage(usageAcc));
                if (anthropicStreamFinished(parsed, data)) sawCompleted = true;
              } catch { /* ignore */ }
            }
          };
          try {
            const reader = upstream.body?.getReader?.();
            if (!reader) {
              for await (const chunk of upstream.body) {
                if (settled) break;
                const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
                scrape(text);
                res.write(typeof chunk === 'string' ? chunk : Buffer.from(chunk));
              }
            } else {
              const decoder = new TextDecoder();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (settled) break;
                const text = decoder.decode(value, { stream: true });
                scrape(text);
                res.write(Buffer.from(value));
              }
            }
          } catch {
            if (!settled) cleanup('stream_error');
            return;
          }
          if (settled) return;
          if (!sawCompleted) {
            cleanup('stream_incomplete');
            return;
          }
          const usage = normalizeAnthropicUsage(usageAcc);
          settled = true;
          await live.finalize(usage, 'success');
          try { res.end(); } catch { /* ignore */ }
          return;
        }

        const text = await upstream.text();
        let result;
        try { result = JSON.parse(text); } catch {
          lastError = new Error('invalid_json');
          await live.abandon();
          continue;
        }
        if (result && (result.type === 'error' || result.error)) {
          lastError = new Error(result.error?.message || result.message || 'anthropic_error');
          await live.abandon();
          continue;
        }
        const usage = normalizeAnthropicUsage(result.usage || {});
        const settledModel = result.model || model;
        await live.finalize(usage, 'success');
        return json(res, 200, result);
      } catch (err) {
        if (live) {
          try { await live.abandon(); } catch { /* ignore */ }
        }
        lastError = err;
        continue;
      }
    }

    releaseReserve(user, tokenReservation, amountReservation, apiKeyRec);
    writeDb(db);
    const payload = anthropicToChatPayload(raw);
    if (!payload.messages.length) return fail(res, 400, lastError?.message || 'messages 不能为空');
    if (outputBudget) payload.max_tokens = outputBudget;
    req._anthropicApi = true;
    return chat(req, res, db, found.user, found.key, payload);
  }


  if (req.method === 'POST' && /^\/v1beta\/models\/[^/]+:(generateContent|streamGenerateContent)$/.test(url.pathname)) {
    if (!rateLimit(req, res, CHAT_RATE_LIMIT, 'chat')) return;
    const apiKey = req.headers['x-api-key'] || req.headers['x-goog-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const found = findByApiSecret(db, apiKey);
    if (!found) return fail(res, 401, '无效的 API Key');
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
    if (!found) return fail(res, 401, '无效的 API Key');
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
    const authorized = resolveAuthorizedModel(db, apiKeyRec, raw.model, primary);
    if (!authorized.ok) return fail(res, 400, '该密钥未授权使用此模型');
    const model = authorized.model;
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
      let availableBalance = availableUserBalance(user, apiKeyRec);
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
      let live = null;
      try {
        const proxyKey = await ensureProxyApiKey(db, user, provider, apiKeyRec);
        if (!proxyKey) {
          lastError = new Error('missing_proxy_key');
          continue;
        }
        const abortHolder = {};
        const clientRequestId = `client:${id('req')}`;
        const upstream = await fetchUpstreamResponses(provider, forward, model, proxyKey, abortHolder, clientRequestId);
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

        const reservation = { tokenReservation, amountReservation };
        live = startLiveBillSession({
          db, user, provider, apiKeyRec, model, started, rate, reservation,
          clientRequestId,
          seedUsage: { prompt_tokens: inputReserve },
          onBroke() { try { abortHolder.abort?.(); } catch { /* ignore */ } }
        });

        if (wantStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive'
          });
          let settled = false;
          let usage = null;
          let buffer = '';
          let sawCompleted = false;
          const cleanup = (reason = 'abort') => {
            if (settled) return;
            settled = true;
            try { abortHolder.abort?.(); } catch { /* ignore */ }
            const hasOfficial = Number(live.state?.lastCost) > 0
              || Number(live.state?.tokenFloor) > Number(live.state?.seedFloor || 0) + 1e-12;
            Promise.resolve(hasOfficial
              ? live.finalize(usage || {}, reason)
              : live.abandon({ releaseHold: true })
            ).catch(() => {});
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
              if (!data || data === '[DONE]') {
                if (data === '[DONE]') sawCompleted = true;
                continue;
              }
              try {
                const parsed = JSON.parse(data);
                if (parsed.type === 'response.completed' || parsed.response?.status === 'completed') {
                  sawCompleted = true;
                }
                const u = parsed.response?.usage || parsed.usage || (parsed.type === 'response.completed' ? parsed.response?.usage : null);
                if (u) {
                  usage = normalizeResponsesUsage(u);
                  live.noteUsage?.(usage);
                }
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
          if (!sawCompleted) {
            cleanup('stream_incomplete');
            return;
          }
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
          await live.finalize(usage, 'success');
          try { res.end(); } catch { /* ignore */ }
          return;
        }

        const text = await upstream.text();
        let result;
        try { result = JSON.parse(text); } catch {
          lastError = new Error('invalid_json');
          await live.abandon();
          continue;
        }
        const usage = normalizeResponsesUsage(result.usage || {});
        const settledModel = result.model || model;
        await live.finalize(usage, 'success');
        return json(res, 200, result);
      } catch (err) {
        if (live) {
          try { await live.abandon(); } catch { /* ignore */ }
        }
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
  const file = url.pathname === '/' ? resolvePublicFile(publicDir, '/') : resolvePublicFile(publicDir, url.pathname);
  if (!file) return fail(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return fail(res, 404, 'Not found');
    const ext = path.extname(file);
    const cache = ext === '.html' ? 'no-store' : 'public, max-age=300';
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', 'Cache-Control': cache });
    if (req.method !== 'HEAD') res.end(data);
    else res.end();
  });
  } catch (err) {
    if (res.headersSent) return;
    if (err?.code === 'PAYLOAD_TOO_LARGE') return fail(res, 413, '请求体过大');
    if (err?.code === 'ERR_INVALID_URL') return fail(res, 400, '无效请求');
    console.error('request_error', err?.stack || err);
    return fail(res, 500, '服务器错误');
  }
});

const initial = readDb();
initial.settings ??= {};
initial.auditLogs ??= [];
initial.sessions ??= {};
initial.paymentOrders ??= [];
initial.upstreamBills ??= [];
initial.checkIns ??= [];
initial.siteErrors ??= [];
ensureSiteErrors(initial);
initial.settings.billingMultiplier ??= DEFAULT_MULTIPLIER;
initial.settings.billingMultiplierVip1129 ??= DEFAULT_VIP1129_BILLING_MULTIPLIER;
initial.settings.allowEstimatedBilling = initial.settings.allowEstimatedBilling === true;
initial.settings.paymentQrs ??= {};
ensurePaymentQrs(initial);
ensureWelfarePromo(initial);
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
const repairedDefaults = repairSeededDefaultModels(initial);
const dupRefund = refundDuplicateUsageCharges(initial);
if (repairedDefaults || dupRefund.refunded) writeDb(initial);
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
  user.pendingActualHold ??= 0;
  user.upstreamOutstandingAmount ??= 0;
  user.accountActive ??= (user.balance || 0) > 0;
  user.banned ??= false;
  user.checkInBonus ??= 0;
  user.avatar = normalizeAvatar(user.avatar).avatar;
  user.role ??= (ADMIN_EMAIL && user.email === ADMIN_EMAIL) ? 'admin' : 'user';
  ensureUsername(user, initial);
  ensureUserKeys(user);
}
syncGptKeyModelsFromGroup(initial);
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
ensureMeasuredPrices(initial);
if (migrateDeepSeekLivePrices(initial)) writeDb(initial);
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
ensureAdminPhoneHash(initial);
const envCodes = (process.env.RECHARGE_CODES || '').split(',').map(x => x.trim()).filter(Boolean);
for (const item of envCodes) {
  const [code, amount, quotaTokens] = item.split(':');
  if (code && !initial.rechargeCodes.some(x => x.code === code)) {
    markDbRootDirty(initial, 'rechargeCodes');
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
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  server.listen(PORT, () => {
    const addr = server.address();
    const actual = typeof addr === 'object' && addr ? addr.port : PORT;
    console.log(`Relay Station running at http://localhost:${actual}`);
  });

  if (!SKIP_BOOT_JOBS) {
    // Create the first ledger task immediately, before timers get a chance to
    // run. Otherwise a normal incremental sync can race the required initial
    // historical backfill during the first event-loop turn.
    const initialLedgerSync = (async () => {
      const billingDb = readDb();
      const n = await reconcilePendingActualCosts(billingDb);
      if (n) console.log(`Pending actual_cost reconciled: ${n}`);
      const fullBackfill = billingDb.settings?.upstreamUsageSync?.initialBackfillCompleted !== true;
      const synced = await reconcileUpstreamUsageLedger(billingDb, { fullBackfill });
      if (synced.rows) console.log(`[billing] upstream ledger: ${synced.rows} rows, ${synced.imported} imported, ${synced.linked} linked`);
      writeDb(billingDb);
    })().catch((err) => {
      console.warn('Boot upstream usage sync skipped:', err.message || err);
    });
    setImmediate(async () => {
      try {
        await initialLedgerSync;

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
        const fresh = readDb();
        copyProviderHealth(bootDb, fresh);
        writeDb(fresh);
        const ok = healthResults.filter(r => r.ok && !r.skipped).length;
        const bad = healthResults.filter(r => !r.ok);
        console.log(`Channel health probe: ${ok} ok, ${bad.length} down (of ${healthResults.length})`);
        for (const r of bad) console.warn(`  channel down ${r.name}: ${r.error}`);
        try {
          const priceDb = readDb();
          const priceOut = await runTokenPriceSync(priceDb, { reason: 'boot' });
          if (priceOut.failedIds?.length) armTokenPriceRetry(priceOut.failedIds);
          console.log(`[prices] boot sync: vip ${priceOut.vipOk} (${priceOut.vipRows}) bei ${priceOut.beiOk} (${priceOut.beiRows}) failed ${priceOut.failedIds?.length || 0}`);
        } catch (err) {
          console.warn('[prices] boot sync failed, keeping last table:', err?.message || err);
          armTokenPriceRetry(null);
        }
      } catch (err) {
        console.error('Boot pool/model sync failed:', err);
      }
    });

    scheduleTokenPriceSyncJobs();

    setInterval(async () => {
      if (periodicBillingSweepRunning || upstreamUsageSyncRunning) return;
      periodicBillingSweepRunning = true;
      try {
        await initialLedgerSync;
        const dbx = readDb();
        const n = await reconcilePendingActualCosts(dbx);
        const synced = await reconcileUpstreamUsageLedger(dbx);
        if (n || synced.rows) writeDb(dbx);
        if (n) console.log(`[billing] reconciled ${n} pending actual_cost rows`);
        if (synced.imported || synced.updated) console.log(`[billing] upstream ledger: ${synced.imported} imported, ${synced.updated} updated`);
      } catch (err) {
        console.error('[billing] usage reconcile failed:', err);
      } finally {
        periodicBillingSweepRunning = false;
      }
    }, UPSTREAM_USAGE_SYNC_INTERVAL_MS);

    setInterval(async () => {
      try {
        const dbx = readDb();
        const healthResults = await probeAllProviderHealth(dbx);
        const fresh = readDb();
        copyProviderHealth(dbx, fresh);
        const added = topUpCodePools(fresh, CODE_POOL_TARGET);
        if (added) console.log(`[pool] periodic refill +${added}`);
        writeDb(fresh);
        const ok = healthResults.filter(r => r.ok && !r.skipped).length;
        const bad = healthResults.filter(r => !r.ok);
        console.log(`[health] hourly probe: ${ok} ok, ${bad.length} down`);
        for (const r of bad) console.warn(`[health] down ${r.name}: ${r.error}`);
      } catch (err) {
        console.error('[pool/models] periodic job failed:', err);
      }
    }, 60 * 60 * 1000);
  }
}
