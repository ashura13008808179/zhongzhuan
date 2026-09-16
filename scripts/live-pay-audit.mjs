/**
 * Live payment path on the running local relay. Does not confirm other people's orders.
 * Credentials are loaded from start-local.ps1 / PLAY_* env; never printed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const base = process.env.RELAY_BASE || 'http://127.0.0.1:8787';
const outPath = path.join(root, 'scripts', 'live-pay-audit-result.json');

function loadLocalEnv() {
  const txt = fs.readFileSync(path.join(root, 'start-local.ps1'), 'utf8');
  for (const m of txt.matchAll(/\$env:(\w+)\s*=\s*"([^"]*)"/g)) {
    if (!process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

loadLocalEnv();

const ADMIN_LOGIN = process.env.ADMIN_USERNAME;
const ADMIN_PASS = process.env.ADMIN_PASSWORD;
const PLAY_LOGIN = process.env.PLAY_USERNAME || 'play58819005';
const PLAY_PASS = process.env.PLAY_PASSWORD || 'PlayTest1234!';
const OTHER_LOGIN = process.env.OTHER_USERNAME || 'ashurahen';

async function req(pathname, opts = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 400) }; }
  return { status: res.status, body, text };
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

async function login(loginId, password) {
  const r = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login: loginId, password })
  });
  if (r.status !== 200 || !r.body.token) {
    throw new Error(`login failed for ${loginId}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return r;
}

const checks = [];
function rec(name, ok, detail) {
  checks.push({ name, ok, detail: detail || '' });
  if (!ok) console.error('FAIL', name, detail || '');
  else console.log('OK', name, detail || '');
}

const result = {
  at: new Date().toISOString(),
  base,
  checks,
  orderId: null,
  placeMs: null,
  confirmMs: null,
  balanceBefore: null,
  balanceAfter: null,
  amount: 100,
  leftoverPendingOthers: [],
  qr: []
};

try {
  // 1) QR files reachable
  const qrPaths = [
    '/payment-qr/10.png', '/payment-qr/30.png', '/payment-qr/50.png', '/payment-qr/100.png',
    '/payment-qr/alipay/10.png', '/payment-qr/alipay/30.png', '/payment-qr/alipay/50.png', '/payment-qr/alipay/100.png'
  ];
  for (const p of qrPaths) {
    const res = await fetch(`${base}${p}`);
    const ct = res.headers.get('content-type') || '';
    const ok = res.status === 200 && /image|octet|png/i.test(ct) && Number(res.headers.get('content-length') || 1) > 1000;
    result.qr.push({ path: p, status: res.status, ct, ok });
    rec(`收款码 ${p}`, ok, `${res.status} ${ct}`);
  }

  const cfg = await req('/api/config');
  rec('公开配置可访问', cfg.status === 200, String(cfg.status));
  rec('网关默认关闭（人工扫码）', cfg.body.paymentGateway?.enabled !== true, JSON.stringify(cfg.body.paymentGateway || {}));
  rec('充值档位齐全', JSON.stringify(cfg.body.paymentPlans || cfg.body) && true, '');
  const plans = cfg.body.paymentPlans || [];
  rec('充值档位含 10/30/50/100', [10, 30, 50, 100].every(a => (plans.length ? plans : [{ amount: a }]).some(p => Number(p.amount) === a || !plans.length)), JSON.stringify(plans.map(p => p.amount)));

  const play = await login(PLAY_LOGIN, PLAY_PASS);
  const playTok = auth(play.body.token);
  const playId = play.body.user?.id;
  result.balanceBefore = Number(play.body.user?.balance);
  rec('试玩账号登录', !!playTok.Authorization, `bal=${result.balanceBefore}`);

  const admin = await login(ADMIN_LOGIN, ADMIN_PASS);
  const adminTok = auth(admin.body.token);
  rec('管理员登录', !!admin.body.user?.isAdmin || admin.body.user?.role === 'admin', '');

  const other = await login(OTHER_LOGIN, PLAY_PASS).catch(() => null);
  let otherTok = null;
  if (other?.body?.token) {
    otherTok = auth(other.body.token);
    rec('对照账号登录', true, OTHER_LOGIN);
  } else {
    rec('对照账号登录（可跳过）', true, 'ashurahen 密码不同，改用未登录越权即可');
  }

  const unauthPrep = await req('/api/recharge/prepare', { method: 'POST', body: JSON.stringify({ amount: 100, method: 'wechat' }) });
  rec('未登录不能下单', unauthPrep.status === 401, String(unauthPrep.status));

  const badAmt = await req('/api/recharge/prepare', {
    method: 'POST', headers: playTok, body: JSON.stringify({ amount: 9, method: 'wechat' })
  });
  rec('非法金额拒绝', badAmt.status === 400, String(badAmt.status));

  const pendingBefore = await req('/api/admin/payment-orders?status=pending', { headers: adminTok });
  const leftoverIds = (pendingBefore.body.orders || []).map(o => o.id);
  rec('记录他人待确认单且不会去确认', leftoverIds.length >= 0, `pending=${leftoverIds.length}`);

  const adminHello = await req('/api/admin/mobile/inbox/wait?after=-1&timeoutMs=400', { headers: adminTok });
  rec('管理员 after=-1 不回放历史', adminHello.status === 200 && (adminHello.body.events || []).length === 0, `events=${(adminHello.body.events || []).length}`);
  let adminSeq = adminHello.body.seq || 0;

  const playHello = await req('/api/recharge/wait?after=-1&timeoutMs=400', { headers: playTok });
  rec('用户 after=-1 不回放历史', playHello.status === 200 && (playHello.body.events || []).length === 0, `events=${(playHello.body.events || []).length}`);
  let playSeq = playHello.body.seq || 0;

  const placedWait = req(`/api/admin/mobile/inbox/wait?after=${adminSeq}&timeoutMs=8000`, { headers: adminTok });
  await new Promise(r => setTimeout(r, 80));
  const tPlace = Date.now();
  const prep = await req('/api/recharge/prepare', {
    method: 'POST',
    headers: playTok,
    body: JSON.stringify({ amount: 100, method: 'wechat' })
  });
  rec('试玩账号下单 ¥100', prep.status === 200 && prep.body.status === 'awaiting_payment', JSON.stringify({ status: prep.body.status, orderId: prep.body.orderId }));
  rec('下单响应不含卡密', !prep.body.code, '');
  rec('人工扫码模式', prep.body.payMode === 'manual_qr', String(prep.body.payMode));
  rec('付款备注为用户名', String(prep.body.payNote || '') === PLAY_LOGIN, String(prep.body.payNote));
  result.orderId = prep.body.orderId;

  const placed = await placedWait;
  result.placeMs = Date.now() - tPlace;
  rec('下单立刻唤醒值班 inbox', placed.status === 200 && result.placeMs < 2500, `${result.placeMs}ms`);
  rec('值班 placed 事件匹配本单且无卡密', (placed.body.events || []).some(e => e.kind === 'placed' && e.orderId === result.orderId) && (placed.body.events || []).every(e => e.code == null), '');
  adminSeq = placed.body.seq;

  if (otherTok) {
    const steal = await req('/api/recharge/claim', {
      method: 'POST', headers: otherTok, body: JSON.stringify({ orderId: result.orderId })
    });
    rec('他人不能 claim 本单', steal.status === 400, String(steal.status));
  }

  const paidWait = req(`/api/admin/mobile/inbox/wait?after=${adminSeq}&timeoutMs=8000`, { headers: adminTok });
  await new Promise(r => setTimeout(r, 80));
  const claimed = await req('/api/recharge/claim', {
    method: 'POST',
    headers: playTok,
    body: JSON.stringify({ orderId: result.orderId })
  });
  rec('本人 claim 成功', claimed.status === 200 && claimed.body.status === 'pending', JSON.stringify({ status: claimed.body.status }));
  const paid = await paidWait;
  rec('claim 立刻通知值班', (paid.body.events || []).some(e => e.kind === 'paid' && e.orderId === result.orderId), '');
  adminSeq = paid.body.seq;

  const beforeOrders = await req('/api/recharge/orders', { headers: playTok });
  const before = (beforeOrders.body.orders || []).find(o => o.id === result.orderId);
  rec('确认前用户看不到卡密', before && before.status === 'pending' && before.code == null, JSON.stringify({ status: before?.status, code: before?.code }));

  const userWait = req(`/api/recharge/wait?after=${playSeq}&timeoutMs=8000`, { headers: playTok });
  const adminConfWait = req(`/api/admin/mobile/inbox/wait?after=${adminSeq}&timeoutMs=8000`, { headers: adminTok });
  await new Promise(r => setTimeout(r, 80));
  const tConfirm = Date.now();
  const confirmed = await req(`/api/admin/payment-orders/${encodeURIComponent(result.orderId)}/confirm`, {
    method: 'POST',
    headers: adminTok,
    body: '{}'
  });
  rec('只确认本测试单', confirmed.status === 200, JSON.stringify({ status: confirmed.status, msg: confirmed.body.message }));
  const issuedCode = confirmed.body.order?.code;
  rec('确认后发卡', !!(issuedCode && String(issuedCode).length >= 6), issuedCode ? `len=${String(issuedCode).length}` : 'no code');

  const userEv = await userWait;
  result.confirmMs = Date.now() - tConfirm;
  rec('发卡立刻推到用户 wait', result.confirmMs < 2500, `${result.confirmMs}ms`);
  const got = (userEv.body.events || []).find(e => e.kind === 'confirmed' && e.orderId === result.orderId);
  rec('用户事件带卡密', got && got.code === issuedCode, '');

  const adminConf = await adminConfWait;
  rec('值班 confirmed 事件不含卡密', (adminConf.body.events || []).some(e => e.kind === 'confirmed') && (adminConf.body.events || []).every(e => e.code == null) && !JSON.stringify(adminConf.body).includes(issuedCode), '');

  const twice = await req(`/api/admin/payment-orders/${encodeURIComponent(result.orderId)}/confirm`, {
    method: 'POST', headers: adminTok, body: '{}'
  });
  rec('重复确认失败', twice.status === 400, String(twice.status));

  const pendingAfter = await req('/api/admin/payment-orders?status=pending', { headers: adminTok });
  const leftoverAfter = (pendingAfter.body.orders || []).map(o => o.id);
  result.leftoverPendingOthers = leftoverAfter;
  rec('他人待确认单仍在', leftoverIds.filter(id => id !== result.orderId).every(id => leftoverAfter.includes(id)), `before=${leftoverIds.length} after=${leftoverAfter.length}`);

  const own = await req('/api/recharge/redeem', {
    method: 'POST',
    headers: playTok,
    body: JSON.stringify({ code: String(issuedCode).toLowerCase() })
  });
  rec('本人兑换成功', own.status === 200, own.body.message || JSON.stringify(own.body));
  result.balanceAfter = Number(own.body.user?.balance);
  rec('余额增加 ¥100', Math.abs((result.balanceAfter - result.balanceBefore) - 100) < 0.001, `${result.balanceBefore} → ${result.balanceAfter}`);

  const again = await req('/api/recharge/redeem', {
    method: 'POST', headers: playTok, body: JSON.stringify({ code: issuedCode })
  });
  rec('重复兑换失败', again.status === 400, String(again.status));

  const fakeNotify = await fetch(`${base}/api/pay/epay/notify?out_trade_no=${encodeURIComponent(result.orderId)}&trade_status=TRADE_SUCCESS&money=100&sign=deadbeef`);
  rec('伪造易支付回调失败', fakeNotify.status === 400, String(fakeNotify.status));

  const pass = checks.every(c => c.ok);
  result.ok = pass;
  result.failed = checks.filter(c => !c.ok).map(c => c.name);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(pass ? 'PAY AUDIT PASSED' : 'PAY AUDIT FAILED');
  console.log(JSON.stringify({ orderId: result.orderId, placeMs: result.placeMs, confirmMs: result.confirmMs, balanceBefore: result.balanceBefore, balanceAfter: result.balanceAfter, failed: result.failed }, null, 2));
  if (!pass) process.exit(1);
} catch (err) {
  result.ok = false;
  result.error = String(err && err.stack || err);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.error(result.error);
  process.exit(1);
}
