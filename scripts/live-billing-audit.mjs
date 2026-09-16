/**
 * Live billing audit: 15 tiny calls per enabled non-maintenance channel.
 * Fetches true upstream /api/v1/usage. Never prints secrets.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { login as vipLogin, fetchUsage as vipUsage } from '../upstream/vip1129.js';
import { login as beiLogin, fetchUsage as beiUsage } from '../upstream/beibeihai.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const txt = fs.readFileSync(path.join(root, 'start-local.ps1'), 'utf8');
for (const m of txt.matchAll(/\$env:(\w+)\s*=\s*"([^"]*)"/g)) {
  if (!process.env[m[1]]) process.env[m[1]] = m[2];
}
const base = process.env.RELAY_BASE || 'http://127.0.0.1:8787';
const outPath = path.join(root, 'scripts', 'live-billing-audit-result.json');
const PLAY_LOGIN = 'play58819005';
const PLAY_PASS = 'PlayTest1234!';
const CALLS_PER = 15;

function loadDb() {
  return JSON.parse(fs.readFileSync(path.join(root, 'data', 'db.json'), 'utf8'));
}

async function req(pathname, opts = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: String(text).slice(0, 300) }; }
  return { status: res.status, body, text };
}

function isVip(p) {
  const url = String(p?.url || '');
  return p?.upstreamSync === 'vip1129' || /vip1129/i.test(url);
}

function usageRows(parsed) {
  const d = parsed?.data;
  const list = d?.data || d?.items || d?.records || d?.list || (Array.isArray(d) ? d : null);
  if (Array.isArray(list)) return list;
  if (Array.isArray(parsed?.data?.data?.items)) return parsed.data.data.items;
  return [];
}

async function chat(key, model, extra = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '只回复一个字：好' }],
        max_tokens: 8,
        temperature: 0,
        ...extra
      }),
      signal: AbortSignal.timeout(180000)
    });
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 240) }; }
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, body, err: res.ok ? null : (body.error?.message || body.error || text.slice(0, 180)) };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, body: {}, err: String(e.message || e) };
  }
}

async function ensureKeys(playTok, groups) {
  const listed = await req('/api/keys', { headers: playTok });
  const keys = listed.body.keys || listed.body || [];
  const byGroup = new Map();
  for (const k of keys) {
    if (!k.groupId || k.enabled === false) continue;
    if (!byGroup.has(k.groupId)) byGroup.set(k.groupId, []);
    byGroup.get(k.groupId).push(k);
  }
  const dual = new Set(['grp_gpt_plus', 'grp_gpt_mix', 'grp_glm', 'grp_gemini']);
  for (const g of groups) {
    const have = byGroup.get(g.id) || [];
    const need = dual.has(g.id) ? 2 : 1;
    while (have.length < need) {
      const created = await req('/api/keys', {
        method: 'POST',
        headers: playTok,
        body: JSON.stringify({ name: `audit-${g.id}-${have.length + 1}`, groupId: g.id })
      });
      if (created.status !== 201 && created.status !== 200) {
        console.error('key create fail', g.id, created.status, JSON.stringify(created.body).slice(0, 200));
        break;
      }
      const rec = created.body.key || created.body;
      have.push(rec);
      byGroup.set(g.id, have);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const full = await req('/api/keys', { headers: playTok });
  const all = full.body.keys || full.body || [];
  const map = new Map();
  for (const k of all) {
    if (!k.groupId || !k.key) continue;
    if (!map.has(k.groupId)) map.set(k.groupId, []);
    map.get(k.groupId).push(k);
  }
  return map;
}

const play = await req('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ login: PLAY_LOGIN, password: PLAY_PASS })
});
if (play.status !== 200) {
  console.error('play login failed', play.status);
  process.exit(1);
}
const playTok = { Authorization: 'Bearer ' + play.body.token };
const admin = await req('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ login: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
});
const adminTok = { Authorization: 'Bearer ' + admin.body.token };

const db0 = loadDb();
const providers = (db0.settings?.providers || []).filter((p) => p.enabled !== false && !p.maintenance);
const groups = providers.filter((p) => p.id !== 'grp_cursor_pool');
const startedIso = new Date().toISOString();
const startedMs = Date.now();
console.log('channels', groups.map((g) => g.id + '/' + (g.defaultModel || '')).join(', '));

const keyMap = await ensureKeys(playTok, groups);
const calls = [];

async function runMode(group, model, keys, mode, n) {
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const rec = keys[mode === 'multi-key' ? i % keys.length : 0];
    const fn = async () => {
      const r = await chat(rec.key, model);
      const row = {
        groupId: group.id,
        groupName: group.name,
        model,
        mode,
        i,
        ok: r.ok,
        status: r.status,
        ms: r.ms,
        err: r.err ? String(r.err).slice(0, 180) : null,
        vip: isVip(group)
      };
      calls.push(row);
      process.stdout.write(`${row.ok ? 'OK' : 'FAIL'} ${group.id} ${mode}#${i} ${r.status} ${r.ms}ms ${row.err || ''}\n`);
      return row;
    };
    if (mode === 'sequential') await fn();
    else jobs.push(fn());
  }
  if (jobs.length) await Promise.all(jobs);
}

for (const g of groups) {
  const keys = keyMap.get(g.id) || [];
  if (!keys.length) {
    for (let i = 0; i < CALLS_PER; i++) {
      calls.push({ groupId: g.id, groupName: g.name, model: g.defaultModel, mode: 'no-key', i, ok: false, status: 0, ms: 0, err: 'no api key', vip: isVip(g) });
    }
    continue;
  }
  const model = g.defaultModel || (g.models || [])[0];
  await runMode(g, model, keys, 'sequential', 5);
  await runMode(g, model, keys, 'same-key-concurrent', 5);
  await runMode(g, model, keys, keys.length > 1 ? 'multi-key' : 'same-key-concurrent', 5);
}

console.log('waiting usage settle');
await new Promise((r) => setTimeout(r, 8000));

const live = { samples: [], moved: false };
try {
  const gem = groups.find((g) => g.id === 'grp_gemini') || groups.find((g) => /gemini/i.test(g.defaultModel || ''));
  const gk = gem && (keyMap.get(gem.id) || [])[0];
  if (gk) {
    const me0 = await req('/api/me', { headers: playTok });
    const b0 = Number(me0.body.user?.balance ?? me0.body.balance);
    const streamP = chat(gk.key, gem.defaultModel, { stream: true, max_tokens: 64 });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const me = await req('/api/me', { headers: playTok });
      const b = Number(me.body.user?.balance ?? me.body.balance);
      live.samples.push({ t: Date.now() - startedMs, bal: b });
      if (b < b0 - 1e-8) live.moved = true;
    }
    await streamP;
  }
} catch (e) {
  live.error = String(e.message || e);
}

const origVip = Number(db0.settings?.billingMultiplierVip1129 || 1.1);
const origBei = Number(db0.settings?.billingMultiplier || 2);
const rateProbe = {
  origVip,
  origBei,
  skippedLivePut: true,
  reason: 'PUT /api/admin/pricing reprices the whole stored ledger; not toggling production rates during this audit'
};

const db1 = loadDb();
const playUser = (db1.users || []).find((u) => u.username === PLAY_LOGIN);
const newLogs = (db1.logs || []).filter((l) => l.userId === playUser?.id && Date.parse(l.createdAt) >= startedMs - 2000);

let vipRows = [];
let beiRows = [];
try {
  const v = await vipLogin(process.env.VIP1129_BASE_URL, process.env.VIP1129_EMAIL, process.env.VIP1129_PASSWORD);
  if (v.ok) {
    const u = await vipUsage(process.env.VIP1129_BASE_URL, v.token, 'page=1&page_size=100');
    vipRows = usageRows(u);
  } else rateProbe.vipLogin = v.error;
} catch (e) {
  rateProbe.vipErr = String(e.message || e);
}
try {
  const b = await beiLogin(process.env.BEIBEIHAI_BASE_URL, process.env.BEIBEIHAI_EMAIL, process.env.BEIBEIHAI_PASSWORD);
  if (b.ok) {
    const u = await beiUsage(process.env.BEIBEIHAI_BASE_URL, b.token, 'page=1&page_size=100');
    beiRows = usageRows(u);
  } else rateProbe.beiLogin = b.error;
} catch (e) {
  rateProbe.beiErr = String(e.message || e);
}

function rowCost(row) {
  const n = Number(row?.actual_cost ?? row?.actualCost ?? row?.quota ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function rowModel(row) {
  return String(row?.model || row?.model_name || '');
}
function rowAt(row) {
  return Date.parse(row?.created_at || row?.createdAt || row?.time || 0);
}

const byGroup = [];
for (const g of groups) {
  const gCalls = calls.filter((c) => c.groupId === g.id);
  const gLogs = newLogs.filter((l) => l.providerId === g.id);
  const rate = isVip(g) ? origVip : origBei;
  let matchOk = 0;
  let matchBad = 0;
  const samples = [];
  for (const log of gLogs) {
    const pool = isVip(g) ? vipRows : beiRows;
    const cost = Number(log.upstreamCost || 0);
    const charged = Number(log.chargedAmount || 0);
    const expect = cost * Number(log.multiplier || rate);
    const localOk = cost > 0 ? Math.abs(charged - expect) <= 0.0002 + 1e-9 : log.status !== 'success';
    const hit = pool.find((r) => {
      const rc = rowCost(r);
      const rm = rowModel(r);
      const rt = rowAt(r);
      const t = Date.parse(log.createdAt);
      return Math.abs(rc - cost) < 0.00015 && (!rm || !log.model || rm === log.model) && (!rt || Math.abs(rt - t) < 180000);
    });
    if (localOk && (hit || cost === 0)) matchOk++;
    else matchBad++;
    if (samples.length < 3) {
      samples.push({
        model: log.model,
        status: log.status,
        upstreamCost: cost,
        chargedAmount: charged,
        multiplier: log.multiplier,
        expect: Number(expect.toFixed(6)),
        localOk,
        trueUpstream: hit ? rowCost(hit) : null
      });
    }
  }
  byGroup.push({
    id: g.id,
    name: g.name,
    model: g.defaultModel,
    vip: isVip(g),
    rate,
    calls: gCalls.length,
    ok: gCalls.filter((c) => c.ok).length,
    fail: gCalls.filter((c) => !c.ok).length,
    logs: gLogs.length,
    matchOk,
    matchBad,
    sumUpstream: gLogs.reduce((s, l) => s + (Number(l.upstreamCost) || 0), 0),
    sumCharged: gLogs.reduce((s, l) => s + (Number(l.chargedAmount) || 0), 0),
    modes: {
      sequential: gCalls.filter((c) => c.mode === 'sequential' && c.ok).length,
      sameKey: gCalls.filter((c) => c.mode === 'same-key-concurrent' && c.ok).length,
      multiKey: gCalls.filter((c) => c.mode === 'multi-key' && c.ok).length
    },
    sampleErr: (gCalls.find((c) => !c.ok) || {}).err || null,
    samples
  });
}

rateProbe.logMultipliers = [...new Set(newLogs.map((l) => l.multiplier))];

const result = {
  at: new Date().toISOString(),
  startedIso,
  playBalance: playUser?.balance,
  calls: calls.length,
  ok: calls.filter((c) => c.ok).length,
  fail: calls.filter((c) => !c.ok).length,
  logs: newLogs.length,
  vipUsageFetched: vipRows.length,
  beiUsageFetched: beiRows.length,
  live,
  rateProbe,
  byGroup,
  failures: calls.filter((c) => !c.ok).slice(0, 40)
};
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  calls: result.calls,
  ok: result.ok,
  fail: result.fail,
  logs: result.logs,
  vipUsageFetched: result.vipUsageFetched,
  beiUsageFetched: result.beiUsageFetched,
  liveMoved: live.moved,
  groups: byGroup.map((g) => `${g.id}:${g.ok}/${g.calls} logs=${g.logs} match=${g.matchOk}/${g.matchOk + g.matchBad}`)
}, null, 2));
