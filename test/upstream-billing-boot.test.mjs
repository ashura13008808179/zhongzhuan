/** Verify that a restart performs its full upstream-ledger backfill before health work. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDbDir } from '../lib/db-crypto.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ledger-boot-'));
const relayPort = 21787 + Math.floor(Math.random() * 1000);
const upstreamPort = 22787 + Math.floor(Math.random() * 1000);
const upstreamBase = `http://127.0.0.1:${upstreamPort}`;
const now = new Date().toISOString();

const upstream = http.createServer((req, res) => {
  if (new URL(req.url, upstreamBase).pathname === '/api/v1/usage') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { items: [{
      id: 'boot-usage', api_key_id: '6178', model: 'gpt-5.6-sol',
      actual_cost: 6.9053, input_tokens: 10, output_tokens: 1, created_at: now
    }] } }));
    return;
  }
  res.writeHead(404).end();
});

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function stop(child) {
  if (child.exitCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function waitFor(predicate, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for boot ledger sync');
}

const initialDb = {
  users: [{
    id: 'usr_boot_customer', email: 'boot@example.com', username: 'bootuser', name: 'Boot User',
    password: 'not-used', balance: 10, quotaTokens: 0, usedTokens: 0, reservedTokens: 0,
    reservedBalance: 0, pendingActualHold: 0, accountActive: true, banned: false, role: 'user',
    apiKeys: [{
      id: 'key_boot_customer', key: 'rk-boot-customer', name: 'boot', groupId: 'grp_gpt_mix',
      models: ['gpt-5.6-sol'], enabled: true, spendLimit: 0, spendUsed: 0, reservedSpend: 0,
      tokenLimit: 0, tokenUsed: 0, upstream: { provider: 'vip1129', id: '6178', key: 'sk-boot' }
    }]
  }],
  rechargeCodes: [], logs: [], upstreamBills: [], auditLogs: [], sessions: {}, paymentOrders: [], checkIns: [],
  settings: {
    billingMultiplier: 2.5,
    billingMultiplierVip1129: 1.1,
    upstreamVip1129: {
      enabled: true, baseUrl: upstreamBase, email: 'mock@example.com', password: 'unused',
      accessToken: 'mock-token', tokenExpiresAt: Date.now() + 600000, groupMap: { grp_gpt_mix: 65 }, lastError: null
    },
    providers: [{
      id: 'grp_gpt_mix', name: 'GPT Mix', url: `${upstreamBase}/v1/chat/completions`, upstreamSync: 'vip1129',
      defaultModel: 'gpt-5.6-sol', models: ['gpt-5.6-sol'], inputPricePer1K: 0.005,
      outputPricePer1K: 0.03, enabled: false, priority: 1, timeoutMs: 1000, maxRetries: 0
    }]
  }
};

let child = null;
try {
  await listen(upstream, upstreamPort);
  fs.writeFileSync(path.join(tmp, 'db.json'), JSON.stringify(initialDb, null, 2));
  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(relayPort), RELAY_DATA_DIR: tmp, RELAY_SKIP_BOOT_JOBS: '', SKIP_BOOT_JOBS: '',
      ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test-admin-pass', ADMIN_EMAIL: 'admin@example.com',
      VIP1129_EMAIL: '', VIP1129_PASSWORD: '', BEIBEIHAI_EMAIL: '', BEIBEIHAI_PASSWORD: ''
    },
    stdio: ['ignore', 'ignore', 'ignore']
  });

  const store = openDbDir(tmp);
  const dbPath = store.file;
  await waitFor(() => {
    try {
      const db = store.read();
      return db.settings?.upstreamUsageSync?.initialBackfillCompleted === true;
    } catch {
      return false;
    }
  });
  const after = store.read();
  const user = after.users.find((item) => item.id === 'usr_boot_customer');
  assert.equal(after.settings.upstreamUsageSync.initialBackfillCompleted, true);
  assert.equal(after.upstreamBills.length, 1);
  assert.equal(after.upstreamBills[0].actualCost, 6.9053);
  assert.ok(Math.abs(after.upstreamBills[0].chargedAmount - 7.59583) < 1e-9);
  assert.ok(Math.abs(user.balance - 2.40417) < 1e-9, `unexpected balance ${user.balance}`);
  console.log('upstream-billing-boot.test.mjs: all assertions passed');
} finally {
  if (child) await stop(child);
  await close(upstream);
  fs.rmSync(tmp, { recursive: true, force: true });
}
