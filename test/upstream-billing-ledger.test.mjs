import assert from 'node:assert/strict';
import {
  upstreamUsageId,
  upstreamUsageApiKeyId,
  upstreamUsageCreatedAt,
  upstreamUsageCost,
  upstreamUsageTokens,
  upstreamBillId,
  usagePageHasMore
} from '../lib/upstream-billing-ledger.js';

const row = {
  id: 12196565,
  api_key_id: 6178,
  created_at: '2026-09-16T09:55:38.422356+08:00',
  actual_cost: '0.067998',
  input_tokens: 4245,
  cache_read_tokens: 142080,
  cache_creation_tokens: 512,
  output_tokens: 972
};

assert.equal(upstreamUsageId(row), '12196565');
assert.equal(upstreamUsageApiKeyId(row), '6178');
assert.equal(upstreamUsageCreatedAt(row), '2026-09-16T01:55:38.422Z');
assert.equal(upstreamUsageCost(row), 0.067998);
assert.equal(upstreamBillId('vip1129', row), 'vip1129:12196565');
assert.deepEqual(upstreamUsageTokens(row), {
  promptTokens: 146837,
  completionTokens: 972,
  totalTokens: 147809,
  cacheReadTokens: 142080,
  cacheWriteTokens: 512
});
assert.equal(upstreamUsageCost({ actual_cost: -1 }), 0);
assert.equal(upstreamBillId('vip1129', {}), '');
assert.equal(usagePageHasMore([1, 2], 2), true);
assert.equal(usagePageHasMore([1], 2), false);

console.log('upstream-billing-ledger.test.mjs: all assertions passed');
