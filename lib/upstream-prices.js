/**
 * Measured BASE 元 / 1K token prices (before upstream group rate_multiplier).
 * Estimate when actual_cost is missing:
 *   upstreamCost = estimateBase(BASE prices) × provider.upstreamRateMultiplier
 *
 * Derived from vip1129 / beibeihai /api/v1/usage:
 *   input_cost / output_cost / cache_*_cost  = BASE
 *   actual_cost = total_cost × rate_multiplier
 */

export function roundPrice(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x <= 0) return 0;
  if (x >= 0.1) return Number(x.toFixed(4));
  if (x >= 0.01) return Number(x.toFixed(5));
  if (x >= 0.001) return Number(x.toFixed(6));
  return Number(x.toFixed(7));
}

function price(input, output, cache = null, write = null) {
  const inputPricePer1K = roundPrice(input);
  const outputPricePer1K = roundPrice(output);
  const cacheReadPricePer1K = roundPrice(cache == null ? inputPricePer1K * 0.1 : cache);
  const cacheWritePricePer1K = roundPrice(write == null ? inputPricePer1K : write);
  return { inputPricePer1K, outputPricePer1K, cacheReadPricePer1K, cacheWritePricePer1K };
}

const GPT_SOL = price(0.005, 0.03, 0.0005);
const GPT_TERRA = price(0.002, 0.012, 0.0002);
const CLAUDE_FABLE = price(0.01, 0.05, 0.001, 0.0125);
const CLAUDE_SONNET = price(0.003, 0.015, 0.0003, 0.00375);
const CLAUDE_HAIKU = price(0.001, 0.005, 0.0001, 0.00125);
const DEEPSEEK = price(0.00015, 0.0006, 0.000015);
const DEEPSEEK_PRO = price(0.00045, 0.0018, 0.000045);
const GEMINI_FLASH = price(0.0003, 0.0025, 0.00003);
const GLM51 = price(0.006, 0.024, 0.0006);
const GLM52 = price(0.008, 0.028, 0.0008);
const KIMI_K3 = price(0.02, 0.1, 0.002);
const KIMI_K26 = price(0.001, 0.004, 0.0001);
const GROK = price(0.002, 0.006, 0.0003);
const COMPOSER = price(0.001, 0.002, 0.0002);
const GROK_IMAGE = price(2.8, 8.4, 0.28);

/** Exact model BASE table. Probe script overwrites with live medians when present. */
export const MEASURED_BASE_PRICES = {
  'gpt-5.6-sol': GPT_SOL,
  'gpt-5.5': GPT_SOL,
  'gpt-6-astra': GPT_SOL,
  'codex-auto-review': GPT_SOL,
  'gpt-5.6-terra': GPT_TERRA,
  'claude-fable-5': CLAUDE_FABLE,
  'claude-fable-5-1': CLAUDE_FABLE,
  'claude-fable-5-thinking': CLAUDE_FABLE,
  'claude-haiku-4-5-20251001': CLAUDE_HAIKU,
  'claude-haiku-4-5': CLAUDE_HAIKU,
  'claude-sonnet-4-20250514': CLAUDE_SONNET,
  'claude-sonnet-4': CLAUDE_SONNET,
  'deepseek-v4-flash': DEEPSEEK,
  'deepseek-chat': DEEPSEEK,
  'deepseek-v4-pro': DEEPSEEK_PRO,
  'gemini-2.5-flash': GEMINI_FLASH,
  'glm-5.1': GLM51,
  'glm-5.2': GLM52,
  'kimi-k3': KIMI_K3,
  'kimi-k2.6': KIMI_K26,
  'grok-4.5': GROK,
  'grok-4.6': GROK,
  'composer-2.5': COMPOSER,
  'grok-imagine-image': GROK_IMAGE
};

