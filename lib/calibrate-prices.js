/**
 * Calibrate per-channel, per-model token unit prices from usage bills.
 * Prices are BASE 元/1K (before group rate). Hold estimates use these × group rate.
 */
import { pricesFromUsageRows } from '../scripts/probe-upstream-prices.mjs';
import { catalogPrice, withFamilyFallbacks } from './upstream-prices.js';

export function perTokenPrice(per1K) {
  const n = Number(per1K);
  if (!(n > 0)) return 0;
  return n / 1000;
}

export function providerModelList(provider) {
  return [...new Set([provider?.defaultModel, ...(provider?.models || [])]
    .map((m) => String(m || '').trim())
    .filter(Boolean))];
}

export function upstreamKeyIdsForGroup(users, groupId) {
  const want = String(groupId || '');
  const ids = [];
  for (const user of users || []) {
    for (const key of user.apiKeys || []) {
      if (String(key.groupId || '') !== want) continue;
      const uid = key.upstream?.id;
      if (uid == null || uid === '') continue;
      ids.push(String(uid));
    }
  }
  return ids;
}

export function usageRowsForProvider(rows, provider, keyIds = []) {
  const models = new Set(providerModelList(provider));
  const ids = new Set((keyIds || []).map(String));
  return (rows || []).filter((row) => {
    const model = String(row?.model || '').trim();
    if (models.size && !models.has(model)) return false;
    if (!ids.size) return true;
    const kid = row?.api_key_id ?? row?.apiKeyId;
    if (kid == null || kid === '') return false;
    return ids.has(String(kid));
  });
}

function compactPrice(price, samples = 0) {
  return {
    inputPricePer1K: Number(price.inputPricePer1K) || 0,
    outputPricePer1K: Number(price.outputPricePer1K) || 0,
    cacheReadPricePer1K: Number(price.cacheReadPricePer1K) || 0,
    cacheWritePricePer1K: Number(price.cacheWritePricePer1K) || 0,
    samples: Number(samples) || Number(price.samples) || 0
  };
}

export function applyChannelModelPrices(provider, measured = {}, catalog = null) {
  const models = providerModelList(provider);
  provider.modelPrices = provider.modelPrices && typeof provider.modelPrices === 'object'
    ? provider.modelPrices
    : {};
  const assigned = [];
  for (const model of models) {
    const fromUsage = measured[model];
    const fromCatalog = catalogPrice(model, catalog);
    const price = fromUsage || fromCatalog;
    if (!price) continue;
    const next = compactPrice(price, fromUsage?.samples);
    next.calibratedAt = new Date().toISOString();
    provider.modelPrices[model] = next;
    assigned.push({
      model,
      inputPer1K: next.inputPricePer1K,
      outputPer1K: next.outputPricePer1K,
      cacheReadPer1K: next.cacheReadPricePer1K,
      inputPerToken: perTokenPrice(next.inputPricePer1K),
      outputPerToken: perTokenPrice(next.outputPricePer1K),
      samples: next.samples,
      source: fromUsage ? 'usage' : 'catalog'
    });
  }
  const def = assigned.find((x) => x.model === provider.defaultModel) || assigned[0];
  if (def) {
    provider.inputPricePer1K = def.inputPer1K;
    provider.outputPricePer1K = def.outputPer1K;
    provider.cacheReadPricePer1K = def.cacheReadPer1K;
    if (def.cacheReadPer1K) provider.cacheWritePricePer1K = Number(provider.modelPrices[def.model]?.cacheWritePricePer1K) || def.inputPer1K;
  }
  const missing = models.filter((m) => !assigned.some((a) => a.model === m));
  return { assigned, missing };
}

export function applyUsagePricesToProviders({ providers, users, vipUsage, beiUsage }) {
  const vipAll = pricesFromUsageRows(vipUsage);
  const beiAll = pricesFromUsageRows(beiUsage);
  const catalog = withFamilyFallbacks({ ...beiAll, ...vipAll });
  const results = [];
  for (const provider of providers || []) {
    const kind = String(provider.upstreamSync || '');
    const pool = kind === 'vip1129' ? vipUsage : kind === 'beibeihai' ? beiUsage : [...(vipUsage || []), ...(beiUsage || [])];
    const keyIds = upstreamKeyIdsForGroup(users, provider.id);
    let rows = usageRowsForProvider(pool, provider, keyIds);
    if (!rows.length) rows = usageRowsForProvider(pool, provider, []);
    const measured = pricesFromUsageRows(rows);
    const { assigned, missing } = applyChannelModelPrices(provider, measured, catalog);
    results.push({
      id: provider.id,
      name: provider.name,
      usageRows: rows.length,
      models: assigned,
      missing
    });
  }
  return results;
}
