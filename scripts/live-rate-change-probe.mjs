/**
 * Live probe: change global billing multiplier, then check admin
 * 上游开销 vs 客户实扣 and the user dashboard. Restores the original rate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const txt = fs.readFileSync(path.join(root, 'start-local.ps1'), 'utf8');
for (const m of txt.matchAll(/\$env:(\w+)\s*=\s*"([^"]*)"/g)) {
  if (!process.env[m[1]]) process.env[m[1]] = m[2];
}

const base = process.env.RELAY_BASE || 'http://127.0.0.1:8787';
const PLAY_LOGIN = 'play58819005';
const PLAY_PASS = 'PlayTest1234!';
const GROUP = process.env.PROBE_GROUP || 'grp_deepseek';
const outPath = path.join(root, 'scripts', 'live-rate-change-probe-result.json');

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

function snapStats(stats) {
  const row = (stats.upstreamByProvider || []).find((r) => r.providerId === GROUP) || null;
  return {
    upstreamCostToday: Number(stats.upstreamCostToday) || 0,
    chargedToday: Number(stats.chargedToday) || 0,
    requestCountToday: Number(stats.requestCountToday) || 0,
    ledgerRows: Number(stats.upstreamLedgerRows) || 0,
    groupId: GROUP,
    groupUpstream: Number(row?.upstreamCost) || 0,
    groupCharged: Number(row?.chargedAmount) || 0,
    groupRequests: Number(row?.requests) || 0
  };
}

function round4(n) {
  return Math.round((Number(n) || 0) * 1e8) / 1e8;
}

async function syncLedger(adminTok) {
  return req('/api/admin/upstream-billing/sync', {
    method: 'POST',
    headers: adminTok,
    body: JSON.stringify({ fullBackfill: true })
  });
}

async function chatOnce(key, model) {
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
      signal: AbortSignal.timeout(120000)
    });
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 180) }; }
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, err: res.ok ? null : (body.error?.message || body.error || text.slice(0, 160)) };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, err: String(e.message || e) };
  }
}

async function chat(key, model) {
  let last = { ok: false, status: 0, ms: 0, err: 'no attempt' };
  for (let i = 0; i < 3; i++) {
    last = await chatOnce(key, model);
    if (last.ok) return last;
    await new Promise((r) => setTimeout(r, 2000 + i * 2000));
  }
  return last;
}

function latestGroupLog() {
  const db = JSON.parse(fs.readFileSync(path.join(root, 'data', 'db.json'), 'utf8'));
  const play = (db.users || []).find((u) => u.username === PLAY_LOGIN);
  const logs = (db.logs || []).filter((l) => l.userId === play?.id && l.providerId === GROUP);
  const log = logs[0] || null;
  return log ? {
    id: log.id,
    status: log.status,
    pending: !!log.pendingActual,
    upstreamCost: Number(log.upstreamCost) || 0,
    chargedAmount: Number(log.chargedAmount) || 0,
    collectedAmount: Number(log.collectedAmount ?? log.alreadyCharged ?? 0),
    multiplier: Number(log.multiplier) || 0,
    createdAt: log.createdAt
  } : null;
}

const report = { ok: false, steps: [] };
function step(name, data) {
  report.steps.push({ name, ...data });
  const extra = Object.entries(data).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
  console.log(`${name} ${extra}`.slice(0, 420));
}

const play = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ login: PLAY_LOGIN, password: PLAY_PASS }) });
if (play.status !== 200) throw new Error('play login failed');
const playTok = { Authorization: 'Bearer ' + play.body.token };
const admin = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ login: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }) });
if (admin.status !== 200) throw new Error('admin login failed');
const adminTok = { Authorization: 'Bearer ' + admin.body.token };

const pricing0 = await req('/api/admin/pricing', { headers: adminTok });
const origBei = Number(pricing0.body.multiplier);
const origVip = Number(pricing0.body.multiplierVip1129);
const probeRate = round4(origBei + 1);
step('rates.before', { origBei, origVip, probeRate, group: GROUP });

let restored = false;
async function restore() {
  if (restored) return;
  restored = true;
  const r = await req('/api/admin/pricing', {
    method: 'PUT',
    headers: adminTok,
    body: JSON.stringify({ multiplier: origBei, multiplierVip1129: origVip })
  });
  step('rates.restore', { status: r.status, multiplier: r.body.multiplier, vip: r.body.multiplierVip1129, repriced: r.body.repricedLedgerRows });
}

try {
  let sync0 = await syncLedger(adminTok);
  if (sync0.status === 409) {
    await new Promise((r) => setTimeout(r, 8000));
    sync0 = await syncLedger(adminTok);
  }
  step('sync.baseline', { status: sync0.status, skipped: !!sync0.body?.syncing, rows: sync0.body?.synced?.rows ?? sync0.body?.error });

  const pool0 = snapStats((await req('/api/admin/code-pool', { headers: adminTok })).body);
  const dash0 = await req('/api/dashboard', { headers: playTok });
  step('snapshot.0', { admin: pool0, playSpent: dash0.body.stats?.totalSpent, playBal: dash0.body.user?.balance });

  const keys = await req('/api/keys', { headers: playTok });
  const list = keys.body.keys || keys.body || [];
  let rec = list.find((k) => k.groupId === GROUP && k.enabled !== false && k.key);
  if (!rec) {
    const created = await req('/api/keys', {
      method: 'POST',
      headers: playTok,
      body: JSON.stringify({ name: 'probe-' + GROUP, groupId: GROUP })
    });
    rec = created.body.key || created.body;
    step('key.create', { status: created.status, id: rec?.id, groupId: rec?.groupId });
    await new Promise((r) => setTimeout(r, 1000));
  }
  const model = rec?.models?.[0] || rec?.defaultModel || 'deepseek-v4-flash';
  const secret = rec.key;
  if (!secret) throw new Error('no key secret');

  const call1 = await chat(secret, model);
  step('chat.1', { ok: call1.ok, status: call1.status, ms: call1.ms, err: call1.err, model });
  if (!call1.ok) throw new Error('chat1 failed: ' + call1.err);
  await new Promise((r) => setTimeout(r, 3000));
  await syncLedger(adminTok);
  await new Promise((r) => setTimeout(r, 1000));

  const pool1 = snapStats((await req('/api/admin/code-pool', { headers: adminTok })).body);
  const dash1 = await req('/api/dashboard', { headers: playTok });
  const log1 = latestGroupLog();
  step('snapshot.1.afterChat', {
    admin: pool1,
    dUpstream: round4(pool1.upstreamCostToday - pool0.upstreamCostToday),
    dCharged: round4(pool1.chargedToday - pool0.chargedToday),
    playSpent: dash1.body.stats?.totalSpent,
    playBal: dash1.body.user?.balance,
    log: log1
  });

  const put = await req('/api/admin/pricing', {
    method: 'PUT',
    headers: adminTok,
    body: JSON.stringify({ multiplier: probeRate })
  });
  step('rates.raise', { status: put.status, multiplier: put.body.multiplier, repriced: put.body.repricedLedgerRows, skipped: put.body.ledgerSync?.skipped });

  const pool2 = snapStats((await req('/api/admin/code-pool', { headers: adminTok })).body);
  const dash2 = await req('/api/dashboard', { headers: playTok });
  const log2 = latestGroupLog();
  step('snapshot.2.afterRaise', {
    admin: pool2,
    dUpstream: round4(pool2.upstreamCostToday - pool1.upstreamCostToday),
    dCharged: round4(pool2.chargedToday - pool1.chargedToday),
    playSpent: dash2.body.stats?.totalSpent,
    playBal: dash2.body.user?.balance,
    log: log2
  });

  const call2 = await chat(secret, model);
  step('chat.2', { ok: call2.ok, status: call2.status, ms: call2.ms, err: call2.err });
  if (!call2.ok) throw new Error('chat2 failed: ' + call2.err);
  await new Promise((r) => setTimeout(r, 3000));
  await syncLedger(adminTok);
  await new Promise((r) => setTimeout(r, 1000));

  const pool3 = snapStats((await req('/api/admin/code-pool', { headers: adminTok })).body);
  const dash3 = await req('/api/dashboard', { headers: playTok });
  const log3 = latestGroupLog();
  step('snapshot.3.afterChatAtNewRate', {
    admin: pool3,
    dUpstream: round4(pool3.upstreamCostToday - pool2.upstreamCostToday),
    dCharged: round4(pool3.chargedToday - pool2.chargedToday),
    playSpent: dash3.body.stats?.totalSpent,
    playBal: dash3.body.user?.balance,
    log: log3
  });

  await restore();
  await new Promise((r) => setTimeout(r, 800));
  const pool4 = snapStats((await req('/api/admin/code-pool', { headers: adminTok })).body);
  const dash4 = await req('/api/dashboard', { headers: playTok });
  const log4 = latestGroupLog();
  step('snapshot.4.afterRestore', {
    admin: pool4,
    dUpstream: round4(pool4.upstreamCostToday - pool3.upstreamCostToday),
    dCharged: round4(pool4.chargedToday - pool3.chargedToday),
    playSpent: dash4.body.stats?.totalSpent,
    playBal: dash4.body.user?.balance,
    log: log4
  });

  const raiseUpstreamUnchanged = Math.abs(pool2.upstreamCostToday - pool1.upstreamCostToday) < 1e-6;
  const raiseChargedMoved = Math.abs(pool2.chargedToday - pool1.chargedToday) > 1e-8;
  const restoreUpstreamUnchanged = Math.abs(pool4.upstreamCostToday - pool3.upstreamCostToday) < 1e-6;
  const chat2RateOk = log3 && Math.abs(log3.multiplier - probeRate) < 1e-8;
  const chat2FormulaOk = log3 && log3.upstreamCost > 0 && Math.abs(log3.chargedAmount - log3.upstreamCost * probeRate) < 1e-8;
  report.ok = !!(raiseUpstreamUnchanged && raiseChargedMoved && chat2RateOk && chat2FormulaOk);
  report.verdict = {
    raiseUpstreamUnchanged,
    raiseChargedMoved,
    restoreUpstreamUnchanged,
    chat2RateOk,
    chat2FormulaOk,
    origBei,
    probeRate,
    group: GROUP
  };
} catch (e) {
  report.ok = false;
  report.error = String(e.message || e);
  step('error', { error: report.error });
  try { await restore(); } catch (re) { step('restore.fail', { error: String(re.message || re) }); }
}

fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log('RESULT', JSON.stringify(report.verdict || { error: report.error }));
console.log('wrote', outPath);
if (!report.ok) process.exitCode = 1;
