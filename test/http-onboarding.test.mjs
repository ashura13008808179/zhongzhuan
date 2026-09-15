/**
 * In-process HTTP checks for register / invite / trial / admin providers alias.
 * Does not call real upstreams. Do not put secrets in this file.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-fix-'));
const port = 18787 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    RELAY_DATA_DIR: tmp,
    RELAY_SKIP_BOOT_JOBS: '1',
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
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

try {
  await waitForListen();

  const badInvite = await req('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: 'badinvite@example.com',
      username: 'badinvite',
      name: 'Bad',
      password: 'password1',
      inviteCode: 'NOTREAL'
    })
  });
  assert.equal(badInvite.status, 400, `invalid invite should 400, got ${badInvite.status} ${JSON.stringify(badInvite.body)}`);
  assert.match(String(badInvite.body.error || ''), /邀请码/);

  const emptyInvite = await req('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: 'newbie@example.com',
      username: 'newbie01',
      name: 'Newbie',
      password: 'password1',
      inviteCode: ''
    })
  });
  assert.equal(emptyInvite.status, 201, JSON.stringify(emptyInvite.body));
  assert.equal(emptyInvite.body.user.balance, 0);
  assert.equal(emptyInvite.body.user.quotaTokens, 0);
  assert.equal(emptyInvite.body.user.username, 'newbie01');
  assert.equal(emptyInvite.body.user.name, 'Newbie');
  const newbieId = emptyInvite.body.user.id;

  const dupUsername = await req('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: 'dupuser@example.com',
      username: 'newbie01',
      name: 'SomeoneElse',
      password: 'password1'
    })
  });
  assert.equal(dupUsername.status, 409);
  assert.match(String(dupUsername.body.error || ''), /用户名已被占用/);

  const dupName = await req('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: 'dupname@example.com',
      username: 'othername99',
      name: 'Newbie',
      password: 'password1'
    })
  });
  assert.equal(dupName.status, 409);
  assert.match(String(dupName.body.error || ''), /名称已被占用/);

  const adminLogin = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login: 'admin', password: 'test-admin-pass' })
  });
  assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.body));
  const token = adminLogin.body.token;
  const auth = { Authorization: `Bearer ${token}` };

  const alias = await req('/api/admin/providers', { headers: auth });
  assert.equal(alias.status, 200, JSON.stringify(alias.body));
  assert.ok(Array.isArray(alias.body.providers));
  const byId = Object.fromEntries(alias.body.providers.map(p => [p.id, p]));
  assert.equal(byId.grp_deepseek?.upstreamSync, 'beibeihai');
  assert.equal(byId.grp_grok?.upstreamSync, 'beibeihai');
  assert.equal(byId.grp_cc_max?.upstreamSync, 'beibeihai');
  assert.equal(byId.grp_claude_cursor, undefined);
  assert.equal(byId.grp_gpt_pro?.upstreamSync, 'vip1129');
  assert.equal(byId.grp_cursor_pool?.maintenance, true);
  assert.match(String(byId.grp_deepseek?.url || ''), /beibeihai\.xyz/);

  const pricing = await req('/api/admin/pricing', { headers: auth });
  assert.equal(pricing.status, 200);
  assert.equal(pricing.body.providers.length, alias.body.providers.length);
  assert.equal(pricing.body.multiplier, 2.5);

  const settings = await req('/api/admin/site-settings', { headers: auth });
  assert.equal(settings.status, 200);
  assert.equal(settings.body.trialBalance, undefined);
  assert.equal(settings.body.recommendedModel, 'gpt-5.6-sol');

  const cfg = await req('/api/config');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.recommendedModel, 'gpt-5.6-sol');
  assert.equal(cfg.body.trialBalance, undefined);

  const updated = await req('/api/admin/site-settings', {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ recommendedModel: 'gpt-5.6-terra' })
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.recommendedModel, 'gpt-5.6-terra');
  const cfg2 = await req('/api/config');
  assert.equal(cfg2.body.recommendedModel, 'gpt-5.6-terra');

  const meBefore = await req('/api/me', { headers: auth });
  assert.equal(meBefore.status, 200);
  assert.equal(meBefore.body.user.avatar, 'letter');
  const av = await req('/api/me', {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ avatar: 'mint' })
  });
  assert.equal(av.status, 200, JSON.stringify(av.body));
  assert.equal(av.body.user.avatar, 'mint');
  const avBad = await req('/api/me', {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ avatar: 'not-a-face' })
  });
  assert.equal(avBad.status, 400);

  const rate14 = await req('/api/admin/pricing', {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ multiplier: 1.4 })
  });
  assert.equal(rate14.status, 200, JSON.stringify(rate14.body));
  assert.equal(rate14.body.multiplier, 1.4);
  const rate11 = await req('/api/admin/pricing', {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ multiplier: 1.1 })
  });
  assert.equal(rate11.status, 200);
  assert.equal(rate11.body.multiplier, 1.1);
  const rateBad = await req('/api/admin/pricing', {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ multiplier: 0 })
  });
  assert.equal(rateBad.status, 400);

  const validInvite = await req('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: 'invited@example.com',
      username: 'invited01',
      name: 'Invited',
      password: 'password1',
      inviteCode: 'ADMIN'
    })
  });
  assert.equal(validInvite.status, 201, JSON.stringify(validInvite.body));
  assert.equal(validInvite.body.user.balance, 0);

  const inboxGuest = await req('/api/admin/mobile/inbox');
  assert.equal(inboxGuest.status, 403);
  const inbox = await req('/api/admin/mobile/inbox', { headers: auth });
  assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
  assert.ok(Array.isArray(inbox.body.pending));
  assert.equal(typeof inbox.body.pendingCount, 'number');
  assert.equal(typeof inbox.body.paymentQr?.wechat?.expired, 'boolean');

  const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const userUpload = await req('/api/admin/payment-qrs/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${emptyInvite.body.token}` },
    body: JSON.stringify({ method: 'wechat', amount: 10, image: png1x1 })
  });
  assert.equal(userUpload.status, 403);
  const blockedAll = await req('/api/admin/payment-qrs/upload', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ method: 'wechat', applyAll: true, image: png1x1 })
  });
  assert.equal(blockedAll.status, 400);
  assert.match(String(blockedAll.body.error || ''), /分别上传/);
  const before = await req('/api/admin/payment-qrs', { headers: auth });
  const original100 = before.body.paymentQrs.wechat['100'];
  const uploaded = await req('/api/admin/payment-qrs/upload', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      method: 'wechat',
      amount: 10,
      image: png1x1,
      expiresAt: '2099-12-31'
    })
  });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  assert.match(String(uploaded.body.url || ''), /^\/payment-qr\/uploads\/wechat-10-\d+\.png$/);
  assert.equal(uploaded.body.paymentQrs.wechat['10'], uploaded.body.url);
  assert.equal(uploaded.body.paymentQrs.wechat['100'], original100);
  assert.notEqual(uploaded.body.paymentQrs.wechat['100'], uploaded.body.url);
  assert.equal(uploaded.body.paymentQrMeta.wechat.expired, false);
  const imgRes = await fetch(`${base}${uploaded.body.url}`);
  assert.equal(imgRes.status, 200);
  assert.match(String(imgRes.headers.get('content-type') || ''), /image\/png/);
  const rel = String(uploaded.body.url).replace(/^\//, '');
  const saved = path.join(root, 'public', ...rel.split('/'));
  try { fs.unlinkSync(saved); } catch { /* ignore leftover */ }

  const usersGuest = await req('/api/admin/users');
  assert.equal(usersGuest.status, 403);
  const usersList = await req('/api/admin/users?q=newbie01', { headers: auth });
  assert.equal(usersList.status, 200);
  assert.equal(usersList.body.users.length, 1);
  assert.equal(usersList.body.users[0].username, 'newbie01');

  const addBal = await req(`/api/admin/users/${encodeURIComponent(newbieId)}`, {
    method: 'PUT', headers: auth, body: JSON.stringify({ balanceDelta: 5 })
  });
  assert.equal(addBal.status, 200, JSON.stringify(addBal.body));
  assert.equal(addBal.body.user.balance, 5);
  const subBal = await req(`/api/admin/users/${encodeURIComponent(newbieId)}`, {
    method: 'PUT', headers: auth, body: JSON.stringify({ balanceDelta: -1.5 })
  });
  assert.equal(subBal.status, 200);
  assert.equal(subBal.body.user.balance, 3.5);
  const setBal = await req(`/api/admin/users/${encodeURIComponent(newbieId)}`, {
    method: 'PUT', headers: auth, body: JSON.stringify({ balance: 8 })
  });
  assert.equal(setBal.status, 200);
  assert.equal(setBal.body.user.balance, 8);
  const overdraft = await req(`/api/admin/users/${encodeURIComponent(newbieId)}`, {
    method: 'PUT', headers: auth, body: JSON.stringify({ balanceDelta: -20 })
  });
  assert.equal(overdraft.status, 400);
  const banSelf = await req(`/api/admin/users/${encodeURIComponent(adminLogin.body.user.id)}`, {
    method: 'PUT', headers: auth, body: JSON.stringify({ banned: true })
  });
  assert.equal(banSelf.status, 400);
  const banUser = await req(`/api/admin/users/${encodeURIComponent(newbieId)}`, {
    method: 'PUT', headers: auth, body: JSON.stringify({ banned: true })
  });
  assert.equal(banUser.status, 200, JSON.stringify(banUser.body));
  assert.equal(banUser.body.user.banned, true);
  const bannedLogin = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login: 'newbie01', password: 'password1' })
  });
  assert.equal(bannedLogin.status, 403);
  const unbanUser = await req(`/api/admin/users/${encodeURIComponent(newbieId)}`, {
    method: 'PUT', headers: auth, body: JSON.stringify({ banned: false })
  });
  assert.equal(unbanUser.status, 200);
  const okLogin = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login: 'newbie01', password: 'password1' })
  });
  assert.equal(okLogin.status, 200);

  const appPage = await fetch(`${base}/admin-app/`);
  assert.equal(appPage.status, 200);
  const appHtml = await appPage.text();
  assert.match(appHtml, /值班控制台/);
  assert.match(appHtml, /收款码/);
  assert.match(appHtml, /用户/);

  const newbieTok = { Authorization: `Bearer ${okLogin.body.token}` };
  const invitedTok = { Authorization: `Bearer ${validInvite.body.token}` };

  const guestWait = await req('/api/admin/mobile/inbox/wait?after=0&timeoutMs=200');
  assert.equal(guestWait.status, 403);

  const snap = await req('/api/admin/mobile/inbox/wait?after=-1&timeoutMs=400', { headers: auth });
  assert.equal(snap.status, 200, JSON.stringify(snap.body));
  let adminSeq = snap.body.seq || 0;
  const userSnap = await req('/api/recharge/wait?after=-1&timeoutMs=400', { headers: newbieTok });
  assert.equal(userSnap.status, 200, JSON.stringify(userSnap.body));
  let userSeq = userSnap.body.seq || 0;

  const prep = await req('/api/recharge/prepare', {
    method: 'POST',
    headers: newbieTok,
    body: JSON.stringify({ amount: 10, method: 'wechat' })
  });
  assert.equal(prep.status, 200, JSON.stringify(prep.body));
  const waitPlaced = await req(`/api/admin/mobile/inbox/wait?after=${adminSeq}&timeoutMs=2000`, { headers: auth });
  assert.equal(waitPlaced.status, 200, JSON.stringify(waitPlaced.body));
  assert.ok((waitPlaced.body.events || []).some(e => e.kind === 'placed' && e.orderId === prep.body.orderId), JSON.stringify(waitPlaced.body.events));
  assert.ok((waitPlaced.body.events || []).every(e => e.code == null));
  adminSeq = waitPlaced.body.seq || adminSeq;

  const claimed = await req('/api/recharge/claim', {
    method: 'POST',
    headers: newbieTok,
    body: JSON.stringify({ orderId: prep.body.orderId })
  });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const waitPaid = await req(`/api/admin/mobile/inbox/wait?after=${adminSeq}&timeoutMs=2000`, { headers: auth });
  assert.equal(waitPaid.status, 200, JSON.stringify(waitPaid.body));
  assert.ok((waitPaid.body.events || []).some(e => e.kind === 'paid' && e.orderId === prep.body.orderId), JSON.stringify(waitPaid.body.events));
  adminSeq = waitPaid.body.seq || adminSeq;

  const confirmedPay = await req(`/api/admin/payment-orders/${encodeURIComponent(prep.body.orderId)}/confirm`, {
    method: 'POST',
    headers: auth,
    body: '{}'
  });
  assert.equal(confirmedPay.status, 200, JSON.stringify(confirmedPay.body));
  const issuedCode = confirmedPay.body.order?.code;
  assert.ok(issuedCode);
  const waitUser = await req(`/api/recharge/wait?after=${userSeq}&timeoutMs=2000`, { headers: newbieTok });
  assert.equal(waitUser.status, 200, JSON.stringify(waitUser.body));
  const confirmedEv = (waitUser.body.events || []).find(e => e.kind === 'confirmed' && e.orderId === prep.body.orderId);
  assert.ok(confirmedEv, JSON.stringify(waitUser.body.events));
  assert.equal(confirmedEv.code, issuedCode);
  const waitAdminConfirm = await req(`/api/admin/mobile/inbox/wait?after=${adminSeq}&timeoutMs=2000`, { headers: auth });
  assert.ok((waitAdminConfirm.body.events || []).some(e => e.kind === 'confirmed' && e.orderId === prep.body.orderId));
  assert.ok((waitAdminConfirm.body.events || []).every(e => e.code == null));
  const liveOrders = await req('/api/recharge/orders', { headers: newbieTok });
  assert.equal(liveOrders.status, 200);
  const live = (liveOrders.body.orders || []).find(o => o.id === prep.body.orderId);
  assert.equal(live?.code, issuedCode);
  const steal = await req('/api/recharge/redeem', {
    method: 'POST',
    headers: invitedTok,
    body: JSON.stringify({ code: issuedCode })
  });
  assert.equal(steal.status, 400);
  assert.match(String(steal.body.error || ''), /无权兑换|无效|已使用/);
  const emptyCode = await req('/api/recharge/redeem', {
    method: 'POST',
    headers: newbieTok,
    body: JSON.stringify({ code: '' })
  });
  assert.equal(emptyCode.status, 400);
  const stockList = await req('/api/admin/codes?limit=200&offset=0', { headers: auth });
  const stock = (stockList.body.codes || []).find(c => !c.usedAt && !c.issuedTo && Number(c.amount) === 10 && c.code !== issuedCode);
  assert.ok(stock, 'expected unused pool code');
  const stockTry = await req('/api/recharge/redeem', {
    method: 'POST',
    headers: newbieTok,
    body: JSON.stringify({ code: stock.code })
  });
  assert.equal(stockTry.status, 400);
  const own = await req('/api/recharge/redeem', {
    method: 'POST',
    headers: newbieTok,
    body: JSON.stringify({ code: String(issuedCode).toLowerCase() })
  });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.user.balance, 18);
  const twice = await req('/api/recharge/redeem', {
    method: 'POST',
    headers: newbieTok,
    body: JSON.stringify({ code: issuedCode })
  });
  assert.equal(twice.status, 400);
  const made = await req('/api/admin/codes', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ count: 1, amount: 10, quotaTokens: 1000, prefix: 'GIFT' })
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const giftOk = await req('/api/recharge/redeem', {
    method: 'POST',
    headers: invitedTok,
    body: JSON.stringify({ code: made.body.codes[0].code })
  });
  assert.equal(giftOk.status, 200, JSON.stringify(giftOk.body));
  assert.equal(giftOk.body.user.balance, 10);

  console.log('http-onboarding.test.mjs: all assertions passed');
} finally {
  child.kill('SIGTERM');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
