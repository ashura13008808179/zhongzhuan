/**
 * Live chat + bill match for both upstreams.
 * Never prints secrets / API keys / passwords.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as vip from '../upstream/vip1129.js';
import * as bei from '../upstream/beibeihai.js';
import { usageListFromPayload } from '../lib/billing-cost.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path.join(ROOT, 'data', 'db.json');
const BASE = process.env.RELAY_BASE || 'http://127.0.0.1:8787';
const EPS = 1e-8;

function loadDb() {
  return JSON.parse(fs.readFileSync(DB, 'utf8'));
}

function userByName(db, name) {
  return (db.users || []).find((u) => u.username === name || u.id === name);
}

function keyByName(user, name) {
  return (user?.apiKeys || []).find((k) => k.name === name);
}

function nearly(a, b) {
  const x = Number(a) || 0;
  const y = Number(b) || 0;
  return Math.abs(x - y) <= Math.max(EPS, Math.abs(y) * 1e-9);
}

async function loginKind(kind, cfg) {
  const client = kind === 'vip1129' ? vip : bei;
  const token = String(cfg.accessToken || '').trim();
  const exp = Date.parse(cfg.tokenExpiresAt || '') || 0;
  if (token && exp - 60000 > Date.now()) return token;
  const logged = await client.login(cfg.baseUrl, cfg.email, cfg.password);
  if (!logged.ok) throw new Error(`${kind}_login_${logged.error || logged.status}`);
  return logged.token;
}

async function usageRows(kind, cfg, token, apiKeyId, pageSize = 20) {
  const client = kind === 'vip1129' ? vip : bei;
  const q = apiKeyId
    ? `page=1&page_size=${pageSize}&api_key_id=${encodeURIComponent(apiKeyId)}`
    : `page=1&page_size=${pageSize}`;
  const parsed = await client.fetchUsage(cfg.baseUrl, token, q, { timeoutMs: 20000 });
  if (!parsed?.ok) return [];
  return usageListFromPayload(parsed.data);
}

async function chatOnce({ secret, model, nonce, stream = false }) {
  const started = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`
    },
    body: JSON.stringify({
      model,
      stream,
      max_tokens: 24,
      temperature: 0,
      messages: [
        { role: 'user', content: `Reply with exactly: ${nonce}` }
      ]
    })
  });
  const text = await res.text();
  let body = {};
  let reply = '';
  let usage = null;
  if (stream) {
    const chunks = String(text || '').split('\n');
    for (const line of chunks) {
      const raw = line.replace(/^data:\s*/, '').trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const ev = JSON.parse(raw);
        const piece = ev?.choices?.[0]?.delta?.content || ev?.choices?.[0]?.message?.content || '';
        if (piece) reply += piece;
        if (ev?.usage) usage = ev.usage;
        if (ev?.choices?.[0]?.usage) usage = ev.choices[0].usage;
      } catch { /* ignore keep-alive */ }
    }
    if (!res.ok) {
      try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 400) }; }
    }
  } else {
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 400) }; }
    reply = body?.choices?.[0]?.message?.content || '';
    usage = body.usage || null;
  }
  return {
    started,
    status: res.status,
    ok: res.ok,
    model: body.model || model,
    usage,
    reply: String(reply).slice(0, 80),
    error: body.error?.message || body.message || (res.ok ? '' : text.slice(0, 200)),
    stream
  };
}

function newestLocalLog(db, { userId, model, afterMs }) {
  return (db.logs || []).find((l) => (
    l.userId === userId
    && l.model === model
    && Date.parse(l.createdAt) >= afterMs - 2000
    && l.status !== 'checkin_bonus'
  )) || null;
}

function pickNewRow(rows, { apiKeyId, model, afterMs, seenIds }) {
  const seen = new Set((seenIds || []).map(String));
  const after = afterMs - 5000;
  return (rows || []).find((row) => {
    if (!row || seen.has(String(row.id))) return false;
    if (apiKeyId && row.api_key_id != null && String(row.api_key_id) !== String(apiKeyId)) return false;
    if (model && row.model && String(row.model) !== String(model)) return false;
    const t = Date.parse(row.created_at || row.createdAt || '') || 0;
    if (t && t < after) return false;
    return Number(row.actual_cost) > 0 || ((Number(row.input_tokens) || 0) + (Number(row.output_tokens) || 0) > 0);
  }) || null;
}

async function waitFor(fn, ms = 25000, step = 800) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, step));
  }
  return last;
}

