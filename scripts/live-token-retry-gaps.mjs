/**
 * Retry the channels that missed 10 settled bills, then re-compare token table vs official.
 * Never prints secrets.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { login as vipLogin, fetchUsage as vipUsage } from '../upstream/vip1129.js';
import { login as beiLogin, fetchUsage as beiUsage } from '../upstream/beibeihai.js';
import { tokenFloorCost, usageListFromPayload } from '../lib/billing-cost.js';
import { exactUserCharge } from '../lib/live-billing.js';
import { openDbDir } from '../lib/db-crypto.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const txt = fs.readFileSync(path.join(root, 'start-local.ps1'), 'utf8');
for (const m of txt.matchAll(/\$env:(\w+)\s*=\s*"([^"]*)"/g)) {
  if (!process.env[m[1]]) process.env[m[1]] = m[2];
}

const base = process.env.RELAY_BASE || 'http://127.0.0.1:8787';
const PLAY_LOGIN = 'play58819005';
const PLAY_PASS = 'PlayTest1234!';
const CALLS_PER = 10;
const EPS_REL = 0.08;
const dbStore = openDbDir(path.join(root, 'data'));
const since = Date.parse(process.env.SINCE || '2026-09-19T11:40:12.578Z');
const outPath = path.join(root, 'scripts', 'live-token-vs-official-result.json');

function isVip(p) {
  return p?.upstreamSync === 'vip1129' || /vip1129/i.test(String(p?.url || ''));
}
function round8(n) { return Number((Number(n) || 0).toFixed(8)); }
function closeEnough(a, b) {
  const x = Number(a) || 0;
  const y = Number(b) || 0;
  if (!(x > 0) || !(y > 0)) return false;
  const rel = Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y));
  return rel <= EPS_REL || Math.abs(x - y) <= 1e-10;
}
function rowUsage(row) {
  return {
    prompt_tokens: Number(row?.input_tokens ?? row?.prompt_tokens ?? 0) || 0,
    completion_tokens: Number(row?.output_tokens ?? row?.completion_tokens ?? 0) || 0,
    cache_read_tokens: Number(row?.cache_read_tokens ?? 0) || 0,
    cache_creation_tokens: Number(row?.cache_creation_tokens ?? 0) || 0
  };
}

async function req(pathname, opts = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: String(text).slice(0, 280) }; }
  return { status: res.status, body };
}

async function chat(key, model, timeoutMs = 180000) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '只回复一个字：好' }],
        max_tokens: 8,
        temperature: 0
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 220) }; }
    return {
      ok: res.ok,
      status: res.status,
      ms: Date.now() - t0,
      usage: body.usage || null,
      err: res.ok ? null : String(body.error?.message || body.error || text.slice(0, 160))
    };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, usage: null, err: String(e.message || e) };
  }
}

async function pullUsage(loginFn, usageFn, url, email, pass) {
  try {
    const auth = await loginFn(url, email, pass);
    if (!auth.ok) return { ok: false, error: auth.error || 'login_failed', rows: [] };
    const rows = [];
    for (let page = 1; page <= 8; page++) {
      const parsed = await usageFn(url, auth.token, `page=${page}&page_size=100`, { timeoutMs: 40000 });
      const list = usageListFromPayload(parsed?.data);
      if (!list.length) break;
      rows.push(...list);
      if (list.length < 100) break;
    }
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: String(e.message || e), rows: [] };
  }
}

function matchRow(pool, log, usedIds) {
  if (log.upstreamUsageId != null) {
    const hit = pool.find((r) => String(r.id) === String(log.upstreamUsageId));
    if (hit) return hit;
  }
  const model = String(log.model || '');
  const t = Date.parse(log.createdAt) || 0;
  const keyId = log.upstreamApiKeyId != null ? String(log.upstreamApiKeyId) : '';
  const candidates = pool.filter((r) => {
    if (usedIds.has(String(r.id))) return false;
    if (model && String(r.model || '') && String(r.model) !== model) return false;
    if (keyId && r.api_key_id != null && String(r.api_key_id) !== keyId) return false;
    const rt = Date.parse(r.created_at || r.createdAt || '') || 0;
    if (t && rt && Math.abs(rt - t) > 180000) return false;
    return true;
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const ta = Date.parse(a.created_at || a.createdAt || '') || 0;
    const tb = Date.parse(b.created_at || b.createdAt || '') || 0;
    return Math.abs(ta - t) - Math.abs(tb - t);
  });
  return candidates[0];
}

const play = await req('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ login: PLAY_LOGIN, password: PLAY_PASS })
});
if (play.status !== 200 || !play.body?.token) {
  console.error(JSON.stringify({ ok: false, step: 'play_login', status: play.status }));
  process.exit(1);
}
const playTok = { Authorization: 'Bearer ' + play.body.token };
const admin = await req('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ login: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
});
const adminTok = { Authorization: 'Bearer ' + admin.body.token };

const db0 = dbStore.read();
const origBei = Number(db0.settings?.billingMultiplier || 2);
const origVip = Number(db0.settings?.billingMultiplierVip1129 || 1.1);
const allProviders = db0.settings?.providers || [];
const plans = [
  {
    id: 'grp_gpt_pro',
    models: ['gpt-5.6-terra'],
    timeoutMs: 180000
  },
  {
    id: 'grp_grok_heavy',
    models: ['grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-4.20-non-reasoning', 'composer-2.5'],
    timeoutMs: 90000
  },
  {
    id: 'grp_claude_kiro',
    models: ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
    timeoutMs: 90000
  }
];

const listed = await req('/api/keys', { headers: playTok });
const keys = listed.body.keys || listed.body || [];
const calls = [];
const retryStarted = Date.now();

for (const plan of plans) {
  const g = allProviders.find((p) => p.id === plan.id);
  const key = keys.find((k) => k.groupId === plan.id && k.key && k.enabled !== false);
  if (!g || !key) {
    calls.push({ groupId: plan.id, ok: false, err: 'missing_group_or_key' });
    continue;
  }
  let model = null;
  for (const candidate of plan.models) {
    const probe = await chat(key.key, candidate, plan.timeoutMs);
    process.stdout.write(`${probe.ok ? 'OK' : 'FAIL'} ${plan.id} probe ${candidate} ${probe.status} ${probe.ms}ms ${probe.err || ''}\n`);
    await new Promise((r) => setTimeout(r, 1500));
    const dbNow = dbStore.read();
    const playUser = (dbNow.users || []).find((u) => u.username === PLAY_LOGIN);
    const recent = (dbNow.logs || []).filter((l) => (
      l.userId === playUser?.id && Date.parse(l.createdAt) >= retryStarted - 2000
    )).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    const landed = recent?.providerId === plan.id;
    calls.push({
      groupId: plan.id,
      groupName: g.name,
      model: candidate,
      i: 'probe',
      ok: probe.ok,
      status: probe.status,
      ms: probe.ms,
      err: probe.err,
      landedProvider: recent?.providerId || null,
      landed
    });
    if (probe.ok && landed) {
      model = candidate;
      break;
    }
  }
  if (!model) {
    console.log(`no native landing model for ${plan.id}`);
    continue;
  }
  for (let i = 0; i < CALLS_PER - 1; i++) {
    const r = await chat(key.key, model, plan.timeoutMs);
    const dbNow = dbStore.read();
    const playUser = (dbNow.users || []).find((u) => u.username === PLAY_LOGIN);
    const recent = (dbNow.logs || []).filter((l) => (
      l.userId === playUser?.id && Date.parse(l.createdAt) >= retryStarted - 2000 && l.providerId === plan.id
    ));
    calls.push({
      groupId: plan.id,
      groupName: g.name,
      model,
      i,
      ok: r.ok,
      status: r.status,
      ms: r.ms,
      err: r.err,
      landedCount: recent.length
    });
    process.stdout.write(`${r.ok ? 'OK' : 'FAIL'} ${plan.id} #${i + 2} ${model} ${r.status} ${r.ms}ms ${r.err || ''}\n`);
  }
}

console.log('waiting bills 20s');
await new Promise((r) => setTimeout(r, 20000));
await req('/api/admin/upstream-billing/sync', {
  method: 'POST',
  headers: adminTok,
  body: JSON.stringify({ fullBackfill: false })
});
await new Promise((r) => setTimeout(r, 5000));

const db1 = dbStore.read();
const playUser = (db1.users || []).find((u) => u.username === PLAY_LOGIN);
const groups = (db1.settings?.providers || []).filter((p) => (
  p.enabled !== false
  && !p.maintenance
  && p.id !== 'grp_cursor_pool'
  && !/welfare|福利/i.test(`${p.id} ${p.name || ''}`)
));
const newLogs = (db1.logs || []).filter((l) => (
  l.userId === playUser?.id
  && Date.parse(l.createdAt) >= since - 2000
  && l.status !== 'checkin_bonus'
));

let vipPull = await pullUsage(vipLogin, vipUsage, process.env.VIP1129_BASE_URL, process.env.VIP1129_EMAIL, process.env.VIP1129_PASSWORD);
if (!vipPull.ok) {
  console.log('vip retry', vipPull.error);
  await new Promise((r) => setTimeout(r, 3000));
  vipPull = await pullUsage(vipLogin, vipUsage, process.env.VIP1129_BASE_URL, process.env.VIP1129_EMAIL, process.env.VIP1129_PASSWORD);
}
const beiPull = await pullUsage(beiLogin, beiUsage, process.env.BEIBEIHAI_BASE_URL, process.env.BEIBEIHAI_EMAIL, process.env.BEIBEIHAI_PASSWORD);

const providers = new Map((db1.settings?.providers || []).map((p) => [p.id, p]));
const usedVip = new Set();
const usedBei = new Set();
const byGroup = [];
const pairwise = [];

for (const g of groups) {
  const provider = providers.get(g.id) || g;
  const rate = isVip(g) ? origVip : origBei;
  const gCalls = calls.filter((c) => c.groupId === g.id);
  const gLogs = newLogs.filter((l) => l.providerId === g.id);
  const pool = isVip(g) ? vipPull.rows : beiPull.rows;
  const used = isVip(g) ? usedVip : usedBei;
  let same = 0;
  let differ = 0;
  let missingOfficial = 0;
  let tableSum = 0;
  let officialSum = 0;
  let chargedSum = 0;
  const samples = [];

  for (const log of gLogs) {
    const row = matchRow(pool, log, used);
    if (row?.id != null) used.add(String(row.id));
    const official = row
      ? Number(row.actual_cost ?? row.actualCost ?? 0) || 0
      : (Number(log.upstreamCost) || 0);
    const officialSource = row ? 'upstream_usage' : (Number(log.upstreamCost) > 0 ? 'local_upstreamCost' : 'none');
    const tableFromLog = Number(log.tokenCost) || 0;
    const tableFromRow = row ? tokenFloorCost(provider, rowUsage(row), row.model || log.model) : tableFromLog;
    const table = tableFromRow > 0 ? tableFromRow : tableFromLog;
    const charged = Number(log.chargedAmount) || 0;
    const expectCharge = exactUserCharge(table, Number(log.multiplier || rate));
    const matched = official > 0 && table > 0 && closeEnough(table, official);
    if (!(official > 0)) missingOfficial += 1;
    else if (matched) same += 1;
    else differ += 1;
    tableSum += table;
    officialSum += official;
    chargedSum += charged;
    const sample = {
      model: log.model,
      status: log.status,
      billingSource: log.billingSource || null,
      officialSource,
      official: round8(official),
      tokenTable: round8(table),
      tokenTableOnLog: round8(tableFromLog),
      charged: round8(charged),
      expectCharge: round8(expectCharge),
      multiplier: Number(log.multiplier || rate),
      ratio: official > 0 ? round8(table / official) : null,
      same: matched,
      chargeFollowsTable: closeEnough(charged, expectCharge),
      inTokens: row ? Number(row.input_tokens) || 0 : Number(log.tokens) || 0,
      outTokens: row ? Number(row.output_tokens) || 0 : 0,
      cacheRead: row ? Number(row.cache_read_tokens) || 0 : 0
    };
    pairwise.push({ groupId: g.id, groupName: g.name, vip: isVip(g), ...sample });
    if (samples.length < 4) samples.push(sample);
  }

  byGroup.push({
    id: g.id,
    name: g.name,
    model: g.defaultModel,
    vip: isVip(g),
    rate,
    priceIn1K: Number(provider.modelPrices?.[g.defaultModel]?.inputPricePer1K ?? provider.inputPricePer1K) || 0,
    priceOut1K: Number(provider.modelPrices?.[g.defaultModel]?.outputPricePer1K ?? provider.outputPricePer1K) || 0,
    groupRate: Number(provider.upstreamRateMultiplier) || 1,
    retryCalls: gCalls.filter((c) => c.i !== 'probe').length + gCalls.filter((c) => c.i === 'probe').length,
    retryOk: gCalls.filter((c) => c.ok).length,
    retryFail: gCalls.filter((c) => !c.ok).length,
    logs: gLogs.length,
    same,
    differ,
    missingOfficial,
    officialFromUsage: pairwise.filter((p) => p.groupId === g.id && p.officialSource === 'upstream_usage').length,
    officialFromLocal: pairwise.filter((p) => p.groupId === g.id && p.officialSource === 'local_upstreamCost').length,
    officialSum: round8(officialSum),
    tokenTableSum: round8(tableSum),
    chargedSum: round8(chargedSum),
    ratio: officialSum > 0 ? round8(tableSum / officialSum) : null,
    sampleErr: (gCalls.find((c) => !c.ok) || {}).err || null,
    samples
  });
}

const compared = pairwise.filter((p) => p.official > 0 && p.tokenTable > 0);
const result = {
  at: new Date().toISOString(),
  startedIso: new Date(since).toISOString(),
  retryStartedIso: new Date(retryStarted).toISOString(),
  base,
  rates: { bei: origBei, vip: origVip },
  retryCalls: calls,
  logs: newLogs.length,
  vipUsageFetched: vipPull.rows.length,
  beiUsageFetched: beiPull.rows.length,
  vipOk: vipPull.ok,
  vipError: vipPull.error || null,
  beiOk: beiPull.ok,
  compared: compared.length,
  same: compared.filter((p) => p.same).length,
  differ: compared.filter((p) => !p.same).length,
  chargeFollowsTable: pairwise.filter((p) => p.chargeFollowsTable).length,
  officialFromUsage: pairwise.filter((p) => p.officialSource === 'upstream_usage').length,
  officialFromLocal: pairwise.filter((p) => p.officialSource === 'local_upstreamCost').length,
  officialSum: round8(compared.reduce((s, p) => s + p.official, 0)),
  tokenTableSum: round8(compared.reduce((s, p) => s + p.tokenTable, 0)),
  chargedSum: round8(pairwise.reduce((s, p) => s + p.charged, 0)),
  byGroup,
  pairwise: pairwise.slice(0, 260)
};
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  ok: result.differ === 0 && result.vipOk && result.beiOk,
  logs: result.logs,
  compared: result.compared,
  same: result.same,
  differ: result.differ,
  vipOk: result.vipOk,
  vipError: result.vipError,
  vipUsageFetched: result.vipUsageFetched,
  beiOk: result.beiOk,
  officialFromUsage: result.officialFromUsage,
  officialFromLocal: result.officialFromLocal,
  officialSum: result.officialSum,
  tokenTableSum: result.tokenTableSum,
  groups: byGroup.map((g) => `${g.id} logs=${g.logs} same=${g.same} differ=${g.differ} miss=${g.missingOfficial} usage=${g.officialFromUsage} local=${g.officialFromLocal} off=${g.officialSum} table=${g.tokenTableSum} ratio=${g.ratio}`),
  retry: calls.map((c) => `${c.groupId} ${c.model || ''} ${c.ok ? 'OK' : 'FAIL'} landed=${c.landedProvider || c.landedCount || ''} ${c.err || ''}`)
}, null, 2));
