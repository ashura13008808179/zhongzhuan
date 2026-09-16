import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECKIN_MIN,
  CHECKIN_MAX,
  CHECKIN_AMOUNTS,
  CHECKIN_TIMEZONE,
  CHECKIN_LOG_STATUS,
  sampleCheckInReward,
  theoreticalCheckInMean,
  checkInRewardWeights,
  shanghaiDate,
  shanghaiHourMinute,
  rechargeDeskOpen,
  publicRechargeHours,
  RECHARGE_DESK_START_MIN,
  RECHARGE_DESK_END_MIN,
  addDaysYmd,
  checkInStreak,
  claimCheckIn,
  checkInStatus,
  checkInAdminStats,
  money2
} from '../lib/checkin.js';

test('reward amounts are 0.05–0.50 inclusive with 2 decimals', () => {
  assert.equal(CHECKIN_AMOUNTS[0], 0.05);
  assert.equal(CHECKIN_AMOUNTS[CHECKIN_AMOUNTS.length - 1], 0.5);
  assert.equal(CHECKIN_AMOUNTS.length, 46);
  for (const x of CHECKIN_AMOUNTS) {
    assert.ok(x >= CHECKIN_MIN && x <= CHECKIN_MAX);
    assert.equal(money2(x), x);
  }
});

test('theoretical mean of inverse-power weights is ≈ 0.1', () => {
  const mean = theoreticalCheckInMean();
  assert.ok(Math.abs(mean - 0.1) < 1e-9, `mean=${mean}`);
  const weights = checkInRewardWeights();
  const pMin = weights[0].weight;
  const pMax = weights[weights.length - 1].weight;
  assert.ok(pMin > pMax * 50, 'low amounts must be much more likely');
  assert.ok(pMax < 0.01, '0.50 should be rare');
});

test('Monte Carlo samples average near 0.1 and stay in range', () => {
  const n = 80000;
  let sum = 0;
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const x = sampleCheckInReward();
    assert.ok(x >= CHECKIN_MIN && x <= CHECKIN_MAX);
    assert.equal(money2(x), x);
    seen.add(x);
    sum += x;
  }
  const mean = sum / n;
  assert.ok(Math.abs(mean - 0.1) < 0.005, `empirical mean ${mean}`);
  assert.ok(seen.has(0.05), 'should occasionally hit the minimum');
});

test('shanghaiDate uses Asia/Shanghai YYYY-MM-DD', () => {
  const utcMorning = new Date('2026-09-13T01:00:00.000Z'); // 09:00 CST
  const utcPrev = new Date('2026-09-12T16:30:00.000Z'); // 00:30 CST on 13th
  const utcStill12th = new Date('2026-09-12T15:30:00.000Z'); // 23:30 CST on 12th
  assert.equal(shanghaiDate(utcMorning), '2026-09-13');
  assert.equal(shanghaiDate(utcPrev), '2026-09-13');
  assert.equal(shanghaiDate(utcStill12th), '2026-09-12');
  assert.equal(CHECKIN_TIMEZONE, 'Asia/Shanghai');
  assert.match(shanghaiDate(), /^\d{4}-\d{2}-\d{2}$/);
});

test('recharge desk is open 08:30–23:30 Asia/Shanghai inclusive', () => {
  const openStart = new Date('2026-09-16T00:30:00.000Z'); // 08:30 CST
  const before = new Date('2026-09-16T00:29:00.000Z'); // 08:29 CST
  const openEnd = new Date('2026-09-16T15:30:00.000Z'); // 23:30 CST
  const after = new Date('2026-09-16T15:31:00.000Z'); // 23:31 CST
  const midnight = new Date('2026-09-16T16:00:00.000Z'); // 00:00 CST next day
  assert.equal(RECHARGE_DESK_START_MIN, 510);
  assert.equal(RECHARGE_DESK_END_MIN, 1410);
  assert.deepEqual(shanghaiHourMinute(openStart), { hour: 8, minute: 30, minutes: 510 });
  assert.equal(rechargeDeskOpen(openStart), true);
  assert.equal(rechargeDeskOpen(before), false);
  assert.equal(rechargeDeskOpen(openEnd), true);
  assert.equal(rechargeDeskOpen(after), false);
  assert.equal(rechargeDeskOpen(midnight), false);
  const closed = publicRechargeHours(before);
  assert.equal(closed.timezone, 'Asia/Shanghai');
  assert.equal(closed.start, '08:30');
  assert.equal(closed.end, '23:30');
  assert.equal(closed.open, false);
  assert.match(closed.closedMessage, /8:30/);
  assert.equal(publicRechargeHours(openStart).open, true);
});

