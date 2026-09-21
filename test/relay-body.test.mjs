/**
 * Relay JSON body: admin/auth stay small; Codex /v1 routes accept large attachments.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDbDir } from '../lib/db-crypto.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-body-'));
const port = 21787 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    RELAY_DATA_DIR: tmp,
    RELAY_SKIP_BOOT_JOBS: '1',
    MAX_JSON_BODY: String(4 * 1024),
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
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 200) }; }
  return { status: res.status, body };
}

try {
  await waitForListen();

  const loginHuge = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login: 'x'.repeat(5000), password: 'password1' })
  });
  assert.equal(loginHuge.status, 413);

  const registered = await req('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: 'body@example.com',
      username: 'bodyuser',
      name: 'body',
      password: 'password1'
    })
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const token = registered.body.token;

  const dbStore = openDbDir(tmp);
  const db = dbStore.read();
  const owner = (db.users || []).find((u) => u.username === 'bodyuser');
  assert.ok(owner);
  const key = 'rk_body_test_secret_xxxxxxxx';
  owner.apiKeys = [{
    id: 'key_body',
    name: 'codex',
    key,
    groupId: 'grp_gpt_pro',
    models: [],
    spendLimit: 0,
    tokenLimit: 0,
    rpm: 0,
    tpm: 0,
    spendUsed: 0,
    tokenUsed: 0,
    reservedSpend: 0,
    reservedTokens: 0,
    enabled: true,
    createdAt: new Date().toISOString()
  }];
  owner.apiKey = key;
  dbStore.write(db);

  const mid = await req('/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'gpt-5.6-terra',
      input: 'pad-' + '文'.repeat(3000)
    })
  });
  assert.notEqual(mid.status, 413, `relay should accept ~6KB chat JSON, got ${mid.status} ${JSON.stringify(mid.body)}`);

  const hugeChat = await req('/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'gpt-5.6-terra',
      input: 'x'.repeat(70 * 1024)
    })
  });
  assert.notEqual(hugeChat.status, 413, `relay chat must not cap attachments, got ${hugeChat.status} ${JSON.stringify(hugeChat.body)}`);

  const filesUnauth = await req('/v1/files', { method: 'POST', body: '{}' });
  assert.equal(filesUnauth.status, 401);

  console.log('relay-body.test.mjs: all assertions passed');
} finally {
  child.kill();
}
