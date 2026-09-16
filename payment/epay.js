import crypto from 'node:crypto';

/** 易支付兼容：MD5 签名 / 验签 / 跳转下单 URL */
export function epaySign(params, key) {
  const filtered = Object.entries(params)
    .filter(([k, v]) => k !== 'sign' && k !== 'sign_type' && v !== undefined && v !== null && String(v) !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const raw = filtered.map(([k, v]) => `${k}=${v}`).join('&') + String(key || '');
  return crypto.createHash('md5').update(raw, 'utf8').digest('hex');
}

export function epayVerify(params, key) {
  const sign = String(params.sign || '');
  if (!sign) return false;
  const expected = epaySign(params, key);
  const left = Buffer.from(sign.toLowerCase(), 'utf8');
  const right = Buffer.from(expected.toLowerCase(), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function normalizeGateway(raw = {}) {
  return {
    enabled: raw.enabled === true,
    type: String(raw.type || 'epay'),
    name: String(raw.name || '易支付'),
    apiUrl: String(raw.apiUrl || '').replace(/\/$/, ''),
    pid: String(raw.pid || '').trim(),
    key: String(raw.key || '').trim(),
    // site public origin for notify/return, e.g. https://pay.example.com
    siteUrl: String(raw.siteUrl || '').replace(/\/$/, ''),
  };
}

export function gatewayReady(gw) {
  return !!(gw?.enabled && gw.apiUrl && gw.pid && gw.key && gw.siteUrl);
}

export function mapPayType(method) {
  const m = String(method || '').toLowerCase();
  if (m === 'alipay') return 'alipay';
  return 'wxpay';
}

export function buildEpaySubmitUrl(gw, order) {
  const params = {
    pid: gw.pid,
    type: mapPayType(order.method),
    out_trade_no: order.id,
    notify_url: `${gw.siteUrl}/api/pay/epay/notify`,
    return_url: `${gw.siteUrl}/api/pay/epay/return`,
    name: `卡密充值¥${order.amount}`,
    money: Number(order.amount).toFixed(2),
    sign_type: 'MD5'
  };
  params.sign = epaySign(params, gw.key);
  const q = new URLSearchParams(params).toString();
  return `${gw.apiUrl}/submit.php?${q}`;
}

export function publicGatewayView(gw) {
  const g = normalizeGateway(gw);
  return {
    enabled: gatewayReady(g),
    type: g.type,
    name: g.name,
    // never expose key
    configured: !!(g.apiUrl && g.pid && g.key && g.siteUrl)
  };
}
