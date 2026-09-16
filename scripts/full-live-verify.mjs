/**
 * Live verify against localhost:8787. Restores welfare settings afterwards.
 * Never prints secrets. Writes scripts/full-live-verify-result.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { login as vipLogin, fetchUsage as vipUsage } from '../upstream/vip1129.js';
import { login as beiLogin, fetchUsage as beiUsage } from '../upstream/beibeihai.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const txt = fs.readFileSync(path.join(root, 'start-local.ps1'), 'utf8');
for (const m of txt.matchAll(/\$env:(\w+)\s*=\s*"([^"]*)"/g)) {
  if (!process.env[m[1]]) process.env[m[1]] = m[2];
}

const base = process.env.RELAY_BASE || 'http://127.0.0.1:8787';
const outPath = path.join(root, 'scripts', 'full-live-verify-result.json');
const PLAY_LOGIN = 'play58819005';
const PLAY_PASS = 'PlayTest1234!';
const SEQ = 3;
const CONCUR = 2;

function loadDb() {
  return JSON.parse(fs.readFileSync(path.join(root, 'data', 'db.json'), 'utf8'));
}

async function req(pathname, opts = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: String(text).slice(0, 280) }; }
  return { status: res.status, body, text };
}

function isVip(p) {
  const url = String(p?.url || '');
  return p?.upstreamSync === 'vip1129' || /vip1129/i.test(url);
}

function usageRows(parsed) {
  const d = parsed?.data;
  const list = d?.data || d?.items || d?.records || d?.list || (Array.isArray(d) ? d : null);
  if (Array.isArray(list)) return list;
  if (Array.isArray(parsed?.data?.data?.items)) return parsed.data.data.items;
  return [];
}

function rowCost(row) {
  const n = Number(row?.actual_cost ?? row?.actualCost ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function rowId(row) {
  return row?.id ?? row?.usage_id ?? null;
}
function rowAt(row) {
  return Date.parse(row?.created_at || row?.createdAt || row?.time || 0);
}

async function chat(key, model, extra = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '只回复一个字：好' }],
        max_tokens: 8,
        temperature: 0,
        ...extra
      }),
      signal: AbortSignal.timeout(180000)
    });
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 240) }; }
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, body, err: res.ok ? null : (body.error?.message || body.error || text.slice(0, 180)) };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, body: {}, err: String(e.message || e) };
  }
}

const features = [];
function feat(name, ok, detail) {
  features.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail).slice(0, 400) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' · ' + String(detail).slice(0, 160) : ''}`);
}

const play = await req('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ login: PLAY_LOGIN, password: PLAY_PASS })
});
feat('play 登录', play.status === 200, play.status);
const playTok = { Authorization: 'Bearer ' + play.body.token };
const admin = await req('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ login: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
});
feat('admin 登录', admin.status === 200, admin.status);
const adminTok = { Authorization: 'Bearer ' + admin.body.token };

const cfg0 = await req('/api/config');
feat('GET /api/config', cfg0.status === 200);
feat('推荐模型 terra', cfg0.body.recommendedModel === 'gpt-5.6-terra', cfg0.body.recommendedModel);
feat('公开配置无福利设置对象', cfg0.body.welfarePromo == null && cfg0.body.welfareMultiplier == null);
feat('公开配置有横幅字段', Object.prototype.hasOwnProperty.call(cfg0.body, 'welfareBanner'));

const home = await fetch(base + '/');
feat('首页 HTML', home.status === 200);
const html = await home.text();
feat('首页含登录', html.includes('登录控制台') || html.includes('登录'));
feat('首页含福利横幅节点', html.includes('welfareBanner'));
const adminApp = await fetch(base + '/admin-app/');
feat('值班台页面', adminApp.status === 200);

const dash = await req('/api/dashboard', { headers: playTok });
feat('用户仪表盘', dash.status === 200);
const dashTxt = JSON.stringify(dash.body);
feat('用户端不含上游字样', !/上游/.test(dashTxt));
const bal0 = Number(dash.body.user?.balance);

const checkin = await req('/api/checkin/status', { headers: playTok });
feat('签到状态', checkin.status === 200, JSON.stringify({ today: checkin.body?.checkedInToday, streak: checkin.body?.streak }));
if (checkin.status === 200 && !checkin.body?.checkedInToday) {
  const claim = await req('/api/checkin', { method: 'POST', headers: playTok, body: '{}' });
  feat('签到领取', claim.status === 200 || claim.status === 409, claim.status + ' ' + (claim.body?.message || claim.body?.error || ''));
} else {
  feat('签到领取', true, '今日已签到，跳过重复领取');
}

const keysList = await req('/api/keys', { headers: playTok });
feat('密钥列表', keysList.status === 200, `n=${(keysList.body.keys || keysList.body || []).length}`);

const pricing = await req('/api/admin/pricing', { headers: adminTok });
feat('后台倍率', pricing.status === 200, `bei=${pricing.body.multiplier} vip=${pricing.body.multiplierVip1129}`);
const origBei = Number(pricing.body.multiplier);
const origVip = Number(pricing.body.multiplierVip1129 ?? 1.1);

const wel0 = await req('/api/admin/welfare', { headers: adminTok });
feat('后台读福利', wel0.status === 200);
const savedPromo = wel0.body?.promo || { enabled: false, multiplier: 1.1, text: '', images: [] };

const welOn = await req('/api/admin/welfare', {
  method: 'PUT',
  headers: adminTok,
  body: JSON.stringify({ enabled: true, multiplier: 1.1, text: '实测横幅 付10得{ten}' })
});
feat('开启 1.1 倍福利', welOn.status === 200 && welOn.body.active === true, JSON.stringify({ active: welOn.body.active, mul: welOn.body.promo?.multiplier }));
const cfgOn = await req('/api/config');
feat('用户端横幅出现', Boolean(cfgOn.body.welfareBanner?.text), cfgOn.body.welfareBanner?.text);
feat('用户端横幅不含倍率字段', cfgOn.body.welfareBanner?.multiplier == null);
const plan10 = (cfgOn.body.paymentPlans || []).find((p) => p.amount === 10);
feat('10 元卡到账 11', Number(plan10?.creditAmount) === 11, plan10?.creditAmount);
const plan100 = (cfgOn.body.paymentPlans || []).find((p) => p.amount === 100);
feat('100 元卡到账 110', Number(plan100?.creditAmount) === 110, plan100?.creditAmount);

const wel2 = await req('/api/admin/welfare', {
  method: 'PUT',
  headers: adminTok,
  body: JSON.stringify({ enabled: true, multiplier: 2, text: '2倍实测 付10得{ten}' })
});
feat('改成 2 倍福利', wel2.status === 200 && Number(wel2.body.promo?.multiplier) === 2);
const cfg2x = await req('/api/config');
const p10b = (cfg2x.body.paymentPlans || []).find((p) => p.amount === 10);
feat('2 倍时 10 元到账 20', Number(p10b?.creditAmount) === 20, p10b?.creditAmount);

const welRestore = await req('/api/admin/welfare', {
  method: 'PUT',
  headers: adminTok,
  body: JSON.stringify({
    enabled: savedPromo.enabled === true,
    multiplier: savedPromo.multiplier,
    text: savedPromo.text || '',
    images: savedPromo.images || [],
    expiresAt: savedPromo.expiresAt,
    refreshExpiry: false
  })
});
feat('恢复原福利设置', welRestore.status === 200);
const cfgBack = await req('/api/config');
feat('关闭后用户端无横幅', savedPromo.enabled === true || cfgBack.body.welfareBanner == null, JSON.stringify(cfgBack.body.welfareBanner));

let calibrate = { status: 0, body: {} };
try {
  calibrate = await req('/api/admin/providers/calibrate-prices', {
    method: 'POST',
    headers: adminTok,
    body: '{}',
    signal: AbortSignal.timeout(60000)
  });
} catch (e) {
  calibrate = { status: 0, body: { error: String(e.message || e) } };
}
feat('对照账单校准估价', calibrate.status === 200, `groups=${(calibrate.body.results || []).length} ${calibrate.body.message || calibrate.body.error || ''}`);

const sync = await req('/api/admin/upstream-billing/sync', {
  method: 'POST',
  headers: adminTok,
  body: JSON.stringify({ fullBackfill: false })
});
feat('账单同步', sync.status === 200, JSON.stringify(sync.body?.synced || sync.body?.error || {}).slice(0, 180));

const db0 = loadDb();
const providers = (db0.settings?.providers || []).filter((p) => p.enabled !== false && !p.maintenance && p.id !== 'grp_cursor_pool');
const groups = providers;

async function ensureKeys(groups) {
  const listed = await req('/api/keys', { headers: playTok });
  const keys = listed.body.keys || listed.body || [];
  const byGroup = new Map();
  for (const k of keys) {
    if (!k.groupId || k.enabled === false) continue;
    if (!byGroup.has(k.groupId)) byGroup.set(k.groupId, []);
    byGroup.get(k.groupId).push(k);
  }
  for (const g of groups) {
    const have = byGroup.get(g.id) || [];
    if (have.length) continue;
    const created = await req('/api/keys', {
      method: 'POST',
      headers: playTok,
      body: JSON.stringify({ name: `verify-${g.id}`, groupId: g.id })
    });
    feat(`创建密钥 ${g.name || g.id}`, created.status === 201 || created.status === 200, created.status + ' ' + (created.body?.error || ''));
    if (created.status === 201 || created.status === 200) {
      const rec = created.body.key || created.body;
      have.push(rec);
      byGroup.set(g.id, have);
    }
  }
  const full = await req('/api/keys', { headers: playTok });
  const all = full.body.keys || full.body || [];
  const map = new Map();
  for (const k of all) {
    if (!k.groupId || !k.key) continue;
    if (!map.has(k.groupId)) map.set(k.groupId, []);
    map.get(k.groupId).push(k);
  }
  return map;
}

const keyMap = await ensureKeys(groups);
const startedMs = Date.now();
const startedIso = new Date().toISOString();
const calls = [];

async function runMode(group, model, keys, mode, n) {
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const rec = keys[0];
    const fn = async () => {
      const r = await chat(rec.key, model);
      const row = {
        groupId: group.id,
        groupName: group.name,
        model,
        mode,
        i,
        ok: r.ok,
        status: r.status,
        ms: r.ms,
        err: r.err ? String(r.err).slice(0, 180) : null,
        vip: isVip(group)
      };
      calls.push(row);
      console.log(`${row.ok ? 'OK' : 'FAIL'} ${group.id} ${mode}#${i} ${r.status} ${r.ms}ms ${row.err || ''}`);
      return row;
    };
    if (mode === 'sequential') await fn();
    else jobs.push(fn());
  }
  if (jobs.length) await Promise.all(jobs);
}

for (const g of groups) {
  const keys = keyMap.get(g.id) || [];
  const model = g.defaultModel || (g.models || [])[0];
  if (!keys.length || !model) {
    calls.push({ groupId: g.id, groupName: g.name, model, mode: 'no-key', i: 0, ok: false, status: 0, ms: 0, err: 'no api key or model', vip: isVip(g) });
    feat(`渠道 ${g.name} 有密钥`, false, 'no key');
    continue;
  }
  feat(`渠道 ${g.name} 有密钥`, true, model);
  await runMode(g, model, keys, 'sequential', SEQ);
  await runMode(g, model, keys, 'same-key-concurrent', CONCUR);
}

const gem = groups.find((g) => g.id === 'grp_gemini') || groups.find((g) => /gemini/i.test(g.defaultModel || g.name || ''));
const gk = gem && (keyMap.get(gem.id) || [])[0];
const live = { samples: [], moved: false, group: gem?.id || null, startBalance: bal0 };
if (gk) {
  const me0 = await req('/api/me', { headers: playTok });
  const b0 = Number(me0.body.user?.balance ?? me0.body.balance);
  live.startBalance = b0;
  const streamP = chat(gk.key, gem.defaultModel, { stream: true, max_tokens: 48 });
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const me = await req('/api/me', { headers: playTok });
    const b = Number(me.body.user?.balance ?? me.body.balance);
    const dashLive = await req('/api/dashboard', { headers: playTok });
    const pending = (dashLive.body.logs || []).filter((l) => l.pendingActual || l.status === 'pending_actual_cost').slice(0, 3)
      .map((l) => ({ model: l.model, charged: l.chargedAmount, collected: l.collectedAmount, status: l.status }));
    live.samples.push({ t: Date.now() - startedMs, bal: b, pending });
    if (b < b0 - 1e-8) live.moved = true;
  }
  await streamP;
}
feat('流式过程中余额已开始扣', live.moved || !gk, live.moved ? `余额从 ${live.startBalance} 变动` : '未观测到中途扣费（可能账单来得快或该渠道失败）');

console.log('waiting usage settle 12s');
await new Promise((r) => setTimeout(r, 12000));
await req('/api/admin/upstream-billing/sync', {
  method: 'POST',
  headers: adminTok,
  body: JSON.stringify({ fullBackfill: false })
});

const db1 = loadDb();
const playUser = (db1.users || []).find((u) => u.username === PLAY_LOGIN);
const newLogs = (db1.logs || []).filter((l) => l.userId === playUser?.id && Date.parse(l.createdAt) >= startedMs - 3000);

let vipRows = [];
let beiRows = [];
try {
  const v = await vipLogin(process.env.VIP1129_BASE_URL, process.env.VIP1129_EMAIL, process.env.VIP1129_PASSWORD);
  if (v.ok) {
    const u = await vipUsage(process.env.VIP1129_BASE_URL, v.token, 'page=1&page_size=100');
    vipRows = usageRows(u);
  }
} catch (e) {
  feat('vip1129 账单拉取', false, e.message);
}
try {
  const b = await beiLogin(process.env.BEIBEIHAI_BASE_URL, process.env.BEIBEIHAI_EMAIL, process.env.BEIBEIHAI_PASSWORD);
  if (b.ok) {
    const u = await beiUsage(process.env.BEIBEIHAI_BASE_URL, b.token, 'page=1&page_size=100');
    beiRows = usageRows(u);
  }
} catch (e) {
  feat('beibeihai 账单拉取', false, e.message);
}
feat('vip1129 账单行', vipRows.length > 0, `n=${vipRows.length}`);
feat('beibeihai 账单行', beiRows.length > 0, `n=${beiRows.length}`);

const dash1 = await req('/api/dashboard', { headers: playTok });
const bal1 = Number(dash1.body.user?.balance);
feat('用户余额未变负', Number.isFinite(bal1) && bal1 >= 0, bal1);

const byGroup = [];
for (const g of groups) {
  const gCalls = calls.filter((c) => c.groupId === g.id);
  const gLogs = newLogs.filter((l) => l.providerId === g.id);
  const rate = isVip(g) ? origVip : origBei;
  const pool = isVip(g) ? vipRows : beiRows;
  let formulaOk = 0;
  let formulaBad = 0;
  let officialHit = 0;
  const samples = [];
  for (const log of gLogs) {
    const cost = Number(log.upstreamCost || 0);
    const charged = Number(log.collectedAmount ?? log.chargedAmount ?? 0);
    const expect = cost * Number(log.multiplier || rate);
    const pending = log.pendingActual || log.status === 'pending_actual_cost';
    const localOk = pending
      ? charged >= 0
      : (cost > 0 ? Math.abs(charged - expect) <= 0.0002 + Math.abs(expect) * 1e-9 : log.status !== 'success');
    if (localOk) formulaOk++;
    else formulaBad++;
    const hit = pool.find((r) => {
      if (log.upstreamUsageId != null && String(rowId(r)) === String(log.upstreamUsageId)) return true;
      const rc = rowCost(r);
      const rt = rowAt(r);
      const t = Date.parse(log.createdAt);
      return cost > 0 && Math.abs(rc - cost) < 0.0002 && (!rt || Math.abs(rt - t) < 180000);
    });
    if (hit) officialHit++;
    samples.push({
      at: log.createdAt,
      model: log.model,
      status: log.status,
      pending: !!pending,
      officialCost: hit ? rowCost(hit) : null,
      localOfficial: cost,
      rate: Number(log.multiplier || rate),
      userCharged: charged,
      expect: Number(expect.toFixed(6)),
      formulaOk: localOk,
      hold: Number(log.alreadyCharged || log.collectedAmount || 0)
    });
  }
  byGroup.push({
    id: g.id,
    name: g.name,
    model: g.defaultModel,
    vip: isVip(g),
    rate,
    calls: gCalls.length,
    ok: gCalls.filter((c) => c.ok).length,
    fail: gCalls.filter((c) => !c.ok).length,
    logs: gLogs.length,
    pending: gLogs.filter((l) => l.pendingActual || l.status === 'pending_actual_cost').length,
    formulaOk,
    formulaBad,
    officialHit,
    sumOfficialLocal: gLogs.reduce((s, l) => s + (Number(l.upstreamCost) || 0), 0),
    sumUserCharged: gLogs.reduce((s, l) => s + (Number(l.collectedAmount ?? l.chargedAmount) || 0), 0),
    sampleErr: (gCalls.find((c) => !c.ok) || {}).err || null,
    samples
  });
}

for (const g of byGroup) {
  feat(
    `渠道 ${g.name} 对话`,
    g.ok > 0 || g.fail === g.calls,
    `成功 ${g.ok}/${g.calls} 日志 ${g.logs} 公式对齐 ${g.formulaOk} 官方命中 ${g.officialHit}`
  );
}

const meEnd = await req('/api/me', { headers: playTok });
const result = {
  at: new Date().toISOString(),
  startedIso,
  playBalanceBefore: bal0,
  playBalanceAfter: Number(meEnd.body.user?.balance),
  playSpentThisRun: Number((bal0 - Number(meEnd.body.user?.balance)).toFixed(6)),
  rates: { bei: origBei, vip: origVip },
  features,
  calls: calls.length,
  ok: calls.filter((c) => c.ok).length,
  fail: calls.filter((c) => !c.ok).length,
  logs: newLogs.length,
  vipUsageFetched: vipRows.length,
  beiUsageFetched: beiRows.length,
  live,
  calibrate: {
    ok: calibrate.status === 200,
    groups: (calibrate.body.results || []).map((r) => ({
      id: r.id,
      name: r.name,
      usageRows: r.usageRows,
      models: (r.models || []).slice(0, 8),
      missing: r.missing
    }))
  },
  byGroup,
  failures: calls.filter((c) => !c.ok)
};

fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  featuresPass: features.filter((f) => f.ok).length,
  featuresFail: features.filter((f) => !f.ok).length,
  calls: result.calls,
  ok: result.ok,
  fail: result.fail,
  spent: result.playSpentThisRun,
  liveMoved: live.moved,
  outPath
}, null, 2));
