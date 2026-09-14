import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDiagnosticSuite } from '../diagnostics/run-suite.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-diag-'));
const dbFile = path.join(tmp, 'db.json');
fs.writeFileSync(dbFile, '{}');

function baseCtx(over = {}) {
  const db = {
    settings: {
      providers: [
        { id: 'grp_ok', name: '可用组', url: 'https://example.test/v1', enabled: true, defaultModel: 'm1', billingMultiplier: 2.5, displayMultiplier: 0.2 },
        { id: 'grp_chatfail', name: '对话失败组', url: 'https://example.test/v1', enabled: true, defaultModel: 'm2', billingMultiplier: 2.5, displayMultiplier: 0.5 },
        { id: 'grp_down', name: '挂掉组', url: 'https://example.test/v1', enabled: true, defaultModel: 'm3', billingMultiplier: 2.5, displayMultiplier: 0.1 },
        { id: 'grp_maint', name: '维护组', url: 'https://example.test/v1', enabled: true, maintenance: true, maintenanceMessage: '请联系站长购买', billingMultiplier: 2.5, displayMultiplier: 0.1 }
      ],
      paymentQrs: {
        wechat: { 10: 'https://cdn.example/wx10.png', 30: 'https://cdn.example/wx30.png', 50: 'https://cdn.example/wx50.png', 100: 'https://cdn.example/wx100.png' },
        alipay: { 10: 'https://cdn.example/ali10.png', 30: 'https://cdn.example/ali30.png', 50: 'https://cdn.example/ali50.png', 100: 'https://cdn.example/ali100.png' }
      },
      paymentQrMeta: { wechatExpiresAt: null, alipayExpiresAt: null }
    },
    rechargeCodes: [
      { code: 'R10-AAAAAA', amount: 10, usedAt: null, issuedAt: null },
      { code: 'R10-USED01', amount: 10, usedAt: '2026-01-01T00:00:00.000Z', issuedAt: null }
    ],
    ...over.db
  };
  if (over.db?.settings) db.settings = { ...db.settings, ...over.db.settings };
  if (over.db?.rechargeCodes) db.rechargeCodes = over.db.rechargeCodes;
  const { db: _ignoredDb, ...rest } = over;

  return {
    db,
    ensureVip1129Token: async () => ({ ok: true }),
    getVip1129Config: () => ({ enabled: false, email: '', password: '', groupMap: {} }),
    ensureBeibeihaiToken: async () => ({ ok: true }),
    getBeibeihaiConfig: () => ({ enabled: false, email: '', password: '', groupMap: {} }),
    isVip1129Provider: () => false,
    isBeibeihaiProvider: () => false,
    isMaintenanceProvider: (p) => !!p?.maintenance,
    probeProviderHealth: async (_db, p) => {
      if (p.id === 'grp_down') return { ok: false, error: '上游 401' };
      return { ok: true, count: 2, endpoint: p.url };
    },
    probeProviderChat: async (_db, p) => {
      if (p.id === 'grp_chatfail') return { ok: false, ms: 321, status: 429, error: 'rate limited', model: 'm2' };
      return { ok: true, ms: 88, model: p.defaultModel };
    },
    providerMultiplier: (p) => Number(p.billingMultiplier || 2.5),
    resolveDisplayMultiplier: (p) => Number(p.displayMultiplier || 0.2),
    poolStats: (d) => ({
      byAmount: [10, 30, 50, 100].map(amount => ({
        amount,
        available: (d.rechargeCodes || []).filter(c => Number(c.amount) === amount && !c.usedAt && !c.issuedAt).length
      }))
    }),
    codeAvailable: (c) => c && !c.usedAt && !c.issuedAt,
    PAYMENT_AMOUNTS: [10, 30, 50, 100],
    REFERRAL_REBATE_RATE: 0.05,
    gatewayReady: () => false,
    getPaymentGateway: () => ({ enabled: false }),
    paymentQrMeta: (d) => d.settings?.paymentQrMeta || {},
    paymentQrStatus: (expiresAt) => ({ expiresAt: expiresAt || null, expired: false, daysLeft: null, tip: '未设到期日' }),
    resolvePublicBaseUrl: () => 'https://example.test',
    fs,
    dbFile,
    tipsForCode: () => ['fix'],
    ...rest
  };
}

