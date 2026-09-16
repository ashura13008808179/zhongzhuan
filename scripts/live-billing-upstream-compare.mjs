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
const base = 'http://127.0.0.1:8787';
const t0 = Date.parse('2026-09-16T05:09:35.897Z') - 5000;

async function req(p, opts = {}) {
  const res = await fetch(base + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const admin = await req('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ login: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
});
const ah = { Authorization: 'Bearer ' + admin.body.token };
const sync = await req('/api/admin/upstream-billing/sync', {
  method: 'POST',
  headers: ah,
  body: JSON.stringify({ fullBackfill: false })
});
console.log('sync', sync.status, JSON.stringify({
  error: sync.body.error,
  synced: sync.body.synced,
  ok: sync.status
}).slice(0, 400));

function rowsOf(parsed) {
  const d = parsed?.data;
  const cands = [
    d?.data?.items, d?.data?.records, d?.data?.list, d?.data,
    d?.items, d?.records, d?.list, parsed?.items
  ];
  for (const c of cands) if (Array.isArray(c)) return c;
  if (Array.isArray(d)) return d;
  return [];
}
function cost(r) { return Number(r?.actual_cost ?? r?.actualCost ?? 0) || 0; }
function model(r) { return String(r?.model || r?.model_name || ''); }
function when(r) { return Date.parse(r?.created_at || r?.createdAt || r?.request_at || r?.time || 0); }

async function pull(loginFn, usageFn, url, email, pass, tag) {
  const auth = await loginFn(url, email, pass);
  if (!auth.ok) return { tag, error: auth.error || 'login_failed', rows: [] };
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const u = await usageFn(url, auth.token, `page=${page}&page_size=100`);
    const rows = rowsOf(u);
    if (!rows.length) break;
    all.push(...rows);
    const oldest = Math.min(...rows.map(when).filter(Boolean));
    if (oldest && oldest < t0) break;
  }
  const inWin = all.filter((r) => {
    const t = when(r);
    return !t || t >= t0;
  });
  const by = {};
  for (const r of inWin) {
    const m = model(r) || '(blank)';
    by[m] ??= { n: 0, cost: 0 };
    by[m].n++;
    by[m].cost += cost(r);
  }
  return {
    tag,
    fetched: all.length,
    windowed: inWin.length,
    sampleKeys: inWin[0] ? Object.keys(inWin[0]).slice(0, 20) : [],
    byModel: Object.entries(by).map(([m, v]) => ({ m, n: v.n, cost: +v.cost.toFixed(8) })).sort((a, b) => b.cost - a.cost)
  };
}

const vip = await pull(vipLogin, vipUsage, process.env.VIP1129_BASE_URL, process.env.VIP1129_EMAIL, process.env.VIP1129_PASSWORD, 'vip1129');
const bei = await pull(beiLogin, beiUsage, process.env.BEIBEIHAI_BASE_URL, process.env.BEIBEIHAI_EMAIL, process.env.BEIBEIHAI_PASSWORD, 'beibeihai');

const db = JSON.parse(fs.readFileSync(path.join(root, 'data', 'db.json'), 'utf8'));
const play = db.users.find((u) => u.username === 'play58819005');
const logs = (db.logs || []).filter((l) => l.userId === play.id && Date.parse(l.createdAt) >= t0);
const localBy = {};
let pending = 0;
for (const l of logs) {
  const m = l.model + '@' + l.providerId;
  localBy[m] ??= { n: 0, up: 0, ch: 0, pending: 0, mul: l.multiplier };
  localBy[m].n++;
  localBy[m].up += Number(l.upstreamCost || 0);
  localBy[m].ch += Number(l.chargedAmount || 0);
  if (l.status === 'pending_actual_cost' || l.pendingActual) {
    localBy[m].pending++;
    pending++;
  }
}

const out = {
  syncStatus: sync.status,
  pendingAfterSync: pending,
  local: Object.entries(localBy).map(([k, v]) => ({
    k, n: v.n, pending: v.pending, mul: v.mul, up: +v.up.toFixed(8), ch: +v.ch.toFixed(8), expect: +(v.up * v.mul).toFixed(8)
  })),
  vip,
  bei
};
fs.writeFileSync(path.join(root, 'scripts', 'live-billing-upstream-compare.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
