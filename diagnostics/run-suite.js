/**
 * Admin diagnostic suite. Caller injects helpers from server.js.
 * Each result: { id, name, ok, level, message, detail?, fix[], latencyMs?, billingMultiplier?, displayMultiplier? }
 */
import path from 'node:path';

export async function runDiagnosticSuite(ctx) {
  const {
    db,
    ensureVip1129Token,
    getVip1129Config,
    ensureBeibeihaiToken,
    getBeibeihaiConfig,
    isVip1129Provider,
    isBeibeihaiProvider,
    isMaintenanceProvider,
    probeProviderHealth,
    probeProviderChat,
    providerMultiplier,
    resolveDisplayMultiplier,
    poolStats,
    codeAvailable,
    PAYMENT_AMOUNTS,
    REFERRAL_REBATE_RATE,
    gatewayReady,
    getPaymentGateway,
    paymentQrMeta,
    paymentQrStatus,
    resolvePublicBaseUrl,
    fs,
    dbFile,
    tipsForCode
  } = ctx;

  const fmtRate = (n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return '?';
    return String(Math.round(x * 10000) / 10000);
  };

  const qrLabel = (st) => {
    if (!st) return '未知';
    if (st.expired) return '已过期';
    if (st.daysLeft != null) return `剩余 ${st.daysLeft} 天`;
    return st.tip || '未设到期日';
  };

  const localAssetExists = (p) => {
    const raw = String(p || '').trim();
    if (!raw) return false;
    if (/^https?:\/\//i.test(raw) || raw.startsWith('data:')) return true;
    const rel = raw.replace(/^[\\/]+/, '').replace(/\//g, path.sep);
    const roots = [process.cwd(), path.join(process.cwd(), 'public')];
    return roots.some(root => {
      try { return fs.existsSync(path.join(root, rel)); } catch { return false; }
    });
  };

  const results = [];
  const push = (r) => {
    const { id, name, ok, level, message, detail, fix, ...extra } = r;
    results.push({
      id,
      name,
      ok: !!ok,
      level: level || (ok ? 'ok' : 'error'),
      message,
      detail: detail || null,
      fix: fix || [],
      ...extra
    });
  };

  // 1) DB writable
  try {
    const dir = dbFile.replace(/[/\\][^/\\]+$/, '');
    fs.accessSync(dir, fs.constants.W_OK);
    const probePath = dbFile + '.diag-probe';
    fs.writeFileSync(probePath, 'ok');
    fs.unlinkSync(probePath);
    push({ id: 'db_writable', name: '数据库可写', ok: true, message: 'data/db.json 所在目录可写' });
  } catch (err) {
    push({
      id: 'db_writable', name: '数据库可写', ok: false, level: 'error',
      message: '无法写入数据目录',
      detail: String(err.message || err),
      fix: tipsForCode('db_write')
    });
  }

  // 2) vip1129 login
  {
    const cfg = getVip1129Config(db);
    if (!cfg.enabled) {
      push({ id: 'vip1129_login', name: 'vip1129 登录', ok: true, level: 'warn', message: '同步已关闭（跳过）', fix: tipsForCode('upstream_disabled') });
    } else if (!cfg.email || !cfg.password) {
      push({ id: 'vip1129_login', name: 'vip1129 登录', ok: false, message: '缺少登录邮箱或密码', fix: tipsForCode('missing_credentials') });
    } else {
      const auth = await ensureVip1129Token(db);
      if (auth.ok) push({ id: 'vip1129_login', name: 'vip1129 登录', ok: true, message: `登录成功（${cfg.email}）` });
      else push({ id: 'vip1129_login', name: 'vip1129 登录', ok: false, message: '登录失败', detail: auth.error, fix: tipsForCode('login_failed') });
    }
  }

  // 3) beibeihai login
  {
    const cfg = getBeibeihaiConfig(db);
    if (!cfg.enabled) {
      push({ id: 'beibeihai_login', name: 'Beibeihai 登录', ok: true, level: 'warn', message: '同步已关闭（跳过）', fix: tipsForCode('upstream_disabled') });
    } else if (!cfg.email || !cfg.password) {
      push({ id: 'beibeihai_login', name: 'Beibeihai 登录', ok: false, message: '缺少登录邮箱或密码', fix: tipsForCode('missing_credentials') });
    } else {
      const auth = await ensureBeibeihaiToken(db);
      if (auth.ok) push({ id: 'beibeihai_login', name: 'Beibeihai 登录', ok: true, message: `登录成功（${cfg.email}）` });
      else push({ id: 'beibeihai_login', name: 'Beibeihai 登录', ok: false, message: '登录失败', detail: auth.error, fix: tipsForCode('login_failed') });
    }
  }

  // 4) group maps
  {
    const cfg = getVip1129Config(db);
    const locals = (db.settings?.providers || []).filter(p => isVip1129Provider(p) && !isMaintenanceProvider(p));
    const mapped = locals.filter(p => cfg.groupMap?.[p.id] != null && cfg.groupMap?.[p.id] !== '');
    const missing = locals.filter(p => cfg.groupMap?.[p.id] == null || cfg.groupMap?.[p.id] === '');
    if (!locals.length) {
      push({ id: 'vip1129_map', name: 'vip1129 分组映射', ok: true, level: 'warn', message: '没有指向 vip1129 的本地渠道（请给 GPT 组设置 upstreamSync=vip1129 或 vip1129.cc URL）' });
    } else if (missing.length) {
      push({
        id: 'vip1129_map', name: 'vip1129 分组映射', ok: false,
        message: `已映射 ${mapped.length} 个，未映射：${missing.map(p => p.name).join('、')}`,
        fix: tipsForCode('no_group_map')
      });
    } else {
      push({ id: 'vip1129_map', name: 'vip1129 分组映射', ok: true, message: `已映射 ${mapped.length} 个渠道` });
    }
  }
  {
    const cfg = getBeibeihaiConfig(db);
    const locals = (db.settings?.providers || []).filter(p => isBeibeihaiProvider(p) && !isMaintenanceProvider(p));
    const mapped = locals.filter(p => cfg.groupMap?.[p.id] != null && cfg.groupMap?.[p.id] !== '');
    const missing = locals.filter(p => cfg.groupMap?.[p.id] == null || cfg.groupMap?.[p.id] === '');
    if (!locals.length) {
      push({
        id: 'beibeihai_map', name: 'Beibeihai 分组映射', ok: false,
        message: '没有指向 Beibeihai 的本地渠道（DeepSeek/Grok/CC-MAX 需 upstreamSync=beibeihai）',
        fix: tipsForCode('no_group_map')
      });
    } else if (missing.length) {
      push({
        id: 'beibeihai_map', name: 'Beibeihai 分组映射', ok: false,
        message: `已映射 ${mapped.length} 个，未映射：${missing.map(p => p.name).join('、')}`,
        fix: [
          ...tipsForCode('no_group_map'),
          '打开「Beibeihai同步」，保存登录后会按分组名称自动匹配 ID',
          '若列表为空，先确认 BEIBEIHAI_EMAIL / BEIBEIHAI_PASSWORD 能登录 sub.beibeihai.xyz'
        ]
      });
    } else {
      push({ id: 'beibeihai_map', name: 'Beibeihai 分组映射', ok: true, message: `已映射 ${mapped.length} 个渠道` });
    }
  }

  // 5) channels: models probe + real chat latency + billing display
  for (const provider of (db.settings?.providers || [])) {
    if (!provider?.id) continue;
    const billing = providerMultiplier ? providerMultiplier(provider, db) : Number(provider.billingMultiplier || 2.5);
    const display = resolveDisplayMultiplier
      ? Number(resolveDisplayMultiplier(provider))
      : Number(provider.displayMultiplier);
    const rateNote = `扣费 ${fmtRate(billing)}x · 展示 ${Number.isFinite(display) ? fmtRate(display) : '?'}x`;
    if (isMaintenanceProvider(provider)) {
      push({
        id: `channel_${provider.id}`,
        name: `渠道 ${provider.name}`,
        ok: true,
        level: 'warn',
        message: `${provider.maintenanceMessage || '请联系站长购买'} · ${rateNote}`,
        latencyMs: null,
        billingMultiplier: billing,
        displayMultiplier: display,
        fix: ['请通过网站联系方式联系站长购买', '或改用其它可用模型组']
      });
      continue;
    }
    if (provider.enabled === false) {
      push({
        id: `channel_${provider.id}`,
        name: `渠道 ${provider.name}`,
        ok: true,
        level: 'warn',
        message: `已停用 · ${rateNote}`,
        billingMultiplier: billing,
        displayMultiplier: display
      });
      continue;
    }
    const intendedModel = provider.defaultModel;
    const probed = await probeProviderHealth(db, provider);
    if (intendedModel) provider.defaultModel = intendedModel;
    if (!probed.ok) {
      push({
        id: `channel_${provider.id}`,
        name: `渠道 ${provider.name}`,
        ok: false,
        message: `不可用 · ${rateNote}`,
        detail: probed.error || provider.health?.lastError,
        billingMultiplier: billing,
        displayMultiplier: display,
        fix: tipsForCode('channel_down')
      });
      continue;
    }
    if (probed.skipped) {
      push({
        id: `channel_${provider.id}`,
        name: `渠道 ${provider.name}`,
        ok: true,
        level: 'warn',
        message: `跳过（${probed.reason || 'disabled'}） · ${rateNote}`,
        billingMultiplier: billing,
        displayMultiplier: display
      });
      continue;
    }
    const chat = probeProviderChat ? await probeProviderChat(db, provider) : { ok: true, ms: null, model: provider.defaultModel };
    if (chat.ok) {
      push({
        id: `channel_${provider.id}`,
        name: `渠道 ${provider.name}`,
        ok: true,
        message: `可用 · 延迟 ${chat.ms}ms · 模型 ${chat.model || probed.count || ''} · ${rateNote}`,
        detail: probed.endpoint || provider.url,
        latencyMs: chat.ms,
        billingMultiplier: billing,
        displayMultiplier: display,
        model: chat.model || null
      });
    } else {
      push({
        id: `channel_${provider.id}`,
        name: `渠道 ${provider.name}`,
        ok: false,
        message: `模型列表正常，但对话失败 · 延迟 ${chat.ms ?? '-'}ms · ${rateNote}`,
        detail: `${chat.model ? `模型 ${chat.model} · ` : ''}${chat.status ? `HTTP ${chat.status} · ` : ''}${chat.error || '未知错误'}`,
        latencyMs: chat.ms,
        billingMultiplier: billing,
        displayMultiplier: display,
        model: chat.model || null,
        fix: tipsForCode('channel_down')
      });
    }
  }

  // 6) public base url
  {
    const url = resolvePublicBaseUrl(db, { headers: {} });
    if (!url) {
      push({
        id: 'public_base_url', name: '站点公网地址', ok: true, level: 'warn',
        message: '未配置 PUBLIC_BASE_URL / 站点网址（本地可用，上线前必须配置）',
        fix: tipsForCode('public_base_url')
      });
    } else if (!/^https?:\/\//i.test(url)) {
      push({
        id: 'public_base_url', name: '站点公网地址', ok: false,
        message: '站点地址格式无效',
        detail: url,
        fix: tipsForCode('public_base_url')
      });
    } else {
      push({ id: 'public_base_url', name: '站点公网地址', ok: true, message: url });
    }
  }

  // 7) payment gateway
  {
    const gw = getPaymentGateway(db);
    if (!gw.enabled) {
      push({
        id: 'payment_gateway', name: '聚合支付', ok: true, level: 'warn',
        message: '未启用（将使用个人收款码 + 备注确认）',
        fix: ['若要自动回调发卡，在「聚合支付」启用并填齐商户信息']
      });
    } else if (!gatewayReady(gw)) {
      push({
        id: 'payment_gateway', name: '聚合支付', ok: false,
        message: '已启用但配置不完整',
        fix: tipsForCode('gateway_incomplete')
      });
    } else {
      push({ id: 'payment_gateway', name: '聚合支付', ok: true, message: `已就绪（${gw.name || '易支付'}）` });
    }
  }

  // 8) payment QR expiry
  {
    const meta = paymentQrMeta(db);
    const wx = paymentQrStatus(meta.wechatExpiresAt);
    const ali = paymentQrStatus(meta.alipayExpiresAt);
    const bad = [];
    if (wx?.expired) bad.push('微信收款码已过期');
    if (ali?.expired) bad.push('支付宝收款码已过期');
    if (bad.length) {
      push({
        id: 'payment_qr', name: '收款码有效期', ok: false,
        message: bad.join('；'),
        detail: [wx?.tip, ali?.tip].filter(Boolean).join(' / ') || null,
        fix: ['在「渠道/付款二维码」更新收款码图片', '在管理里刷新过期时间字段', '或提示用户改用其它金额/支付方式']
      });
    } else {
      push({
        id: 'payment_qr', name: '收款码有效期', ok: true,
        message: `微信 ${qrLabel(wx)} / 支付宝 ${qrLabel(ali)}`
      });
    }
  }

  // 9) recharge / card codes
  {
    const amounts = Array.isArray(PAYMENT_AMOUNTS) && PAYMENT_AMOUNTS.length ? PAYMENT_AMOUNTS : [10, 30, 50, 100];
    const stats = typeof poolStats === 'function' ? poolStats(db) : { byAmount: [] };
    const rows = Array.isArray(stats.byAmount) ? stats.byAmount : [];
    const empty = rows.filter(x => Number(x.available || 0) < 1);
    if (!rows.length) {
      push({
        id: 'recharge_pool', name: '卡密库存', ok: false,
        message: '无法读取卡密池',
        fix: ['重启服务让卡密池自动补货', '或到「卡密」页手动生成']
      });
    } else if (empty.length) {
      push({
        id: 'recharge_pool', name: '卡密库存', ok: false,
        message: `以下面额无可用卡密：${empty.map(x => '¥' + x.amount).join('、')}`,
        detail: rows.map(x => `¥${x.amount} 余 ${x.available}`).join(' · '),
        fix: ['重启服务会按目标库存自动补卡密', '也可在「卡密」页按面额生成']
      });
    } else {
      push({
        id: 'recharge_pool', name: '卡密库存', ok: true,
        message: rows.map(x => `¥${x.amount} 余 ${x.available}`).join(' · ')
      });
    }

    const redeemable = (code) => (db.rechargeCodes || []).find(x => x.code === code && !x.usedAt) || null;
    const ghost = redeemable('__diag_invalid_code__');
    const emptyHit = redeemable('');
    push({
      id: 'recharge_invalid',
      name: '无效卡密拦截',
      ok: !ghost && !emptyHit,
      message: (ghost || emptyHit) ? '异常：无效/空卡密会被当成可兑换' : '无效卡密、空卡密都会被拒绝（与兑换接口同一套查找）',
      fix: (ghost || emptyHit) ? ['检查 /api/recharge/redeem 是否错误地匹配了空卡密'] : []
    });

    const sample = (db.rechargeCodes || []).find(c => (typeof codeAvailable === 'function' ? codeAvailable(c) : (!c.usedAt && !c.issuedAt)) && Number(c.amount) > 0);
    const used = (db.rechargeCodes || []).find(c => c.usedAt);
    const usedStillOpen = used ? !!redeemable(used.code) : false;
    const rate = Number(REFERRAL_REBATE_RATE || 0.05);
    const rebate10 = Math.round(10 * rate * 100) / 100;
    const amountsOk = amounts.length >= 1 && amounts.every(a => Number(a) > 0);
    if (!sample) {
      push({
        id: 'recharge_redeem', name: '卡密兑换逻辑', ok: false,
        message: '没有可用卡密，无法校验兑换字段',
        fix: ['先补卡密库存再测兑换']
      });
    } else {
      const found = redeemable(sample.code);
      const amountOk = Number.isFinite(Number(sample.amount)) && Number(sample.amount) > 0;
      const codeOk = typeof sample.code === 'string' && sample.code.length >= 6;
      const whitelistOk = amounts.includes(Number(sample.amount)) || amounts.includes(sample.amount);
      push({
        id: 'recharge_redeem',
        name: '卡密兑换逻辑',
        ok: amountOk && codeOk && !!found && !usedStillOpen && amountsOk,
        message: `可兑 ¥${Number(sample.amount).toFixed(2)} · 码长 ${String(sample.code).length} · 面额档 ${amounts.map(a => '¥' + a).join('/')} · 已用卡密${used ? (usedStillOpen ? '仍可兑换（异常）' : '已正确作废') : '暂无已用样例'} · 邀请返利 ${fmtRate(rate * 100)}%（¥10→¥${rebate10.toFixed(2)}）`,
        detail: whitelistOk ? null : `样例面额 ¥${sample.amount} 不在充值档位里`,
        fix: usedStillOpen ? ['已使用卡密不应再能兑换，检查 usedAt 写入'] : []
      });
    }

    const gw = typeof getPaymentGateway === 'function' ? getPaymentGateway(db) : { enabled: false };
    if (!gatewayReady?.(gw)) {
      const qrs = db.settings?.paymentQrs || {};
      const missing = [];
      for (const amount of amounts) {
        const wxPath = qrs.wechat?.[String(amount)] || `/payment-qr/${amount}.png`;
        const aliPath = qrs.alipay?.[String(amount)] || `/payment-qr/alipay/${amount}.png`;
        if (!localAssetExists(wxPath)) missing.push(`微信¥${amount}`);
        if (!localAssetExists(aliPath)) missing.push(`支付宝¥${amount}`);
      }
      if (missing.length) {
        push({
          id: 'recharge_qr_files',
          name: '收款码图片',
          ok: true,
          level: 'warn',
          message: `个人收款码缺图：${missing.slice(0, 8).join('、')}${missing.length > 8 ? '…' : ''}`,
          detail: '聚合支付未启用时用户靠扫码付款；缺图会导致充值页空白。远程 URL / data URI 视为已配置。',
          fix: ['把对应金额的微信/支付宝码放到 public/payment-qr/', '或在「聚合支付」启用自动回调']
        });
      } else {
        push({
          id: 'recharge_qr_files',
          name: '收款码图片',
          ok: true,
          message: `微信/支付宝 ¥${amounts.join('/')} 收款码均已配置`
        });
      }
    }

    const dupes = {};
    for (const c of db.rechargeCodes || []) {
      const k = String(c.code || '');
      if (!k) continue;
      dupes[k] = (dupes[k] || 0) + 1;
    }
    const clash = Object.entries(dupes).filter(([, n]) => n > 1).slice(0, 5);
    push({
      id: 'recharge_unique',
      name: '卡密不重复',
      ok: clash.length === 0,
      message: clash.length ? `发现重复卡密 ${clash.length} 组` : '卡密编码无重复',
      detail: clash.length ? clash.map(([c, n]) => `${c}×${n}`).join('、') : null,
      fix: clash.length ? ['停止生成并清理重复卡密'] : []
    });
  }

  const failed = results.filter(r => !r.ok);
  const warned = results.filter(r => r.ok && r.level === 'warn');
  return {
    at: new Date().toISOString(),
    summary: {
      total: results.length,
      passed: results.filter(r => r.ok && r.level !== 'warn').length,
      warned: warned.length,
      failed: failed.length
    },
    results
  };
}
