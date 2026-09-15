/**
 * Isolated payment flow + security checks. Does not touch data/db.json.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { epaySign } from '../payment/epay.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pay-'));
const port = 19000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    RELAY_DATA_DIR: tmp,
    RELAY_SKIP_BOOT_JOBS: '1',
    CODE_POOL_TARGET: '2',
    CLAIM_DAILY_LIMIT: '20',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'test-admin-pass',
    ADMIN_EMAIL: 'admin@example.com',
    VIP1129_EMAIL: '',
    VIP1129_PASSWORD: '',
    BEIBEIHAI_EMAIL: '',
    BEIBEIHAI_PASSWORD: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let out = '';
child.stdout.on('data', (c) => { out += c; });
child.stderr.on('data', (c) => { out += c; });

function waitForListen(ms = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), ms);
    const tick = () => {
      if (/Relay Station running/.test(out)) {
        clearTimeout(t);
        resolve();
      } else if (child.exitCode != null) {
        clearTimeout(t);
        reject(new Error(`server exited ${child.exitCode}:\n${out}`));
      } else {
        setTimeout(tick, 50);
      }
    };
    tick();
  });
}

async function req(pathname, opts = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { status: res.status, body, text };
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

async function register(username, email) {
  const r = await req('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email,
      username,
      name: username,
      password: 'password1'
    })
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

try {
  await waitForListen();

  const adminLogin = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login: 'admin', password: 'test-admin-pass' })
  });
  assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.body));
  const adminTok = auth(adminLogin.body.token);
  const alice = await register('payalice01', 'payalice01@example.com');
  const bob = await register('paybob02', 'paybob02@example.com');
  const aliceTok = auth(alice.token);
  const bobTok = auth(bob.token);

  // --- 未登录 / 越权 ---
  assert.equal((await req('/api/recharge/prepare', { method: 'POST', body: JSON.stringify({ amount: 10, method: 'wechat' }) })).status, 401);
  assert.equal((await req('/api/recharge/claim', { method: 'POST', body: JSON.stringify({ orderId: 'x' }) })).status, 401);
  assert.equal((await req('/api/recharge/orders')).status, 401);
  assert.equal((await req('/api/recharge/wait?timeoutMs=200')).status, 401);
  assert.equal((await req('/api/recharge/redeem', { method: 'POST', body: JSON.stringify({ code: 'R10-ABCDEF' }) })).status, 401);
  assert.equal((await req('/api/admin/mobile/inbox/wait?timeoutMs=200')).status, 403);
  assert.equal((await req('/api/admin/payment-orders', { headers: aliceTok })).status, 403);
  assert.equal((await req('/api/admin/mobile/inbox', { headers: aliceTok })).status, 403);
  assert.equal((await req('/api/admin/mobile/inbox/wait?timeoutMs=200', { headers: aliceTok })).status, 403);
  assert.equal((await req('/api/admin/payment-orders/pay_x/confirm', { method: 'POST', headers: aliceTok, body: '{}' })).status, 403);
  assert.equal((await req('/api/admin/payment-orders/pay_x/reject', { method: 'POST', headers: aliceTok, body: '{}' })).status, 403);

  const fakeTok = auth('not-a-real-session-token');
  assert.equal((await req('/api/recharge/wait?timeoutMs=200', { headers: fakeTok })).status, 401);
  assert.equal((await req('/api/admin/mobile/inbox/wait?timeoutMs=200', { headers: fakeTok })).status, 403);

  // --- 金额 / 方式校验 ---
  assert.equal((await req('/api/recharge/prepare', {
    method: 'POST', headers: aliceTok, body: JSON.stringify({ amount: 9, method: 'wechat' })
  })).status, 400);
  assert.equal((await req('/api/recharge/prepare', {
    method: 'POST', headers: aliceTok, body: JSON.stringify({ amount: 10, method: 'paypal' })
  })).status, 400);

  // --- 易支付伪造回调：网关未启用时应失败且不发卡 ---
  const fakeNotify = await fetch(`${base}/api/pay/epay/notify?out_trade_no=pay_fake&trade_status=TRADE_SUCCESS&money=10&sign=deadbeef`);
  assert.equal(fakeNotify.status, 400);
  assert.equal((await fakeNotify.text()).trim(), 'fail');

  // --- 同步序号 ---
  const adminHello = await req('/api/admin/mobile/inbox/wait?after=-1&timeoutMs=250', { headers: adminTok });
  assert.equal(adminHello.status, 200);
  let adminSeq = adminHello.body.seq || 0;
  const aliceHello = await req('/api/recharge/wait?after=-1&timeoutMs=250', { headers: aliceTok });
  assert.equal(aliceHello.status, 200);

  // --- 长轮询必须被下单立刻唤醒（而不是等超时） ---
  const placedWait = req(`/api/admin/mobile/inbox/wait?after=${adminSeq}&timeoutMs=8000`, { headers: adminTok });
  await new Promise(r => setTimeout(r, 80));
  const tPlace = Date.now();
  const prep = await req('/api/recharge/prepare', {
    method: 'POST',
    headers: aliceTok,
    body: JSON.stringify({ amount: 10, method: 'wechat' })
  });
  assert.equal(prep.status, 200, JSON.stringify(prep.body));
  assert.equal(prep.body.status, 'awaiting_payment');
  assert.ok(prep.body.orderId);
  assert.ok(!prep.body.code);
  const placed = await placedWait;
  const placeMs = Date.now() - tPlace;
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  assert.ok(placeMs < 2500, `下单通知应立刻返回，实际 ${placeMs}ms`);
  assert.ok((placed.body.events || []).some(e => e.kind === 'placed' && e.orderId === prep.body.orderId));
  assert.ok((placed.body.events || []).every(e => e.code == null));
  adminSeq = placed.body.seq;

  // Bob 不能用 Alice 的订单号提交付款
  const stealClaim = await req('/api/recharge/claim', {
    method: 'POST',
    headers: bobTok,
    body: JSON.stringify({ orderId: prep.body.orderId })
  });
  assert.equal(stealClaim.status, 400);

  // --- claim 立刻二次通知 ---
  const paidWait = req(`/api/admin/mobile/inbox/wait?after=${adminSeq}&timeoutMs=8000`, { headers: adminTok });
  await new Promise(r => setTimeout(r, 80));
  const claimed = await req('/api/recharge/claim', {
    method: 'POST',
    headers: aliceTok,
    body: JSON.stringify({ orderId: prep.body.orderId })
  });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.status, 'pending');
  const paid = await paidWait;
  assert.ok((paid.body.events || []).some(e => e.kind === 'paid' && e.orderId === prep.body.orderId));
  adminSeq = paid.body.seq;

  const claimAgain = await req('/api/recharge/claim', {
    method: 'POST',
    headers: aliceTok,
    body: JSON.stringify({ orderId: prep.body.orderId })
  });
  assert.equal(claimAgain.status, 200);
  assert.equal(claimAgain.body.status, 'pending');

  // Alice 未确认前看不到卡密
  const beforeOrders = await req('/api/recharge/orders', { headers: aliceTok });
  const before = (beforeOrders.body.orders || []).find(o => o.id === prep.body.orderId);
  assert.equal(before.status, 'pending');
  assert.equal(before.code, null);

  const bobOrders = await req('/api/recharge/orders', { headers: bobTok });
  assert.ok(!(bobOrders.body.orders || []).some(o => o.id === prep.body.orderId));

  // --- 确认后用户长轮询立刻拿到卡密；管理员事件不得带卡密 ---
  const userWait = req(`/api/recharge/wait?after=${adminSeq}&timeoutMs=8000`, { headers: aliceTok });
  const bobWait = req(`/api/recharge/wait?after=0&timeoutMs=600`, { headers: bobTok });
  const adminConfWait = req(`/api/admin/mobile/inbox/wait?after=${adminSeq}&timeoutMs=8000`, { headers: adminTok });
  await new Promise(r => setTimeout(r, 80));
  const tConfirm = Date.now();
  const confirmed = await req(`/api/admin/payment-orders/${encodeURIComponent(prep.body.orderId)}/confirm`, {
    method: 'POST',
    headers: adminTok,
    body: '{}'
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  const issuedCode = confirmed.body.order?.code;
  assert.ok(issuedCode && String(issuedCode).length >= 6);
  const userEv = await userWait;
  const confirmMs = Date.now() - tConfirm;
  assert.ok(confirmMs < 2500, `发卡应立刻推到用户，实际 ${confirmMs}ms`);
  const got = (userEv.body.events || []).find(e => e.kind === 'confirmed' && e.orderId === prep.body.orderId);
  assert.ok(got, JSON.stringify(userEv.body.events));
  assert.equal(got.code, issuedCode);

  const bobEv = await bobWait;
  const bobDump = JSON.stringify(bobEv.body);
  assert.ok(!bobDump.includes(issuedCode), '其他用户 wait 不得泄露卡密');
  assert.ok(!(bobEv.body.events || []).some(e => e.orderId === prep.body.orderId));

  const adminConf = await adminConfWait;
  const adminDump = JSON.stringify(adminConf.body);
  assert.ok((adminConf.body.events || []).some(e => e.kind === 'confirmed'));
  assert.ok((adminConf.body.events || []).every(e => e.code == null));
  assert.ok(!adminDump.includes(issuedCode), '值班 inbox/wait 不得下发卡密');

  const inbox = await req('/api/admin/mobile/inbox', { headers: adminTok });
  assert.ok(!JSON.stringify(inbox.body).includes(issuedCode), '值班 inbox 不得下发卡密');

  const live = await req('/api/recharge/orders', { headers: aliceTok });
  const mine = (live.body.orders || []).find(o => o.id === prep.body.orderId);
  assert.equal(mine.code, issuedCode);

  const twiceConfirm = await req(`/api/admin/payment-orders/${encodeURIComponent(prep.body.orderId)}/confirm`, {
    method: 'POST',
    headers: adminTok,
    body: '{}'
  });
  assert.equal(twiceConfirm.status, 400);

  // --- 兑换权限 ---
  const steal = await req('/api/recharge/redeem', {
    method: 'POST',
    headers: bobTok,
    body: JSON.stringify({ code: issuedCode })
  });
  assert.equal(steal.status, 400);
  const stockList = await req('/api/admin/codes?limit=50&offset=0', { headers: adminTok });
  const stock = (stockList.body.codes || []).find(c => !c.usedAt && !c.issuedTo && Number(c.amount) === 10 && c.code !== issuedCode);
  assert.ok(stock, 'expected unused pool code');
  assert.equal((await req('/api/recharge/redeem', {
    method: 'POST', headers: aliceTok, body: JSON.stringify({ code: stock.code })
  })).status, 400);
  const own = await req('/api/recharge/redeem', {
    method: 'POST',
    headers: aliceTok,
    body: JSON.stringify({ code: String(issuedCode).toLowerCase() })
  });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.user.balance, 10);
  assert.equal((await req('/api/recharge/redeem', {
    method: 'POST', headers: aliceTok, body: JSON.stringify({ code: issuedCode })
  })).status, 400);

  // --- 拒绝单不得发卡，确认已拒绝失败 ---
  const prep2 = await req('/api/recharge/prepare', {
    method: 'POST',
    headers: bobTok,
    body: JSON.stringify({ amount: 30, method: 'alipay' })
  });
  assert.equal(prep2.status, 200);
  await req('/api/recharge/claim', {
    method: 'POST',
    headers: bobTok,
    body: JSON.stringify({ orderId: prep2.body.orderId })
  });
  const rejected = await req(`/api/admin/payment-orders/${encodeURIComponent(prep2.body.orderId)}/reject`, {
    method: 'POST',
    headers: adminTok,
    body: JSON.stringify({ reason: '未到账' })
  });
  assert.equal(rejected.status, 200);
  assert.equal((await req(`/api/admin/payment-orders/${encodeURIComponent(prep2.body.orderId)}/confirm`, {
    method: 'POST', headers: adminTok, body: '{}'
  })).status, 400);
  const bobAfter = await req('/api/recharge/orders', { headers: bobTok });
  const rejectedOrder = (bobAfter.body.orders || []).find(o => o.id === prep2.body.orderId);
  assert.equal(rejectedOrder.status, 'rejected');
  assert.equal(rejectedOrder.code, null);

  // --- 封禁后不能继续支付 / 听卡密 ---
  const ban = await req(`/api/admin/users/${encodeURIComponent(alice.user.id)}`, {
    method: 'PUT',
    headers: adminTok,
    body: JSON.stringify({ banned: true })
  });
  assert.equal(ban.status, 200);
  assert.equal((await req('/api/recharge/prepare', {
    method: 'POST', headers: aliceTok, body: JSON.stringify({ amount: 10, method: 'wechat' })
  })).status, 403);
  assert.equal((await req('/api/recharge/orders', { headers: aliceTok })).status, 403);
  assert.equal((await req('/api/recharge/wait?timeoutMs=200', { headers: aliceTok })).status, 403);
  assert.equal((await req('/api/recharge/redeem', {
    method: 'POST', headers: aliceTok, body: JSON.stringify({ code: 'R10-XXXXXX' })
  })).status, 403);

  // --- 启用网关后伪造签名不得发卡 ---
  const gw = await req('/api/admin/payment-gateway', {
    method: 'PUT',
    headers: adminTok,
    body: JSON.stringify({
      enabled: true,
      type: 'epay',
      apiUrl: 'https://pay.example.test',
      pid: '1000',
      key: 'test-epay-key',
      siteUrl: `http://127.0.0.1:${port}`
    })
  });
  assert.equal(gw.status, 200, JSON.stringify(gw.body));
  const prepGw = await req('/api/recharge/prepare', {
    method: 'POST',
    headers: bobTok,
    body: JSON.stringify({ amount: 10, method: 'wechat' })
  });
  assert.equal(prepGw.status, 200, JSON.stringify(prepGw.body));
  const badSign = await fetch(`${base}/api/pay/epay/notify?out_trade_no=${encodeURIComponent(prepGw.body.orderId)}&trade_status=TRADE_SUCCESS&money=10.00&sign=00000000000000000000000000000000&sign_type=MD5`);
  assert.equal(badSign.status, 400);
  const still = await req('/api/recharge/orders', { headers: bobTok });
  const gwOrder = (still.body.orders || []).find(o => o.id === prepGw.body.orderId);
  assert.ok(gwOrder.status !== 'confirmed');
  assert.equal(gwOrder.code, null);

  const okParams = {
    pid: '1000',
    out_trade_no: prepGw.body.orderId,
    trade_status: 'TRADE_SUCCESS',
    money: '10.00',
    trade_no: 'epay-test-1',
    type: 'wxpay',
    sign_type: 'MD5'
  };
  okParams.sign = epaySign(okParams, 'test-epay-key');
  const qs = new URLSearchParams(okParams).toString();
  const goodNotify = await fetch(`${base}/api/pay/epay/notify?${qs}`);
  assert.equal(goodNotify.status, 200, await goodNotify.text());
  const afterGw = await req('/api/recharge/orders', { headers: bobTok });
  const paidGw = (afterGw.body.orders || []).find(o => o.id === prepGw.body.orderId);
  assert.equal(paidGw.status, 'confirmed');
  assert.ok(paidGw.code);
  const prepMismatch = await req('/api/recharge/prepare', {
    method: 'POST',
    headers: bobTok,
    body: JSON.stringify({ amount: 50, method: 'alipay' })
  });
  const mismatch = {
    pid: '1000',
    out_trade_no: prepMismatch.body.orderId,
    trade_status: 'TRADE_SUCCESS',
    money: '10.00',
    sign_type: 'MD5'
  };
  mismatch.sign = epaySign(mismatch, 'test-epay-key');
  const mismatchRes = await fetch(`${base}/api/pay/epay/notify?${new URLSearchParams(mismatch)}`);
  assert.equal(mismatchRes.status, 400);
  const mismatchOrder = (await req('/api/recharge/orders', { headers: bobTok })).body.orders.find(o => o.id === prepMismatch.body.orderId);
  assert.notEqual(mismatchOrder.status, 'confirmed');

  console.log('payment-flow-security.test.mjs: all assertions passed');
} finally {
  child.kill('SIGTERM');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
