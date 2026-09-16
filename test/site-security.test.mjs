/**
 * Local defensive security checks. Isolated temp db. Does not touch production
 * data and does not deploy anywhere.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  clientIp,
  isBlockedPublicPath,
  privilegeFieldsPresent,
  resolvePublicFile,
  robotsTxt,
  sessionExpired,
  sessionRecord,
  timingSafeHexEqual
} from '../lib/http-security.js';
import { sanitizeChatCompletion } from '../lib/response-mask.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sec-'));
const port = 19600 + Math.floor(Math.random() * 800);
const base = `http://127.0.0.1:${port}`;

assert.equal(privilegeFieldsPresent({ email: 'a@b.c' }), false);
assert.equal(privilegeFieldsPresent({ balance: 99 }), true);
assert.equal(privilegeFieldsPresent({ role: 'admin' }), true);
assert.equal(privilegeFieldsPresent({ unlimited: true }), true);
assert.equal(isBlockedPublicPath('/data/db.json'), true);
assert.equal(isBlockedPublicPath('/data/.master.key'), true);
assert.equal(isBlockedPublicPath('/.master.key'), true);
assert.equal(isBlockedPublicPath('/..%2fserver.js'), true);
assert.equal(isBlockedPublicPath('/.env'), true);
assert.equal(isBlockedPublicPath('/app.js.bak'), true);
assert.equal(isBlockedPublicPath('/app.js'), false);
assert.equal(isBlockedPublicPath('/admin-app/index.html'), false);
assert.equal(resolvePublicFile(path.join(root, 'public'), '/../server.js'), null);
assert.ok(robotsTxt().includes('Disallow: /api/'));
const rec = sessionRecord('usr_x', Date.now() - 8 * 24 * 3600 * 1000);
assert.equal(sessionExpired(rec, Date.now()), true);
assert.equal(timingSafeHexEqual('abc', 'abc'), true);
assert.equal(timingSafeHexEqual('abc', 'abd'), false);
{
  const masked = sanitizeChatCompletion({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-5.6-terra',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    quota: 99,
    channel: 'vip1129',
    system_fingerprint: 'fp_leak'
  }, 'gpt-5.6-terra');
  assert.equal(masked.channel, undefined);
  assert.equal(masked.quota, undefined);
  assert.equal(masked.system_fingerprint, undefined);
  assert.equal(masked.choices[0].message.content, 'hi');
}
if (String(process.env.TRUST_PROXY || '').trim() !== '1') {
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '8.8.8.8' }, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1');
}

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    RELAY_DATA_DIR: tmp,
    RELAY_SKIP_BOOT_JOBS: '1',
    AUTH_LOGIN_RATE_LIMIT: '8',
    AUTH_REGISTER_RATE_LIMIT: '20',
    REGISTER_DAILY_LIMIT: '20',
    LOGIN_FAIL_LIMIT: '5',
    LOGIN_FAIL_WINDOW_MS: '600000',
    MAX_JSON_BODY: String(16 * 1024),
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
  const headers = { ...(opts.headers || {}) };
  if (opts.body != null && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${base}${pathname}`, { ...opts, headers });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 300) }; }
  return { status: res.status, body, text, headers: res.headers };
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

try {
  await waitForListen();

  const home = await req('/');
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.match(String(home.headers.get('content-security-policy') || ''), /frame-ancestors 'none'/);

  const robots = await req('/robots.txt');
  assert.equal(robots.status, 200);
  assert.match(robots.text, /Disallow: \/api\//);

  const cfg = await req('/api/config');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.providers, undefined);
  assert.equal(cfg.body.apiKey, undefined);
  assert.equal(cfg.body.adminPassword, undefined);
  assert.ok(cfg.body.contactQq);
  assert.equal(cfg.body.rechargeHours?.timezone, 'Asia/Shanghai');
  assert.equal(cfg.body.rechargeHours?.start, '08:30');
  assert.equal(cfg.body.rechargeHours?.end, '23:30');
  assert.equal(typeof cfg.body.rechargeHours?.open, 'boolean');
  assert.match(String(cfg.body.rechargeHours?.closedMessage || ''), /8:30/);

  for (const p of ['/../server.js', '/../data/db.json', '/data/db.json', '/data/.master.key', '/.env', '/app.js.bak', '/package.json']) {
    const r = await req(p);
    assert.ok(r.status === 403 || r.status === 404, `${p} should be blocked, got ${r.status}`);
    assert.equal(String(r.text).includes('ADMIN_PASSWORD'), false);
  }

  assert.equal((await req('/api/admin/users')).status, 403);
  assert.equal((await req('/api/admin/codes')).status, 403);
  assert.equal((await req('/api/admin/pricing')).status, 403);
  assert.equal((await req('/api/recharge/redeem', { method: 'POST', body: JSON.stringify({ code: 'R10-DEADBEEF' }) })).status, 401);

  const priv = await req('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: 'attacker01@example.com',
      username: 'attacker01',
      name: 'attacker01',
      password: 'password1',
      role: 'admin',
      balance: 999999,
      unlimited: true,
      isAdmin: true
    })
  });
  assert.equal(priv.status, 400, JSON.stringify(priv.body));

  const alice = await req('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: 'secalice@example.com',
      username: 'secalice',
      name: 'secalice',
      password: 'password1'
    })
  });
  assert.equal(alice.status, 201, JSON.stringify(alice.body));
  assert.equal(alice.body.user.role, 'user');
  assert.equal(alice.body.user.isAdmin, false);
  assert.equal(alice.body.user.unlimited, false);
  assert.equal(Number(alice.body.user.balance), 0);
  const aliceTok = auth(alice.body.token);

  const keysLeak = await req('/api/keys', { headers: aliceTok });
  assert.equal(keysLeak.status, 200);
  for (const k of keysLeak.body.keys || []) {
    assert.equal(k.upstreamProvider, undefined);
    assert.equal(k.upstreamGroupId, undefined);
    assert.equal(k.upstreamSynced, undefined);
    assert.equal(JSON.stringify(k).includes('vip1129'), false);
    assert.equal(JSON.stringify(k).includes('beibeihai'), false);
  }
  const optsLeak = await req('/api/key-options', { headers: aliceTok });
  assert.equal(JSON.stringify(optsLeak.body).toLowerCase().includes('vip1129'), false);
  assert.equal(JSON.stringify(optsLeak.body).toLowerCase().includes('beibeihai'), false);
  const badKey = await req('/v1/models', { headers: { Authorization: 'Bearer sk-not-real' } });
  assert.equal(badKey.status, 401);
  assert.equal(String(badKey.body.error || '').includes('Relay'), false);
  assert.equal(String(badKey.body.error || '').toLowerCase().includes('vip1129'), false);

  const meHack = await req('/api/me', {
    method: 'PUT',
    headers: aliceTok,
    body: JSON.stringify({ avatar: 'lime', balance: 99999, role: 'admin', unlimited: true })
  });
  assert.equal(meHack.status, 400);

  const meOk = await req('/api/me', { headers: aliceTok });
  assert.equal(meOk.status, 200);
  assert.equal(Number(meOk.body.user.balance), 0);
  assert.equal(meOk.body.user.role, 'user');
  assert.equal(meOk.body.user.isAdmin, false);

  const stealAdmin = await req(`/api/admin/users/${alice.body.user.id}`, {
    method: 'PUT',
    headers: aliceTok,
    body: JSON.stringify({ balance: 99999, role: 'admin' })
  });
  assert.equal(stealAdmin.status, 403);

  const aliceUsers = await req('/api/admin/users', { headers: aliceTok });
  assert.equal(aliceUsers.status, 403);

  const fakeRedeem = await req('/api/recharge/redeem', {
    method: 'POST',
    headers: aliceTok,
    body: JSON.stringify({ code: 'R10-NOTREAL1' })
  });
  assert.equal(fakeRedeem.status, 400);
  const afterFake = await req('/api/me', { headers: aliceTok });
  assert.equal(Number(afterFake.body.user.balance), 0);

  const huge = await req('/api/auth/login', {
    method: 'POST',
    body: '{"login":"' + 'x'.repeat(20 * 1024) + '","password":"password1"}'
  });
  assert.equal(huge.status, 413);

  const adminLogin = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login: 'admin', password: 'test-admin-pass' })
  });
  assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.body));
  const adminTok = auth(adminLogin.body.token);

  const noUnlimited = await req(`/api/admin/users/${alice.body.user.id}`, {
    method: 'PUT',
    headers: adminTok,
    body: JSON.stringify({ unlimited: true })
  });
  assert.equal(noUnlimited.status, 400);

  const codes = await req('/api/admin/codes', {
    method: 'POST',
    headers: adminTok,
    body: JSON.stringify({ count: 1, amount: 10, quotaTokens: 1000, prefix: 'SEC' })
  });
  assert.equal(codes.status, 201, JSON.stringify(codes.body));
  const code = codes.body.codes[0].code;

  const bob = await req('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: 'secbob@example.com',
      username: 'secbob',
      name: 'secbob',
      password: 'password1'
    })
  });
  assert.equal(bob.status, 201, JSON.stringify(bob.body));
  const bobTok = auth(bob.body.token);

  const [r1, r2] = await Promise.all([
    req('/api/recharge/redeem', { method: 'POST', headers: aliceTok, body: JSON.stringify({ code }) }),
    req('/api/recharge/redeem', { method: 'POST', headers: bobTok, body: JSON.stringify({ code }) })
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 400]);
  const aliceBal = Number((await req('/api/me', { headers: aliceTok })).body.user.balance);
  const bobBal = Number((await req('/api/me', { headers: bobTok })).body.user.balance);
  assert.equal(aliceBal + bobBal, 10);
  assert.ok(aliceBal === 10 || bobBal === 10);

  const notify = await fetch(`${base}/api/pay/epay/notify?out_trade_no=pay_x&trade_status=TRADE_SUCCESS&money=10&sign=deadbeef`);
  assert.equal(notify.status, 400);
  assert.equal((await notify.text()).trim(), 'fail');

  let lastLogin = { status: 0 };
  for (let i = 0; i < 9; i++) {
    lastLogin = await req('/api/auth/login', {
      method: 'POST',
      headers: { 'X-Forwarded-For': `203.0.113.${i}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'nobody', password: 'wrong-password' })
    });
  }
  assert.equal(lastLogin.status, 429, `spoofed XFF should still rate-limit, got ${lastLogin.status}`);

  console.log('site-security.test.mjs: all assertions passed');
} finally {
  child.kill('SIGTERM');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
