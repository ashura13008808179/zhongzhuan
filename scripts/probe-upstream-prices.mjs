/**
 * Pull vip1129 / beibeihai usage bills and derive BASE 元/1K prices from
 * input_cost / output_cost / cache_*_cost (these are pre-rate).
 * actual_cost = total_cost × group.rate_multiplier.
 *
 * --apply  writes prices + upstreamRateMultiplier into data/db.json
 * --ping   cheap max_tokens=8 probes for default models still missing
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as vip from '../upstream/vip1129.js';
import * as bei from '../upstream/beibeihai.js';
import { usageListFromPayload } from '../lib/billing-cost.js';
import { normalizeAvailableGroups } from '../lib/relay-core.js';
import { catalogPrice, withFamilyFallbacks } from '../lib/upstream-prices.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.argv.includes('--db')
  ? process.argv[process.argv.indexOf('--db') + 1]
  : path.join(ROOT, 'data', 'db.json');
const APPLY = process.argv.includes('--apply');
const PING = process.argv.includes('--ping');
const PING_LIMIT = Number(process.env.PING_LIMIT || 8);

export function roundPrice(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x <= 0) return 0;
  if (x >= 0.1) return Number(x.toFixed(4));
  if (x >= 0.01) return Number(x.toFixed(5));
  if (x >= 0.001) return Number(x.toFixed(6));
  return Number(x.toFixed(7));
}

export function unitPricePer1K(cost, tokens) {
  const c = Number(cost);
  const t = Number(tokens);
  if (!(c > 0) || !(t > 0)) return null;
  return (c / t) * 1000;
}

export function median(values) {
  const a = (values || []).filter((n) => Number.isFinite(n) && n > 0).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function pricesFromUsageRows(rows) {
  const buckets = new Map();
  for (const row of rows || []) {
    const model = String(row?.model || '').trim();
    if (!model) continue;
    if (!buckets.has(model)) buckets.set(model, { in: [], out: [], cache: [], write: [], n: 0 });
    const b = buckets.get(model);
    b.n += 1;
    const pi = unitPricePer1K(row.input_cost, row.input_tokens);
    const po = unitPricePer1K(row.output_cost, row.output_tokens);
    const pc = unitPricePer1K(row.cache_read_cost, row.cache_read_tokens);
    const pw = unitPricePer1K(row.cache_creation_cost, row.cache_creation_tokens);
    if (pi != null) b.in.push(pi);
    if (po != null) b.out.push(po);
    if (pc != null) b.cache.push(pc);
    if (pw != null) b.write.push(pw);
  }
  const out = {};
  for (const [model, b] of buckets) {
    const input = median(b.in);
    const output = median(b.out);
    if (input == null && output == null) continue;
    const resolvedIn = input ?? (output != null ? output / 5 : 0);
    const resolvedOut = output ?? (resolvedIn * 4);
    const cache = median(b.cache) ?? resolvedIn * 0.1;
    const write = median(b.write) ?? resolvedIn;
    out[model] = {
      inputPricePer1K: roundPrice(resolvedIn),
      outputPricePer1K: roundPrice(resolvedOut),
      cacheReadPricePer1K: roundPrice(cache),
      cacheWritePricePer1K: roundPrice(write),
      samples: b.n,
      inN: b.in.length,
      outN: b.out.length,
      cacheN: b.cache.length,
      writeN: b.write.length
    };
  }
  return out;
}

async function loginOrThrow(kind, cfg) {
  const client = kind === 'vip1129' ? vip : bei;
  const logged = await client.login(cfg.baseUrl, cfg.email, cfg.password);
  if (!logged.ok) throw new Error(`${kind} login failed: ${logged.error || logged.status}`);
  return { client, token: logged.token, base: cfg.baseUrl };
}

async function fetchUsagePage(base, token, query, timeoutMs = 25000) {
  const q = query.startsWith('?') ? query : `?${query}`;
  const res = await fetch(`${String(base).replace(/\/$/, '')}/api/v1/usage${q}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: String(text).slice(0, 400) }; }
  return { ok: res.ok, status: res.status, data };
}

async function fetchAllUsage(base, token, pages = 6, pageSize = 50) {
  const all = [];
  for (let page = 1; page <= pages; page += 1) {
    let res;
    try {
      res = await fetchUsagePage(base, token, `page=${page}&page_size=${pageSize}`);
    } catch {
      break;
    }
    if (!res.ok) break;
    const list = usageListFromPayload(res.data);
    if (!list.length) break;
    all.push(...list);
    if (list.length < pageSize) break;
  }
  return all;
}

function pickProbeKey(db, providerId) {
  for (const user of db.users || []) {
    for (const key of user.apiKeys || []) {
      if (key.enabled === false) continue;
      if (String(key.groupId || '') !== String(providerId)) continue;
      const secret = String(key.key || '').trim();
      if (!secret) continue;
      return secret;
    }
  }
  return null;
}

async function pingModel(chatUrl, secret, model) {
  const res = await fetch(chatUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      model,
      stream: false,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }]
    }),
    signal: AbortSignal.timeout(45000)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: String(text).slice(0, 240) }; }
  const usage = data?.usage || data?.data?.usage || null;
  return {
    ok: res.ok,
    status: res.status,
    usage: usage ? {
      prompt: usage.prompt_tokens ?? usage.input_tokens ?? null,
      completion: usage.completion_tokens ?? usage.output_tokens ?? null
    } : null,
    error: res.ok ? null : (data?.error?.message || data?.message || res.status)
  };
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeGroups(payload) {
  return normalizeAvailableGroups(payload).map((g) => ({
    id: Number(g.id),
    name: String(g.name || ''),
    rate: Number(g.rate ?? 1) || 1
  })).filter((g) => Number.isFinite(g.id));
}

const isMain = (() => {
  const self = path.normalize(fileURLToPath(import.meta.url));
  const argv1 = process.argv[1] ? path.normalize(path.resolve(process.argv[1])) : '';
  return argv1 === self;
})();
if (!isMain) {
  // imported by tests
} else {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  const vipCfg = db.settings?.upstreamVip1129 || {};
  const beiCfg = db.settings?.upstreamBeibeihai || {};

  const vipAuth = await loginOrThrow('vip1129', vipCfg);
  const beiAuth = await loginOrThrow('beibeihai', beiCfg);

  const [vipGroupsRes, beiGroupsRes] = await Promise.all([
    vipAuth.client.listAvailableGroups(vipAuth.base, vipAuth.token),
    beiAuth.client.listAvailableGroups(beiAuth.base, beiAuth.token)
  ]);
  const vipGroupList = normalizeGroups(vipGroupsRes.data);
  const beiGroupList = normalizeGroups(beiGroupsRes.data);
  const vipById = new Map(vipGroupList.map((g) => [g.id, g]));
  const beiById = new Map(beiGroupList.map((g) => [g.id, g]));

  let vipUsage = [];
  let beiUsage = [];
  try { vipUsage = await fetchAllUsage(vipAuth.base, vipAuth.token); } catch {}
  try { beiUsage = await fetchAllUsage(beiAuth.base, beiAuth.token); } catch {}

  let measured = {
    ...pricesFromUsageRows(beiUsage),
    ...pricesFromUsageRows(vipUsage)
  };

  const pingResults = [];
  if (PING) {
    const wanted = [];
    for (const p of db.settings?.providers || []) {
      if (p.enabled === false || p.maintenance) continue;
      const model = p.defaultModel;
      if (!model) continue;
      if (measured[model] || catalogPrice(model)) continue;
      wanted.push({ provider: p, model });
    }
    for (const item of wanted.slice(0, PING_LIMIT)) {
      const secret = pickProbeKey(db, item.provider.id);
      if (!secret) {
        pingResults.push({ providerId: item.provider.id, model: item.model, ok: false, error: 'no_key' });
        continue;
      }
      pingResults.push({ providerId: item.provider.id, model: item.model, ...(await pingModel(item.provider.url, secret, item.model)) });
      await wait(1200);
    }
    await wait(3000);
    try { vipUsage = await fetchAllUsage(vipAuth.base, vipAuth.token, 3, 50); } catch {}
    try { beiUsage = await fetchAllUsage(beiAuth.base, beiAuth.token, 3, 50); } catch {}
    measured = {
      ...pricesFromUsageRows(beiUsage),
      ...pricesFromUsageRows(vipUsage)
    };
  }

  const modelBase = withFamilyFallbacks(measured);

  function rateForProvider(p) {
    if (p.upstreamSync === 'vip1129') {
      const g = vipById.get(Number(vipCfg.groupMap?.[p.id]));
      return g?.rate || 1;
    }
    if (p.upstreamSync === 'beibeihai') {
      const g = beiById.get(Number(beiCfg.groupMap?.[p.id]));
      return g?.rate || 1;
    }
    return Number(p.upstreamRateMultiplier) || 1;
  }

  const channelPlan = [];
  for (const p of db.settings?.providers || []) {
    const rate = rateForProvider(p);
    const models = [...new Set([p.defaultModel, ...(p.models || [])].filter(Boolean))];
    const assigned = {};
    for (const m of models) {
      const price = catalogPrice(m, modelBase);
      if (price) assigned[m] = price;
    }
    const fb = assigned[p.defaultModel] || Object.values(assigned)[0] || null;
    channelPlan.push({
      id: p.id,
      name: p.name,
      sync: p.upstreamSync || null,
      upstreamRateMultiplier: rate,
      fallback: fb,
      modelCount: Object.keys(assigned).length,
      missing: models.filter((m) => !assigned[m])
    });
    p._assigned = assigned;
  }

  const report = {
    ok: true,
    db: DB_PATH,
    groups: { vip1129: vipGroupList, beibeihai: beiGroupList },
    usageCounts: { vip1129: vipUsage.length, beibeihai: beiUsage.length },
    pingResults,
    measured,
    modelBase,
    channelPlan: channelPlan.map(({ id, name, sync, upstreamRateMultiplier, fallback, modelCount, missing }) => ({
      id, name, sync, upstreamRateMultiplier, fallback, modelCount, missing
    }))
  };

  if (APPLY) {
    const bak = `${DB_PATH}.bak-price-probe-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(DB_PATH, bak);
    report.backup = bak;
    for (const p of db.settings.providers || []) {
      const plan = channelPlan.find((x) => x.id === p.id);
      if (!plan) continue;
      p.upstreamRateMultiplier = plan.upstreamRateMultiplier;
      if (plan.fallback) {
        p.inputPricePer1K = plan.fallback.inputPricePer1K;
        p.outputPricePer1K = plan.fallback.outputPricePer1K;
        p.cacheReadPricePer1K = plan.fallback.cacheReadPricePer1K;
        if (plan.fallback.cacheWritePricePer1K) p.cacheWritePricePer1K = plan.fallback.cacheWritePricePer1K;
      }
      p.modelPrices = { ...(p.modelPrices || {}), ...(p._assigned || {}) };
      delete p._assigned;
    }
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    report.applied = true;
  } else {
    for (const p of db.settings.providers || []) delete p._assigned;
  }

  console.log(JSON.stringify(report, null, 2));
}
