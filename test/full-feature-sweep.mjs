/**
 * Isolated HTTP sweep of remaining user/admin/static/v1 surfaces.
 * Does not touch production db or real payment orders.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sweep-'));
const port = 19300 + Math.floor(Math.random() * 800);
const base = `http://127.0.0.1:${port}`;
const fails = [];

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    RELAY_DATA_DIR: tmp,
    RELAY_SKIP_BOOT_JOBS: '1',
    CODE_POOL_TARGET: '2',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'test-admin-pass',
    ADMIN_EMAIL: 'admin@example.com',
    VIP1129_EMAIL: '',
    VIP1129_PASSWORD: '',
    BEIBEIHAI_EMAIL: '',
    BEIBEIHAI_PASSWORD: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let out = '';
child.stdout.on('data', c => { out += c; });
child.stderr.on('data', c => { out += c; });

function waitForListen(ms = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), ms);
    const tick = () => {
      if (/Relay Station running/.test(out)) { clearTimeout(t); resolve(); }
      else if (child.exitCode != null) { clearTimeout(t); reject(new Error(`exited ${child.exitCode}:\n${out}`)); }
      else setTimeout(tick, 50);
    };
    tick();
  });
}

async function req(pathname, opts = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 200) }; }
  return { status: res.status, body, text, headers: res.headers };
}

function check(name, ok, detail) {
  if (!ok) fails.push(`${name}: ${detail || 'failed'}`);
}

try {
  await waitForListen();

  const home = await fetch(`${base}/`);
  check('GET /', home.status === 200, home.status);
  const html = await home.text();
  check('index has 登录', html.includes('登录控制台') || html.includes('登录'));

  for (const p of ['/terms.html', '/privacy.html', '/refund.html', '/admin-app/', '/payment-qr.svg']) {
    const r = await fetch(`${base}${p}`);
    check(`GET ${p}`, r.status === 200, r.status);
  }

  const cfg = await req('/api/config');
  check('GET /api/config', cfg.status === 200 && Array.isArray(cfg.body.paymentPlans), JSON.stringify(cfg.body).slice(0, 120));
  check('config rechargeHours', cfg.body.rechargeHours?.start === '08:30' && cfg.body.rechargeHours?.end === '23:30' && typeof cfg.body.rechargeHours?.open === 'boolean', JSON.stringify(cfg.body.rechargeHours));

  const guestDash = await req('/api/dashboard');
  check('dashboard guest 401', guestDash.status === 401, guestDash.status);

  const reg = await req('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: 'sweep@example.com',
      username: 'sweeper01',
      name: 'Sweeper',
      password: 'password1'
    })
  });
  check('register 201', reg.status === 201, JSON.stringify(reg.body));
  const userTok = { Authorization: `Bearer ${reg.body.token}` };

  const login = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login: 'sweeper01', password: 'password1' })
  });
  check('login 200', login.status === 200 && login.body.token, login.status);

  const me = await req('/api/me', { headers: userTok });
  check('GET /api/me', me.status === 200 && me.body.user?.username === 'sweeper01', JSON.stringify(me.body));

  const av = await req('/api/me', { method: 'PATCH', headers: userTok, body: JSON.stringify({ avatar: 'mint' }) });
  check('PATCH avatar mint', av.status === 200 && av.body.user?.avatar === 'mint', JSON.stringify(av.body));

  const dash = await req('/api/dashboard', { headers: userTok });
  check('dashboard billedTokens', dash.status === 200 && dash.body.stats && 'billedTokens' in dash.body.stats && 'totalSpent' in dash.body.stats, JSON.stringify(dash.body.stats));
  check('dashboard inviteCode', typeof dash.body.inviteCode === 'string' && dash.body.inviteCode.length > 0, dash.body.inviteCode);

  const models = await req('/api/models', { headers: userTok });
  check('GET /api/models', models.status === 200 && Array.isArray(models.body.models), models.status);
  const keyOpts = await req('/api/key-options', { headers: userTok });
  check('GET /api/key-options', keyOpts.status === 200, keyOpts.status);

  const keys0 = await req('/api/keys', { headers: userTok });
  check('GET /api/keys', keys0.status === 200 && Array.isArray(keys0.body.keys), keys0.status);
  const created = await req('/api/keys', {
    method: 'POST',
    headers: userTok,
    body: JSON.stringify({ name: 'sweep-key', enabled: true })
  });
  check('POST /api/keys', created.status === 201 && created.body.key?.id, JSON.stringify(created.body));
  const kid = created.body.key?.id;
  if (kid) {
    const put = await req(`/api/keys/${kid}`, {
      method: 'PUT',
      headers: userTok,
      body: JSON.stringify({ name: 'sweep-key-2', enabled: true })
    });
    check('PUT /api/keys/:id', put.status === 200, JSON.stringify(put.body));
    const rot = await req(`/api/keys/${kid}/rotate`, { method: 'POST', headers: userTok, body: '{}' });
    check('POST rotate key', rot.status === 200 && rot.body.key?.key, JSON.stringify(rot.body));
    const del = await req(`/api/keys/${kid}`, { method: 'DELETE', headers: userTok });
    check('DELETE /api/keys/:id', del.status === 200 || del.status === 204, del.status);
  }

  const k2 = await req('/api/keys', {
    method: 'POST',
    headers: userTok,
    body: JSON.stringify({ name: 'sweep-v1', enabled: true })
  });
  check('POST second key', k2.status === 201 && k2.body.key?.key, JSON.stringify(k2.body).slice(0, 160));
  const v1secret = k2.body.key?.key;
  if (v1secret) {
    const modelsAuth = await req('/v1/models', { headers: { Authorization: `Bearer ${v1secret}` } });
    check('GET /v1/models auth', modelsAuth.status === 200 && Array.isArray(modelsAuth.body.data) && modelsAuth.body.data.length > 0, JSON.stringify(modelsAuth.body).slice(0, 160));
    const chatBad = await req('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${v1secret}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    check('chat empty model not 401', chatBad.status !== 401 && chatBad.status !== 200, chatBad.status);
    const unknown = await req('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${v1secret}` },
      body: JSON.stringify({ model: 'zz-unknown-model-xyz', messages: [{ role: 'user', content: 'hi' }] })
    });
    check('unknown model 4xx', unknown.status >= 400 && unknown.status < 500, `${unknown.status} ${JSON.stringify(unknown.body).slice(0, 180)}`);
    check('unknown model not 200', unknown.status !== 200, unknown.status);
    check('unknown model json error', typeof unknown.body.error === 'string' || typeof unknown.body.error === 'object', JSON.stringify(unknown.body).slice(0, 180));
    const filesUnauth = await req('/v1/files', { method: 'POST', body: '{}' });
    check('POST /v1/files unauth', filesUnauth.status === 401 || filesUnauth.status === 403, filesUnauth.status);
    const files = await req('/v1/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${v1secret}` },
      body: JSON.stringify({ filename: 'probe-in.txt', content: 'AGENT_IO_OK_915', purpose: 'assistants' })
    });
    check('POST /v1/files json not html', !String(files.text || '').toLowerCase().includes('<html') && !String(files.body?.raw || '').toLowerCase().includes('page not found'), String(files.text || files.body?.raw || '').slice(0, 120));
    check('POST /v1/files not bare 404 html', files.status !== 404 || (files.body && files.body.error), `${files.status} ${JSON.stringify(files.body).slice(0, 160)}`);
    check('POST /v1/files api body', files.status === 200 || files.status === 501 || files.status === 401 || files.status === 400, files.status);
    const fileId = files.body?.id;
    if (fileId) {
      const listed = await req('/v1/files', { headers: { Authorization: `Bearer ${v1secret}` } });
      check('GET /v1/files list', listed.status === 200 && Array.isArray(listed.body.data) && listed.body.data.some((f) => f.id === fileId), JSON.stringify(listed.body).slice(0, 180));
      const got = await req(`/v1/files/${fileId}`, { headers: { Authorization: `Bearer ${v1secret}` } });
      check('GET /v1/files/:id', got.status === 200 && got.body.filename === 'probe-in.txt', JSON.stringify(got.body).slice(0, 180));
      const content = await req(`/v1/files/${fileId}/content`, { headers: { Authorization: `Bearer ${v1secret}` } });
      check('对话/读取文件 content', content.status === 200 && String(content.text || '').includes('AGENT_IO_OK_915'), String(content.text || '').slice(0, 120));
      const edited = await req(`/v1/files/${fileId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${v1secret}` },
        body: JSON.stringify({ filename: 'probe-in.txt', content: 'EDITED_OK' })
      });
      check('对话：修改文件', edited.status === 200 && edited.body.id === fileId, JSON.stringify(edited.body).slice(0, 160));
      const content2 = await req(`/v1/files/${fileId}/content`, { headers: { Authorization: `Bearer ${v1secret}` } });
      check('修改后读取文件', content2.status === 200 && String(content2.text || '').includes('EDITED_OK'), String(content2.text || '').slice(0, 120));
      const created = await req('/v1/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${v1secret}` },
        body: JSON.stringify({ filename: 'added.txt', content: 'NEW_FILE', purpose: 'assistants' })
      });
      check('对话：添加文件', created.status === 200 && created.body.id && created.body.filename === 'added.txt', JSON.stringify(created.body).slice(0, 160));
    }
  }

  const ci = await req('/api/checkin', { method: 'POST', headers: userTok, body: '{}' });
  check('checkin first', ci.status === 200 && Number(ci.body.amount) > 0, JSON.stringify(ci.body));
  const ci2 = await req('/api/checkin', { method: 'POST', headers: userTok, body: '{}' });
  check('checkin second 409', ci2.status === 409, ci2.status);
  const cis = await req('/api/checkin/status', { headers: userTok });
  check('checkin status', cis.status === 200 && cis.body.checkedInToday === true, JSON.stringify(cis.body));

  const adminLogin = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login: 'admin', password: 'test-admin-pass' })
  });
  check('admin login', adminLogin.status === 200, adminLogin.status);
  const adminTok = { Authorization: `Bearer ${adminLogin.body.token}` };

  const adminPages = [
    '/api/admin/pricing',
    '/api/admin/providers',
    '/api/admin/users',
    '/api/admin/codes?limit=20',
    '/api/admin/audit',
    '/api/admin/orders',
    '/api/admin/checkin',
    '/api/admin/code-pool',
    '/api/admin/billing-alerts',
    '/api/admin/security-alerts',
    '/api/admin/site-errors',
    '/api/admin/site-settings',
    '/api/admin/payment-gateway',
    '/api/admin/payment-qrs',
    '/api/admin/payment-orders',
    '/api/admin/mobile/inbox',
    '/api/admin/upstream-accounts',
    '/api/admin/upstream-beibeihai',
    '/api/admin/upstream-vip1129',
    '/api/admin/diagnostics/last'
  ];
  for (const p of adminPages) {
    const r = await req(p, { headers: adminTok });
    check(`admin GET ${p}`, r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    const g = await req(p);
    check(`guest ${p} forbidden`, g.status === 401 || g.status === 403, g.status);
  }
  const billingAlerts = await req('/api/admin/billing-alerts', { headers: adminTok });
  check('admin billing-alerts open defined', billingAlerts.status === 200 && typeof billingAlerts.body.open === 'number', `open=${billingAlerts.body.open}`);
  check('admin billing-alerts alerts array', Array.isArray(billingAlerts.body.alerts), JSON.stringify(billingAlerts.body).slice(0, 160));

  const pricing = await req('/api/admin/pricing', { headers: adminTok });
  check('dual rates', Number(pricing.body.multiplier) === 2.5 && Number(pricing.body.multiplierVip1129) === 1.5, JSON.stringify(pricing.body));
  check('estimate off by default', pricing.body.allowEstimatedBilling === false, JSON.stringify(pricing.body));

  const gwPut = await req('/api/admin/payment-gateway', {
    method: 'PUT',
    headers: adminTok,
    body: JSON.stringify({ enabled: false, pid: '', key: '', apiUrl: '', siteUrl: 'https://example.test' })
  });
  check('PUT payment-gateway', gwPut.status === 200, JSON.stringify(gwPut.body));

  const sitePut = await req('/api/admin/site-settings', {
    method: 'PUT',
    headers: adminTok,
    body: JSON.stringify({ publicBaseUrl: 'https://example.test', recommendedModel: 'gpt-5.6-terra' })
  });
  check('PUT site-settings', sitePut.status === 200 && sitePut.body.recommendedModel === 'gpt-5.6-terra', JSON.stringify(sitePut.body));

  const prep = await req('/api/recharge/prepare', {
    method: 'POST',
    headers: userTok,
    body: JSON.stringify({ amount: 10, method: 'alipay' })
  });
  check('prepare alipay', prep.status === 200 && prep.body.orderId, JSON.stringify(prep.body));
  const claim = await req('/api/recharge/claim', {
    method: 'POST',
    headers: userTok,
    body: JSON.stringify({ orderId: prep.body.orderId })
  });
  check('claim paid', claim.status === 200, JSON.stringify(claim.body));
  const rej = await req(`/api/admin/payment-orders/${encodeURIComponent(prep.body.orderId)}/reject`, {
    method: 'POST',
    headers: adminTok,
    body: JSON.stringify({ reason: 'sweep-test' })
  });
  check('reject order', rej.status === 200 && rej.body.order?.status === 'rejected', JSON.stringify(rej.body));
  const userWait = await req('/api/recharge/wait?after=0&timeoutMs=400', { headers: userTok });
  check('user wait after reject', userWait.status === 200 && (userWait.body.events || []).some(e => e.kind === 'rejected' && e.orderId === prep.body.orderId), JSON.stringify(userWait.body.events));

  const orders = await req('/api/recharge/orders', { headers: userTok });
  check('user orders', orders.status === 200 && Array.isArray(orders.body.orders), orders.status);

  const gen = await req('/api/admin/codes', {
    method: 'POST',
    headers: adminTok,
    body: JSON.stringify({ count: 1, amount: 7, quotaTokens: 1000, prefix: 'SWP' })
  });
  check('POST /api/admin/codes', gen.status === 201 && Array.isArray(gen.body.codes) && gen.body.codes[0]?.code, JSON.stringify(gen.body).slice(0, 200));
  const card = gen.body.codes?.[0]?.code;
  const balBefore = Number((await req('/api/me', { headers: userTok })).body.user?.balance) || 0;
  if (card) {
    const rd = await req('/api/recharge/redeem', {
      method: 'POST',
      headers: userTok,
      body: JSON.stringify({ code: card })
    });
    check('redeem code', rd.status === 200 && Number(rd.body.user?.balance) >= balBefore + 7, JSON.stringify(rd.body).slice(0, 200));
    const rd2 = await req('/api/recharge/redeem', {
      method: 'POST',
      headers: userTok,
      body: JSON.stringify({ code: card })
    });
    check('redeem reused 400', rd2.status === 400, rd2.status);
  }

  const usersQ = await req('/api/admin/users?q=sweeper01', { headers: adminTok });
  check('admin users search', usersQ.status === 200 && usersQ.body.users?.some(u => u.username === 'sweeper01'), JSON.stringify(usersQ.body).slice(0, 160));
  const sweepId = (usersQ.body.users || []).find(u => u.username === 'sweeper01')?.id;
  if (sweepId) {
    const bump = await req(`/api/admin/users/${encodeURIComponent(sweepId)}`, {
      method: 'PUT',
      headers: adminTok,
      body: JSON.stringify({ balanceDelta: 1.25 })
    });
    check('admin balanceDelta', bump.status === 200 && Number(bump.body.user?.balance) > 0, JSON.stringify(bump.body).slice(0, 200));
  }

  const prep2 = await req('/api/recharge/prepare', {
    method: 'POST',
    headers: userTok,
    body: JSON.stringify({ amount: 10, method: 'wechat' })
  });
  check('prepare wechat', prep2.status === 200 && prep2.body.orderId, JSON.stringify(prep2.body));
  const conf = await req(`/api/admin/payment-orders/${encodeURIComponent(prep2.body.orderId)}/confirm`, {
    method: 'POST',
    headers: adminTok,
    body: '{}'
  });
  check('confirm order', conf.status === 200 && conf.body.order?.status === 'confirmed' && conf.body.order?.code, JSON.stringify(conf.body).slice(0, 240));
  if (conf.body.order?.code) {
    const rd3 = await req('/api/recharge/redeem', {
      method: 'POST',
      headers: userTok,
      body: JSON.stringify({ code: conf.body.order.code })
    });
    check('redeem confirmed card', rd3.status === 200, JSON.stringify(rd3.body).slice(0, 200));
  }

  const errClr = await req('/api/admin/site-errors', { method: 'DELETE', headers: adminTok });
  check('DELETE site-errors', errClr.status === 200, errClr.status);

  const pricePut = await req('/api/admin/pricing', {
    method: 'PUT',
    headers: adminTok,
    body: JSON.stringify({ multiplier: 2.5, multiplierVip1129: 1.5, allowEstimatedBilling: false })
  });
  check('PUT pricing restore', pricePut.status === 200 && Number(pricePut.body.multiplier) === 2.5, JSON.stringify(pricePut.body).slice(0, 160));

  const v1 = [
    ['GET', '/v1/models'],
    ['POST', '/v1/chat/completions'],
    ['POST', '/v1/messages'],
    ['POST', '/v1/responses'],
    ['POST', '/v1/files'],
    ['POST', '/api/chat']
  ];
  for (const [method, p] of v1) {
    const r = await req(p, { method, body: method === 'GET' ? undefined : JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] }) });
    check(`${method} ${p} unauth`, r.status === 401 || r.status === 403, r.status);
  }

  const gem = await req('/v1beta/models/gemini-2.5-flash:generateContent', {
    method: 'POST',
    body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] })
  });
  check('gemini unauth', gem.status === 401 || gem.status === 403, gem.status);

  const lo = await req('/api/auth/logout', { method: 'POST', headers: userTok, body: '{}' });
  check('logout', lo.status === 200 || lo.status === 204, lo.status);

  if (fails.length) {
    console.error('full-feature-sweep FAILED:\n' + fails.map(x => ' - ' + x).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('full-feature-sweep.mjs: all assertions passed');
  }
} finally {
  child.kill('SIGTERM');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