async function probeOne(plan) {
  const db0 = loadDb();
  const user = userByName(db0, plan.user);
  const key = keyByName(user, plan.keyName);
  if (!user || !key?.key) throw new Error(`missing_user_or_key:${plan.user}/${plan.keyName}`);
  const rate = plan.rate;
  const wantStream = plan.stream === true || process.argv.includes('--stream');
  const nonce = `BILLPROBE-${plan.kind}${wantStream ? '-s' : ''}-${Date.now().toString(36)}`;
  const token = await loginKind(plan.kind, plan.cfg);
  const beforeRows = await usageRows(plan.kind, plan.cfg, token, key.upstream?.id);
  const seenIds = beforeRows.map((r) => r.id);
  const bal0 = Number(user.balance) || 0;
  const chat = await chatOnce({ secret: key.key, model: plan.model, nonce, stream: wantStream });
  const log = await waitFor(() => {
    const db = loadDb();
    const hit = newestLocalLog(db, { userId: user.id, model: plan.model, afterMs: chat.started });
    if (!hit) return null;
    if (hit.pendingActual || hit.upstreamCostSource === 'pending') return null;
    return hit;
  }, 28000, 700);
  const row = await waitFor(async () => {
    const rows = await usageRows(plan.kind, plan.cfg, token, key.upstream?.id);
    return pickNewRow(rows, {
      apiKeyId: key.upstream?.id,
      model: plan.model,
      afterMs: chat.started,
      seenIds
    });
  }, 28000, 700);
  const db1 = loadDb();
  const user1 = userByName(db1, plan.user);
  const bal1 = Number(user1?.balance) || 0;
  const actual = Number(row?.actual_cost);
  const expectedCharge = Number.isFinite(actual) ? actual * rate : null;
  const charged = log ? Number(log.chargedAmount) : null;
  const delta = bal0 - bal1;
  const matchCost = log && row && nearly(log.upstreamCost, actual);
  const matchCharge = expectedCharge != null && charged != null && nearly(charged, expectedCharge);
  const matchBalance = user.unlimited ? true : (expectedCharge != null && nearly(delta, expectedCharge));
  const ok = !!(chat.ok && log && row && matchCost && matchCharge && matchBalance && log.upstreamCostSource === 'reported');
  return {
    kind: plan.kind,
    channel: plan.channel,
    model: plan.model,
    stream: wantStream,
    rate,
    http: chat.status,
    chatOk: chat.ok,
    reply: chat.reply,
    chatUsage: chat.usage,
    error: chat.error || '',
    local: log && {
      id: log.id,
      status: log.status,
      source: log.upstreamCostSource,
      upstreamCost: log.upstreamCost,
      chargedAmount: log.chargedAmount,
      alreadyCharged: log.alreadyCharged,
      multiplier: log.multiplier,
      pending: !!log.pendingActual,
      usageId: log.upstreamUsageId,
      clientRequestId: log.clientRequestId || null
    },
    upstream: row && {
      id: row.id,
      request_id: row.request_id || row.requestId || null,
      actual_cost: row.actual_cost,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_read_tokens: row.cache_read_tokens,
      created_at: row.created_at
    },
    expectedCharge,
    balanceBefore: bal0,
    balanceAfter: bal1,
    balanceDelta: delta,
    matchCost,
    matchCharge,
    matchBalance,
    ok
  };
}

const db = loadDb();
const vipCfg = db.settings.upstreamVip1129;
const beiCfg = db.settings.upstreamBeibeihai;
const plans = [
  {
    kind: 'beibeihai',
    channel: 'grp_deepseek',
    user: 'play58819005',
    keyName: 'bei-play',
    model: 'deepseek-v4-flash',
    rate: Number(db.settings.billingMultiplier) || 2.5,
    cfg: beiCfg
  },
  {
    kind: 'vip1129',
    channel: 'grp_gpt_pro',
    user: 'play58819005',
    keyName: 'codex-play',
    model: 'gpt-5.6-terra',
    rate: Number(db.settings.billingMultiplierVip1129) || 1.5,
    cfg: vipCfg
  },
  {
    kind: 'beibeihai',
    channel: 'grp_cc_max',
    user: 'play58819005',
    keyName: 'claude-play',
    model: 'claude-haiku-4-5-20251001',
    rate: Number(db.settings.billingMultiplier) || 2.5,
    cfg: beiCfg
  }
];

const only = process.argv.includes('--vip') ? 'vip1129' : (process.argv.includes('--bei') ? 'beibeihai' : '');
const out = [];
for (const plan of plans) {
  if (only && plan.kind !== only) continue;
  try {
    out.push(await probeOne(plan));
  } catch (err) {
    out.push({ kind: plan.kind, channel: plan.channel, model: plan.model, ok: false, error: String(err?.message || err) });
  }
}

const summary = {
  at: new Date().toISOString(),
  allOk: out.every((r) => r.ok),
  results: out
};
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.allOk ? 0 : 2);
