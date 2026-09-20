/**
 * Token-table cost + 花销倍率 helpers.
 * Customer charge = token-table cost × global billing multiplier (beibeihai / vip1129).
 * Channel displayMultiplier / billingMultiplier are display-only.
 * Price fetch never wipes the last table: failed or in-flight syncs keep previous prices.
 */
import { catalogPrice, channelFallbackPrice } from './upstream-prices.js';

export function modelPrice(provider, model, kind) {
  const positive = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    const value = Number(obj[kind]);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const listed = positive(provider?.modelPrices?.[model]);
  if (listed != null) return listed;
  const catalog = positive(catalogPrice(model));
  if (catalog != null) return catalog;
  if (!isGenericPlaceholder(provider)) {
    if (kind === 'inputPricePer1K') {
      const n = Number(provider?.inputPricePer1K ?? provider?.pricePer1K);
      if (Number.isFinite(n) && n > 0) return n;
    }
    if (kind === 'outputPricePer1K') {
      const n = Number(provider?.outputPricePer1K ?? provider?.pricePer1K);
      if (Number.isFinite(n) && n > 0) return n;
    }
    if (kind === 'cacheReadPricePer1K') {
      const n = Number(provider?.cacheReadPricePer1K);
      if (Number.isFinite(n) && n > 0) return n;
    }
    if (kind === 'cacheWritePricePer1K') {
      const n = Number(provider?.modelPrices?.[model]?.cacheWritePricePer1K ?? provider?.cacheWritePricePer1K);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  const channel = positive(channelFallbackPrice(provider?.id));
  if (channel != null) return channel;
  if (kind === 'cacheReadPricePer1K') return modelPrice(provider, model, 'inputPricePer1K') * 0.1;
  if (kind === 'cacheWritePricePer1K') return modelPrice(provider, model, 'inputPricePer1K');
  return 0;
}

function isGenericPlaceholder(provider) {
  const input = Number(provider?.inputPricePer1K);
  const output = Number(provider?.outputPricePer1K);
  return input === 0.01 && output === 0.03;
}

/** Prefer real upstream bill. Only actual_cost — never stream usage.cost (often 0). */
export function extractReportedUpstreamCost(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const candidates = [usage.actual_cost, usage.actualCost];
  for (const c of candidates) {
    if (c == null || c === '') continue;
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** Group rate_multiplier from vip1129/beibeihai; 1 when unset (prices already effective). */
export function providerUpstreamRate(provider) {
  const n = Number(provider?.upstreamRateMultiplier);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/**
 * Base token cost BEFORE group rate_multiplier.
 * Counts cache-read / cache-write tokens that usage often splits out of prompt_tokens.
 */
export function estimateBaseUpstreamCost(provider, usage, model) {
  const resolvedModel = model || provider.defaultModel || '';
  const inputPrice = modelPrice(provider, resolvedModel, 'inputPricePer1K');
  const outputPrice = modelPrice(provider, resolvedModel, 'outputPricePer1K');
  const cachePrice = modelPrice(provider, resolvedModel, 'cacheReadPricePer1K');
  const cacheWritePrice = modelPrice(provider, resolvedModel, 'cacheWritePricePer1K');
  const prompt = Math.max(0, Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0) || 0);
  const completion = Math.max(0, Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0);
  const cachedRaw = Number(
    usage?.prompt_tokens_details?.cached_tokens ??
    usage?.input_tokens_details?.cached_tokens ??
    usage?.cache_read_input_tokens ??
    usage?.cache_read_tokens ??
    usage?.cached_tokens ??
    0
  ) || 0;
  const cacheWriteRaw = Number(
    usage?.cache_creation_input_tokens ??
    usage?.cache_creation_tokens ??
    usage?.cache_write_tokens ??
    usage?.input_tokens_details?.cache_write_tokens ??
    usage?.input_tokens_details?.cache_creation_tokens ??
    usage?.prompt_tokens_details?.cache_write_tokens ??
    0
  ) || 0;
  let cacheTokens;
  let freshInput;
  if (cachedRaw > prompt && prompt > 0) {
    freshInput = prompt;
    cacheTokens = cachedRaw;
  } else {
    cacheTokens = Math.min(prompt, Math.max(0, cachedRaw));
    freshInput = Math.max(0, prompt - cacheTokens);
  }
  const writeTokens = Math.max(0, cacheWriteRaw);
  const writePrice = Number.isFinite(Number(cacheWritePrice)) && Number(cacheWritePrice) > 0
    ? Number(cacheWritePrice)
    : inputPrice;
  return (freshInput / 1000) * inputPrice
    + (cacheTokens / 1000) * cachePrice
    + (writeTokens / 1000) * writePrice
    + (completion / 1000) * outputPrice;
}

/** Real upstream bill when reported; else estimate only if allowEstimate. */
export function resolveUpstreamCost(provider, usage, model, opts = {}) {
  const reported = extractReportedUpstreamCost(usage);
  if (reported != null) return { cost: reported, source: 'reported' };
  if (opts.allowEstimate === false) return { cost: 0, source: 'pending' };
  const cost = estimateBaseUpstreamCost(provider, usage, model) * providerUpstreamRate(provider);
  return { cost, source: 'estimated' };
}

export function allowEstimatedBilling(db) {
  return db?.settings?.allowEstimatedBilling === true;
}

export function isPendingBillStatus(status) {
  const s = String(status || '');
  return s === 'success' || s === 'stream_incomplete' || s === 'client_abort';
}

export function usageListFromPayload(parsed) {
  const root = parsed?.data ?? parsed;
  if (Array.isArray(root)) return root;
  if (Array.isArray(root?.items)) return root.items;
  if (Array.isArray(root?.data)) return root.data;
  return [];
}

function usageFreshAndCache(usage) {
  const prompt = Math.max(0, Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0) || 0);
  const completion = Math.max(0, Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0);
  const cachedRaw = Number(
    usage?.prompt_tokens_details?.cached_tokens ??
    usage?.input_tokens_details?.cached_tokens ??
    usage?.cache_read_input_tokens ??
    usage?.cache_read_tokens ??
    usage?.cached_tokens ??
    0
  ) || 0;
  let cacheTokens;
  let freshInput;
  if (cachedRaw > prompt && prompt > 0) {
    freshInput = prompt;
    cacheTokens = cachedRaw;
  } else {
    cacheTokens = Math.min(prompt, Math.max(0, cachedRaw));
    freshInput = Math.max(0, prompt - cacheTokens);
  }
  return { freshInput, cacheTokens, completion };
}

function rowCreatedAt(row) {
  return Date.parse(row?.created_at || row?.createdAt || '') || 0;
}

function rowRequestId(row) {
  return String(row?.request_id || row?.requestId || row?.client_request_id || '');
}

function rowMatchesRequestId(row, clientRequestId) {
  const want = String(clientRequestId || '').trim();
  const rid = rowRequestId(row);
  if (!want || !rid) return false;
  if (rid === want) return true;
  if (rid === `client:${want}` || want === `client:${rid}`) return true;
  return want.length >= 12 && (rid.endsWith(want) || want.endsWith(rid));
}

/**
 * Pick the vip1129/beibeihai /api/v1/usage row for this request.
 * actual_cost on that row is the real upstream deduction (already includes their group rate).
 * Upstream often generates its own client:uuid and does not echo our X-Request-Id.
 * Match order: echoed request id → time window + token distance. Never steal a far sibling.
 */
export function pickUpstreamUsageRow(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const keyId = opts.apiKeyId != null && opts.apiKeyId !== '' ? String(opts.apiKeyId) : '';
  const model = String(opts.model || '');
  const used = new Set((opts.usedIds || []).map(String));
  const startedAt = opts.startedAt instanceof Date ? opts.startedAt.getTime() : Number(opts.startedAt || 0);
  const now = Number(opts.now || Date.now());
  const clientRequestId = String(opts.clientRequestId || '').trim();
  const { freshInput, cacheTokens, completion } = usageFreshAndCache(opts.usage);
  const splitTotal = freshInput + cacheTokens + completion;
  const localTotal = splitTotal || Math.max(0, Number(opts.usage?.total_tokens || 0) || 0);
  const lookbackMs = Number.isFinite(Number(opts.lookbackMs)) && Number(opts.lookbackMs) >= 0
    ? Number(opts.lookbackMs)
    : 5000;
  const windowStart = startedAt > 0 ? startedAt - lookbackMs : 0;
  const windowEnd = now + 20000;
  const maxScore = localTotal > 0 ? Math.max(24, Math.floor(localTotal * 0.35)) : Infinity;
  const live = opts.live === true || opts.allowIncomplete === true;

  if (clientRequestId) {
    const hit = list.find((row) => row && !used.has(String(row.id)) && rowMatchesRequestId(row, clientRequestId));
    if (hit) return hit;
  }

  const tokenScore = (row) => {
    if (splitTotal <= 0 && localTotal > 0) {
      const rowTotal = (Number(row.input_tokens) || 0)
        + (Number(row.output_tokens) || 0)
        + (Number(row.cache_read_tokens) || 0);
      return Math.abs(rowTotal - localTotal);
    }
    const din = Math.abs((Number(row.input_tokens) || 0) - freshInput);
    const dcache = Math.abs((Number(row.cache_read_tokens) || 0) - cacheTokens);
    const dout = Math.abs((Number(row.output_tokens) || 0) - completion);
    return din + dcache + dout;
  };

  const candidates = list.filter((row) => {
    if (!row || used.has(String(row.id))) return false;
    if (keyId && row.api_key_id != null && String(row.api_key_id) !== keyId) return false;
    if (model && row.model && String(row.model) !== model) return false;
    if (windowStart) {
      const t = rowCreatedAt(row);
      if (t && (t < windowStart || t > windowEnd)) return false;
    }
    return true;
  });
  if (!candidates.length) return null;
  const billed = candidates.filter((row) => {
    const cost = Number(row.actual_cost);
    const tok = (Number(row.input_tokens) || 0) + (Number(row.output_tokens) || 0) + (Number(row.cache_read_tokens) || 0);
    return (Number.isFinite(cost) && cost > 0) || tok > 0;
  });
  let pool = billed.length ? billed : candidates;
  if (localTotal > 0 && !live) {
    const close = pool.filter((row) => tokenScore(row) <= maxScore);
    if (!close.length) return null;
    pool = close;
  }
  if (pool.length === 1) return pool[0];

  if (opts.preferNewest === true || live) {
    return [...pool].sort((a, b) => {
      const ta = rowCreatedAt(a);
      const tb = rowCreatedAt(b);
      if (tb !== ta) return tb - ta;
      return (Number(b.id) || 0) - (Number(a.id) || 0);
    })[0];
  }
  if (localTotal <= 0 && startedAt > 0) {
    return [...pool].sort((a, b) => {
      const da = Math.abs((rowCreatedAt(a) || startedAt) - startedAt);
      const db = Math.abs((rowCreatedAt(b) || startedAt) - startedAt);
      if (da !== db) return da - db;
      return (Number(b.id) || 0) - (Number(a.id) || 0);
    })[0];
  }

  const scored = pool.map((row) => {
    const t = rowCreatedAt(row);
    const dt = startedAt > 0 && t ? Math.abs(t - startedAt) : 0;
    return { row, score: tokenScore(row), dt };
  }).sort((a, b) => (a.score - b.score) || (a.dt - b.dt));
  return scored[0]?.row || null;
}

/**
 * Pick a usage row that this request uniquely owns.
 * `claim(id)` must be atomic and return false when another in-flight request already took it.
 * Concurrent callers with identical tokens otherwise all bind the newest billed row and double-charge.
 */
export function pickExclusiveUpstreamUsageRow(items, opts = {}, claim = null) {
  const used = new Set((opts.usedIds || []).map(String));
  const known = opts.knownId != null && opts.knownId !== '' ? String(opts.knownId) : '';
  const list = Array.isArray(items) ? items : [];
  if (known) {
    const hit = list.find((row) => row && String(row.id) === known);
    if (hit) return hit;
  }
  const limit = Math.max(1, list.length + 1);
  for (let i = 0; i < limit; i++) {
    const row = pickUpstreamUsageRow(list, { ...opts, usedIds: [...used] });
    if (!row) return null;
    if (typeof claim !== 'function') return row;
    if (claim(row.id)) return row;
    used.add(String(row.id));
  }
  return null;
}

/** Later logs that reused another request's upstreamUsageId. Keep the earliest. */
export function findDuplicateUsageCharges(logs) {
  const by = new Map();
  for (const log of logs || []) {
    if (!log?.upstreamUsageId) continue;
    if (log.pendingActual || log.status === 'pending_actual_cost' || log.status === 'duplicate_reversed') continue;
    const key = String(log.upstreamUsageId);
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(log);
  }
  const dups = [];
  for (const [usageId, group] of by) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => {
      const da = Date.parse(a.createdAt || 0) || 0;
      const db = Date.parse(b.createdAt || 0) || 0;
      if (da !== db) return da - db;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
    dups.push({ usageId, keep: sorted[0], extras: sorted.slice(1) });
  }
  return dups;
}

/** Copy actual_cost + token fields from a usage API row onto local usage. */
export function applyUpstreamUsageRow(usage, row) {
  if (!usage || typeof usage !== 'object' || !row) return usage;
  const cost = Number(row.actual_cost);
  if (Number.isFinite(cost) && cost > 0) usage.actual_cost = cost;
  if (row.id != null) usage.upstreamUsageId = row.id;
  const inTok = (Number(row.input_tokens) || 0)
    + (Number(row.cache_read_tokens) || 0)
    + (Number(row.cache_creation_tokens) || 0);
  const outTok = Number(row.output_tokens) || 0;
  if (inTok + outTok > 0) {
    usage.prompt_tokens = inTok;
    usage.completion_tokens = outTok;
    usage.total_tokens = inTok + outTok;
    const cached = Number(row.cache_read_tokens) || 0;
    if (cached > 0) {
      usage.cache_read_tokens = cached;
      usage.prompt_tokens_details = { ...(usage.prompt_tokens_details || {}), cached_tokens: cached };
    }
  }
  return usage;
}

export function providerCost(provider, usage, model) {
  return resolveUpstreamCost(provider, usage, model).cost;
}

export function estimatedCost(provider, inputTokens, outputTokens, model) {
  return providerCost(provider, { prompt_tokens: inputTokens, completion_tokens: outputTokens }, model);
}

/** Token-table cost before the global billing multiplier. Customer charge = this × rate. */
export function tokenFloorCost(provider, usage, model) {
  if (!provider || !usage) return 0;
  const cost = estimateBaseUpstreamCost(provider, usage, model) * providerUpstreamRate(provider);
  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

/**
 * vip1129 usage `actual_cost` is inflated 7× versus true upstream spend.
 * Customer charge stays token-table × global rate; only accounting / inversion
 * comparisons use the deflated true cost.
 */
export const VIP1129_UPSTREAM_COST_DIVISOR = 7;

export function providerUsesVip1129CostDivisor(provider) {
  if (!provider) return false;
  if (String(provider.upstreamSync || '').toLowerCase() === 'vip1129') return true;
  return /vip1129/i.test(String(provider.url || ''));
}

/** True upstream spend. VIP1129 reported bills are divided by 7; other providers unchanged. */
export function trueUpstreamCost(reportedCost, provider) {
  const n = Number(reportedCost);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (providerUsesVip1129CostDivisor(provider)) return n / VIP1129_UPSTREAM_COST_DIVISOR;
  return n;
}

/**
 * charged ≈ 0.4 × reported VIP bill is NOT inverted: 0.4 × reported ≈ 2.8 × true cost.
 * Compare charged against true upstream cost, never the raw 7× figure.
 */
export function isInvertedCharge(chargedAmount, reportedUpstreamCost, provider) {
  const trueCost = trueUpstreamCost(reportedUpstreamCost, provider);
  const charged = Number(chargedAmount);
  if (!(trueCost > 0) || !Number.isFinite(charged)) return false;
  return charged + 1e-12 < trueCost;
}

/** Finance/inversion view of a log or ledger row. Does not double-divide marked true costs. */
export function accountingUpstreamCost(entry, provider) {
  if (!entry) return 0;
  if (entry.upstreamCostTrue === true) {
    const n = Number(entry.upstreamCost);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  const raw = Number(entry.upstreamReportedCost ?? entry.actualCost ?? entry.upstreamCost ?? 0);
  return trueUpstreamCost(raw, provider);
}

export function applyTrueUpstreamCost(target, reportedCost, provider) {
  const raw = Number(reportedCost);
  const reported = Number.isFinite(raw) && raw > 0 ? raw : 0;
  const trueCost = trueUpstreamCost(reported, provider);
  if (target && typeof target === 'object') {
    if (reported > 0) target.upstreamReportedCost = reported;
    target.upstreamCost = trueCost > 0 ? trueCost : reported;
    target.upstreamCostTrue = true;
  }
  return trueCost;
}

/** Token extra consumption after 花销倍率: billedTokens = upstreamTokens × global rate. */
export function billedTokensFromLog(log) {
  const tok = Math.max(0, Number(log?.tokens || 0));
  const rate = Number(log?.multiplier);
  const billed = Number(log?.billedTokens);
  if (Number.isFinite(billed) && billed > 0) return billed;
  if (Number.isFinite(rate) && rate > 0) return tok * rate;
  if (Number.isFinite(billed) && billed >= 0 && log?.billedTokens != null) return billed;
  return tok;
}
