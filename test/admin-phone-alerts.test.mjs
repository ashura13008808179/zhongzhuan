/**
 * Admin phone gate + signup burst alerts. Isolated temp db.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-guard-'));
const port = 19700 + Math.floor(Math.random() * 800);
const base = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    RELAY_DATA_DIR: tmp,
    RELAY_SKIP_BOOT_JOBS: '1',
    ADMIN_PHONE: '13800138000',
    REGISTER_BURST_COUNT: '3',
    REGISTER_BURST_WINDOW_MS: '60000',
    REGISTER_DAILY_LIMIT: '20',
    AUTH_REGISTER_RATE_LIMIT: '30',
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
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 200) }; }
  return { status: res.status, body };
}

try {
  await waitForListen();

  const userLogin = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login: 'nobody', password: 'password1' })
  });
  assert.equal(userLogin.status, 401);

  const step1 = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login: 'admin', password: 'test-admin-pass' })
  });
  assert.equal(step1.status, 200, JSON.stringify(step1.body));
  assert.equal(step1.body.needPhone, true);
  assert.equal(step1.body.token, undefined);
  assert.ok(step1.body.ticket);
  assert.equal(JSON.stringify(step1.body).includes('13800138000'), false);
  assert.equal(JSON.stringify(step1.body).includes('adminPhoneHash'), false);

  const badPhone = await req('/api/auth/login/phone', {
    method: 'POST',
    body: JSON.stringify({ ticket: step1.body.ticket, phone: '13900000000' })
  });
  assert.equal(badPhone.status, 401);

  const step1b = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login: 'admin', password: 'test-admin-pass' })
  });
  const okPhone = await req('/api/auth/login/phone', {
    method: 'POST',
    body: JSON.stringify({ ticket: step1b.body.ticket, phone: '13800138000' })
  });
  assert.equal(okPhone.status, 200, JSON.stringify(okPhone.body));
  assert.ok(okPhone.body.token);
  assert.equal(okPhone.body.user.isAdmin, true);
  const leaked = JSON.stringify(okPhone.body);
  assert.equal(leaked.includes('13800138000'), false);
  assert.equal(leaked.includes('adminPhoneHash'), false);
  const adminTok = { Authorization: `Bearer ${okPhone.body.token}` };

  const dbBuf = fs.readFileSync(path.join(tmp, 'db.json'));
  assert.equal(dbBuf.subarray(0, 6).toString(), 'ZZENC1');
  const dbText = dbBuf.toString('latin1');
  assert.equal(dbText.includes('13800138000'), false);
  assert.equal(dbText.includes('adminPhoneHash'), false);
  assert.equal(dbText.includes('test-admin-pass'), false);
  assert.equal(dbText.includes('burstuser'), false);
  assert.equal(fs.existsSync(path.join(tmp, '.master.key')), true);

  for (const pathName of ['/api/config', '/api/me', '/api/dashboard', '/api/admin/pricing', '/api/admin/site-settings', '/api/admin/mobile/inbox', '/api/admin/users', '/api/admin/security-alerts']) {
    const r = await req(pathName, { headers: adminTok });
    const raw = JSON.stringify(r.body);
    assert.equal(raw.includes('13800138000'), false, pathName);
    assert.equal(raw.includes('adminPhoneHash'), false, pathName);
    assert.equal(raw.includes('adminPhoneBoundAt'), false, pathName);
  }

  for (let i = 1; i <= 3; i++) {
    const r = await req('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: `burst${i}@example.com`,
        username: `burstuser${i}`,
        name: `burstuser${i}`,
        password: 'password1'
      })
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }

  const alerts = await req('/api/admin/security-alerts', { headers: adminTok });
  assert.equal(alerts.status, 200, JSON.stringify(alerts.body));
  assert.ok((alerts.body.openCount || 0) >= 1);
  const open = (alerts.body.alerts || []).find(a => a.status === 'open');
  assert.ok(open, 'expected open signup burst alert');
  assert.ok(open.count >= 3);

  const inbox = await req('/api/admin/mobile/inbox', { headers: adminTok });
  assert.ok((inbox.body.securityAlerts || []).some(a => a.id === open.id));

  const userOk = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login: 'burstuser1', password: 'password1' })
  });
  assert.equal(userOk.status, 200, JSON.stringify(userOk.body));
  assert.equal(userOk.body.needPhone, undefined);
  assert.ok(userOk.body.token);

  const one = await req(`/api/admin/security-alerts/${open.id}/ban-one`, {
    method: 'POST',
    headers: adminTok,
    body: JSON.stringify({ userId: open.users[0].userId })
  });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  const bannedOne = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login: open.users[0].username, password: 'password1' })
  });
  assert.equal(bannedOne.status, 403);

  const ban = await req(`/api/admin/security-alerts/${open.id}/ban-all`, {
    method: 'POST',
    headers: adminTok,
    body: '{}'
  });
  assert.equal(ban.status, 200, JSON.stringify(ban.body));
  assert.ok(ban.body.bannedCount >= 3);

  const bannedLogin = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login: 'burstuser1', password: 'password1' })
  });
  assert.equal(bannedLogin.status, 403);

  const after = fs.readFileSync(path.join(tmp, 'db.json'));
  assert.equal(after.subarray(0, 6).toString(), 'ZZENC1');
  const afterText = after.toString('latin1');
  assert.equal(afterText.includes('burstuser'), false);
  assert.equal(afterText.includes('password1'), false);
  assert.equal(afterText.includes('adminPhoneHash'), false);

  console.log('admin-phone-alerts.test.mjs: all assertions passed');
} finally {
  child.kill('SIGTERM');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
