import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const txt = fs.readFileSync(path.join(root, 'start-local.ps1'), 'utf8');
for (const m of txt.matchAll(/\$env:(\w+)\s*=\s*"([^"]*)"/g)) {
  if (!process.env[m[1]]) process.env[m[1]] = m[2];
}
const base = 'http://127.0.0.1:8787';
async function req(pathname, opts = {}) {
  const res = await fetch(base + pathname, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const play = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ login: 'play58819005', password: 'PlayTest1234!' }) });
const admin = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ login: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }) });
const pT = { Authorization: 'Bearer ' + play.body.token };
const aT = { Authorization: 'Bearer ' + admin.body.token };
const pr = await req('/api/admin/pricing', { headers: aT });
const pool = await req('/api/admin/code-pool', { headers: aT });
const dash = await req('/api/dashboard', { headers: pT });
const ds = (pool.body.upstreamByProvider || []).find((r) => r.providerId === 'grp_deepseek');
const gem = (pool.body.upstreamByProvider || []).find((r) => r.providerId === 'grp_gemini');
const db = JSON.parse(fs.readFileSync(path.join(root, 'data', 'db.json'), 'utf8'));
const playU = db.users.find((u) => u.username === 'play58819005');
const log = (db.logs || []).find((l) => l.id === 'log_0c399f92313e6a' || (l.userId === playU.id && l.providerId === 'grp_deepseek'));
console.log(JSON.stringify({
  rates: { bei: pr.body.multiplier, vip: pr.body.multiplierVip1129 },
  admin: { up: pool.body.upstreamCostToday, ch: pool.body.chargedToday, n: pool.body.requestCountToday },
  deepseek: ds, gemini: gem,
  play: { spent: dash.body.stats.totalSpent, bal: dash.body.user.balance, log0: dash.body.logs?.[0] },
  dsLog: log ? { id: log.id, up: log.upstreamCost, ch: log.chargedAmount, mul: log.multiplier } : null
}, null, 2));
