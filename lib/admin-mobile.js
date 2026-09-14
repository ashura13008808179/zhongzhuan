export function parseUpstreamAccount(parsed) {
  const root = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed;
  const user = root?.data && typeof root.data === 'object' && ('balance' in root.data || 'email' in root.data)
    ? root.data
    : root;
  if (!user || typeof user !== 'object') return null;
  const balance = Number(user.balance);
  const frozen = Number(user.frozen_balance ?? user.frozenBalance ?? 0);
  return {
    ok: true,
    id: user.id ?? null,
    email: user.email || '',
    username: user.username || '',
    status: user.status || '',
    role: user.role || '',
    balance: Number.isFinite(balance) ? Math.round(balance * 10000) / 10000 : null,
    frozenBalance: Number.isFinite(frozen) ? Math.round(frozen * 10000) / 10000 : 0,
    concurrency: Number(user.concurrency || 0) || null
  };
}

export function publicOrder(o) {
  if (!o) return null;
  return {
    id: o.id,
    userId: o.userId,
    username: o.username || '',
    email: o.email || '',
    amount: Number(o.amount || 0),
    method: o.method || '',
    payNote: o.payNote || null,
    status: o.status,
    code: o.status === 'confirmed' ? (o.code || null) : null,
    createdAt: o.createdAt || null,
    userReportedAt: o.userReportedAt || null,
    confirmedAt: o.confirmedAt || null
  };
}

export function buildMobileInbox(db) {
  const orders = Array.isArray(db.paymentOrders) ? db.paymentOrders : [];
  const pending = orders.filter(o => o.status === 'pending').map(publicOrder);
  const awaiting = orders.filter(o => o.status === 'awaiting_payment').map(publicOrder);
  const recent = orders.slice(0, 30).map(publicOrder);
  const providers = (db.settings?.providers || []).map(p => ({
    id: p.id,
    name: p.name,
    enabled: p.enabled !== false,
    maintenance: !!p.maintenance,
    healthOk: p.health?.ok !== false,
    lastError: p.health?.lastError || null,
    lastCheckedAt: p.health?.lastCheckedAt || null,
    billingMultiplier: p.billingMultiplier,
    displayMultiplier: p.displayMultiplier
  }));
  const last = db.settings?.lastDiagnostics || null;
  return {
    at: new Date().toISOString(),
    pendingCount: pending.length,
    awaitingCount: awaiting.length,
    notifyIds: pending.map(o => o.id),
    pending,
    awaiting,
    recent,
    providers,
    diagnostics: last ? {
      at: last.at,
      summary: last.summary || null
    } : null
  };
}
