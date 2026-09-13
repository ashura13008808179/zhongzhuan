/**
 * Daily check-in (签到) helpers.
 *
 * Calendar day is always Asia/Shanghai, formatted as YYYY-MM-DD.
 * Reward: discrete 0.05–0.50 (inclusive, 2 decimals), inverse-power weights
 * w(x) ∝ x^{-α} with α chosen so the exact discrete mean is 0.10.
 * Higher amounts are rarer (P(0.05)≈26%, P(≥0.30)≈3.7%, P(0.50)≈0.09%).
 * Credits go to user.balance; cumulative check-in total is user.checkInBonus.
 * Invite rebates stay on bonusBalance and are not touched.
 */

import crypto from 'node:crypto';

export const CHECKIN_MIN = 0.05;
export const CHECKIN_MAX = 0.5;
export const CHECKIN_TIMEZONE = 'Asia/Shanghai';
export const CHECKIN_HISTORY_CAP = 20000;
export const CHECKIN_LOG_STATUS = 'checkin_bonus';

/** Inverse-power exponent: discrete mean over {0.05,…,0.50} is 0.10. */
export const CHECKIN_WEIGHT_ALPHA = 2.4411081100593037;

export const CHECKIN_AMOUNTS = Object.freeze(
  Array.from({ length: 46 }, (_, i) => Math.round((CHECKIN_MIN + i * 0.01) * 100) / 100)
);

function buildWeights() {
  const raw = CHECKIN_AMOUNTS.map((x) => 1 / Math.pow(x, CHECKIN_WEIGHT_ALPHA));
  const total = raw.reduce((sum, w) => sum + w, 0);
  const cumulative = [];
  let acc = 0;
  for (const w of raw) {
    acc += w / total;
    cumulative.push(acc);
  }
  cumulative[cumulative.length - 1] = 1;
  return { raw, total, cumulative };
}

const WEIGHTS = buildWeights();

export function checkInRewardWeights() {
  return CHECKIN_AMOUNTS.map((amount, i) => ({
    amount,
    weight: WEIGHTS.raw[i] / WEIGHTS.total
  }));
}

export function theoreticalCheckInMean() {
  return checkInRewardWeights().reduce((sum, x) => sum + x.amount * x.weight, 0);
}

function defaultRng() {
  return crypto.randomInt(0, 2 ** 48) / 2 ** 48;
}

/**
 * Sample a skewed check-in reward. Pass rng() → [0,1) for tests.
 */
export function sampleCheckInReward(rng = defaultRng) {
  const u = Number(rng());
  const pick = Number.isFinite(u) ? Math.min(Math.max(u, 0), 0.999999999999) : defaultRng();
  const idx = WEIGHTS.cumulative.findIndex((c) => pick < c);
  return CHECKIN_AMOUNTS[idx < 0 ? CHECKIN_AMOUNTS.length - 1 : idx];
}

export function shanghaiDate(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: CHECKIN_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return fmt.format(date);
}

export function addDaysYmd(ymd, delta) {
  const [y, m, d] = String(ymd || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  const dt = new Date(Date.UTC(y, m - 1, d + Number(delta || 0)));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function money2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function findUserCheckIn(checkIns, userId, date) {
  return (checkIns || []).find((r) => r.userId === userId && r.date === date) || null;
}

export function userCheckIns(checkIns, userId) {
  return (checkIns || [])
    .filter((r) => r.userId === userId)
    .slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.at).localeCompare(String(a.at)));
}

/**
 * Consecutive Shanghai days ending at today if checked in today,
 * otherwise ending at yesterday (streak still counts until the day is missed).
 */
