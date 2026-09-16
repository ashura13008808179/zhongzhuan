/**
 * Real concurrent billing audit. It intentionally uses an isolated regular
 * account and newly-created upstream keys so every row in the report belongs
 * to this run. It never prints API secrets.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as vip1129 from '../upstream/vip1129.js';
import { usageListFromPayload } from '../lib/billing-cost.js';
import { upstreamUsageApiKeyId, upstreamUsageCost, upstreamUsageId } from '../lib/upstream-billing-ledger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = path.join(ROOT, 'data', 'db.json');
const BASE = process.env.RELAY_BASE || 'http://127.0.0.1:8787';
const GROUP_ID = 'grp_gpt_mix';
const MODEL = 'gpt-5.5';
const SINGLE_KEY_CONCURRENCY = Math.max(1, Math.min(50, Number(process.env.CONCURRENT_SINGLE_KEY_COUNT || 10)));
const MULTI_KEY_COUNT = Math.max(0, Math.min(20, Number(process.env.CONCURRENT_MULTI_KEY_COUNT || 3)));
const MULTI_KEY_CONCURRENCY = Math.max(1, Math.min(50, Number(process.env.CONCURRENT_MULTI_KEY_REQUESTS || 5)));
const FUNDING = Math.max(0, Number(process.env.CONCURRENT_BILLING_FUNDING || 10));
const EPSILON = 1e-10;
const runId = String(process.env.CONCURRENT_BILLING_RUN_ID || `concurrent-${Date.now().toString(36)}`).trim();
const reportFile = path.join(ROOT, 'data', `${runId}.report.json`);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const numeric = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const close = (a, b) => Math.abs(numeric(a) - numeric(b)) <= EPSILON;

function readDb() {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (error) { lastError = error; }
  }
  throw lastError;
}

function responseError(body) {
  if (typeof body?.error === 'string') return body.error;
  return body?.error?.message || body?.message || body?.raw || 'unknown_error';
}

async function api(pathname, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
  return { ok: response.ok, status: response.status, data };
}

async function requireApi(pathname, opts) {
  const result = await api(pathname, opts);
  if (!result.ok) throw new Error(`api_${opts?.method || 'GET'}_${pathname}_${result.status}:${responseError(result.data)}`);
  return result.data;
}

function adminToken(db) {
  const admin = (db.users || []).find((user) => user?.role === 'admin');
  const session = Object.entries(db.sessions || {}).find(([, value]) => value?.userId === admin?.id);
  if (!admin || !session) throw new Error('admin_session_not_found');
  return session[0];
}

async function upstreamRows(cfg, upstreamKeyId) {
  let token = String(cfg?.accessToken || '').trim();
  const expiresAt = Date.parse(cfg?.tokenExpiresAt || '') || 0;
  if (!token || expiresAt - Date.now() < 60_000) {
    const logged = await vip1129.login(cfg?.baseUrl, cfg?.email, cfg?.password);
    if (!logged.ok) throw new Error(`upstream_login_${logged.status || logged.error || 'failed'}`);
    token = logged.token;
  }
  let last;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    last = await vip1129.fetchUsage(
      cfg.baseUrl,
      token,
      `page=1&page_size=100&api_key_id=${encodeURIComponent(upstreamKeyId)}`,
      { timeoutMs: 30_000 }
    );
    if (last.ok) return usageListFromPayload(last.data);
    if (last.status !== 429) throw new Error(`upstream_usage_${last.status || last.error || 'failed'}`);
    await wait(12_000 + attempt * 8_000);
  }
  throw new Error(`upstream_usage_rate_limited_${last?.status || 429}`);
}

async function chat(key, phase, ordinal) {
  const requestId = `${runId}-${phase}-${String(ordinal).padStart(2, '0')}`;
  const started = Date.now();
  try {
    const response = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key.secret}`,
        'Content-Type': 'application/json',
        'X-Request-Id': requestId
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 8,
        stream: false,
        messages: [{ role: 'user', content: `Reply exactly ${requestId}.` }]
      })
    });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 300) }; }
    return {
      phase,
      keyLabel: key.label,
      localKeyId: key.id,
      requestId,
      httpStatus: response.status,
      durationMs: Date.now() - started,
      responseId: body?.id || null,
      reply: String(body?.choices?.[0]?.message?.content || '').slice(0, 100),
      error: response.ok ? '' : responseError(body)
    };
  } catch (error) {
    return {
      phase,
      keyLabel: key.label,
      localKeyId: key.id,
      requestId,
      httpStatus: 0,
      durationMs: Date.now() - started,
      responseId: null,
      reply: '',
      error: String(error?.message || error)
    };
  }
}

function ownedRows(db, userId, keys) {
  const keyIds = new Set(keys.map((key) => key.id));
  const upstreamByKey = new Map(keys.map((key) => [key.id, String(key.upstreamKeyId)]));
  const owns = (row) => row?.userId === userId
    && keyIds.has(row?.apiKeyId)
    && String(row?.upstreamApiKeyId || '') === upstreamByKey.get(row.apiKeyId);
  return {
    logs: (db.logs || []).filter(owns),
    bills: (db.upstreamBills || []).filter(owns)
  };
}

async function waitForLedger(userId, keys, expectedSuccesses, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const db = readDb();
    const rows = ownedRows(db, userId, keys);
    const settledLogs = rows.logs.filter((log) => log.upstreamCostSource === 'reported' && !log.pendingActual && log.upstreamUsageId);
    const settled = settledLogs.length === expectedSuccesses
      && rows.bills.length === expectedSuccesses
      && rows.bills.every((bill) => bill.localLogId && close(bill.chargedAmount, numeric(bill.actualCost) * numeric(bill.multiplier)));
    last = { db, ...rows, settled };
    if (settled) return last;
    await wait(1_000);
  }
  return last || { db: readDb(), logs: [], bills: [], settled: false };
}

function reconcileKey({ key, upstream, logs, bills, multiplier }) {
  const usageIds = new Set(upstream.map(upstreamUsageId));
  const keyLogs = logs.filter((row) => row.apiKeyId === key.id);
  const keyBills = bills.filter((row) => row.apiKeyId === key.id);
  const logIds = new Set(keyLogs.map((row) => String(row.upstreamUsageId)));
  const billIds = new Set(keyBills.map((row) => String(row.upstreamUsageId)));
  const rowsById = new Map(upstream.map((row) => [upstreamUsageId(row), row]));
  const billsById = new Map(keyBills.map((row) => [String(row.upstreamUsageId), row]));
  const logsById = new Map(keyLogs.map((row) => [String(row.upstreamUsageId), row]));
  const rows = [...usageIds].map((usageId) => {
    const row = rowsById.get(usageId);
    const bill = billsById.get(usageId);
    const log = logsById.get(usageId);
    const actualCost = upstreamUsageCost(row);
    const expectedCharge = actualCost * multiplier;
    return {
      upstreamUsageId: usageId,
      actualCost,
      expectedCharge,
      billCharge: bill ? numeric(bill.chargedAmount) : null,
      logCharge: log ? numeric(log.chargedAmount) : null,
      matched: Boolean(bill && log)
        && close(bill.actualCost, actualCost)
        && close(bill.chargedAmount, expectedCharge)
        && close(log.chargedAmount, expectedCharge)
    };
  });
  const costTotal = upstream.reduce((sum, row) => sum + upstreamUsageCost(row), 0);
  const chargedTotal = keyBills.reduce((sum, row) => sum + numeric(row.chargedAmount), 0);
  return {
    keyLabel: key.label,
    localKeyId: key.id,
    upstreamKeyId: key.upstreamKeyId,
    upstreamRows: upstream.length,
    localLogs: keyLogs.length,
    localBills: keyBills.length,
    missingBills: [...usageIds].filter((id) => !billIds.has(id)).length,
    missingLogs: [...usageIds].filter((id) => !logIds.has(id)).length,
    surplusBills: [...billIds].filter((id) => !usageIds.has(id)).length,
    surplusLogs: [...logIds].filter((id) => !usageIds.has(id)).length,
    duplicateBills: keyBills.length - billIds.size,
    duplicateLogs: keyLogs.length - logIds.size,
    upstreamCostTotal: costTotal,
    chargedTotal,
    spendUsed: numeric(key.currentSpendUsed),
    matched: rows.every((row) => row.matched)
      && close(chargedTotal, costTotal * multiplier)
      && close(numeric(key.currentSpendUsed), chargedTotal),
    rows
  };
}

const report = {
  runId,
  startedAt: new Date().toISOString(),
  plan: {
    model: MODEL,
    groupId: GROUP_ID,
    singleKeyConcurrentRequests: SINGLE_KEY_CONCURRENCY,
    multiKeyCount: MULTI_KEY_COUNT,
    requestsPerMultiKey: MULTI_KEY_CONCURRENCY,
    totalRequests: SINGLE_KEY_CONCURRENCY + MULTI_KEY_COUNT * MULTI_KEY_CONCURRENCY
  },
  status: 'running',
  requests: []
};

try {
  const db0 = readDb();
  const registration = await requireApi('/api/auth/register', {
    method: 'POST',
    body: {
      username: `${runId.replace(/[^a-z0-9]/gi, '').toLowerCase()}`.slice(0, 30),
      name: `Concurrent Audit ${runId.slice(-6)}`,
      email: `${runId.replace(/[^a-z0-9]/gi, '').toLowerCase()}@billing-test.invalid`,
      password: `Test-${runId}-x9!`
    }
  });
  const userId = registration.user?.id;
  const userToken = registration.token;
  if (!userId || !userToken) throw new Error('test_user_registration_incomplete');
  await requireApi(`/api/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    token: adminToken(db0),
    body: { balance: FUNDING }
  });

  const keySpecs = [
    { label: 'single-key', count: SINGLE_KEY_CONCURRENCY, phase: 'single' },
    ...Array.from({ length: MULTI_KEY_COUNT }, (_, index) => ({ label: `multi-key-${index + 1}`, count: MULTI_KEY_CONCURRENCY, phase: 'multi' }))
  ];
  const keys = [];
  for (const spec of keySpecs) {
    const created = await requireApi('/api/keys', {
      token: userToken,
      method: 'POST',
      body: { name: `${runId}-${spec.label}`, groupId: GROUP_ID, models: [MODEL] }
    });
    if (!created.key?.id || !created.key?.key) throw new Error(`key_creation_incomplete:${spec.label}`);
    const db = readDb();
    const user = (db.users || []).find((item) => item.id === userId);
    const stored = (user?.apiKeys || []).find((item) => item.id === created.key.id);
    if (!stored?.upstream?.id || stored.upstream.provider !== 'vip1129') throw new Error(`upstream_key_not_synced:${spec.label}`);
    keys.push({ ...spec, id: stored.id, secret: created.key.key, upstreamKeyId: String(stored.upstream.id) });
  }

  const dbBefore = readDb();
  const userBefore = (dbBefore.users || []).find((item) => item.id === userId);
  const multiplier = numeric(dbBefore.settings?.billingMultiplierVip1129);
  if (multiplier <= 0) throw new Error('invalid_vip1129_multiplier');
  report.testUser = { id: userId, username: userBefore?.username };
  report.keys = keys.map(({ secret, ...key }) => key);
  report.multiplier = multiplier;
  report.balanceBefore = numeric(userBefore?.balance);

  const singleKey = keys[0];
  const singleBatch = await Promise.all(Array.from({ length: singleKey.count }, (_, index) => chat(singleKey, singleKey.phase, index + 1)));
  report.requests.push(...singleBatch);
  const multiBatch = await Promise.all(keys.slice(1).flatMap((key) => (
    Array.from({ length: key.count }, (_, index) => chat(key, key.phase, index + 1))
  )));
  report.requests.push(...multiBatch);

  const successfulRequests = report.requests.filter((item) => item.httpStatus === 200);
  const local = await waitForLedger(userId, keys, successfulRequests.length);
  const finalDb = local.db;
  const finalUser = (finalDb.users || []).find((item) => item.id === userId);
  const finalKeys = new Map((finalUser?.apiKeys || []).map((key) => [key.id, key]));
  for (const key of keys) key.currentSpendUsed = finalKeys.get(key.id)?.spendUsed || 0;

  const upstreamByKey = new Map();
  for (const key of keys) {
    const rows = await upstreamRows(finalDb.settings?.upstreamVip1129, key.upstreamKeyId);
    if (rows.some((row) => upstreamUsageApiKeyId(row) && upstreamUsageApiKeyId(row) !== key.upstreamKeyId)) {
      throw new Error(`upstream_usage_wrong_key:${key.label}`);
    }
    upstreamByKey.set(key.id, rows);
  }
  const reconciliation = keys.map((key) => reconcileKey({
    key,
    upstream: upstreamByKey.get(key.id) || [],
    logs: local.logs,
    bills: local.bills,
    multiplier
  }));
  const upstreamCostTotal = reconciliation.reduce((sum, item) => sum + item.upstreamCostTotal, 0);
  const chargedTotal = reconciliation.reduce((sum, item) => sum + item.chargedTotal, 0);
  const balanceDelta = report.balanceBefore - numeric(finalUser?.balance);
  const allRequestsSucceeded = successfulRequests.length === report.plan.totalRequests;
  const allMatched = allRequestsSucceeded
    && local.settled
    && reconciliation.every((item) => item.matched)
    && close(chargedTotal, upstreamCostTotal * multiplier)
    && close(balanceDelta, chargedTotal)
    && numeric(finalUser?.upstreamOutstandingAmount) === 0;

  report.finishedAt = new Date().toISOString();
  report.status = allMatched ? 'passed' : 'failed_reconciliation';
  report.summary = {
    allMatched,
    requestCount: report.requests.length,
    http200: successfulRequests.length,
    failedRequests: report.requests.length - successfulRequests.length,
    localSettled: local.settled,
    upstreamCostTotal,
    expectedChargeTotal: upstreamCostTotal * multiplier,
    chargedTotal,
    balanceDelta,
    outstandingAmount: numeric(finalUser?.upstreamOutstandingAmount),
    perKey: reconciliation.map(({ rows, ...summary }) => summary)
  };
  report.rows = reconciliation.flatMap((item) => item.rows.map((row) => ({ keyLabel: item.keyLabel, ...row })));
} catch (error) {
  report.finishedAt = new Date().toISOString();
  report.status = 'failed_execution';
  report.error = String(error?.message || error);
}

report.reportFile = path.relative(ROOT, reportFile);
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === 'passed' ? 0 : 2;
