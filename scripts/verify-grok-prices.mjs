/**
 * 3 live grok-4.6 calls: token table vs official actual_cost after calibration.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { login as beiLogin, fetchUsage as beiUsage } from '../upstream/beibeihai.js';
import { tokenFloorCost, usageListFromPayload } from '../lib/billing-cost.js';
import { openDbDir } from '../lib/db-crypto.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const txt = fs.readFileSync(path.join(root, 'start-local.ps1'), 'utf8');
for (const m of txt.matchAll(/\$env:(\w+)\s*=\s*"([^"]*)"/g)) {
  if (!process.env[m[1]]) process.env[m[1]] = m[2];
}

const base = 'http://127.0.0.1:8787';
async function req(pathname, opts = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const play = await req('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ login: 'play58819005', password: 'PlayTest1234!' })
});
const playTok = { Authorization: 'Bearer ' + play.body.token };
const admin = await req('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ login: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
});
const adminTok = { Authorization: 'Bearer ' + admin.body.token };
const keys = (await req('/api/keys', { headers: playTok })).body.keys || [];
const key = keys.find((k) => k.groupId === 'grp_grok_heavy' && k.key);
if (!key) {
  console.error(JSON.stringify({ ok: false, error: 'no_grok_key' }));
  process.exit(1);
}

const started = Date.now();
const calls = [];
for (let i = 0; i < 3; i++) {
  const t0 = Date.now();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.key}` },
    body: JSON.stringify({
      model: 'grok-4.6',
      messages: [{ role: 'user', content: '只回复一个字：好' }],
      max_tokens: 8,
      temperature: 0
    }),
    signal: AbortSignal.timeout(90000)
  });
  const body = await res.json().catch(() => ({}));
  calls.push({ ok: res.ok, status: res.status, ms: Date.now() - t0, err: res.ok ? null : String(body.error?.message || body.error || '') });
  console.log(`${res.ok ? 'OK' : 'FAIL'} #${i + 1} ${res.status} ${Date.now() - t0}ms`);
}

await new Promise((r) => setTimeout(r, 16000));
await req('/api/admin/upstream-billing/sync', {
  method: 'POST',
  headers: adminTok,
  body: JSON.stringify({ fullBackfill: false })
});
await new Promise((r) => setTimeout(r, 3000));

const db = openDbDir(path.join(root, 'data')).read();
const playUser = (db.users || []).find((u) => u.username === 'play58819005');
const provider = (db.settings?.providers || []).find((p) => p.id === 'grp_grok_heavy');
const logs = (db.logs || []).filter((l) => (
  l.userId === playUser?.id
  && l.providerId === 'grp_grok_heavy'
  && l.model === 'grok-4.6'
  && Date.parse(l.createdAt) >= started - 2000
));

let rows = [];
try {
  const auth = await beiLogin(process.env.BEIBEIHAI_BASE_URL, process.env.BEIBEIHAI_EMAIL, process.env.BEIBEIHAI_PASSWORD);
  if (auth.ok) {
    const parsed = await beiUsage(process.env.BEIBEIHAI_BASE_URL, auth.token, 'page=1&page_size=50', { timeoutMs: 25000 });
    rows = usageListFromPayload(parsed?.data);
  }
} catch { /* compare local reported if usage list fails */ }

const used = new Set();
const compared = logs.map((log) => {
  const row = rows.find((r) => {
    if (used.has(String(r.id))) return false;
    if (String(r.model || '') !== 'grok-4.6') return false;
    const rt = Date.parse(r.created_at || r.createdAt || '') || 0;
    const t = Date.parse(log.createdAt) || 0;
    return !(t && rt && Math.abs(rt - t) > 180000);
  });
  if (row?.id != null) used.add(String(row.id));
  const official = row
    ? Number(row.actual_cost) || 0
    : (log.upstreamCostSource === 'reported' ? Number(log.upstreamCost) || 0 : 0);
  const table = row
    ? tokenFloorCost(provider, {
      prompt_tokens: Number(row.input_tokens) || 0,
      completion_tokens: Number(row.output_tokens) || 0,
      cache_read_tokens: Number(row.cache_read_tokens) || 0
    }, 'grok-4.6')
    : Number(log.tokenCost) || 0;
  const rel = official > 0 ? Math.abs(table - official) / official : null;
  return {
    officialSource: row ? 'upstream_usage' : log.upstreamCostSource,
    official: Number((official || 0).toFixed(8)),
    tokenTable: Number((table || 0).toFixed(8)),
    ratio: official > 0 ? Number((table / official).toFixed(6)) : null,
    rel,
    same: official > 0 && table > 0 && (rel <= 0.08 || Math.abs(table - official) <= 1e-10),
    source: log.upstreamCostSource,
    in: row ? Number(row.input_tokens) || 0 : null,
    out: row ? Number(row.output_tokens) || 0 : null
  };
});

console.log(JSON.stringify({
  ok: compared.length === 3 && compared.every((c) => c.same),
  httpOk: calls.filter((c) => c.ok).length,
  price: provider.modelPrices?.['grok-4.6'],
  compared
}, null, 2));
process.exit(compared.length === 3 && compared.every((c) => c.same) ? 0 : 2);
