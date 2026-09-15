/**
 * Upstream cost + 花销倍率 helpers.
 * Customer charge = upstreamCost × global billing multiplier (beibeihai / vip1129).
 * Channel displayMultiplier / billingMultiplier are display-only.
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
  const localTotal = freshInput + cacheTokens + completion;
  const lookbackMs = Number.isFinite(Number(opts.lookbackMs)) && Number(opts.lookbackMs) >= 0
    ? Number(opts.lookbackMs)
    : 5000;
  const windowStart = startedAt > 0 ? startedAt - lookbackMs : 0;
  const windowEnd = now + 20000;
  const maxScore = localTotal > 0 ? Math.max(24, Math.floor(localTotal * 0.35)) : Infinity;

  if (clientRequestId) {
    const hit = list.find((row) => row && !used.has(String(row.id)) && rowMatchesRequestId(row, clientRequestId));
    if (hit) return hit;
  }

  const tokenScore = (row) => {
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
  if (localTotal > 0) {
    const close = pool.filter((row) => tokenScore(row) <= maxScore);
    if (!close.length) return null;
    pool = close;
  }
  if (pool.length === 1) return pool[0];

  if (opts.preferNewest === true) {
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
