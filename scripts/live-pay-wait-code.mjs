import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const txt = fs.readFileSync(path.join(root, 'start-local.ps1'), 'utf8');
for (const m of txt.matchAll(/\$env:(\w+)\s*=\s*"([^"]*)"/g)) {
  if (!process.env[m[1]]) process.env[m[1]] = m[2];
}
const base = 'http://127.0.0.1:8787';
async function req(p, opts = {}) {
  const res = await fetch(base + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const play = await req('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ login: 'play58819005', password: 'PlayTest1234!' })
});
const admin = await req('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ login: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
});
const ph = { Authorization: 'Bearer ' + play.body.token };
const ah = { Authorization: 'Bearer ' + admin.body.token };
const prep = await req('/api/recharge/prepare', {
  method: 'POST',
  headers: ph,
  body: JSON.stringify({ amount: 10, method: 'alipay' })
});
if (prep.status !== 200) {
  console.error(JSON.stringify(prep));
  process.exit(1);
}
await req('/api/recharge/claim', {
  method: 'POST',
  headers: ph,
  body: JSON.stringify({ orderId: prep.body.orderId })
});
const adminHello = await req('/api/admin/mobile/inbox/wait?after=-1&timeoutMs=200', { headers: ah });
const seq = Number(adminHello.body.seq || 0);
const userWait = req('/api/recharge/wait?after=' + seq + '&timeoutMs=8000', { headers: ph });
await new Promise((r) => setTimeout(r, 80));
const t = Date.now();
const conf = await req('/api/admin/payment-orders/' + encodeURIComponent(prep.body.orderId) + '/confirm', {
  method: 'POST',
  headers: ah,
  body: '{}'
});
const ev = await userWait;
const ms = Date.now() - t;
const got = (ev.body.events || []).find((e) => e.kind === 'confirmed' && e.orderId === prep.body.orderId);
const pending = await req('/api/admin/payment-orders?status=pending', { headers: ah });
const out = {
  orderId: prep.body.orderId,
  confirmStatus: conf.status,
  waitMs: ms,
  eventHasCode: !!(got && got.code),
  eventCodeLen: got && got.code ? String(got.code).length : 0,
  eventKinds: (ev.body.events || []).map((e) => e.kind),
  leftoverPending: (pending.body.orders || []).map((o) => o.username + ':' + o.amount)
};
console.log(JSON.stringify(out, null, 2));
if (conf.status !== 200 || !out.eventHasCode || ms >= 2500) process.exit(1);
