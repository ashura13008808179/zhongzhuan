import assert from 'node:assert/strict';
import { cloneDbValue, rebaseDbSnapshot, snapshotDbForRebase } from '../lib/db-rebase.js';

const close = (actual, expected) => assert.ok(Math.abs(Number(actual) - expected) < 1e-12, `${actual} !== ${expected}`);

const initial = {
  users: [{
    id: 'usr_concurrent', balance: 10, reservedBalance: 0, reservedTokens: 0,
    apiKeys: [{ id: 'key_concurrent', spendUsed: 0, reservedSpend: 0, reservedTokens: 0 }]
  }],
  logs: [],
  upstreamBills: [],
  auditLogs: [],
  siteErrors: [],
  sessions: {},
  settings: { providers: [{ id: 'grp_test', health: { ok: true } }] },
  paymentOrders: [],
  checkIns: []
};

// Two requests reserve money from the same original on-disk snapshot.
const firstReserve = cloneDbValue(initial);
const secondReserve = cloneDbValue(initial);
const firstBase = snapshotDbForRebase(firstReserve);
const secondBase = snapshotDbForRebase(secondReserve);
for (const db of [firstReserve, secondReserve]) {
  const user = db.users[0];
  const key = user.apiKeys[0];
  user.reservedBalance += 0.004;
  user.reservedTokens += 4;
  key.reservedSpend += 0.004;
  key.reservedTokens += 4;
}

let committed = rebaseDbSnapshot(firstBase, firstReserve, initial, { logCap: 3000 });
const firstAfterReserve = snapshotDbForRebase(committed);
committed = rebaseDbSnapshot(secondBase, secondReserve, committed, { logCap: 3000 });
const secondAfterReserve = snapshotDbForRebase(committed);
const secondRequestSnapshot = cloneDbValue(committed);
close(committed.users[0].reservedBalance, 0.008);
close(committed.users[0].apiKeys[0].reservedSpend, 0.008);

// Each request then settles from its own snapshot. The second completion must
// preserve the first completion's charge while releasing only its own hold.
const firstSettled = cloneDbValue(firstReserve);
firstSettled.users[0].balance -= 0.0013;
firstSettled.users[0].reservedBalance -= 0.004;
firstSettled.users[0].apiKeys[0].spendUsed += 0.0013;
firstSettled.users[0].apiKeys[0].reservedSpend -= 0.004;
firstSettled.logs.unshift({ id: 'log_first', chargedAmount: 0.0013 });
committed = rebaseDbSnapshot(firstAfterReserve, firstSettled, committed, { logCap: 3000 });

const secondSettled = cloneDbValue(secondRequestSnapshot);
secondSettled.users[0].balance -= 0.0014;
secondSettled.users[0].reservedBalance -= 0.004;
secondSettled.users[0].apiKeys[0].spendUsed += 0.0014;
secondSettled.users[0].apiKeys[0].reservedSpend -= 0.004;
secondSettled.logs.unshift({ id: 'log_second', chargedAmount: 0.0014 });
committed = rebaseDbSnapshot(secondAfterReserve, secondSettled, committed, { logCap: 3000 });

const user = committed.users[0];
close(user.balance, 9.9973);
close(user.reservedBalance, 0);
close(user.apiKeys[0].spendUsed, 0.0027);
close(user.apiKeys[0].reservedSpend, 0);
assert.deepEqual(committed.logs.map((row) => row.id).sort(), ['log_first', 'log_second']);

// A background ledger bill added between the two writes must not be removed.
const stale = cloneDbValue(initial);
const staleBase = snapshotDbForRebase(stale);
stale.logs.unshift({ id: 'log_request' });
const latest = cloneDbValue(initial);
latest.upstreamBills.push({ id: 'vip1129:usage-background' });
const merged = rebaseDbSnapshot(staleBase, stale, latest, { logCap: 3000 });
assert.equal(merged.logs.length, 1);
assert.equal(merged.upstreamBills.length, 1);

const modelBaseDb = {
  users: [{
    id: 'usr_models',
    apiKeys: [{ id: 'key_models', groupId: 'grp_gpt_mix', models: ['gpt-5.6-sol', 'gpt-5.6-terra'] }]
  }],
  logs: [],
  upstreamBills: [],
  auditLogs: [],
  siteErrors: [],
  sessions: {},
  settings: {},
  paymentOrders: [],
  checkIns: []
};
const modelNext = cloneDbValue(modelBaseDb);
modelNext.users[0].apiKeys[0].models = ['gpt-5.6-terra', 'gpt-5.6-sol'];
const modelMerged = rebaseDbSnapshot(snapshotDbForRebase(modelBaseDb), modelNext, modelBaseDb, { logCap: 3000 });
assert.deepEqual(modelMerged.users[0].apiKeys[0].models, ['gpt-5.6-terra', 'gpt-5.6-sol']);

console.log('db-rebase.test.mjs: all assertions passed');
