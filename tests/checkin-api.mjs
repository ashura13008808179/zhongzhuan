/**
 * HTTP smoke test for check-in endpoints.
 * Spawns server.js with an isolated DATA_DIR.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function waitForListen(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`server start timeout: ${buf}`)), timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/Relay Station running at http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        resolve(Number(m[1]));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}: ${buf}`));
    });
  });
}

async function req(base, method, urlPath, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const dir = await mkdtemp(path.join(tmpdir(), 'relay-checkin-'));
const child = spawn(process.execPath, [path.join(root, 'server.js')], {
  cwd: root,
  env: {
    ...process.env,
    PORT: '0',
    DATA_DIR: dir,
    CODE_POOL_TARGET: '0',
    SKIP_BOOT_JOBS: '1',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'test-admin-pass',
    ADMIN_EMAIL: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let failed = 0;
try {
  const port = await waitForListen(child);
  const base = `http://127.0.0.1:${port}`;

  const unauth = await req(base, 'POST', '/api/checkin');
  assert.equal(unauth.status, 401);

  const reg = await req(base, 'POST', '/api/auth/register', {
    body: { email: 'checkin-user@example.com', username: 'checkinuser', password: 'password1', name: '签到用户' }
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  const token = reg.json.token;
  const startBalance = Number(reg.json.user.balance || 0);

  const status0 = await req(base, 'GET', '/api/checkin/status', { token });
  assert.equal(status0.status, 200);
  assert.equal(status0.json.checkedInToday, false);
  assert.equal(status0.json.timezone, 'Asia/Shanghai');
  assert.match(status0.json.date, /^\d{4}-\d{2}-\d{2}$/);

  const claim = await req(base, 'POST', '/api/checkin', { token });
  assert.equal(claim.status, 200, JSON.stringify(claim.json));
  assert.equal(claim.json.alreadyCheckedIn, false);
  assert.ok(claim.json.amount >= 0.05 && claim.json.amount <= 0.5);
  assert.equal(claim.json.balance, Math.round((startBalance + claim.json.amount) * 100) / 100);
  assert.equal(claim.json.date, status0.json.date);

  const again = await req(base, 'POST', '/api/checkin', { token });
  assert.equal(again.status, 409);
  assert.match(again.json.error, /今日已签到/);
  assert.equal(again.json.alreadyCheckedIn, true);
  assert.equal(again.json.amount, claim.json.amount);

  const status1 = await req(base, 'GET', '/api/checkin/status', { token });
  assert.equal(status1.json.checkedInToday, true);
  assert.equal(status1.json.todayAmount, claim.json.amount);
  assert.ok(status1.json.streak >= 1);
  assert.equal(status1.json.recent[0].amount, claim.json.amount);

  const me = await req(base, 'GET', '/api/me', { token });
  assert.equal(me.json.user.balance, claim.json.balance);
  assert.equal(me.json.user.checkInBonus, claim.json.amount);
  assert.equal(me.json.user.bonusBalance, 0);

  const adminLogin = await req(base, 'POST', '/api/auth/login', {
    body: { login: 'admin', password: 'test-admin-pass' }
  });
  assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.json));
  const adminStats = await req(base, 'GET', '/api/admin/checkin', { token: adminLogin.json.token });
  assert.equal(adminStats.status, 200);
  assert.ok(adminStats.json.today.users >= 1);
  assert.ok(adminStats.json.totals.records >= 1);

  const userForbidden = await req(base, 'GET', '/api/admin/checkin', { token });
  assert.equal(userForbidden.status, 403);

  console.log('checkin-api: ok');
} catch (err) {
  failed = 1;
  console.error('checkin-api: FAIL', err);
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
  await rm(dir, { recursive: true, force: true });
}

process.exit(failed);
