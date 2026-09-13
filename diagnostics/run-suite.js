/**
 * Admin diagnostic suite. Caller injects helpers from server.js.
 * Each result: { id, name, ok, level, message, detail?, fix[] }
 */

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
    gatewayReady,
    getPaymentGateway,
    paymentQrMeta,
    paymentQrStatus,
    resolvePublicBaseUrl,
    fs,
    dbFile,
    tipsForCode
  } = ctx;

  const results = [];
  const push = (r) => results.push({
    id: r.id,
    name: r.name,
    ok: !!r.ok,
    level: r.level || (r.ok ? 'ok' : 'error'),
    message: r.message,
    detail: r.detail || null,
    fix: r.fix || []
  });

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
        message: '没有指向 Beibeihai 的本地渠道（DeepSeek/Grok/CC-MAX/Claude-Cursor 需 upstreamSync=beibeihai）',
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

  // 5) channels
  for (const provider of (db.settings?.providers || [])) {
    if (!provider?.id) continue;
    if (isMaintenanceProvider(provider)) {
      push({
        id: `channel_${provider.id}`,
        name: `渠道 ${provider.name}`,
        ok: true,
        level: 'warn',
        message: provider.maintenanceMessage || '请联系站长购买',
        fix: ['请通过网站联系方式联系站长购买', '或改用其它可用模型组']
      });
      continue;
    }
    if (provider.enabled === false) {
      push({ id: `channel_${provider.id}`, name: `渠道 ${provider.name}`, ok: true, level: 'warn', message: '已停用' });
      continue;
    }
    // Channel-level apiKey may be empty for vip1129/beibeihai: probe injects a synced sk-.
    const probed = await probeProviderHealth(db, provider);
    if (probed.ok) {
      push({
        id: `channel_${provider.id}`,
        name: `渠道 ${provider.name}`,
        ok: true,
        message: probed.skipped ? `跳过（${probed.reason || 'disabled'}）` : `探测成功，模型数 ${probed.count ?? 0}`,
        detail: probed.endpoint || provider.url
      });
    } else {
      push({
        id: `channel_${provider.id}`,
        name: `渠道 ${provider.name}`,
        ok: false,
        message: '渠道探测失败',
        detail: probed.error || provider.health?.lastError,
        fix: tipsForCode('channel_down')
      });
    }
  }

  // 6) public base url
  {
    const url = resolvePublicBaseUrl(db, { headers: {} });
    if (!url) {
      push({
        id: 'public_base_url', name: '站点公网地址', ok: false, level: 'warn',
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
    if (wx.status === 'expired') bad.push('微信收款码已过期');
    if (ali.status === 'expired') bad.push('支付宝收款码已过期');
    if (bad.length) {
      push({
        id: 'payment_qr', name: '收款码有效期', ok: false,
        message: bad.join('；'),
        fix: ['在「渠道/付款二维码」更新收款码图片', '在管理里刷新过期时间字段', '或提示用户改用其它金额/支付方式']
      });
    } else {
      push({
        id: 'payment_qr', name: '收款码有效期', ok: true,
        message: `微信 ${wx.label || wx.status || '未知'} / 支付宝 ${ali.label || ali.status || '未知'}`
      });
    }
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
