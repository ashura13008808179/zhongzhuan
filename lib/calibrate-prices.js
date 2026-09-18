/**
 * Calibrate per-channel, per-model token unit prices from usage bills.
 * Prices are BASE 元/1K (before group rate). Hold estimates use these × group rate.
 */
import { catalogPrice } from './upstream-prices.js';

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

export function hasPositivePrice(price) {
  if (!price || typeof price !== 'object') return false;
  return Number(price.inputPricePer1K) > 0 || Number(price.outputPricePer1K) > 0;
}

export function per1MFromPer1K(per1K) {
  const n = Number(per1K);
  return Number.isFinite(n) && n > 0 ? n * 1000 : 0;
}

export function applyChannelModelPrices(provider, measured = {}, catalog = null, { keepExisting = true } = {}) {
  const models = providerModelList(provider);
  provider.modelPrices = provider.modelPrices && typeof provider.modelPrices === 'object'
    ? { ...provider.modelPrices }
    : {};
  const assigned = [];
  const kept = [];
  for (const model of models) {
    const existing = provider.modelPrices[model];
    const fromUsage = measured[model];
    if (fromUsage && hasPositivePrice(fromUsage)) {
      const next = compactPrice(fromUsage, fromUsage.samples);
      next.calibratedAt = new Date().toISOString();
      next.source = 'usage';
      provider.modelPrices[model] = next;
      assigned.push({
        model,
        inputPer1K: next.inputPricePer1K,
        outputPer1K: next.outputPricePer1K,
        cacheReadPer1K: next.cacheReadPricePer1K,
        inputPer1M: per1MFromPer1K(next.inputPricePer1K),
        outputPer1M: per1MFromPer1K(next.outputPricePer1K),
        inputPerToken: perTokenPrice(next.inputPricePer1K),
        outputPerToken: perTokenPrice(next.outputPricePer1K),
        samples: next.samples,
        source: 'usage'
      });
      continue;
    }
    if (keepExisting && hasPositivePrice(existing)) {
      kept.push(model);
      continue;
    }
    const fromCatalog = catalogPrice(model, catalog);
    if (fromCatalog && hasPositivePrice(fromCatalog) && !hasPositivePrice(existing)) {
      const next = compactPrice(fromCatalog, 0);
      next.calibratedAt = new Date().toISOString();
      next.source = 'catalog';
      provider.modelPrices[model] = next;
      assigned.push({
        model,
        inputPer1K: next.inputPricePer1K,
        outputPer1K: next.outputPricePer1K,
        cacheReadPer1K: next.cacheReadPricePer1K,
        inputPer1M: per1MFromPer1K(next.inputPricePer1K),
        outputPer1M: per1MFromPer1K(next.outputPricePer1K),
        inputPerToken: perTokenPrice(next.inputPricePer1K),
        outputPerToken: perTokenPrice(next.outputPricePer1K),
        samples: 0,
        source: 'catalog'
      });
    }
  }
  const priced = models
    .map((model) => ({ model, price: provider.modelPrices[model] }))
    .filter((row) => hasPositivePrice(row.price));
  const def = priced.find((row) => row.model === provider.defaultModel) || priced[0];
  if (def) {
    provider.inputPricePer1K = Number(def.price.inputPricePer1K) || 0;
    provider.outputPricePer1K = Number(def.price.outputPricePer1K) || 0;
    provider.cacheReadPricePer1K = Number(def.price.cacheReadPricePer1K) || 0;
    provider.cacheWritePricePer1K = Number(def.price.cacheWritePricePer1K) || Number(def.price.inputPricePer1K) || 0;
  }
  const missing = models.filter((m) => !hasPositivePrice(provider.modelPrices[m]));
  return { assigned, kept, missing };
}
