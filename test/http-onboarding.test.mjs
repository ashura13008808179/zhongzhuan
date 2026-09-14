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

  console.log('http-onboarding.test.mjs: all assertions passed');
} finally {
  child.kill('SIGTERM');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
