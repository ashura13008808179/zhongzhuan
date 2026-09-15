/**
 * Isolated check: remote Codex/billing APIs plus local live payment. Not part of npm test.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-merge-'));
const port = 19200 + Math.floor(Math.random() * 800);
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    RELAY_DATA_DIR: tmp,
    RELAY_SKIP_BOOT_JOBS: '1',
    CODE_POOL_TARGET: '2',
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
child.stdout.on('data', c => { out += c; });
child.stderr.on('data', c => { out += c; });

function waitForListen(ms = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), ms);
    const tick = () => {
      if (/Relay Station running/.test(out)) { clearTimeout(t); resolve(); }
      else if (child.exitCode != null) { clearTimeout(t); reject(new Error(`exited ${child.exitCode}:\n${out}`)); }
      else setTimeout(tick, 50);
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
  const responses = await req('/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'gpt-5.2', input: 'hi' }) });
  assert.equal(responses.status, 401);
  assert.match(String(responses.body.error || ''), /API Key|无效/);

  const admin = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login: 'admin', password: 'test-admin-pass' })
  });
  assert.equal(admin.status, 200);
  const auth = { Authorization: `Bearer ${admin.body.token}` };

  const pricing = await req('/api/admin/pricing', { headers: auth });
  assert.equal(pricing.status, 200, JSON.stringify(pricing.body));
  assert.ok('multiplier' in pricing.body || 'billingMultiplier' in pricing.body || pricing.body.multiplier != null || pricing.body.ok);
  const vip = pricing.body.multiplierVip1129 ?? pricing.body.billingMultiplierVip1129;
  assert.ok(vip != null, JSON.stringify(pricing.body));
  assert.equal(Number(vip), 1.5);

  const putVip = await req('/api/admin/pricing', {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ multiplierVip1129: 1.6 })
  });
  assert.equal(putVip.status, 200, JSON.stringify(putVip.body));
  const afterVip = await req('/api/admin/pricing', { headers: auth });
  assert.equal(Number(afterVip.body.multiplierVip1129 ?? afterVip.body.billingMultiplierVip1129), 1.6);

  const user = await req('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: 'mergepay@example.com', username: 'mergepay01', name: 'MergePay', password: 'password1' })
  });
  assert.equal(user.status, 201, JSON.stringify(user.body));
  const uAuth = { Authorization: `Bearer ${user.body.token}` };

  const snap = await req('/api/admin/mobile/inbox/wait?after=-1&timeoutMs=250', { headers: auth });
  const seq = snap.body.seq || 0;
  const prep = await req('/api/recharge/prepare', {
    method: 'POST',
    headers: uAuth,
    body: JSON.stringify({ amount: 10, method: 'wechat' })
  });
  assert.equal(prep.status, 200);
  const placed = await req(`/api/admin/mobile/inbox/wait?after=${seq}&timeoutMs=2000`, { headers: auth });
  assert.ok((placed.body.events || []).some(e => e.kind === 'placed' && e.orderId === prep.body.orderId));
  await req('/api/recharge/claim', {
    method: 'POST',
    headers: uAuth,
    body: JSON.stringify({ orderId: prep.body.orderId })
  });
  const conf = await req(`/api/admin/payment-orders/${encodeURIComponent(prep.body.orderId)}/confirm`, {
    method: 'POST',
    headers: auth,
    body: '{}'
  });
  assert.equal(conf.status, 200);
  assert.ok(conf.body.order?.code);
  const live = await req('/api/recharge/orders', { headers: uAuth });
  assert.equal((live.body.orders || []).find(o => o.id === prep.body.orderId)?.code, conf.body.order.code);

  const appJs = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  assert.match(appJs, /totalSpent/);
  assert.match(appJs, /startPayLive/);
  assert.match(appJs, /saveCustomRateVip/);
  const adminApp = fs.readFileSync(path.join(root, 'public/admin-app/app.js'), 'utf8');
  assert.match(adminApp, /inbox\/wait/);
  assert.match(adminApp, /rateVip/);

  console.log('remote-plus-pay-verify.mjs: all assertions passed');
} finally {
  child.kill('SIGTERM');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
