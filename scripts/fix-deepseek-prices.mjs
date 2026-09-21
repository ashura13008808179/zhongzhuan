/**
 * Write DeepSeek channel prices from live official bills:
 * 35 in / 32 out → input 0.00015 / output 0.0006 元/1K (BASE, before group 0.5).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenFloorCost } from '../lib/billing-cost.js';
import { catalogPrice } from '../lib/upstream-prices.js';
import { openDbDir } from '../lib/db-crypto.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const txt = fs.readFileSync(path.join(root, 'start-local.ps1'), 'utf8');
for (const m of txt.matchAll(/\$env:(\w+)\s*=\s*"([^"]*)"/g)) {
  if (!process.env[m[1]]) process.env[m[1]] = m[2];
}

const flash = catalogPrice('deepseek-v4-flash');
const pro = catalogPrice('deepseek-v4-pro');
const nowIso = new Date().toISOString();
const dbStore = openDbDir(path.join(root, 'data'));
const db = dbStore.read();
const provider = (db.settings.providers || []).find((p) => p.id === 'grp_deepseek');
if (!provider) {
  console.error(JSON.stringify({ ok: false, error: 'missing_grp_deepseek' }));
  process.exit(1);
}

const listed = new Set([provider.defaultModel, ...(provider.models || [])].filter(Boolean));
const next = {};
for (const [model, price] of Object.entries(provider.modelPrices || {})) {
  if (listed.has(model) && !/deepseek/i.test(model)) next[model] = price;
}
function stamp(model, src) {
  next[model] = {
    inputPricePer1K: src.inputPricePer1K,
    outputPricePer1K: src.outputPricePer1K,
    cacheReadPricePer1K: src.cacheReadPricePer1K,
    cacheWritePricePer1K: src.cacheWritePricePer1K || src.inputPricePer1K,
    source: 'official_actual',
    calibratedAt: nowIso
  };
}
stamp('deepseek-v4-flash', flash);
stamp('deepseek-chat', flash);
stamp('deepseek-v4-pro', pro);
provider.modelPrices = next;
provider.inputPricePer1K = flash.inputPricePer1K;
provider.outputPricePer1K = flash.outputPricePer1K;
provider.cacheReadPricePer1K = flash.cacheReadPricePer1K;
provider.cacheWritePricePer1K = flash.cacheWritePricePer1K || flash.inputPricePer1K;

const table = tokenFloorCost(provider, {
  prompt_tokens: 35,
  completion_tokens: 32,
  cache_read_tokens: 0
}, 'deepseek-v4-flash');

dbStore.write(db);
console.log(JSON.stringify({
  ok: true,
  flash,
  pro,
  tableCost35in32out: table,
  officialActual: 0.000012225,
  match: Math.abs(table - 0.000012225) < 1e-12
}, null, 2));
