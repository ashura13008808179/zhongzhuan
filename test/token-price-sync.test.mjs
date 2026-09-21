import assert from 'node:assert/strict';
import {
  nextTokenPriceSyncAt,
  shanghaiWallDate,
  msUntilNextTokenPriceSync,
  applyUsagePricesToProviders,
  recentUsageRows,
  TOKEN_PRICE_RETRY_MS
} from '../lib/token-price-sync.js';
import { applyChannelModelPrices } from '../lib/calibrate-prices.js';
import { catalogPrice } from '../lib/upstream-prices.js';

assert.equal(TOKEN_PRICE_RETRY_MS, 5 * 60 * 1000);

const beforeNoon = new Date('2026-09-18T02:00:00.000Z'); // 上海 10:00
assert.equal(
  nextTokenPriceSyncAt(beforeNoon).toISOString(),
  shanghaiWallDate('2026-09-18', 12, 0).toISOString()
);

const exactlyNoon = new Date('2026-09-18T04:00:00.000Z'); // 上海 12:00
assert.equal(
  nextTokenPriceSyncAt(exactlyNoon).toISOString(),
  shanghaiWallDate('2026-09-19', 0, 0).toISOString()
);

const afterNoon = new Date('2026-09-18T05:00:00.000Z'); // 上海 13:00
assert.equal(
  nextTokenPriceSyncAt(afterNoon).toISOString(),
  shanghaiWallDate('2026-09-19', 0, 0).toISOString()
);

const lateNight = new Date('2026-09-18T15:59:00.000Z'); // 上海 23:59
assert.equal(
  nextTokenPriceSyncAt(lateNight).toISOString(),
  shanghaiWallDate('2026-09-19', 0, 0).toISOString()
);

assert.ok(msUntilNextTokenPriceSync(beforeNoon) > 0);
assert.ok(msUntilNextTokenPriceSync(beforeNoon) < 3 * 60 * 60 * 1000);

const provider = {
  id: 'bei',
  name: 'BEI',
  defaultModel: 'gpt',
  models: ['gpt', 'claude'],
  modelPrices: {
    gpt: { inputPricePer1K: 3, outputPricePer1K: 4 },
    claude: { inputPricePer1K: 1, outputPricePer1K: 2 }
  }
};
const measured = {
  gpt: { inputPricePer1K: 0.02, outputPricePer1K: 0.08, samples: 4 }
};
const first = applyChannelModelPrices(provider, measured, null, { keepExisting: true });
assert.ok(first.kept.includes('claude'));
assert.equal(provider.modelPrices.gpt.inputPricePer1K, 0.02);
assert.equal(provider.modelPrices.gpt.outputPricePer1K, 0.08);
assert.equal(provider.modelPrices.claude.inputPricePer1K, 1);
assert.equal(provider.modelPrices.claude.outputPricePer1K, 2);

const empty = {
  id: 'new',
  defaultModel: 'gpt-5.4',
  models: ['gpt-5.4'],
  modelPrices: {}
};
const catalogFill = applyChannelModelPrices(empty, {}, { 'gpt-5.4': { inputPricePer1K: 0.005, outputPricePer1K: 0.03 } }, { keepExisting: true });
assert.equal(empty.modelPrices['gpt-5.4'].source, 'catalog');
assert.ok(catalogFill.assigned.some((row) => row.model === 'gpt-5.4'));

const vip = {
  id: 'vip',
  name: 'VIP',
  upstreamSync: 'vip1129',
  defaultModel: 'claude',
  models: ['claude'],
  modelPrices: { claude: { inputPricePer1K: 1.11, outputPricePer1K: 2.22 } }
};
const bei = {
  id: 'bei2',
  name: 'BEI2',
  upstreamSync: 'beibeihai',
  defaultModel: 'gpt',
  models: ['gpt', 'kimi'],
  modelPrices: {
    gpt: { inputPricePer1K: 3, outputPricePer1K: 4 },
    kimi: { inputPricePer1K: 0.5, outputPricePer1K: 0.6 }
  }
};
const out = applyUsagePricesToProviders({
  providers: [vip, bei],
  users: [],
  vipUsage: [{ model: 'claude', input_tokens: 1000, output_tokens: 1000, input_cost: 9, output_cost: 9 }],
  beiUsage: [{ model: 'gpt', input_tokens: 1000, output_tokens: 1000, input_cost: 0.02, output_cost: 0.08 }],
  vipOk: false,
  beiOk: true
});
assert.deepEqual(out.failedIds, ['vip']);
assert.equal(vip.modelPrices.claude.inputPricePer1K, 1.11, 'failed fetch must keep last table');
assert.equal(bei.modelPrices.gpt.inputPricePer1K, 0.02);
assert.equal(bei.modelPrices.kimi.inputPricePer1K, 0.5, 'unsampled models keep last price');

assert.equal(catalogPrice('deepseek-v4-flash').inputPricePer1K, 0.00015);
assert.equal(catalogPrice('deepseek-v4-flash').outputPricePer1K, 0.0006);
assert.equal(catalogPrice('grok-4.6').inputPricePer1K, 0.002473);
assert.equal(catalogPrice('grok-4.6').outputPricePer1K, 0.0066);
assert.equal(catalogPrice('grok-4.6').cacheReadPricePer1K, 0.0003709);

const now = Date.parse('2026-09-18T10:30:00.000Z');
const mixed = recentUsageRows([
  { model: 'deepseek-v4-flash', created_at: '2026-09-01T00:00:00.000Z', input_tokens: 1000, input_cost: 0.003, output_tokens: 1000, output_cost: 0.009 },
  { model: 'deepseek-v4-flash', created_at: '2026-09-18T10:10:00.000Z', input_tokens: 35, input_cost: 0.00000525, output_tokens: 32, output_cost: 0.0000192 }
], now);
assert.equal(mixed.length, 1);
assert.equal(mixed[0].input_cost, 0.00000525);

const ds = {
  id: 'grp_deepseek',
  name: 'DeepSeek',
  upstreamSync: 'beibeihai',
  defaultModel: 'deepseek-v4-flash',
  models: ['deepseek-v4-flash'],
  modelPrices: { 'deepseek-v4-flash': { inputPricePer1K: 0.00015, outputPricePer1K: 0.0006 } }
};
const stale = applyUsagePricesToProviders({
  providers: [ds],
  users: [],
  vipUsage: [],
  beiUsage: [{
    model: 'deepseek-v4-flash',
    created_at: '2026-09-01T00:00:00.000Z',
    input_tokens: 1000,
    output_tokens: 1000,
    input_cost: 0.003,
    output_cost: 0.009
  }],
  vipOk: true,
  beiOk: true
});
assert.equal(ds.modelPrices['deepseek-v4-flash'].inputPricePer1K, 0.00015, 'stale DeepSeek bills must not restore old table');
assert.equal(stale.results[0].keptModels.includes('deepseek-v4-flash'), true);

console.log('token-price-sync.test.mjs: all assertions passed');