const byId = (report) => Object.fromEntries(report.results.map(r => [r.id, r]));

{
  const report = await runDiagnosticSuite(baseCtx());
  const m = byId(report);
  assert.equal(m.channel_grp_ok.ok, true);
  assert.equal(m.channel_grp_ok.latencyMs, 88);
  assert.equal(m.channel_grp_ok.billingMultiplier, 2.5);
  assert.equal(m.channel_grp_ok.displayMultiplier, 0.2);
  assert.match(m.channel_grp_ok.message, /延迟 88ms/);
  assert.match(m.channel_grp_ok.message, /扣费 2\.5x/);
  assert.match(m.channel_grp_ok.message, /展示 0\.2x/);

  assert.equal(m.channel_grp_chatfail.ok, false);
  assert.equal(m.channel_grp_chatfail.latencyMs, 321);
  assert.match(m.channel_grp_chatfail.detail, /rate limited/);

  assert.equal(m.channel_grp_down.ok, false);
  assert.match(m.channel_grp_down.detail, /401/);

  assert.equal(m.channel_grp_maint.ok, true);
  assert.equal(m.channel_grp_maint.level, 'warn');
  assert.match(m.channel_grp_maint.message, /请联系站长购买/);

  assert.equal(m.recharge_pool.ok, false);
  assert.match(m.recharge_pool.message, /无可用卡密/);
  assert.equal(m.recharge_invalid.ok, true);
  assert.equal(m.recharge_redeem.ok, true);
  assert.match(m.recharge_redeem.message, /已正确作废/);
  assert.match(m.recharge_redeem.message, /¥10→¥0\.50/);
  assert.equal(m.recharge_unique.ok, true);
  assert.equal(m.payment_qr.ok, true);
  assert.match(m.payment_qr.message, /未设到期日/);
}

{
  const report = await runDiagnosticSuite(baseCtx({
    db: {
      rechargeCodes: [
        { code: 'R10-AAAAAA', amount: 10, usedAt: null, issuedAt: null },
        { code: 'R30-BBBBBB', amount: 30, usedAt: null, issuedAt: null },
        { code: 'R50-CCCCCC', amount: 50, usedAt: null, issuedAt: null },
        { code: 'R100-DDDDDD', amount: 100, usedAt: null, issuedAt: null },
        { code: 'R10-USED01', amount: 10, usedAt: '2026-01-01T00:00:00.000Z' }
      ]
    }
  }));
  const m = byId(report);
  assert.equal(m.recharge_pool.ok, true);
  assert.match(m.recharge_pool.message, /¥10 余 1/);
}

{
  const report = await runDiagnosticSuite(baseCtx({
    db: {
      rechargeCodes: [
        { code: 'DUPCODE', amount: 10, usedAt: null, issuedAt: null },
        { code: 'DUPCODE', amount: 10, usedAt: '2026-01-01T00:00:00.000Z' }
      ]
    }
  }));
  const m = byId(report);
  assert.equal(m.recharge_unique.ok, false);
  assert.equal(m.recharge_redeem.ok, false);
  assert.match(m.recharge_redeem.message, /仍可兑换/);
}

{
  const report = await runDiagnosticSuite(baseCtx({
    paymentQrStatus: (expiresAt) => ({ expiresAt, expired: true, daysLeft: 0, tip: '已过期', status: undefined })
  }));
  const m = byId(report);
  assert.equal(m.payment_qr.ok, false);
  assert.match(m.payment_qr.message, /微信收款码已过期/);
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
console.log('diagnostics-suite.test.mjs: all assertions passed');
