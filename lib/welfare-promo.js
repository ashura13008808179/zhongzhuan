import { addDaysYmd, money2, shanghaiDate } from './checkin.js';

export const DEFAULT_WELFARE_MULTIPLIER = 1.1;
export const WELFARE_MIN_MULTIPLIER = 1;
export const WELFARE_MAX_MULTIPLIER = 10;
export const WELFARE_MAX_IMAGES = 8;
export const DEFAULT_WELFARE_TEXT =
  '今日充值福利开启！卡密按 {mul} 倍到账，付 10 得 {ten}，今晚 24:00 截止。';

export function clampWelfareMultiplier(value, fallback = DEFAULT_WELFARE_MULTIPLIER) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(WELFARE_MAX_MULTIPLIER, Math.max(WELFARE_MIN_MULTIPLIER, Math.round(n * 100) / 100));
}

export function shanghaiMidnightIso(ymd) {
  const [y, m, d] = String(ymd || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(Date.UTC(y, m - 1, d, -8, 0, 0, 0)).toISOString();
}

export function shanghaiTonightEndIso(now = new Date()) {
  return shanghaiMidnightIso(addDaysYmd(shanghaiDate(now), 1));
}

export function defaultWelfareText(multiplier = DEFAULT_WELFARE_MULTIPLIER) {
  const mul = clampWelfareMultiplier(multiplier);
  return DEFAULT_WELFARE_TEXT
    .replaceAll('{mul}', String(mul))
    .replaceAll('{ten}', String(money2(10 * mul)));
}

export function renderWelfareText(text, multiplier = DEFAULT_WELFARE_MULTIPLIER) {
  const mul = clampWelfareMultiplier(multiplier);
  const raw = String(text || '').trim();
  const tpl = raw || DEFAULT_WELFARE_TEXT;
  return tpl
    .replaceAll('{mul}', String(mul))
    .replaceAll('{ten}', String(money2(10 * mul)))
    .replaceAll('{thirty}', String(money2(30 * mul)))
    .replaceAll('{fifty}', String(money2(50 * mul)))
    .replaceAll('{hundred}', String(money2(100 * mul)));
}

function sanitizeImages(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const url = String(item || '').trim();
    if (!url) continue;
    if (url.startsWith('/welfare/') || url.startsWith('https://') || url.startsWith('http://')) {
      out.push(url.slice(0, 500));
    }
    if (out.length >= WELFARE_MAX_IMAGES) break;
  }
  return out;
}

export function emptyWelfarePromo(now = new Date()) {
  return {
    enabled: false,
    multiplier: DEFAULT_WELFARE_MULTIPLIER,
    expiresAt: shanghaiTonightEndIso(now),
    text: '',
    images: []
  };
}

export function normalizeWelfarePromo(raw, now = new Date()) {
  const base = emptyWelfarePromo(now);
  const src = raw && typeof raw === 'object' ? raw : {};
  const expiresAt = String(src.expiresAt || '').trim() || base.expiresAt;
  return {
    enabled: src.enabled === true,
    multiplier: clampWelfareMultiplier(src.multiplier, DEFAULT_WELFARE_MULTIPLIER),
    expiresAt,
    text: String(src.text || '').slice(0, 240),
    images: sanitizeImages(src.images)
  };
}

export function isWelfareActive(promo, now = new Date()) {
  const p = normalizeWelfarePromo(promo, now);
  if (!p.enabled) return false;
  const end = Date.parse(p.expiresAt);
  if (!Number.isFinite(end)) return false;
  return now.getTime() < end;
}

export function welfareCreditAmount(faceAmount, multiplier) {
  return money2((Number(faceAmount) || 0) * clampWelfareMultiplier(multiplier, 1));
}

export function stampIssuedCard(card, promo, now = new Date()) {
  const face = money2(card?.amount);
  const next = { ...card, paidAmount: face };
  if (isWelfareActive(promo, now)) {
    const mul = clampWelfareMultiplier(promo.multiplier);
    next.welfareMultiplier = mul;
    next.creditAmount = welfareCreditAmount(face, mul);
  } else {
    next.creditAmount = face;
  }
  return next;
}

export function redeemCreditAmount(card) {
  const credit = Number(card?.creditAmount);
  if (Number.isFinite(credit) && credit > 0) return money2(credit);
  return money2(card?.amount);
}

export function publicWelfarePromo(promo, now = new Date()) {
  const p = normalizeWelfarePromo(promo, now);
  if (!isWelfareActive(p, now)) return null;
  return {
    enabled: true,
    multiplier: p.multiplier,
    expiresAt: p.expiresAt,
    text: renderWelfareText(p.text, p.multiplier),
    images: p.images.slice()
  };
}

/** Customer-facing banner only. Admin multiplier/expiry stay on /api/admin/welfare. */
export function publicWelfareBanner(promo, now = new Date()) {
  const p = publicWelfarePromo(promo, now);
  if (!p) return null;
  return { text: p.text, images: p.images };
}

export function applyPaymentPlanWelfare(plans, promo, now = new Date()) {
  const active = isWelfareActive(promo, now);
  const mul = active ? clampWelfareMultiplier(promo?.multiplier) : 1;
  return (plans || []).map((plan) => {
    const amount = Number(plan.amount) || 0;
    const creditAmount = active ? welfareCreditAmount(amount, mul) : amount;
    return {
      ...plan,
      creditAmount,
      welfareMultiplier: active ? mul : 1,
      welfareActive: active
    };
  });
}
