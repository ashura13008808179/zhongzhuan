/**
 * Compare already-settled probe logs vs official usage. No new chats.
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
const since = Date.parse(process.env.SINCE || '2026-09-18T10:01:54.000Z');
const db = openDbDir(path.join(root, 'data')).read();
const play = (db.users || []).find((u) => u.username === 'play58819005');
const beiRate = Number(db.settings?.billingMultiplier || 2);
const vipRate = Number(db.settings?.billingMultiplierVip1129 || 1.1);
const providers = new Map((db.settings?.providers || []).map((p) => [p.id, p]));

function isVip(p) {
  return p?.upstreamSync === 'vip1129' || /vip1129/i.test(String(p?.url || ''));
}
function round8(n) { return Number((Number(n) || 0).toFixed(8)); }
function closeEnough(a, b) {
  const x = Number(a) || 0;
  const y = Number(b) || 0;
  return Math.abs(x - y) <= Math.max(0.0002, 0.08 * Math.max(Math.abs(x), Math.abs(y), 1e-12));
}
function rowUsage(row) {
  return {
    prompt_tokens: Number(row?.input_tokens ?? 0) || 0,
    completion_tokens: Number(row?.output_tokens ?? 0) || 0,
    cache_read_tokens: Number(row?.cache_read_tokens ?? 0) || 0,
    cache_creation_tokens: Number(row?.cache_creation_tokens ?? 0) || 0
  };
}

async function req(pathname, opts = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const admin = await req('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ login: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
});
if (admin.body?.token) {
  await req('/api/admin/upstream-billing/sync', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + admin.body.token },
    body: JSON.stringify({ fullBackfill: false })
  });
}

const db2 = openDbDir(path.join(root, 'data')).read();
const logs = (db2.logs || []).filter((l) => (
  l.userId === play?.id
  && Date.parse(l.createdAt) >= since - 2000
  && l.status !== 'checkin_bonus'
));

async function pull(loginFn, usageFn, url, email, pass) {
  const auth = await loginFn(url, email, pass);
  if (!auth.ok) return [];
  const rows = [];
  for (let page = 1; page <= 5; page++) {
    const parsed = await usageFn(url, auth.token, `page=${page}&page_size=100`, { timeoutMs: 25000 });
    const list = usageListFromPayload(parsed?.data);
    if (!list.length) break;
    rows.push(...list);
    if (list.length < 100) break;
  }
  return rows.filter((r) => {
    const t = Date.parse(r.created_at || r.createdAt || '') || 0;
    return !t || t >= since - 120000;
  });
}

const vipRows = await pull(vipLogin, vipUsage, process.env.VIP1129_BASE_URL, process.env.VIP1129_EMAIL, process.env.VIP1129_PASSWORD);
const beiRows = await pull(beiLogin, beiUsage, process.env.BEIBEIHAI_BASE_URL, process.env.BEIBEIHAI_EMAIL, process.env.BEIBEIHAI_PASSWORD);

const used = new Set();
function matchRow(pool, log) {
  if (log.upstreamUsageId != null) {
    const hit = pool.find((r) => String(r.id) === String(log.upstreamUsageId));
    if (hit) return hit;
  }
  const model = String(log.model || '');
  const t = Date.parse(log.createdAt) || 0;
  const keyId = log.upstreamApiKeyId != null ? String(log.upstreamApiKeyId) : '';
  const cands = pool.filter((r) => {
    if (used.has(String(r.id))) return false;
    if (model && String(r.model || '') && String(r.model) !== model) return false;
    if (keyId && r.api_key_id != null && String(r.api_key_id) !== keyId) return false;
    const rt = Date.parse(r.created_at || r.createdAt || '') || 0;
    if (t && rt && Math.abs(rt - t) > 180000) return false;
    return true;
  });
  cands.sort((a, b) => {
    const ta = Date.parse(a.created_at || a.createdAt || '') || 0;
    const tb = Date.parse(b.created_at || b.createdAt || '') || 0;
    return Math.abs(ta - t) - Math.abs(tb - t);
  });
  return cands[0] || null;
}

const byGroup = new Map();
let same = 0;
let differ = 0;
let missing = 0;
let officialSum = 0;
let tableSum = 0;
let chargedSum = 0;
const diffs = [];

for (const log of logs) {
  const provider = providers.get(log.providerId);
  const vip = isVip(provider);
  const pool = vip ? vipRows : beiRows;
  const row = matchRow(pool, log);
  if (row?.id != null) used.add(String(row.id));
  const official = row
    ? Number(row.actual_cost ?? row.actualCost ?? 0) || 0
    : Number(log.upstreamCost) || 0;
  const tableFromRow = row ? tokenFloorCost(provider, rowUsage(row), row.model || log.model) : 0;
  const table = tableFromRow > 0 ? tableFromRow : (Number(log.tokenCost) || 0);
  const charged = Number(log.chargedAmount) || 0;
  const rate = Number(log.multiplier || (vip ? vipRate : beiRate));
  const matched = official > 0 && table > 0 && closeEnough(table, official);
  if (!(official > 0)) missing += 1;
  else if (matched) same += 1;
  else {
    differ += 1;
    if (diffs.length < 24) {
      diffs.push({
        group: log.providerId,
        model: log.model,
        official: round8(official),
        table: round8(table),
        charged: round8(charged),
        ratio: official > 0 ? round8(table / official) : null
      });
    }
  }
  officialSum += official;
  tableSum += table;
  chargedSum += charged;
  const g = byGroup.get(log.providerId) || {
    id: log.providerId,
    name: provider?.name || log.providerId,
    vip,
    rate,
    n: 0,
    same: 0,
    differ: 0,
    missing: 0,
    official: 0,
    table: 0,
    charged: 0
  };
  g.n += 1;
  g.official += official;
  g.table += table;
  g.charged += charged;
  if (!(official > 0)) g.missing += 1;
  else if (matched) g.same += 1;
  else g.differ += 1;
  byGroup.set(log.providerId, g);
}

const groups = [...byGroup.values()].map((g) => ({
  ...g,
  official: round8(g.official),
  table: round8(g.table),
  charged: round8(g.charged),
  ratio: g.official > 0 ? round8(g.table / g.official) : null
}));

const out = {
  since: new Date(since).toISOString(),
  logs: logs.length,
  vipRows: vipRows.length,
  beiRows: beiRows.length,
  same,
  differ,
  missing,
  officialSum: round8(officialSum),
  tokenTableSum: round8(tableSum),
  chargedSum: round8(chargedSum),
  overallRatio: officialSum > 0 ? round8(tableSum / officialSum) : null,
  groups,
  diffs
};
fs.writeFileSync(path.join(root, 'scripts', 'live-token-vs-official-partial.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
