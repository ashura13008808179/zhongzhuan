import assert from 'node:assert/strict';
import {
  pushPaymentEvent,
  waitForEvents,
  currentSeq,
  publicPaymentEvent,
  clampWaitMs,
  __resetPaymentEventsForTests
} from '../lib/payment-events.js';

__resetPaymentEventsForTests();
assert.equal(currentSeq(), 0);

const seq0 = currentSeq();
const waiter = waitForEvents(seq0 || 0, { timeoutMs: 2000 });
await new Promise(r => setTimeout(r, 20));
const placed = pushPaymentEvent({
  kind: 'placed',
  orderId: 'o1',
  userId: 'u1',
  username: 'bob',
  amount: 10,
  method: 'wechat',
  payNote: 'bob',
  status: 'awaiting_payment'
});
const got = await waiter;
assert.equal(got.length, 1);
assert.equal(got[0].orderId, 'o1');
assert.equal(got[0].kind, 'placed');
assert.equal(placed.seq, 1);

const hidden = publicPaymentEvent(placed, { includeCode: false });
assert.equal('code' in hidden, false);

const paidWait = waitForEvents(currentSeq(), { timeoutMs: 2000 });
await new Promise(r => setTimeout(r, 20));
pushPaymentEvent({
  kind: 'paid',
  orderId: 'o1',
  userId: 'u1',
  amount: 10,
  status: 'pending'
});
const paid = await paidWait;
assert.equal(paid[0].kind, 'paid');
assert.equal(paid[0].orderId, 'o1');

const otherWait = waitForEvents(currentSeq(), { userId: 'u2', timeoutMs: 250 });
pushPaymentEvent({
  kind: 'confirmed',
  orderId: 'o1',
  userId: 'u1',
  amount: 10,
  status: 'confirmed',
  code: 'SECRET-CODE'
});
const other = await otherWait;
assert.equal(other.length, 0);

const mine = await waitForEvents(paid[0].seq, { userId: 'u1', timeoutMs: 250 });
assert.equal(mine.length, 1);
assert.equal(mine[0].kind, 'confirmed');
const shown = publicPaymentEvent(mine[0], { includeCode: true });
assert.equal(shown.code, 'SECRET-CODE');
const adminView = publicPaymentEvent(mine[0], { includeCode: false });
assert.equal('code' in adminView, false);

const firstSync = await waitForEvents(-1, { timeoutMs: 200 });
assert.equal(firstSync.length, 0, 'after=-1 must not replay history as new notifications');

assert.equal(clampWaitMs(50), 200);
assert.equal(clampWaitMs(999999), 28000);
assert.equal(clampWaitMs('x'), 25000);

console.log('payment-events.test.mjs: all assertions passed');
