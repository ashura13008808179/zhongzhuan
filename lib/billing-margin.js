/**
 * Token-table customer charge vs official upstream actual_cost.
 * Customer billing stays on the token table; this module only compares
 * and warns when the official upstream payment exceeds that charge.
 */

import crypto from 'node:crypto';

export const OVER_CHARGE_EPS = 1e-5;
export const BILLING_ALERT_KIND = 'upstream_over_charge';
export const BILLING_ALERT_CAP = 200;
export const SKIP_COMPARE_STATUSES = new Set([
  'referral_rebate',
  'checkin_bonus',
  'duplicate_reversed',
  'pending_actual_cost'
]);

export function money4(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 10000) / 10000;
}

export function shanghaiDay(d = new Date()) {
  const at = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(at.getTime())) return '';
  const local = new Date(at.getTime() - at.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

export function hasOfficialUpstream(row) {
  if (!row) return false;
  if (row.upstreamCostSource === 'token_table') return false;
  if (row.upstreamCostSource === 'reported') return true;
  const up = Number(row.upstreamCost ?? row.actualCost);
  return Number.isFinite(up) && up > 0;
}

export function isUpstreamOverCharge(row) {
  if (!hasOfficialUpstream(row)) return false;
  const up = Number(row.upstreamCost ?? row.actualCost);
  const charged = Number(row.chargedAmount);
  if (!Number.isFinite(up) || !Number.isFinite(charged)) return false;
  if (up <= 0) return false;
  return up > charged + OVER_CHARGE_EPS;
}

export function overChargeLoss(row) {
  if (!isUpstreamOverCharge(row)) return 0;
  return money4((Number(row.upstreamCost ?? row.actualCost) || 0) - (Number(row.chargedAmount) || 0));
}

function userLabel(db, uid) {
  const u = (db?.users || []).find((x) => x.id === uid);
  return u?.username || u?.name || uid || 'unknown';
}

function providerLabel(db, pid, fallback) {
  const p = (db?.settings?.providers || []).find((x) => x.id === pid);
  return p?.name || fallback || pid || 'unknown';
}

/**
 * One row per local request (or unmatched official bill) for a calendar day.
 * Official actual_cost from the upstream ledger overlays the local log.
 */
export function billingCompareRows(db, { day } = {}) {
  const d = day || shanghaiDay();
  const logs = db?.logs || [];
  const bills = db?.upstreamBills || [];
  const billByLog = new Map();
  const billByUsage = new Map();
  for (const bill of bills) {
    if (!bill) continue;
    if (bill.localLogId) billByLog.set(bill.localLogId, bill);
    if (bill.upstreamUsageId != null) {
      billByUsage.set(`${bill.upstreamApiKeyId || ''}:${bill.upstreamUsageId}`, bill);
    }
  }
  const usedBills = new Set();
  const rows = [];
  for (const log of logs) {
    if (!log?.createdAt || shanghaiDay(new Date(log.createdAt)) !== d) continue;
    if (SKIP_COMPARE_STATUSES.has(log.status)) continue;
    const bill = billByLog.get(log.id)
      || (log.upstreamUsageId != null
        ? billByUsage.get(`${log.upstreamApiKeyId || ''}:${log.upstreamUsageId}`)
        : null);
    if (bill) usedBills.add(bill);
    const official = bill && Number(bill.actualCost) > 0 ? Number(bill.actualCost) : Number(log.upstreamCost) || 0;
    const source = (bill && Number(bill.actualCost) > 0)
      ? 'reported'
      : (log.upstreamCostSource || (official > 0 ? 'reported' : 'token_table'));
    rows.push({
      id: log.id,
      createdAt: log.createdAt,
      userId: log.userId,
      username: userLabel(db, log.userId),
      providerId: log.providerId || 'unknown',
      providerName: log.providerName || providerLabel(db, log.providerId),
      model: log.model || '',
      tokenCost: Number(log.tokenCost) || 0,
      chargedAmount: Number(log.chargedAmount) || 0,
      upstreamCost: official,
      upstreamCostSource: source,
      status: log.status || 'success'
    });
  }
  for (const bill of bills) {
    if (!bill?.createdAt || shanghaiDay(new Date(bill.createdAt)) !== d) continue;
    if (usedBills.has(bill)) continue;
    if (bill.status && SKIP_COMPARE_STATUSES.has(bill.status)) continue;
    rows.push({
      id: bill.id,
      createdAt: bill.createdAt,
      userId: bill.userId,
      username: userLabel(db, bill.userId),
      providerId: bill.providerId || 'unknown',
      providerName: providerLabel(db, bill.providerId),
      model: bill.model || '',
      tokenCost: Number(bill.tokenCost) || 0,
      chargedAmount: Number(bill.chargedAmount) || 0,
      upstreamCost: Number(bill.actualCost) || 0,
      upstreamCostSource: 'reported',
      status: bill.status || 'success'
    });
  }
  return rows;
}

export function summarizeBillingCompare(db, { day } = {}) {
  const d = day || shanghaiDay();
  const rows = billingCompareRows(db, { day: d });
  const byUser = {};
  const byProvider = {};
  const invertedRequests = [];
  let invertedCount = 0;
  let invertedLoss = 0;
  let officialCount = 0;
  for (const row of rows) {
    const uid = row.userId || 'unknown';
    const pid = row.providerId || 'unknown';
    const official = hasOfficialUpstream(row);
    const inverted = isUpstreamOverCharge(row);
    const loss = inverted ? overChargeLoss(row) : 0;
    const margin = official ? money4((Number(row.chargedAmount) || 0) - (Number(row.upstreamCost) || 0)) : 0;
    if (official) officialCount += 1;
    if (!byUser[uid]) {
      byUser[uid] = {
        userId: uid,
        username: row.username,
        requests: 0,
        tokenCost: 0,
        chargedAmount: 0,
        upstreamCost: 0,
        margin: 0,
        invertedCount: 0,
        invertedLoss: 0,
        officialCount: 0
      };
    }
    byUser[uid].requests += 1;
    byUser[uid].tokenCost += Number(row.tokenCost) || 0;
    byUser[uid].chargedAmount += Number(row.chargedAmount) || 0;
    byUser[uid].upstreamCost += Number(row.upstreamCost) || 0;
    byUser[uid].margin += margin;
    if (official) byUser[uid].officialCount += 1;
    if (inverted) {
      byUser[uid].invertedCount += 1;
      byUser[uid].invertedLoss += loss;
    }
    if (!byProvider[pid]) {
      byProvider[pid] = {
        providerId: pid,
        providerName: row.providerName || pid,
        requests: 0,
        tokenCost: 0,
        chargedAmount: 0,
        upstreamCost: 0,
        invertedCount: 0,
        invertedLoss: 0
      };
    }
    byProvider[pid].requests += 1;
    byProvider[pid].tokenCost += Number(row.tokenCost) || 0;
    byProvider[pid].chargedAmount += Number(row.chargedAmount) || 0;
    byProvider[pid].upstreamCost += Number(row.upstreamCost) || 0;
    if (inverted) {
      byProvider[pid].invertedCount += 1;
      byProvider[pid].invertedLoss += loss;
    }
    if (inverted) {
      invertedCount += 1;
      invertedLoss += loss;
      invertedRequests.push({
        id: row.id,
        createdAt: row.createdAt,
        userId: row.userId,
        username: row.username,
        providerId: row.providerId,
        providerName: row.providerName,
        model: row.model,
        tokenCost: money4(row.tokenCost),
        chargedAmount: money4(row.chargedAmount),
        upstreamCost: money4(row.upstreamCost),
        loss: money4(loss)
      });
    }
  }
  const roundUser = (row) => ({
    ...row,
    tokenCost: money4(row.tokenCost),
    chargedAmount: money4(row.chargedAmount),
    upstreamCost: money4(row.upstreamCost),
    margin: money4(row.margin),
    invertedLoss: money4(row.invertedLoss)
  });
  const roundProvider = (row) => ({
    ...row,
    tokenCost: money4(row.tokenCost),
    chargedAmount: money4(row.chargedAmount),
    upstreamCost: money4(row.upstreamCost),
    invertedLoss: money4(row.invertedLoss)
  });
  invertedRequests.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return {
    day: d,
    invertedCount,
    invertedLoss: money4(invertedLoss),
    officialCount,
    invertedRequests: invertedRequests.slice(0, 80),
    byUser: Object.values(byUser).map(roundUser).sort((a, b) => {
      if (b.invertedLoss !== a.invertedLoss) return b.invertedLoss - a.invertedLoss;
      return b.chargedAmount - a.chargedAmount;
    }),
    byProvider: Object.values(byProvider).map(roundProvider).sort((a, b) => b.upstreamCost - a.upstreamCost)
  };
}

export function publicBillingAlert(a) {
  if (!a) return null;
  return {
    id: a.id,
    kind: a.kind || BILLING_ALERT_KIND,
    status: a.status,
    day: a.day || '',
    count: a.count || 0,
    loss: money4(a.loss),
    users: a.users || [],
    samples: a.samples || [],
    createdAt: a.createdAt,
    updatedAt: a.updatedAt
  };
}

export function openBillingAlerts(db) {
  return (db?.billingAlerts || [])
    .filter((a) => a && a.status === 'open' && a.kind === BILLING_ALERT_KIND)
    .map(publicBillingAlert);
}

function alreadySampled(alerts, logId) {
  if (!logId) return false;
  return (alerts || []).some((a) => (
    (a.logIds || []).includes(logId)
    || (a.samples || []).some((s) => s && s.logId === logId)
  ));
}

export function noteUpstreamOverCharge(db, log, extras = {}) {
  if (!log || !isUpstreamOverCharge(log)) return null;
  db.billingAlerts ??= [];
  const logId = log.id || null;
  if (logId && alreadySampled(db.billingAlerts, logId)) return null;
  const now = new Date().toISOString();
  const day = shanghaiDay(log.createdAt ? new Date(log.createdAt) : new Date());
  const loss = overChargeLoss(log);
  const sample = {
    logId,
    userId: log.userId || null,
    username: extras.username || log.username || log.userId || '',
    model: extras.model || log.model || '',
    providerName: extras.providerName || log.providerName || log.providerId || '',
    tokenCost: money4(log.tokenCost),
    chargedAmount: money4(log.chargedAmount),
    upstreamCost: money4(log.upstreamCost ?? log.actualCost),
    loss,
    createdAt: log.createdAt || now
  };
  const open = db.billingAlerts.find((a) => (
    a.kind === BILLING_ALERT_KIND && a.day === day && a.status === 'open'
  ));
  if (open) {
    open.count = (open.count || 0) + 1;
    open.loss = money4((open.loss || 0) + loss);
    open.updatedAt = now;
    if (logId) open.logIds = [logId, ...(open.logIds || [])].filter(Boolean).slice(0, 200);
    open.samples = [sample, ...(open.samples || [])].slice(0, 20);
    open.users ??= [];
    if (log.userId && !open.users.some((u) => u.userId === log.userId)) {
      open.users.push({ userId: log.userId, username: sample.username });
      open.users = open.users.slice(0, 50);
    }
    return { alert: open, created: false };
  }
  const alert = {
    id: `balrt_${crypto.randomBytes(6).toString('hex')}`,
    kind: BILLING_ALERT_KIND,
    status: 'open',
    day,
    count: 1,
    loss,
    logIds: logId ? [logId] : [],
    samples: [sample],
    users: log.userId ? [{ userId: log.userId, username: sample.username }] : [],
    createdAt: now,
    updatedAt: now
  };
  db.billingAlerts.unshift(alert);
  db.billingAlerts = db.billingAlerts.slice(0, BILLING_ALERT_CAP);
  return { alert, created: true };
}

export function scanTodayUpstreamOverCharges(db, { day } = {}) {
  const rows = billingCompareRows(db, { day });
  const created = [];
  let updated = 0;
  for (const row of rows) {
    const result = noteUpstreamOverCharge(db, row, {
      username: row.username,
      model: row.model,
      providerName: row.providerName
    });
    if (!result) continue;
    if (result.created) created.push(result.alert);
    else updated += 1;
  }
  return { created, updated, inverted: rows.filter(isUpstreamOverCharge).length };
}

export function dismissBillingAlert(db, alertId) {
  db.billingAlerts ??= [];
  const alert = db.billingAlerts.find((a) => a.id === alertId);
  if (!alert) return null;
  alert.status = 'dismissed';
  alert.updatedAt = new Date().toISOString();
  return alert;
}
