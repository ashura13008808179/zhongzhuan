import assert from 'node:assert/strict';
import {
  modelPrice,
  extractReportedUpstreamCost,
  providerUpstreamRate,
  estimateBaseUpstreamCost,
  resolveUpstreamCost,
  billedTokensFromLog,
  usageListFromPayload,
  pickUpstreamUsageRow,
  pickExclusiveUpstreamUsageRow,
  findDuplicateUsageCharges
} from '../lib/billing-cost.js';
import { pricesFromUsageRows } from '../scripts/probe-upstream-prices.mjs';

const provider = {
  defaultModel: 'gpt-5.6-sol',
  inputPricePer1K: 0.005,
  outputPricePer1K: 0.03,
  cacheReadPricePer1K: 0.0005,
  upstreamRateMultiplier: 2,
  modelPrices: {
    'gpt-5.6-sol': { inputPricePer1K: 0.005, outputPricePer1K: 0.03, cacheReadPricePer1K: 0.0005 }
  }
};

assert.equal(modelPrice(provider, 'gpt-5.6-sol', 'cacheReadPricePer1K'), 0.0005);
assert.equal(providerUpstreamRate(provider), 2);
assert.equal(providerUpstreamRate({}), 1);

assert.equal(extractReportedUpstreamCost({ actual_cost: 0.12 }), 0.12);
assert.equal(extractReportedUpstreamCost({ actualCost: '0.08' }), 0.08);
assert.equal(extractReportedUpstreamCost({ totalCost: '0.08' }), null);
assert.equal(extractReportedUpstreamCost({ tokens: 10 }), null);
assert.equal(extractReportedUpstreamCost({ cost: 0 }), null);
assert.equal(extractReportedUpstreamCost({ actual_cost: 0 }), null);
assert.equal(extractReportedUpstreamCost({ cost: 9.99, actual_cost: 0.12 }), 0.12);

// 1000 fresh in + 1000 cache (folded into prompt) + 1000 out
const folded = estimateBaseUpstreamCost(provider, {
  prompt_tokens: 2000,
  completion_tokens: 1000,
  prompt_tokens_details: { cached_tokens: 1000 }
}, 'gpt-5.6-sol');
assert.equal(folded, 0.005 + 0.0005 + 0.03);

// vip1129-style: input is fresh-only, cache_read listed separately and larger
const separate = estimateBaseUpstreamCost(provider, {
  prompt_tokens: 500,
  completion_tokens: 0,
  cache_read_tokens: 1500
}, 'gpt-5.6-sol');
assert.equal(separate, (500 / 1000) * 0.005 + (1500 / 1000) * 0.0005);

const reported = resolveUpstreamCost(provider, { actual_cost: 0.42, prompt_tokens: 10 }, 'gpt-5.6-sol');
assert.equal(reported.source, 'reported');
assert.equal(reported.cost, 0.42);

const estimated = resolveUpstreamCost(provider, {
  prompt_tokens: 1000,
  completion_tokens: 0
}, 'gpt-5.6-sol');
assert.equal(estimated.source, 'estimated');
assert.equal(estimated.cost, 0.005 * 2);

const pending = resolveUpstreamCost(provider, {
  prompt_tokens: 1000,
  completion_tokens: 0
}, 'gpt-5.6-sol', { allowEstimate: false });
assert.equal(pending.source, 'pending');
assert.equal(pending.cost, 0);
assert.equal(resolveUpstreamCost(provider, { cost: 0, prompt_tokens: 1000 }, 'gpt-5.6-sol', { allowEstimate: false }).source, 'pending');
assert.equal(resolveUpstreamCost(provider, { actual_cost: 0.42 }, 'gpt-5.6-sol', { allowEstimate: false }).source, 'reported');

assert.deepEqual(usageListFromPayload({ data: { items: [{ id: 1 }] } }), [{ id: 1 }]);

const started = Date.parse('2026-09-15T08:05:50.000Z');
const rows = [
  {
    id: 11, api_key_id: 6173, model: 'gpt-5.6-sol',
    input_tokens: 858, output_tokens: 8, cache_read_tokens: 7488,
    actual_cost: 0.0115836, created_at: '2026-09-15T08:05:50.504Z'
  },
  {
    id: 12, api_key_id: 6173, model: 'gpt-5.6-sol',
    input_tokens: 3665, output_tokens: 8, cache_read_tokens: 20226,
    actual_cost: 0.0401492, created_at: '2026-09-15T08:11:00.634Z'
  },
  {
    id: 13, api_key_id: 99, model: 'gpt-5.6-sol',
    input_tokens: 858, output_tokens: 8, cache_read_tokens: 7488,
    actual_cost: 9.99, created_at: '2026-09-15T08:05:50.504Z'
  }
];
const hit = pickUpstreamUsageRow(rows, {
  apiKeyId: 6173,
  model: 'gpt-5.6-sol',
  usage: {
    prompt_tokens: 8346,
    completion_tokens: 8,
    prompt_tokens_details: { cached_tokens: 7488 }
  },
  startedAt: started,
  now: started + 2000,
  usedIds: []
});
assert.equal(hit.id, 11);
assert.equal(hit.actual_cost, 0.0115836);