const FAMILY_RULES = [
  { test: /gpt-5\.6-terra/i, price: GPT_TERRA },
  { test: /gpt-|codex-/i, price: GPT_SOL },
  { test: /haiku/i, price: CLAUDE_HAIKU },
  { test: /sonnet/i, price: CLAUDE_SONNET },
  { test: /fable|opus|claude/i, price: CLAUDE_FABLE },
  { test: /gemini-.*image/i, price: GROK_IMAGE },
  { test: /gemini/i, price: GEMINI_FLASH },
  { test: /deepseek.*pro/i, price: DEEPSEEK_PRO },
  { test: /deepseek/i, price: DEEPSEEK },
  { test: /kimi-k3/i, price: KIMI_K3 },
  { test: /kimi/i, price: KIMI_K26 },
  { test: /glm-5\.[2-9]|glm-5\.3/i, price: GLM52 },
  { test: /glm/i, price: GLM51 },
  { test: /imagine|image/i, price: GROK_IMAGE },
  { test: /composer|grok-4\.20|grok-build/i, price: COMPOSER },
  { test: /grok/i, price: GROK }
];

export const CHANNEL_BASE_FALLBACK = {
  grp_gpt_pro: GPT_SOL,
  grp_gpt_plus: GPT_SOL,
  grp_gpt_mix: GPT_SOL,
  grp_aws_cc: CLAUDE_FABLE,
  grp_deepseek: DEEPSEEK,
  grp_cc_max: CLAUDE_SONNET,
  grp_glm: GLM51,
  grp_kimi: KIMI_K3,
  grp_grok_heavy: COMPOSER,
  grp_claude_kiro: CLAUDE_HAIKU,
  grp_claude_kiro_welfare: CLAUDE_FABLE,
  grp_cursor_pool: CLAUDE_SONNET
};

function copyPrice(src) {
  if (!src) return null;
  return {
    inputPricePer1K: Number(src.inputPricePer1K) || 0,
    outputPricePer1K: Number(src.outputPricePer1K) || 0,
    cacheReadPricePer1K: Number(src.cacheReadPricePer1K) || 0,
    cacheWritePricePer1K: Number(src.cacheWritePricePer1K) || 0
  };
}

export function familyPrice(model) {
  const name = String(model || '');
  for (const rule of FAMILY_RULES) {
    if (rule.test.test(name)) return copyPrice(rule.price);
  }
  return null;
}

export function catalogPrice(model, overlay = null) {
  const name = String(model || '');
  if (!name) return null;
  if (overlay?.[name]) return copyPrice(overlay[name]);
  if (MEASURED_BASE_PRICES[name]) return copyPrice(MEASURED_BASE_PRICES[name]);
  return familyPrice(name);
}

export function channelFallbackPrice(providerId) {
  return copyPrice(CHANNEL_BASE_FALLBACK[String(providerId || '')] || GPT_SOL);
}

function similarPrice(a, b) {
  const ai = Number(a?.inputPricePer1K) || 0;
  const bi = Number(b?.inputPricePer1K) || 0;
  if (!(ai > 0) || !(bi > 0)) return false;
  const ratio = ai > bi ? ai / bi : bi / ai;
  return ratio <= 4;
}

/** Merge live probe medians onto the seed table, then fill missing listed models via family. */
export function withFamilyFallbacks(measured = {}, listedModels = []) {
  const out = { ...MEASURED_BASE_PRICES };
  for (const [model, price] of Object.entries(measured || {})) {
    if (!(price?.inputPricePer1K > 0 || price?.outputPricePer1K > 0)) continue;
    const seed = MEASURED_BASE_PRICES[model];
    const samples = Number(price.samples) || 0;
    if (seed && !similarPrice(seed, price) && samples < 10) continue;
    out[model] = copyPrice(price);
  }
  for (const model of listedModels) {
    if (!out[model]) {
      const fam = familyPrice(model);
      if (fam) out[model] = fam;
    }
  }
  return out;
}

export function listedModelsFromProviders(providers) {
  const set = new Set();
  for (const p of providers || []) {
    if (p?.defaultModel) set.add(String(p.defaultModel));
    for (const m of p?.models || []) set.add(String(m));
  }
  return [...set];
}
