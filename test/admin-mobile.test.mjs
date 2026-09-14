import assert from 'node:assert/strict';
import { parseUpstreamAccount, publicOrder, buildMobileInbox } from '../lib/admin-mobile.js';

const account = parseUpstreamAccount({
  code: 0,
  data: { email: 'a@b.com', balance: 12.34567, frozen_balance: 1.2, concurrency: 5, status: 'active' }
});
assert.equal(account.ok, true);
assert.equal(account.balance, 12.3457);
assert.equal(account.frozenBalance, 1.2);
assert.equal(account.concurrency, 5);

const order = publicOrder({
  id: 'pay_1', userId: 'u1', username: 'bob', amount: 10, method: 'wechat',
  status: 'pending', payNote: 'ABC', code: 'SECRET', createdAt: '2026-01-01T00:00:00.000Z'
});
assert.equal(order.code, null);
assert.equal(order.payNote, 'ABC');

const confirmed = publicOrder({ id: 'pay_2', status: 'confirmed', code: 'R10-OK', amount: 10 });
assert.equal(confirmed.code, 'R10-OK');

const inbox = buildMobileInbox({
  paymentOrders: [
    { id: 'a', status: 'pending', amount: 10, username: 'x' },
    { id: 'b', status: 'awaiting_payment', amount: 30 },
    { id: 'c', status: 'confirmed', amount: 10, code: 'R10-Z' }
  ],
  settings: {
    providers: [
      { id: 'g1', name: 'G1', enabled: true, health: { ok: false, lastError: '401' } }
    ],
    lastDiagnostics: { at: '2026-01-01T00:00:00.000Z', summary: { failed: 2 } }
  }
});
assert.equal(inbox.pendingCount, 1);
assert.equal(inbox.awaitingCount, 1);
assert.deepEqual(inbox.notifyIds, ['a']);
assert.equal(inbox.providers[0].healthOk, false);
assert.equal(inbox.diagnostics.summary.failed, 2);

console.log('admin-mobile.test.mjs: all assertions passed');
