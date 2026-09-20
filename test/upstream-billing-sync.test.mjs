/**
 * End-to-end ledger test with a local vip1129-compatible usage endpoint.
 * It proves that the upstream actual_cost, rather than local request matching,
 * is the number used to correct customer billing.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDbDir } from '../lib/db-crypto.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ledger-'));
const relayPort = 19787 + Math.floor(Math.random() * 1000);
const upstreamPort = 20787 + Math.floor(Math.random() * 1000);
const relayBase = `http://127.0.0.1:${relayPort}`;
const upstreamBase = `http://127.0.0.1:${upstreamPort}`;
const now = new Date().toISOString();
let forwardedChats = 0;

const usageRows = [
  {
    id: 'usage-direct', api_key_id: '6178', model: 'gpt-5.6-sol',
    actual_cost: 6.9053, input_tokens: 1000, output_tokens: 100,
    created_at: now
  },
  {
    id: 'usage-missed', api_key_id: '6178', model: 'gpt-5.6-sol',
    actual_cost: 0.25, input_tokens: 200, output_tokens: 20,
    created_at: now
  },
  {
    id: 'usage-over-limit', api_key_id: '6200', model: 'gpt-5.6-sol',
    actual_cost: 2, input_tokens: 200, output_tokens: 20,
    created_at: now
  }
];

const upstream = http.createServer((req, res) => {
  const url = new URL(req.url, upstreamBase);
  if (url.pathname === '/api/v1/usage') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { items: usageRows } }));
    return;
  }
  if (url.pathname === '/v1/chat/completions') {
    forwardedChats += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'unexpected' } }], usage: { total_tokens: 1 } }));
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

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function stop(child) {
  if (child.exitCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
  });
}

function assertAmount(actual, expected, message = '') {
  assert.ok(Math.abs(Number(actual) - expected) < 1e-9, `${message} expected ${expected}, got ${actual}`);
}

function waitForListen(child, output, ms = 15000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      if (/Relay Station running/.test(output())) return resolve();
      if (child.exitCode != null) return reject(new Error(`relay exited ${child.exitCode}: ${output()}`));
      if (Date.now() >= deadline) return reject(new Error(`relay did not listen: ${output()}`));
      setTimeout(tick, 40);
    };
    tick();
  });
}

async function request(pathname, opts = {}) {
  const response = await fetch(`${relayBase}${pathname}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(relayPort),
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
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

try {
  await listen(upstream, upstreamPort);
  await waitForListen(child, () => output);

  const login = await request('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ login: 'admin', password: 'test-admin-pass' })
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const auth = { Authorization: `Bearer ${login.body.token}` };

  const store = openDbDir(tmp);
  const dbPath = store.file;
  const db = store.read();
  const provider = db.settings.providers.find((item) => item.id === 'grp_gpt_mix');
  provider.url = `${upstreamBase}/v1/chat/completions`;
  provider.upstreamSync = 'vip1129';
  provider.enabled = true;
  provider.models = ['gpt-5.6-sol'];
  provider.defaultModel = 'gpt-5.6-sol';
  db.settings.billingMultiplierVip1129 = 1.1;
  db.settings.upstreamVip1129 = {
    enabled: true,
    baseUrl: upstreamBase,
    email: 'mock@example.com',
    password: 'unused',
    accessToken: 'mock-token',
    tokenExpiresAt: Date.now() + 600000,
    groupMap: { grp_gpt_mix: 65 },
    lastError: null
  };
  const userId = 'usr_ledger_customer';
  const keyId = 'key_ledger_customer';
  db.users.push({
    id: userId,
    email: 'ledger@example.com',
    username: 'ledgeruser',
    name: 'Ledger User',
    balance: 18.5428,
    quotaTokens: 0,
    usedTokens: 0,
    reservedTokens: 0,
    reservedBalance: 0,
    pendingActualHold: 0,
    upstreamOutstandingAmount: 0,
    accountActive: true,
    role: 'user',
    apiKeys: [{
      id: keyId, key: 'rk-ledger-customer', name: 'ledger', groupId: 'grp_gpt_mix',
      models: ['gpt-5.6-sol'], enabled: true, spendLimit: 0, spendUsed: 1.4572,
      reservedSpend: 0, tokenLimit: 0, tokenUsed: 0, upstream: { provider: 'vip1129', id: '6178', key: 'sk-ledger' }
    }]
  });
  db.users.push({
    id: 'usr_overdrawn_customer', email: 'overdrawn@example.com', username: 'overdrawnuser', name: 'Overdrawn User',
    balance: 0.5, quotaTokens: 0, usedTokens: 0, reservedTokens: 0, reservedBalance: 0,
    pendingActualHold: 0, upstreamOutstandingAmount: 0, accountActive: true, role: 'user',
    apiKeys: [{
      id: 'key_overdrawn_customer', key: 'rk-overdrawn-customer', name: 'overdrawn', groupId: 'grp_gpt_mix',
      models: ['gpt-5.6-sol'], enabled: true, spendLimit: 0, spendUsed: 0, reservedSpend: 0,
      tokenLimit: 0, tokenUsed: 0, upstream: { provider: 'vip1129', id: '6200', key: 'sk-overdrawn' }
    }]
  });
  db.logs = [{
    id: 'log_direct', userId, apiKeyId: keyId, model: 'gpt-5.6-sol', providerId: 'grp_gpt_mix',
    tokens: 1100, billedTokens: 1210, upstreamCost: 1.3247272727, upstreamCostSource: 'reported',
    chargedAmount: 1.4572, alreadyCharged: 1.4572, multiplier: 1.1,
    upstreamUsageId: 'usage-direct', upstreamApiKeyId: '6178', pendingActual: false,
    holdAmount: 0, status: 'success', createdAt: now, startedAt: now
  }];
  store.write(db);

  const first = await request('/api/admin/upstream-billing/sync', {
    method: 'POST', headers: auth, body: JSON.stringify({ fullBackfill: true })
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.synced.imported, 2);
  assert.equal(first.body.synced.linked, 1);

  let after = store.read();
  let customer = after.users.find((item) => item.id === userId);
  const overdrawn = after.users.find((item) => item.id === 'usr_overdrawn_customer');
  let direct = after.logs.find((item) => item.id === 'log_direct');
  assertAmount(customer.balance, 12.12917, 'unexpected balance');
  assertAmount(direct.chargedAmount, 7.59583);
  assert.equal(direct.multiplier, 1.1);
  assert.equal(after.upstreamBills.length, 3);
  assertAmount(overdrawn.balance, 0);
  assertAmount(overdrawn.upstreamOutstandingAmount, 1.7);
  assert.equal(overdrawn.accountActive, false);
  assertAmount(first.body.stats.upstreamCostToday, 9.1553 / 7);
  assertAmount(first.body.stats.chargedToday, 10.0708);

  const duplicate = await request('/api/admin/upstream-billing/sync', {
    method: 'POST', headers: auth, body: JSON.stringify({ fullBackfill: true })
  });
  assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body));
  after = store.read();
  customer = after.users.find((item) => item.id === userId);
  assertAmount(customer.balance, 12.12917, 'a repeated sync must not charge again');
  assert.equal(after.upstreamBills.length, 3, 'a repeated sync must not duplicate bills');

  const repriced = await request('/api/admin/pricing', {
    method: 'PUT', headers: auth, body: JSON.stringify({ multiplierVip1129: 1.5 })
  });
  assert.equal(repriced.status, 200, JSON.stringify(repriced.body));
  assert.equal(repriced.body.ledgerSync?.skipped, false);
  assert.equal(repriced.body.repricedLedgerRows, 3);
  after = store.read();
  customer = after.users.find((item) => item.id === userId);
  const repricedOverdrawn = after.users.find((item) => item.id === 'usr_overdrawn_customer');
  direct = after.logs.find((item) => item.id === 'log_direct');
  assertAmount(customer.balance, 9.26705, 'unexpected repriced balance');
  assertAmount(repricedOverdrawn.upstreamOutstandingAmount, 2.5);
  assert.equal(repricedOverdrawn.accountActive, false);
  assertAmount(direct.chargedAmount, 10.35795);
  assert.equal(direct.multiplier, 1.5);
  assert.equal(repriced.body.multiplierVip1129, 1.5);
  assertAmount(after.upstreamBills.reduce((sum, bill) => sum + Number(bill.chargedAmount || 0), 0), 13.73295);

  const blocked = await request('/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer rk-overdrawn-customer' },
    body: JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hello' }], max_tokens: 32 })
  });
  assert.equal(blocked.status, 402, JSON.stringify(blocked.body));
  assert.equal(forwardedChats, 0, 'an unpaid upstream bill must block before contacting upstream');

  console.log('upstream-billing-sync.test.mjs: all assertions passed');
} finally {
  await stop(child);
  await close(upstream);
  fs.rmSync(tmp, { recursive: true, force: true });
}
