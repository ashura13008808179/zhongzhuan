/**
 * Read-only audit of production admin stats vs user balances.
 * Never prints secrets or other users' unpaid order details.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const txt = fs.readFileSync(path.join(root, 'start-local.ps1'), 'utf8');
for (const m of txt.matchAll(/\$env:(\w+)\s*=\s*"([^"]*)"/g)) {
  if (!process.env[m[1]]) process.env[m[1]] = m[2];
}

const base = process.env.PROD_BASE || 'http://47.114.44.213:8787';

async function req(pathname, opts = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: String(text).slice(0, 240) }; }
  return { status: res.status, body };
}

const admin = await req('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ login: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
});
if (admin.status !== 200 || !admin.body?.token) {
  const safe = { ...admin.body };
  delete safe.token;
  console.log(JSON.stringify({ ok: false, step: 'login', status: admin.status, keys: Object.keys(admin.body || {}), error: admin.body?.error || 'login_failed', body: safe }));
  process.exit(1);
}
const auth = { Authorization: 'Bearer ' + admin.body.token };
console.error('login_ok', admin.body.user?.username || admin.body.user?.role || 'yes');

const [pricing, pool, users, dash] = await Promise.all([
  req('/api/admin/pricing', { headers: auth }),
  req('/api/admin/code-pool', { headers: auth }),
  req('/api/admin/users', { headers: auth }),
  req('/api/dashboard', { headers: auth })
]);

const list = users.body.users || users.body || [];
const people = (Array.isArray(list) ? list : []).filter((u) => u && u.role !== 'admin');
const adminUser = (Array.isArray(list) ? list : []).find((u) => u.role === 'admin');

const out = {
  ok: true,
  base,
  rates: {
    bei: pricing.body.multiplier,
    vip: pricing.body.multiplierVip1129
  },
  pool: {
    upstreamCostToday: pool.body.upstreamCostToday,
    chargedToday: pool.body.chargedToday,
    requestCountToday: pool.body.requestCountToday,
    ledgerRows: pool.body.upstreamLedgerRows,
    estimated: pool.body.upstreamCostIsEstimate,
    reported: pool.body.upstreamCostReportedCount,
    byProvider: (pool.body.upstreamByProvider || []).map((r) => ({
      name: r.providerName,
      id: r.providerId,
      n: r.requests,
      upstream: r.upstreamCost,
      charged: r.chargedAmount,
      ratio: r.upstreamCost > 0 ? Number((r.chargedAmount / r.upstreamCost).toFixed(4)) : null
    }))
  },
  adminSelf: adminUser ? { username: adminUser.username, balance: adminUser.balance, unlimited: adminUser.unlimited } : null,
  customers: people.map((u) => ({
    username: u.username || u.email || u.id,
    name: u.name,
    balance: u.balance,
    usedTokens: u.usedTokens,
    accountActive: u.accountActive
  })),
  dashboard: dash.status === 200 ? {
    balance: dash.body.user?.balance,
    totalSpent: dash.body.stats?.totalSpent,
    requests: dash.body.stats?.requests
  } : { status: dash.status }
};

console.log(JSON.stringify(out, null, 2));