const skipped = pickUpstreamUsageRow(rows, {
  apiKeyId: 6173,
  model: 'gpt-5.6-sol',
  usage: {
    prompt_tokens: 8346,
    completion_tokens: 8,
    prompt_tokens_details: { cached_tokens: 7488 }
  },
  startedAt: started,
  now: started + 2000,
  usedIds: [11]
});
assert.equal(skipped, null);

const truncated = pickUpstreamUsageRow([
  {
    id: 21, api_key_id: 1, model: 'gpt-5.6-sol',
    input_tokens: 100, output_tokens: 8, cache_read_tokens: 0,
    actual_cost: 0.14, created_at: '2026-09-15T08:05:50.504Z'
  },
  {
    id: 22, api_key_id: 1, model: 'gpt-5.6-sol',
    input_tokens: 80000, output_tokens: 2000, cache_read_tokens: 100000,
    actual_cost: 1.3954, created_at: '2026-09-15T08:05:51.000Z'
  }
], {
  apiKeyId: 1,
  model: 'gpt-5.6-sol',
  usage: { prompt_tokens: 100, completion_tokens: 8 },
  startedAt: started,
  now: started + 2000,
  usedIds: []
});
assert.equal(truncated.id, 21);
assert.equal(truncated.actual_cost, 0.14);

const byRequest = pickUpstreamUsageRow([
  {
    id: 31, api_key_id: 1, model: 'gpt-5.6-sol', request_id: 'client:other',
    input_tokens: 80000, output_tokens: 2000, actual_cost: 9.99,
    created_at: '2026-09-15T08:05:51.000Z'
  },
  {
    id: 32, api_key_id: 1, model: 'gpt-5.6-sol', request_id: 'client:req_ownbill',
    input_tokens: 100, output_tokens: 8, actual_cost: 0.14,
    created_at: '2026-09-15T08:05:50.504Z'
  }
], {
  apiKeyId: 1,
  model: 'gpt-5.6-sol',
  clientRequestId: 'client:req_ownbill',
  usage: { prompt_tokens: 100, completion_tokens: 8 },
  startedAt: started,
  now: started + 2000,
  preferNewest: true
});
assert.equal(byRequest.id, 32);

const notSibling = pickUpstreamUsageRow([
  {
    id: 41, api_key_id: 1, model: 'gpt-5.6-sol', request_id: 'client:someone-else',
    input_tokens: 50, output_tokens: 8, actual_cost: 0.99,
    created_at: '2026-09-15T08:05:51.200Z'
  }
], {
  apiKeyId: 1,
  model: 'gpt-5.6-sol',
  clientRequestId: 'client:req_ownbill',
  usage: { prompt_tokens: 100, completion_tokens: 8 },
  startedAt: started,
  now: started + 2000,
  preferNewest: true
});
assert.equal(notSibling, null);

const unmatchedHeader = pickUpstreamUsageRow([
  {
    id: 51, api_key_id: 1, model: 'gpt-5.6-sol', request_id: 'client:6ed1b3e1-2012-42ef-87fb-e256734bf1b8',
    input_tokens: 23, output_tokens: 15, cache_read_tokens: 0, actual_cost: 0.000102,
    created_at: '2026-09-15T08:05:50.504Z'
  },
  {
    id: 52, api_key_id: 1, model: 'gpt-5.6-sol', request_id: 'client:83c4a2a0-3528-40f1-94f8-31df2e5dcbf9',
    input_tokens: 80000, output_tokens: 2000, actual_cost: 9.99,
    created_at: '2026-09-15T08:05:51.000Z'
  }
], {
  apiKeyId: 1,
  model: 'gpt-5.6-sol',
  clientRequestId: 'client:req_b500eade12740c',
  usage: { prompt_tokens: 23, completion_tokens: 15 },
  startedAt: started,
  now: started + 2000
});
assert.equal(unmatchedHeader.id, 51);
assert.equal(unmatchedHeader.actual_cost, 0.000102);

const byTotalOnly = pickUpstreamUsageRow([
  {
    id: 61, api_key_id: 6163, model: 'gpt-5.6-terra',
    input_tokens: 140000, output_tokens: 11717, cache_read_tokens: 0,
    actual_cost: 0.08, created_at: '2026-09-15T08:05:50.504Z'
  },
  {
    id: 62, api_key_id: 6163, model: 'gpt-5.6-terra',
    input_tokens: 20000, output_tokens: 100, cache_read_tokens: 0,
    actual_cost: 0.01, created_at: '2026-09-15T08:05:51.000Z'
  }
], {
  apiKeyId: '',
  model: 'gpt-5.6-terra',
  usage: { total_tokens: 151717 },
  startedAt: started,
  now: started + 300000
});
assert.equal(byTotalOnly.id, 61);

