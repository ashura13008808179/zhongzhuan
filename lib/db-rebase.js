/**
 * Optimistic three-way merge for the JSON database.
 *
 * Each HTTP request has its own in-memory snapshot while awaiting an upstream
 * response. Atomic rename protects the file from corruption, but by itself
 * cannot prevent a late snapshot from overwriting an earlier request. These
 * helpers rebase the snapshot's changes onto the latest committed database.
 */

const MISSING = Symbol('missing');

export const MERGED_ROOTS = [
  'users',
  'logs',
  'upstreamBills',
  'auditLogs',
  'siteErrors',
  'sessions',
  'settings',
  'paymentOrders',
  'checkIns',
  'securityAlerts',
  'billingAlerts',
  'files'
];

export function cloneDbValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function snapshotDbForRebase(db) {
  const snapshot = {};
  for (const root of MERGED_ROOTS) snapshot[root] = cloneDbValue(db?.[root]);
  return snapshot;
}

function equal(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!equal(a[i], b[i])) return false;
    return true;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !equal(a[key], b[key])) return false;
  }
  return true;
}

function keyedArrayPath(path) {
  const root = path[0];
  if (path.length === 1 && ['users', 'logs', 'upstreamBills', 'auditLogs', 'siteErrors', 'paymentOrders', 'checkIns', 'securityAlerts', 'billingAlerts', 'files'].includes(root)) return 'id';
  if (path.length === 1 && root === 'rechargeCodes') return 'code';
  if (path.at(-1) === 'apiKeys') return 'id';
  if (root === 'settings' && path.at(-1) === 'providers') return 'id';
  return '';
}

function additiveNumberPath(path) {
  if (path[0] !== 'users') return false;
  const field = path.at(-1);
  if (path.includes('apiKeys')) {
    return ['spendUsed', 'tokenUsed', 'reservedSpend', 'reservedTokens'].includes(field);
  }
  return [
    'balance',
    'bonusBalance',
    'checkInBonus',
    'quotaTokens',
    'usedTokens',
    'reservedTokens',
    'reservedBalance',
    'pendingActualHold',
    'upstreamOutstandingAmount',
    'invited'
  ].includes(field);
}

function mapByKey(rows, key) {
  const map = new Map();
  for (const item of Array.isArray(rows) ? rows : []) {
    const value = item?.[key];
    if (value != null && value !== '') map.set(String(value), item);
  }
  return map;
}

function mergeKeyedArray(base, next, latest, path, key) {
  const baseMap = mapByKey(base, key);
  const nextMap = mapByKey(next, key);
  const latestMap = mapByKey(latest, key);
  const merged = [];
  const added = new Set();

  for (const item of Array.isArray(next) ? next : []) {
    const id = item?.[key] == null ? '' : String(item[key]);
    if (!id || added.has(id)) continue;
    added.add(id);
    const value = mergeValue(baseMap.has(id) ? baseMap.get(id) : MISSING, item, latestMap.has(id) ? latestMap.get(id) : MISSING, [...path, id]);
    if (value !== MISSING) merged.push(value);
  }

  // Preserve rows that were added by a concurrent request after this snapshot.
  for (const item of Array.isArray(latest) ? latest : []) {
    const id = item?.[key] == null ? '' : String(item[key]);
    if (!id || added.has(id) || baseMap.has(id)) continue;
    added.add(id);
    merged.push(cloneDbValue(item));
  }
  return merged;
}

function mergeValue(base, next, latest, path) {
  if (next === MISSING) return base === MISSING ? (latest === MISSING ? MISSING : cloneDbValue(latest)) : MISSING;
  if (base === MISSING) return cloneDbValue(next);
  if (equal(base, next)) return latest === MISSING ? MISSING : cloneDbValue(latest);

  const baseIsObject = base && typeof base === 'object';
  const nextIsObject = next && typeof next === 'object';
  const latestIsObject = latest && typeof latest === 'object';
  if (!baseIsObject || !nextIsObject || Array.isArray(base) !== Array.isArray(next)) {
    if (additiveNumberPath(path)
      && Number.isFinite(Number(base))
      && Number.isFinite(Number(next))) {
      const current = Number.isFinite(Number(latest)) ? Number(latest) : 0;
      return current + (Number(next) - Number(base));
    }
    return cloneDbValue(next);
  }

  if (Array.isArray(next)) {
    const key = keyedArrayPath(path);
    if (key) return mergeKeyedArray(base, next, Array.isArray(latest) ? latest : [], path, key);
    return cloneDbValue(next);
  }

  const out = {};
  const keys = new Set([
    ...Object.keys(base || {}),
    ...Object.keys(next || {}),
    ...(latestIsObject && !Array.isArray(latest) ? Object.keys(latest) : [])
  ]);
  for (const key of keys) {
    const value = mergeValue(
      Object.prototype.hasOwnProperty.call(base, key) ? base[key] : MISSING,
      Object.prototype.hasOwnProperty.call(next, key) ? next[key] : MISSING,
      latestIsObject && Object.prototype.hasOwnProperty.call(latest, key) ? latest[key] : MISSING,
      [...path, key]
    );
    if (value !== MISSING) out[key] = value;
  }
  return out;
}

/** Rebase one request's mutations onto a newer database snapshot. */
export function rebaseDbSnapshot(base, next, latest, opts = {}) {
  const merged = cloneDbValue(latest || {});
  for (const root of MERGED_ROOTS) {
    merged[root] = mergeValue(
      Object.prototype.hasOwnProperty.call(base || {}, root) ? base[root] : MISSING,
      Object.prototype.hasOwnProperty.call(next || {}, root) ? next[root] : MISSING,
      Object.prototype.hasOwnProperty.call(latest || {}, root) ? latest[root] : MISSING,
      [root]
    );
    if (merged[root] === MISSING) delete merged[root];
  }

  // Recharge code arrays can contain tens of thousands of entries, so callers
  // snapshot them only for operations that mutate this root.
  if (Object.prototype.hasOwnProperty.call(base || {}, 'rechargeCodes')) {
    merged.rechargeCodes = mergeValue(base.rechargeCodes, next.rechargeCodes, latest?.rechargeCodes, ['rechargeCodes']);
  }
  if (Array.isArray(merged.logs) && Number(opts.logCap) > 0) merged.logs = merged.logs.slice(0, Number(opts.logCap));
  return merged;
}
