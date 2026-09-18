import assert from 'node:assert/strict';
import { liveChargeDelta, applyLiveMoneyCharge, applyLiveMoneyRefund, settleRemainder, parkPendingHold, releasePendingHold, LIVE_POLL_INTERVAL_MS, exactUserCharge, liveBillTarget } from '../lib/live-billing.js';

assert.equal(LIVE_POLL_INTERVAL_MS, 500);

assert.equal(liveChargeDelta(0, 1.3954, 1.5), 1.3954 * 1.5);
assert.equal(liveChargeDelta(0.5, 0.5, 1.5), 0);
assert.equal(liveChargeDelta(0.8, 0.5, 1.5), 0);
assert.equal(liveChargeDelta(0.2, 0.5, 2.5), 0.3 * 2.5);

const user = { balance: 10, reservedBalance: 2 };
const key = { spendUsed: 0, reservedSpend: 2 };
const reservation = { amountReservation: 2 };
const first = applyLiveMoneyCharge(user, key, 0.75, reservation, false);
assert.equal(first.applied, 0.75);
assert.equal(user.balance, 9.25);
assert.equal(user.reservedBalance, 1.25);
assert.equal(reservation.amountReservation, 1.25);
assert.equal(key.spendUsed, 0.75);
assert.equal(first.broke, false);

const second = applyLiveMoneyCharge(user, key, 1.25, reservation, false);
assert.equal(second.applied, 1.25);
assert.equal(reservation.amountReservation, 0);
assert.equal(user.reservedBalance, 0);
assert.equal(user.balance, 8);

const poor = { balance: 0.2, reservedBalance: 0 };
const last = applyLiveMoneyCharge(poor, null, 0.2, { amountReservation: 0 }, false);
assert.equal(last.broke, true);
assert.equal(last.applied, 0.2);
assert.equal(poor.balance, 0);

const short = { balance: 0.4, reservedBalance: 0 };
const clipped = applyLiveMoneyCharge(short, null, 2.5, { amountReservation: 0 }, false);
assert.equal(clipped.applied, 0.4);
assert.equal(clipped.broke, true);
assert.equal(short.balance, 0);

assert.equal(exactUserCharge(1.3954, 1.5), 1.3954 * 1.5);
assert.equal(exactUserCharge(0.0115836, 2.5), 0.0115836 * 2.5);
assert.equal(exactUserCharge(0, 2.5), 0);
assert.equal(liveChargeDelta(0, 1.3954, 1.5), exactUserCharge(1.3954, 1.5));

const admin = { balance: 1, reservedBalance: 0 };
applyLiveMoneyCharge(admin, null, 9, { amountReservation: 0 }, true);
assert.equal(admin.balance, 1);

assert.equal(settleRemainder(2.0931, 0.75), 2.0931 - 0.75);
assert.equal(settleRemainder(1, 1), 0);
assert.equal(settleRemainder(1, 1.2), 0);

const parked = { pendingActualHold: 0 };
const parkedKey = { pendingActualHold: 0 };
assert.equal(parkPendingHold(parked, parkedKey, 1.25), 1.25);
assert.equal(parked.pendingActualHold, 1.25);
assert.equal(parkedKey.pendingActualHold, 1.25);
releasePendingHold(parked, parkedKey, 0.25);
assert.equal(parked.pendingActualHold, 1);
assert.equal(parkedKey.pendingActualHold, 1);

assert.equal(liveBillTarget(1, 9, 1.1), 9 * 1.1);
assert.equal(liveBillTarget(0.50379672, 0.01, 1.1), 0.01 * 1.1);
assert.equal(liveBillTarget(0, 1, 2), 2);
assert.equal(liveBillTarget(0, 0, 2), 0);

const refundUser = { balance: 8 };
const refundKey = { spendUsed: 3 };
assert.equal(applyLiveMoneyRefund(refundUser, refundKey, 1.25), 1.25);
assert.equal(refundUser.balance, 9.25);
assert.equal(refundKey.spendUsed, 1.75);
assert.equal(applyLiveMoneyRefund({ balance: 1 }, null, 2, true), 0);

console.log('live-billing.test.mjs: all assertions passed');