const wrongKey = pickUpstreamUsageRow([{
  id: 71, api_key_id: 6163, model: 'gpt-5.6-terra',
  input_tokens: 140000, output_tokens: 11717, actual_cost: 0.08,
  created_at: '2026-09-15T08:05:50.504Z'
}], {
  apiKeyId: 9999,
  model: 'gpt-5.6-terra',
  usage: { total_tokens: 151717 },
  startedAt: started,
  now: started + 300000
});
assert.equal(wrongKey, null);

assert.equal(billedTokensFromLog({ tokens: 100, billedTokens: 250, multiplier: 2.5 }), 250);
assert.equal(billedTokensFromLog({ tokens: 100, multiplier: 1.5 }), 150);
assert.equal(billedTokensFromLog({ tokens: 100, billedTokens: 0, multiplier: 2.5 }), 250);

const generic = {
  id: 'grp_gpt_pro',
  inputPricePer1K: 0.01,
  outputPricePer1K: 0.03,
  cacheReadPricePer1K: 0.001,
  upstreamRateMultiplier: 1.4,
  modelPrices: {}
};
const catalogEst = resolveUpstreamCost(generic, { prompt_tokens: 1000, completion_tokens: 0 }, 'gpt-5.6-sol');
assert.equal(catalogEst.source, 'estimated');
assert.equal(catalogEst.cost, 0.005 * 1.4);

const terraEst = resolveUpstreamCost(generic, {
  prompt_tokens: 1000,
  completion_tokens: 0
}, 'gpt-5.6-terra');
assert.equal(terraEst.cost, 0.002 * 1.4);

const derived = pricesFromUsageRows([{
  model: 'gpt-5.6-terra',
  input_tokens: 1384,
  output_tokens: 843,
  cache_read_tokens: 117760,
  cache_creation_tokens: 0,
  input_cost: 0.002768,
  output_cost: 0.010116,
  cache_read_cost: 0.023552,
  cache_creation_cost: 0,
  actual_cost: 0.0510104,
  rate_multiplier: 1.4
}]);
assert.equal(derived['gpt-5.6-terra'].inputPricePer1K, 0.002);
assert.equal(derived['gpt-5.6-terra'].outputPricePer1K, 0.012);
assert.equal(derived['gpt-5.6-terra'].cacheReadPricePer1K, 0.0002);

const twin = [
  { id: 101, api_key_id: 1, model: 'gpt-5.6-sol', input_tokens: 10, output_tokens: 2, actual_cost: 0.006762, created_at: '2026-09-16T05:10:00.000Z' },
  { id: 102, api_key_id: 1, model: 'gpt-5.6-sol', input_tokens: 10, output_tokens: 2, actual_cost: 0.006762, created_at: '2026-09-16T05:10:01.000Z' }
];
const claimed = new Set();
const firstPick = pickExclusiveUpstreamUsageRow(twin, {
  apiKeyId: 1,
  model: 'gpt-5.6-sol',
  usage: {},
  startedAt: Date.parse('2026-09-16T05:10:00.000Z'),
  now: Date.parse('2026-09-16T05:10:02.000Z'),
  preferNewest: true,
  lookbackMs: 180000
}, (id) => {
  const key = String(id);
  if (claimed.has(key)) return false;
  claimed.add(key);
  return true;
});
const secondPick = pickExclusiveUpstreamUsageRow(twin, {
  apiKeyId: 1,
  model: 'gpt-5.6-sol',
  usage: {},
  startedAt: Date.parse('2026-09-16T05:10:00.000Z'),
  now: Date.parse('2026-09-16T05:10:02.000Z'),
  preferNewest: true,
  lookbackMs: 180000,
  usedIds: [...claimed]
}, (id) => {
  const key = String(id);
  if (claimed.has(key)) return false;
  claimed.add(key);
  return true;
});
assert.equal(firstPick.id, 102);
assert.equal(secondPick.id, 101);
assert.notEqual(firstPick.id, secondPick.id);

const dups = findDuplicateUsageCharges([
  { id: 'a', upstreamUsageId: '9', chargedAmount: 0.1, collectedAmount: 0.1, createdAt: '2026-09-16T05:10:00.000Z', status: 'success' },
  { id: 'b', upstreamUsageId: '9', chargedAmount: 0.1, collectedAmount: 0.1, createdAt: '2026-09-16T05:10:01.000Z', status: 'success' },
  { id: 'c', upstreamUsageId: '8', chargedAmount: 0.2, collectedAmount: 0.2, createdAt: '2026-09-16T05:10:00.000Z', status: 'success' }
]);
assert.equal(dups.length, 1);
assert.equal(dups[0].keep.id, 'a');
assert.equal(dups[0].extras.length, 1);
assert.equal(dups[0].extras[0].id, 'b');

console.log('billing-cost.test.mjs: all assertions passed');
