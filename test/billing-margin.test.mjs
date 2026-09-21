import assert from 'node:assert/strict';
import {
  money4,
  hasOfficialUpstream,
  isUpstreamOverCharge,
  overChargeLoss,
  billingCompareRows,
  summarizeBillingCompare,
  noteUpstreamOverCharge,
  scanTodayUpstreamOverCharges,
  dismissBillingAlert,
  openBillingAlerts,
  shanghaiDay
} from '../lib/billing-margin.js';

assert.equal(isUpstreamOverCharge({
  upstreamCost: 0.02,
  chargedAmount: 0.01,
  upstreamCostSource: 'reported'
}), true);
assert.equal(isUpstreamOverCharge({
  upstreamCost: 0.01,
  chargedAmount: 0.02,
  upstreamCostSource: 'reported'
}), false);
assert.equal(isUpstreamOverCharge({
  upstreamCost: 0.02,
  chargedAmount: 0.01,
  upstreamCostSource: 'token_table'
}), false, 'token-table fallback is not official actual_cost');
assert.equal(hasOfficialUpstream({ upstreamCost: 0.02, upstreamCostSource: 'reported' }), true);
assert.equal(overChargeLoss({
  upstreamCost: 0.025,
  chargedAmount: 0.01,
  upstreamCostSource: 'reported'
}), money4(0.015));

const createdAt = new Date().toISOString();
const day = shanghaiDay(createdAt);
const db = {
  users: [{ id: 'u1', username: 'alice' }, { id: 'u2', username: 'bob' }],
  settings: { providers: [{ id: 'grp_g', name: 'Grok' }] },
  logs: [
    {
      id: 'log_ok',
      userId: 'u1',
      providerId: 'grp_g',
      model: 'grok-4.6',
      tokenCost: 0.01,
      chargedAmount: 0.02,
      upstreamCost: 0.011,
      upstreamCostSource: 'reported',
      status: 'success',
      createdAt
    },
    {
      id: 'log_loss',
      userId: 'u2',
      providerId: 'grp_g',
      model: 'grok-4.6',
      tokenCost: 0.008,
      chargedAmount: 0.0088,
      upstreamCost: 0.01,
      upstreamCostSource: 'reported',
      status: 'success',
      createdAt
    },
    {
      id: 'log_table',
      userId: 'u1',
      providerId: 'grp_g',
      tokenCost: 0.01,
      chargedAmount: 0.02,
      upstreamCost: 0.01,
      upstreamCostSource: 'token_table',
      status: 'success',
      createdAt
    }
  ],
  upstreamBills: [
    {
      id: 'bill_extra',
      userId: 'u1',
      providerId: 'grp_g',
      localLogId: 'missing',
      actualCost: 0.05,
      chargedAmount: 0.04,
      createdAt
    }
  ],
  billingAlerts: []
};

const rows = billingCompareRows(db, { day });
assert.equal(rows.length, 4);
assert.equal(rows.filter(isUpstreamOverCharge).length, 2);

const sum = summarizeBillingCompare(db, { day });
assert.equal(sum.invertedCount, 2);
assert.ok(sum.invertedLoss > 0);
const bob = sum.byUser.find((u) => u.userId === 'u2');
assert.equal(bob.invertedCount, 1);
assert.ok(bob.invertedLoss > 0);
assert.ok(bob.chargedAmount < bob.upstreamCost);

const first = noteUpstreamOverCharge(db, db.logs[1], { username: 'bob', providerName: 'Grok' });
assert.equal(first.created, true);
assert.equal(first.alert.count, 1);
const dup = noteUpstreamOverCharge(db, db.logs[1], { username: 'bob' });
assert.equal(dup, null);
const scanned = scanTodayUpstreamOverCharges(db, { day });
assert.equal(scanned.created.length, 0);
assert.equal(first.alert.count, 2, 'unmatched inverted bill is folded into the open daily alert');
assert.equal(openBillingAlerts(db).length, 1);

const dismissed = dismissBillingAlert(db, first.alert.id);
assert.equal(dismissed.status, 'dismissed');
assert.equal(openBillingAlerts(db).length, 0);

console.log('billing-margin tests ok');