export function checkInStreak(checkIns, userId, today) {
  const dates = new Set(
    (checkIns || []).filter((r) => r.userId === userId).map((r) => r.date)
  );
  let cursor = dates.has(today) ? today : addDaysYmd(today, -1);
  let streak = 0;
  while (cursor && dates.has(cursor)) {
    streak += 1;
    cursor = addDaysYmd(cursor, -1);
  }
  return streak;
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(7).toString('hex')}`;
}

export function publicCheckInRecord(record) {
  if (!record) return null;
  return {
    date: record.date,
    amount: Number(record.amount) || 0,
    at: record.at
  };
}

/**
 * Claim today's reward. Mutates db/user; caller persists.
 */
export function claimCheckIn(db, user, opts = {}) {
  if (!user) return { ok: false, error: '未登录', status: 401 };
  const now = opts.now instanceof Date ? opts.now : new Date();
  const date = opts.date || shanghaiDate(now);
  const rng = typeof opts.rng === 'function' ? opts.rng : defaultRng;
  const id = typeof opts.id === 'function' ? opts.id : makeId;
  db.checkIns ??= [];

  const existing = findUserCheckIn(db.checkIns, user.id, date);
  if (existing) {
    return {
      ok: false,
      status: 409,
      error: '今日已签到，请明天再来',
      alreadyCheckedIn: true,
      date,
      amount: Number(existing.amount) || 0,
      balance: money2(user.balance)
    };
  }

  const amount = money2(sampleCheckInReward(rng));
  const clamped = Math.min(CHECKIN_MAX, Math.max(CHECKIN_MIN, amount));
  user.balance = money2((user.balance || 0) + clamped);
  user.checkInBonus = money2((user.checkInBonus || 0) + clamped);
  if ((user.balance || 0) > 0) user.accountActive = true;

  const at = now.toISOString();
  const record = {
    id: id('cin'),
    userId: user.id,
    date,
    amount: clamped,
    at,
    source: 'daily_checkin'
  };
  db.checkIns.unshift(record);
  db.checkIns = db.checkIns.slice(0, CHECKIN_HISTORY_CAP);

  db.logs ??= [];
  db.logs.unshift({
    id: id('log'),
    userId: user.id,
    model: 'checkin',
    tokens: 0,
    billedTokens: 0,
    upstreamCost: 0,
    chargedAmount: -clamped,
    multiplier: 1,
    latency: 0,
    status: CHECKIN_LOG_STATUS,
    detail: { amount: clamped, date, source: 'daily_checkin' },
    createdAt: at
  });
  db.logs = db.logs.slice(0, 3000);

  return {
    ok: true,
    status: 200,
    alreadyCheckedIn: false,
    date,
    amount: clamped,
    balance: user.balance,
    record
  };
}

export function checkInStatus(db, user, opts = {}) {
  if (!user) return { ok: false, error: '未登录', status: 401 };
  const now = opts.now instanceof Date ? opts.now : new Date();
  const date = opts.date || shanghaiDate(now);
  const recentLimit = Number.isInteger(opts.recentLimit) ? opts.recentLimit : 14;
  db.checkIns ??= [];
  const mine = userCheckIns(db.checkIns, user.id);
  const today = findUserCheckIn(db.checkIns, user.id, date);
  return {
    ok: true,
    checkedInToday: Boolean(today),
    todayAmount: today ? Number(today.amount) || 0 : undefined,
    streak: checkInStreak(db.checkIns, user.id, date),
    date,
    timezone: CHECKIN_TIMEZONE,
    checkInBonus: money2(user.checkInBonus),
    recent: mine.slice(0, recentLimit).map(publicCheckInRecord)
  };
}

export function checkInAdminStats(db, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const date = opts.date || shanghaiDate(now);
  const recentLimit = Number.isInteger(opts.recentLimit) ? opts.recentLimit : 50;
  const checkIns = db.checkIns || [];
  const todayRows = checkIns.filter((r) => r.date === date);
  const usersById = new Map((db.users || []).map((u) => [u.id, u]));
  const totalAmount = money2(checkIns.reduce((s, r) => s + (Number(r.amount) || 0), 0));
  const todayAmount = money2(todayRows.reduce((s, r) => s + (Number(r.amount) || 0), 0));
  return {
    timezone: CHECKIN_TIMEZONE,
    today: {
      date,
      users: todayRows.length,
      amount: todayAmount
    },
    totals: {
      records: checkIns.length,
      amount: totalAmount,
      users: new Set(checkIns.map((r) => r.userId)).size
    },
    recent: checkIns.slice(0, recentLimit).map((r) => {
      const u = usersById.get(r.userId);
      return {
        id: r.id,
        userId: r.userId,
        username: u?.username || '',
        email: u?.email || '',
        date: r.date,
        amount: Number(r.amount) || 0,
        at: r.at
      };
    })
  };
}
