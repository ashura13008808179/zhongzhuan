/**
 * Admin billing-alerts payload. Live scripts and UI read `open` (count of
 * inverted / loss-making charges), never `undefined`.
 */
import { accountingUpstreamCost } from './billing-cost.js';

function localDay(d = new Date()) {
  const x = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(x.getTime())) return '';
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function providerOf(db, id, kind) {
  const hit = (db?.settings?.providers || []).find((p) => p && p.id === id);
  if (hit) return hit;
  if (kind) return { upstreamSync: kind, kind };
  return null;
}

export function invertedBillingRows(db, { day = localDay() } = {}) {
  const ledger = Array.isArray(db?.upstreamBills) ? db.upstreamBills : [];
  const logs = Array.isArray(db?.logs) ? db.logs : [];
  const source = ledger.length ? ledger : logs;
  const out = [];
  for (const row of source) {
    if (!row?.createdAt || localDay(new Date(row.createdAt)) !== day) continue;
    if (row.status === 'referral_rebate' || row.status === 'checkin_bonus') continue;
    const provider = providerOf(db, row.providerId, row.kind);
    const charged = Number(row.chargedAmount ?? row.collectedAmount ?? 0);
    const trueCost = accountingUpstreamCost(row, provider);
    if (!(trueCost > 0 && Number.isFinite(charged) && charged + 1e-12 < trueCost)) continue;
    out.push({
      id: row.id || row.upstreamUsageId || `inv_${row.createdAt}_${row.providerId || ''}`,
      status: 'open',
      providerId: row.providerId || null,
      providerName: provider?.name || row.providerName || row.providerId || '',
      userId: row.userId || null,
      model: row.model || '',
      chargedAmount: Number.isFinite(charged) ? charged : 0,
      upstreamCost: trueCost,
      createdAt: row.createdAt,
      kind: row.kind || provider?.upstreamSync || null
    });
  }
  return out;
}

export function buildBillingAlerts(db, stats = null) {
  const day = stats?.day || localDay();
  const alerts = invertedBillingRows(db, { day });
  const open = alerts.length;
  const loss = alerts.reduce((s, a) => s + Math.max(0, Number(a.upstreamCost || 0) - Number(a.chargedAmount || 0)), 0);
  return {
    open,
    openCount: open,
    alerts,
    invertedCount: Number.isFinite(Number(stats?.invertedCount)) ? Number(stats.invertedCount) : open,
    invertedLossToday: Number.isFinite(Number(stats?.invertedLossToday))
      ? Number(stats.invertedLossToday)
      : Math.round(loss * 10000) / 10000,
    day
  };
}