test('addDaysYmd walks calendar dates', () => {
  assert.equal(addDaysYmd('2026-03-01', -1), '2026-02-28');
  assert.equal(addDaysYmd('2024-03-01', -1), '2024-02-29');
  assert.equal(addDaysYmd('2026-12-31', 1), '2027-01-01');
});

test('streak counts consecutive Shanghai days', () => {
  const rows = [
    { userId: 'u1', date: '2026-09-13' },
    { userId: 'u1', date: '2026-09-12' },
    { userId: 'u1', date: '2026-09-11' },
    { userId: 'u1', date: '2026-09-09' },
    { userId: 'u2', date: '2026-09-13' }
  ];
  assert.equal(checkInStreak(rows, 'u1', '2026-09-13'), 3);
  assert.equal(checkInStreak(rows, 'u1', '2026-09-14'), 3);
  assert.equal(checkInStreak(rows, 'u1', '2026-09-15'), 0);
  assert.equal(checkInStreak(rows, 'u2', '2026-09-13'), 1);
  assert.equal(checkInStreak([], 'u1', '2026-09-13'), 0);
});

test('claimCheckIn credits balance once per day and logs source', () => {
  const user = { id: 'usr_a', balance: 1.2, bonusBalance: 3.3, checkInBonus: 0, accountActive: false };
  const db = { checkIns: [], logs: [] };
  const first = claimCheckIn(db, user, { date: '2026-09-13', rng: () => 0, now: new Date('2026-09-13T08:00:00+08:00') });
  assert.equal(first.ok, true);
  assert.equal(first.alreadyCheckedIn, false);
  assert.equal(first.amount, 0.05);
  assert.equal(user.balance, 1.25);
  assert.equal(user.checkInBonus, 0.05);
  assert.equal(user.bonusBalance, 3.3);
  assert.equal(user.accountActive, true);
  assert.equal(db.checkIns.length, 1);
  assert.equal(db.logs[0].status, CHECKIN_LOG_STATUS);
  assert.equal(db.logs[0].chargedAmount, -0.05);

  const again = claimCheckIn(db, user, { date: '2026-09-13', rng: () => 0 });
  assert.equal(again.ok, false);
  assert.equal(again.status, 409);
  assert.equal(again.alreadyCheckedIn, true);
  assert.equal(user.balance, 1.25);
  assert.equal(db.checkIns.length, 1);
  assert.match(again.error, /今日已签到/);

  const nextDay = claimCheckIn(db, user, { date: '2026-09-14', rng: () => 1 });
  assert.equal(nextDay.ok, true);
  assert.equal(nextDay.amount, 0.5);
  assert.equal(user.balance, 1.75);
  assert.equal(user.checkInBonus, 0.55);
});

test('checkInStatus and admin stats summarize records', () => {
  const user = { id: 'usr_b', balance: 0, bonusBalance: 0, checkInBonus: 0, username: 'bob', email: 'b@x.com' };
  const db = { checkIns: [], logs: [], users: [user] };
  claimCheckIn(db, user, { date: '2026-09-12', rng: () => 0, now: new Date('2026-09-12T10:00:00+08:00') });
  claimCheckIn(db, user, { date: '2026-09-13', rng: () => 0, now: new Date('2026-09-13T10:00:00+08:00') });
  const status = checkInStatus(db, user, { date: '2026-09-13' });
  assert.equal(status.checkedInToday, true);
  assert.equal(status.todayAmount, 0.05);
  assert.equal(status.streak, 2);
  assert.equal(status.recent.length, 2);
  assert.equal(status.timezone, 'Asia/Shanghai');

  const empty = checkInStatus(db, user, { date: '2026-09-14' });
  assert.equal(empty.checkedInToday, false);
  assert.equal(empty.todayAmount, undefined);

  const admin = checkInAdminStats(db, { date: '2026-09-13' });
  assert.equal(admin.today.users, 1);
  assert.equal(admin.today.amount, 0.05);
  assert.equal(admin.totals.records, 2);
  assert.equal(admin.recent[0].username, 'bob');
});
