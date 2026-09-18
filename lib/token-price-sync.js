/**
 * Merge freshly measured token prices into the channel table without
 * wiping the last good table while a fetch is in flight or after a failure.
 */
import { pricesFromUsageRows } from '../scripts/probe-upstream-prices.mjs';
import { catalogPrice, withFamilyFallbacks } from './upstream-prices.js';
import {
  applyChannelModelPrices,
  providerModelList,
  upstreamKeyIdsForGroup,
  usageRowsForProvider,
  hasPositivePrice,
  per1MFromPer1K
} from './calibrate-prices.js';
import { shanghaiDate, addDaysYmd } from './checkin.js';

export const TOKEN_PRICE_RETRY_MS = 5 * 60 * 1000;
export const TOKEN_PRICE_RECENT_MS = 48 * 60 * 60 * 1000;
export const TOKEN_PRICE_SLOTS = Object.freeze([0, 12]);

/** Prefer the last 48h of dated bills. Stale dated rows do not overwrite the last table. */
export function recentUsageRows(rows, now = Date.now(), windowMs = TOKEN_PRICE_RECENT_MS) {
  const list = rows || [];
  const since = now - windowMs;
  const datedRecent = [];
  let datedAny = 0;
  const undated = [];
  for (const row of list) {
    const t = Date.parse(row?.created_at || row?.createdAt || '') || 0;
    if (!t) {
      undated.push(row);
      continue;
    }
    datedAny += 1;
    if (t >= since) datedRecent.push(row);
  }
  if (datedRecent.length) return datedRecent;
  if (datedAny) return [];
  return undated;
}

export function shanghaiWallDate(ymd, hour = 0, minute = 0) {
  const [y, m, d] = String(ymd || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d, hour - 8, minute, 0, 0));
}

export function nextTokenPriceSyncAt(now = new Date()) {
  const ymd = shanghaiDate(now);
  const todayNoon = shanghaiWallDate(ymd, 12, 0);
  const nextMidnight = shanghaiWallDate(addDaysYmd(ymd, 1), 0, 0);
  if (todayNoon && now.getTime() < todayNoon.getTime()) return todayNoon;
  return nextMidnight;
}

export function msUntilNextTokenPriceSync(now = new Date()) {
  const at = nextTokenPriceSyncAt(now);
  if (!at) return TOKEN_PRICE_RETRY_MS;
  return Math.max(250, at.getTime() - now.getTime());
}

export function providerKindForPrices(provider) {
  const sync = String(provider?.upstreamSync || '').toLowerCase();
  if (sync === 'vip1129' || sync === 'beibeihai') return sync;
  const url = String(provider?.url || '');
  if (/vip1129/i.test(url)) return 'vip1129';
  if (/beibeihai|api\.gptgod/i.test(url)) return 'beibeihai';
  return sync || 'beibeihai';
}

function modelSummary(provider, model, price, source) {
  const group = Number(provider?.upstreamRateMultiplier);
  const rate = Number.isFinite(group) && group > 0 ? group : 1;
  const input = Number(price?.inputPricePer1K) || 0;
  const output = Number(price?.outputPricePer1K) || 0;
  const cache = Number(price?.cacheReadPricePer1K) || 0;
  return {
    model,
    source,
    inputPer1K: input,
    outputPer1K: output,
    cacheReadPer1K: cache,
    inputPer1M: per1MFromPer1K(input),
    outputPer1M: per1MFromPer1K(output),
    cacheReadPer1M: per1MFromPer1K(cache),
    officialInputPer1M: per1MFromPer1K(input) * rate,
    officialOutputPer1M: per1MFromPer1K(output) * rate,
    samples: Number(price?.samples) || 0
  };
}

export function channelTokenPriceView(provider) {
  const prices = provider?.modelPrices && typeof provider.modelPrices === 'object'
    ? provider.modelPrices
    : {};
  const models = providerModelList(provider);
  const rows = [];
  for (const model of models) {
    const price = prices[model];
    if (!hasPositivePrice(price)) continue;
    rows.push(modelSummary(provider, model, price, price.source || 'table'));
  }
  for (const [model, price] of Object.entries(prices)) {
    if (models.includes(model)) continue;
    if (!hasPositivePrice(price)) continue;
    rows.push(modelSummary(provider, model, price, price.source || 'table'));
  }
  return {
    id: provider?.id,
    name: provider?.name,
    kind: providerKindForPrices(provider),
    modelCount: rows.length,
    models: rows
  };
}

/**
 * Apply new measurements. Failed kinds keep the previous table untouched.
 * Models without a fresh sample keep their last saved price.
 */
export function applyUsagePricesToProviders({
  providers,
  users,
  vipUsage,
  beiUsage,
  vipOk = true,
  beiOk = true,
  onlyIds = null
} = {}) {
  const vipAll = vipOk ? pricesFromUsageRows(recentUsageRows(vipUsage)) : {};
  const beiAll = beiOk ? pricesFromUsageRows(recentUsageRows(beiUsage)) : {};
  const catalog = withFamilyFallbacks({ ...beiAll, ...vipAll });
  const want = Array.isArray(onlyIds) && onlyIds.length
    ? new Set(onlyIds.map(String))
    : null;
  const results = [];
  const failedIds = [];
  for (const provider of providers || []) {
    if (want && !want.has(String(provider.id))) continue;
    const kind = providerKindForPrices(provider);
    const kindOk = kind === 'vip1129' ? vipOk : beiOk;
    if (!kindOk) {
      failedIds.push(provider.id);
      results.push({
        id: provider.id,
        name: provider.name,
        kind,
        ok: false,
        kept: true,
        error: `${kind}_fetch_failed`,
        usageRows: 0,
        models: [],
        missing: providerModelList(provider)
      });
      continue;
    }
    const pool = kind === 'vip1129' ? vipUsage : beiUsage;
    const keyIds = upstreamKeyIdsForGroup(users, provider.id);
    let rows = usageRowsForProvider(pool, provider, keyIds);
    if (!rows.length) rows = usageRowsForProvider(pool, provider, []);
    rows = recentUsageRows(rows);
    const measured = pricesFromUsageRows(rows);
    const { assigned, kept, missing } = applyChannelModelPrices(provider, measured, catalog, {
      keepExisting: true
    });
    results.push({
      id: provider.id,
      name: provider.name,
      kind,
      ok: true,
      kept: assigned.length === 0,
      error: null,
      usageRows: rows.length,
      models: assigned,
      keptModels: kept,
      missing
    });
  }
  return { results, failedIds };
}
