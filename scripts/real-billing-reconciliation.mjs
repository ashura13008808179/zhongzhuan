/**
 * Creates an isolated regular account, runs real chat requests, and reconciles
 * its local ledger with the provider usage ledger. Output is intentionally
 * secret-free so it can be retained as an audit record.
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
const REQUEST_COUNT = Math.max(1, Math.min(100, Number(process.env.BILLING_TEST_COUNT || 30)));
const FUNDING_AMOUNT = Math.max(1, Number(process.env.BILLING_TEST_BALANCE || 20));
const TEST_GROUP = String(process.env.BILLING_TEST_GROUP || 'grp_gpt_mix').trim();
const TEST_MODEL = String(process.env.BILLING_TEST_MODEL || 'gpt-5.6-sol').trim();
const MAX_TRANSIENT_RETRIES = Math.max(0, Math.min(10, Number(process.env.BILLING_TEST_RETRIES || 4)));
const RETRY_DELAY_MS = Math.max(1_000, Number(process.env.BILLING_TEST_RETRY_DELAY_MS || 15_000));
const EPSILON = 1e-10;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const closeEnough = (a, b) => Math.abs(number(a) - number(b)) <= EPSILON;

function readDb() {
  // The server uses atomic rename writes. A small retry still makes this tool
  // resilient to antivirus/file-indexing interference on Windows.
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (error) { lastError = error; }
  }
  throw lastError;
}

function testRows(db, { userId, keyId, upstreamKeyId }) {
  const ownBill = (bill) => bill?.userId === userId
    && bill?.apiKeyId === keyId
    && String(bill?.upstreamApiKeyId || '') === String(upstreamKeyId);
  const ownLog = (log) => log?.userId === userId
    && log?.apiKeyId === keyId
    && String(log?.upstreamApiKeyId || '') === String(upstreamKeyId);
  return {
    bills: (db.upstreamBills || []).filter(ownBill),
    logs: (db.logs || []).filter(ownLog)
  };
}

function pickAdminAuth(db) {
  const admin = (db.users || []).find((user) => user?.role === 'admin');
  if (!admin) throw new Error('admin_not_found');
  const session = Object.entries(db.sessions || {}).find(([, value]) => value?.userId === admin.id);
  if (!session) throw new Error('admin_session_not_found');
  return { admin, token: session[0] };
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
  if (!result.ok) throw new Error(`api_${opts?.method || 'GET'}_${pathname}_${result.status}:${result.data?.error || result.data?.message || 'failed'}`);
  return result.data;
}

async function waitForSettled(context, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    const db = readDb();
    const { bills, logs } = testRows(db, context);
    const settled = bills.length === REQUEST_COUNT
      && logs.length === REQUEST_COUNT
      && bills.every((bill) => bill.localLogId && closeEnough(bill.chargedAmount, number(bill.actualCost) * context.multiplier))
      && logs.every((log) => log.upstreamUsageId && log.upstreamCostSource === 'reported' && !log.pendingActual);
    last = { db, bills, logs, settled };
    if (settled) return last;
    await delay(1_000);
  }
  return last || { db: readDb(), bills: [], logs: [], settled: false };
}

async function upstreamUsage(cfg, upstreamKeyId) {
  let authToken = String(cfg?.accessToken || '').trim();
  const expiresAt = Date.parse(cfg?.tokenExpiresAt || '') || 0;
  if (!authToken || expiresAt - Date.now() < 60_000) {
    const login = await vip1129.login(cfg?.baseUrl, cfg?.email, cfg?.password);
    if (!login.ok) throw new Error(`upstream_login_${login.status || login.error || 'failed'}`);
    authToken = login.token;
  }
  let last;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    last = await vip1129.fetchUsage(
      cfg.baseUrl,
      authToken,
      `page=1&page_size=100&api_key_id=${encodeURIComponent(upstreamKeyId)}`,
      { timeoutMs: 30_000 }
    );
    if (last.ok) return usageListFromPayload(last.data);
    if (last.status !== 429) throw new Error(`upstream_usage_${last.status || last.error || 'failed'}`);
    await delay(12_000 + attempt * 8_000);
  }
  throw new Error(`upstream_usage_rate_limited_${last?.status || 429}`);
}

function auditRows({ upstreamRows, bills, logs, multiplier }) {
  const billsByUsage = new Map(bills.map((bill) => [String(bill.upstreamUsageId), bill]));
  const logsByUsage = new Map(logs.map((log) => [String(log.upstreamUsageId), log]));
  return upstreamRows
    .map((row) => {
      const usageId = upstreamUsageId(row);
      const bill = billsByUsage.get(usageId);
      const log = logsByUsage.get(usageId);
      const actualCost = upstreamUsageCost(row);
      const expectedCharge = actualCost * multiplier;
      return {
        upstreamUsageId: usageId,
        actualCost,
        expectedCharge,
        billActualCost: bill ? number(bill.actualCost) : null,
        billChargedAmount: bill ? number(bill.chargedAmount) : null,
        logChargedAmount: log ? number(log.chargedAmount) : null,
        logId: log?.id || null,
        matched: Boolean(bill && log)
          && closeEnough(bill.actualCost, actualCost)
          && closeEnough(bill.chargedAmount, expectedCharge)
          && closeEnough(log.chargedAmount, expectedCharge)
      };
    })
    .sort((a, b) => String(a.upstreamUsageId).localeCompare(String(b.upstreamUsageId), undefined, { numeric: true }));
}

const resumedRunId = String(process.env.BILLING_TEST_RESUME_RUN || '').trim();
const requestedRunId = String(process.env.BILLING_TEST_RUN_ID || '').trim();
const runId = resumedRunId || requestedRunId || `billing30-${Date.now().toString(36)}`;
const reportFile = path.join(ROOT, 'data', `${runId}.report.json`);
const report = {
  runId,
  requestCount: REQUEST_COUNT,
  fundingAmount: FUNDING_AMOUNT,
  startedAt: new Date().toISOString(),
  status: 'running',
  requests: [],
  transientFailures: []
};

try {
  const username = `${runId.replace(/[^a-z0-9]/gi, '').toLowerCase()}`.slice(0, 30);
  const initialDb = readDb();
  let userId;
  let userToken;
  let localKey;
  let dbAfterKey;
  let testUser;
  let upstreamKeyId;
  let priorRows = { bills: [], logs: [] };
  let startOrdinal = 1;

  if (resumedRunId) {
    testUser = (initialDb.users || []).find((user) => user.username === username);
    if (!testUser) throw new Error('resume_test_user_not_found');
    const session = Object.entries(initialDb.sessions || {}).find(([, value]) => value?.userId === testUser.id);
    if (!session) throw new Error('resume_test_user_session_not_found');
    userId = testUser.id;
    userToken = session[0];
    localKey = (testUser.apiKeys || []).find((key) => key.name === runId && key.upstream?.provider === 'vip1129');
    if (!localKey?.id || !localKey?.key) throw new Error('resume_test_api_key_not_found');
    upstreamKeyId = localKey.upstream?.id;
    dbAfterKey = initialDb;
    report.resumed = true;
  } else {
    const { token: adminToken } = pickAdminAuth(initialDb);
    const registration = await requireApi('/api/auth/register', {
      method: 'POST',
      body: {
        username,
        name: `Billing Audit ${runId.slice(-6)}`,
        email: `${username}@billing-test.invalid`,
        password: `Test-${runId}-x9!`
      }
    });
    userId = registration.user?.id;
    userToken = registration.token;
    if (!userId || !userToken) throw new Error('test_user_registration_incomplete');
    await requireApi(`/api/admin/users/${encodeURIComponent(userId)}`, {
      token: adminToken,
      method: 'PUT',
      body: { balance: FUNDING_AMOUNT }
    });
    const created = await requireApi('/api/keys', {
      token: userToken,
      method: 'POST',
      body: { name: runId, groupId: TEST_GROUP, models: [TEST_MODEL] }
    });
    localKey = created.key;
    if (!localKey?.id || !localKey?.key) throw new Error('test_api_key_creation_incomplete');
    dbAfterKey = readDb();
    testUser = (dbAfterKey.users || []).find((user) => user.id === userId);
    localKey = (testUser?.apiKeys || []).find((key) => key.id === localKey.id) || localKey;
    upstreamKeyId = localKey?.upstream?.id;
  }

  if (!upstreamKeyId || localKey?.upstream?.provider !== 'vip1129') throw new Error('test_upstream_key_not_synced');
  const multiplier = number(dbAfterKey.settings?.billingMultiplierVip1129);
  if (multiplier <= 0) throw new Error('invalid_vip1129_multiplier');
  const context = { userId, keyId: localKey.id, upstreamKeyId, multiplier };
  priorRows = testRows(dbAfterKey, context);
  if (!resumedRunId && (priorRows.bills.length || priorRows.logs.length)) throw new Error('isolated_key_has_preexisting_ledger_rows');
  if (priorRows.bills.length !== priorRows.logs.length || priorRows.bills.length >= REQUEST_COUNT) throw new Error('resume_ledger_state_invalid');
  startOrdinal = priorRows.logs.length + 1;
  report.testUser = { id: userId, username: testUser.username };
  report.key = { id: localKey.id, upstreamKeyId, provider: 'vip1129', groupId: TEST_GROUP };
  report.multiplier = multiplier;
  report.balanceBeforeRequests = resumedRunId ? FUNDING_AMOUNT : number(testUser?.balance);
  report.requests = priorRows.logs.map((log, index) => ({
    ordinal: index + 1,
    requestId: log.clientRequestId || `preexisting-${index + 1}`,
    httpStatus: 200,
    durationMs: number(log.latency),
    responseId: null,
    reply: ''
  }));

  for (let ordinal = startOrdinal; ordinal <= REQUEST_COUNT; ordinal += 1) {
    const requestId = `${runId}-${String(ordinal).padStart(2, '0')}`;
    let completed = false;
    let finalError = 'failed';
    for (let attempt = 1; attempt <= MAX_TRANSIENT_RETRIES + 1; attempt += 1) {
      const started = Date.now();
      const response = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${localKey.key}`,
          'Content-Type': 'application/json',
          'X-Request-Id': requestId
        },
        body: JSON.stringify({
          model: TEST_MODEL,
          stream: false,
          temperature: 0,
          max_tokens: 16,
          messages: [{ role: 'user', content: `Reply with exactly ${requestId} and nothing else.` }]
        })
      });
      const bodyText = await response.text();
      let body = {};
      try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { body = { raw: bodyText.slice(0, 300) }; }
      const error = typeof body?.error === 'string'
        ? body.error
        : (body?.error?.message || body?.message || body?.raw || 'failed');
      if (response.ok) {
        report.requests.push({
          ordinal,
          requestId,
          attempt,
          httpStatus: response.status,
          durationMs: Date.now() - started,
          responseId: body?.id || null,
          reply: String(body?.choices?.[0]?.message?.content || '').slice(0, 100)
        });
        completed = true;
        break;
      }
      finalError = error;
      report.transientFailures.push({
        ordinal,
        requestId,
        attempt,
        httpStatus: response.status,
        durationMs: Date.now() - started,
        error
      });
      if (attempt <= MAX_TRANSIENT_RETRIES) await delay(RETRY_DELAY_MS);
    }
    if (!completed) throw new Error(`chat_request_${ordinal}_failed_after_retries:${finalError}`);
  }

  const local = await waitForSettled(context);
  const finalDb = local.db;
  const finalUser = (finalDb.users || []).find((user) => user.id === userId);
  const upstreamRows = await upstreamUsage(finalDb.settings?.upstreamVip1129, upstreamKeyId);
  const wrongKeyRows = upstreamRows.filter((row) => upstreamUsageApiKeyId(row) && upstreamUsageApiKeyId(row) !== String(upstreamKeyId));
  const rows = auditRows({ upstreamRows, bills: local.bills, logs: local.logs, multiplier });
  const upstreamIds = new Set(upstreamRows.map(upstreamUsageId));
  const billIds = new Set(local.bills.map((bill) => String(bill.upstreamUsageId)));
  const logIds = new Set(local.logs.map((log) => String(log.upstreamUsageId)));
  const upstreamCostTotal = upstreamRows.reduce((sum, row) => sum + upstreamUsageCost(row), 0);
  const expectedChargeTotal = upstreamCostTotal * multiplier;
  const chargedTotal = local.bills.reduce((sum, bill) => sum + number(bill.chargedAmount), 0);
  const balanceDelta = report.balanceBeforeRequests - number(finalUser?.balance);
  const duplicateBillIds = local.bills.length - billIds.size;
  const duplicateLogIds = local.logs.length - logIds.size;
  const missingBills = [...upstreamIds].filter((usageId) => !billIds.has(usageId));
  const missingLogs = [...upstreamIds].filter((usageId) => !logIds.has(usageId));
  const surplusBills = [...billIds].filter((usageId) => !upstreamIds.has(usageId));
  const surplusLogs = [...logIds].filter((usageId) => !upstreamIds.has(usageId));
  const discrepancies = rows.reduce((sum, row) => sum + Math.abs(number(row.billChargedAmount) - row.expectedCharge), 0);
  const allMatched = report.requests.length === REQUEST_COUNT
    && report.requests.every((item) => item.httpStatus === 200)
    && local.settled
    && upstreamRows.length === REQUEST_COUNT
    && !wrongKeyRows.length
    && !missingBills.length && !missingLogs.length && !surplusBills.length && !surplusLogs.length
    && duplicateBillIds === 0 && duplicateLogIds === 0
    && rows.length === REQUEST_COUNT && rows.every((row) => row.matched)
    && closeEnough(chargedTotal, expectedChargeTotal)
    && closeEnough(balanceDelta, expectedChargeTotal)
    && number(finalUser?.upstreamOutstandingAmount) === 0;

  report.finishedAt = new Date().toISOString();
  report.status = allMatched ? 'passed' : 'failed_reconciliation';
  report.summary = {
    allMatched,
    localSettled: local.settled,
    upstreamRows: upstreamRows.length,
    localBills: local.bills.length,
    localLogs: local.logs.length,
    missingBills: missingBills.length,
    missingLogs: missingLogs.length,
    surplusBills: surplusBills.length,
    surplusLogs: surplusLogs.length,
    duplicateBillIds,
    duplicateLogIds,
    wrongKeyRows: wrongKeyRows.length,
    upstreamCostTotal,
    expectedChargeTotal,
    chargedTotal,
    balanceDelta,
    chargeRatio: upstreamCostTotal > 0 ? chargedTotal / upstreamCostTotal : null,
    perRowChargeDifferenceTotal: discrepancies,
    outstandingAmount: number(finalUser?.upstreamOutstandingAmount),
    transientFailedAttempts: report.transientFailures.length
  };
  report.rows = rows;
} catch (error) {
  report.finishedAt = new Date().toISOString();
  report.status = 'failed_execution';
  report.error = String(error?.message || error);
}

report.reportFile = path.relative(ROOT, reportFile);
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === 'passed' ? 0 : 2;
