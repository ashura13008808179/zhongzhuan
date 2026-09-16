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
const admin = await req('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ login: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
});
const ah = { Authorization: 'Bearer ' + admin.body.token };
for (const id of process.argv.slice(2)) {
  const r = await req(`/api/admin/payment-orders/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    headers: ah,
    body: JSON.stringify({ reason: '测试未实际付款' })
  });
  console.log(id, r.status, r.body.message || r.body.error || '');
}
