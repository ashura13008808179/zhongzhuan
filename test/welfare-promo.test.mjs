import assert from 'node:assert/strict';
import {
  shanghaiTonightEndIso,
  isWelfareActive,
  stampIssuedCard,
  redeemCreditAmount,
  welfareCreditAmount,
  publicWelfareBanner,
  publicWelfarePromo,
  applyPaymentPlanWelfare,
  clampWelfareMultiplier,
  renderWelfareText
} from '../lib/welfare-promo.js';

const beforeMidnight = new Date('2026-09-16T15:59:59.000Z');
const atMidnight = new Date('2026-09-16T16:00:00.000Z');
assert.equal(shanghaiTonightEndIso(new Date('2026-09-16T07:12:00.000Z')), '2026-09-16T16:00:00.000Z');

const live = { enabled: true, multiplier: 1.1, expiresAt: '2026-09-16T16:00:00.000Z', text: '', images: [] };
assert.equal(isWelfareActive(live, beforeMidnight), true);
assert.equal(isWelfareActive(live, atMidnight), false);
assert.equal(isWelfareActive({ ...live, enabled: false }, beforeMidnight), false);

assert.equal(welfareCreditAmount(10, 1.1), 11);
assert.equal(welfareCreditAmount(10, 2), 20);
assert.equal(welfareCreditAmount(30, 1.1), 33);
assert.equal(clampWelfareMultiplier(0.5), 1);

const stamped = stampIssuedCard({ amount: 10, code: 'R10-A' }, live, beforeMidnight);
assert.equal(stamped.creditAmount, 11);
assert.equal(stamped.welfareMultiplier, 1.1);
assert.equal(stamped.amount, 10);
assert.equal(redeemCreditAmount(stamped), 11);

const afterHours = stampIssuedCard({ amount: 10 }, live, atMidnight);
assert.equal(afterHours.creditAmount, 10);
assert.equal(redeemCreditAmount({ amount: 10 }), 10);
assert.equal(redeemCreditAmount({ amount: 10, creditAmount: 20 }), 20);

const banner = publicWelfareBanner(live, beforeMidnight);
assert.ok(banner);
assert.match(banner.text, /1\.1/);
assert.match(banner.text, /11/);
assert.equal(banner.multiplier, undefined);
assert.equal(publicWelfareBanner(live, atMidnight), null);
assert.equal(publicWelfarePromo({ ...live, enabled: false }, beforeMidnight), null);

const plans = applyPaymentPlanWelfare([{ amount: 10, label: '¥10' }, { amount: 100, label: '¥100' }], live, beforeMidnight);
assert.equal(plans[0].creditAmount, 11);
assert.equal(plans[1].creditAmount, 110);
assert.equal(plans[0].welfareActive, true);

const plain = applyPaymentPlanWelfare([{ amount: 10 }], live, atMidnight);
assert.equal(plain[0].creditAmount, 10);
assert.equal(plain[0].welfareActive, false);

assert.match(renderWelfareText('付10得{ten}', 2), /付10得20/);

console.log('welfare-promo.test.mjs: all assertions passed');
