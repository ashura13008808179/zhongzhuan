/**
 * One-shot: sync upstreamRateMultiplier from live groups + set BASE modelPrices
 * (pre-rate). server.js multiplies by upstreamRateMultiplier for upstreamCost.
 * Does NOT change global billingMultiplier / billingMultiplierVip1129.
 * Does NOT use displayMultiplier for charging.
 */
import fs from 'fs';
import path from 'path';
import { MEASURED_BASE_PRICES as MODEL_BASE, CHANNEL_BASE_FALLBACK } from './lib/upstream-prices.js';

const DB_PATH = process.argv[2] || 'C:/apps/zhongzhuan/data/db.json';
const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
const vip = db.settings.upstreamVip1129 || {};
const bei = db.settings.upstreamBeibeihai || {};

async function login(base, email, password) {
  const res = await fetch(`${String(base).replace(/\/$/, '')}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json().catch(() => ({}));
  const token = data?.data?.access_token || data?.access_token;
  if (!token) throw new Error(`login failed ${base} status=${res.status}`);
  return token;
}
async function listGroups(base, token) {
  const res = await fetch(`${String(base).replace(/\/$/, '')}/api/v1/groups/available`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  const data = await res.json().catch(() => ({}));
  const root = data?.data ?? data;
  return Array.isArray(root) ? root : (Array.isArray(root?.items) ? root.items : []);
}

const vipBase = vip.baseUrl || 'https://api.vip1129.cc';
const beiBase = bei.baseUrl || 'https://sub.beibeihai.xyz';

const vipTok = await login(vipBase, vip.email, vip.password);
const beiTok = await login(beiBase, bei.email, bei.password);
const vipGroups = await listGroups(vipBase, vipTok);
const beiGroups = await listGroups(beiBase, beiTok);
const vipById = new Map(vipGroups.map(g => [Number(g.id), g]));
const beiById = new Map(beiGroups.map(g => [Number(g.id), g]));

const vipMap = { ...(vip.groupMap || {}) };
const beiMap = { ...(bei.groupMap || {}) };

const before = {};
const after = {};
const coverage = [];

for (const p of db.settings.providers || []) {
  before[p.id] = {
    in: p.inputPricePer1K, out: p.outputPricePer1K,
    rate: p.upstreamRateMultiplier, disp: p.displayMultiplier,
    mp: Object.keys(p.modelPrices || {}).length
  };

  let rate = 1;
  let upName = null;
  let source = 'default';
  if (p.upstreamSync === 'vip1129' || /vip1129/i.test(p.url || '')) {
    const gid = vipMap[p.id];
    const g = gid != null ? vipById.get(Number(gid)) : null;
    if (g && Number.isFinite(Number(g.rate_multiplier))) {
      rate = Number(g.rate_multiplier);
      upName = g.name;
      source = 'vip1129.group';
    }
  } else if (p.upstreamSync === 'beibeihai' || /beibeihai/i.test(p.url || '')) {
    const gid = beiMap[p.id];
    const g = gid != null ? beiById.get(Number(gid)) : null;
    if (g && Number.isFinite(Number(g.rate_multiplier))) {
      rate = Number(g.rate_multiplier);
      upName = g.name;
      source = 'beibeihai.group';
    }
  }

  const fb = CHANNEL_BASE_FALLBACK[p.id] || { inputPricePer1K: 0.005, outputPricePer1K: 0.03, cacheReadPricePer1K: 0.0005 };
  p.upstreamRateMultiplier = rate;
  p.inputPricePer1K = fb.inputPricePer1K;
  p.outputPricePer1K = fb.outputPricePer1K;
  p.cacheReadPricePer1K = fb.cacheReadPricePer1K;

  // Merge modelPrices for known models on this channel (keep any admin extras)
  p.modelPrices = p.modelPrices && typeof p.modelPrices === 'object' ? p.modelPrices : {};
  const models = Array.isArray(p.models) ? p.models : [];
  for (const m of models) {
    if (MODEL_BASE[m]) p.modelPrices[m] = { ...MODEL_BASE[m] };
  }
  // Always seed key defaults even if models list incomplete
  for (const [m, price] of Object.entries(MODEL_BASE)) {
    if (p.defaultModel === m || models.includes(m)) p.modelPrices[m] = { ...price };
  }
  // Seed GPT family on all vip gpt channels
  if (['grp_gpt_pro', 'grp_gpt_plus', 'grp_gpt_mix'].includes(p.id)) {
    for (const m of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-6-astra', 'codex-auto-review']) {
      p.modelPrices[m] = { ...MODEL_BASE[m] };
    }
  }

  after[p.id] = {
    in: p.inputPricePer1K, out: p.outputPricePer1K, cache: p.cacheReadPricePer1K,
    rate: p.upstreamRateMultiplier, mp: Object.keys(p.modelPrices).length
  };
  coverage.push({
    id: p.id, name: p.name, sync: p.upstreamSync || null,
    upstreamGroup: upName, rateSource: source,
    upstreamRateMultiplier: rate,
    displayMultiplier_NOT_USED_FOR_CHARGE: p.displayMultiplier,
    baseIn: p.inputPricePer1K, baseOut: p.outputPricePer1K,
    effectiveInApprox: +(p.inputPricePer1K * rate).toFixed(6),
    effectiveOutApprox: +(p.outputPricePer1K * rate).toFixed(6),
    modelPriceCount: Object.keys(p.modelPrices).length
  });
}

// backup
const bak = DB_PATH + `.bak-upstream-cost-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.copyFileSync(DB_PATH, bak);
fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
console.log(JSON.stringify({
  ok: true,
  db: DB_PATH,
  backup: bak,
  globalsUnchanged: {
    billingMultiplier: db.settings.billingMultiplier,
    billingMultiplierVip1129: db.settings.billingMultiplierVip1129
  },
  before,
  after,
  coverage
}, null, 2));
