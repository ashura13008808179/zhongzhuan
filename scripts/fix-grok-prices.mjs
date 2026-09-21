/**
 * Write grok-4.6 channel prices from live official bills (10 calls, 2026-09-19).
 * Output 0.0066 / 1K; input+cache scaled to keep cache = 15% of input.
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

const samples = [
  { in: 84, out: 232, cache: 128, official: 0.00017864 },
  { in: 84, out: 290, cache: 128, official: 0.00021692 },
  { in: 84, out: 200, cache: 128, official: 0.00015752 },
  { in: 84, out: 404, cache: 128, official: 0.00029216 },
  { in: 84, out: 255, cache: 128, official: 0.00019382 },
  { in: 84, out: 208, cache: 128, official: 0.0001628 },
  { in: 84, out: 191, cache: 128, official: 0.00015158 },
  { in: 84, out: 241, cache: 128, official: 0.00018458 },
  { in: 84, out: 319, cache: 128, official: 0.00023606 },
  { in: 84, out: 255, cache: 128, official: 0.00019382 }
];

const src = catalogPrice('grok-4.6');
const nowIso = new Date().toISOString();
const dbStore = openDbDir(path.join(root, 'data'));
const db = dbStore.read();
const provider = (db.settings.providers || []).find((p) => p.id === 'grp_grok_heavy');
if (!provider) {
  console.error(JSON.stringify({ ok: false, error: 'missing_grp_grok_heavy' }));
  process.exit(1);
}

provider.modelPrices = { ...(provider.modelPrices || {}) };
function stamp(model) {
  provider.modelPrices[model] = {
    inputPricePer1K: src.inputPricePer1K,
    outputPricePer1K: src.outputPricePer1K,
    cacheReadPricePer1K: src.cacheReadPricePer1K,
    cacheWritePricePer1K: src.cacheWritePricePer1K || src.inputPricePer1K,
    source: 'official_actual',
    calibratedAt: nowIso,
    samples: samples.length
  };
}
stamp('grok-4.6');
stamp('grok-4.6-latest');

const checks = samples.map((s) => {
  const table = tokenFloorCost(provider, {
    prompt_tokens: s.in,
    completion_tokens: s.out,
    cache_read_tokens: s.cache
  }, 'grok-4.6');
  const rel = Math.abs(table - s.official) / s.official;
  return {
    out: s.out,
    official: s.official,
    table: Number(table.toFixed(8)),
    rel: Number(rel.toFixed(8)),
    ok: rel <= 0.08 || Math.abs(table - s.official) <= 1e-10
  };
});

dbStore.write(db);
console.log(JSON.stringify({
  ok: checks.every((c) => c.ok),
  src,
  checks,
  maxRel: Math.max(...checks.map((c) => c.rel))
}, null, 2));
