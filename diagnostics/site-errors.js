/** Site error log + human-readable fix tips for Relay Station admin. */

export const SITE_ERROR_CAP = 200;

export function ensureSiteErrors(db) {
  db.siteErrors ??= [];
  if (!Array.isArray(db.siteErrors)) db.siteErrors = [];
  return db.siteErrors;
}

export function recordSiteError(db, entry = {}) {
  const list = ensureSiteErrors(db);
  const item = {
    id: `err_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    level: entry.level || 'error',
    source: String(entry.source || 'system').slice(0, 64),
    code: String(entry.code || 'unknown').slice(0, 64),
    message: String(entry.message || '未知错误').slice(0, 500),
    detail: entry.detail != null ? String(entry.detail).slice(0, 2000) : null,
    fix: Array.isArray(entry.fix)
      ? entry.fix.map(x => String(x).slice(0, 300)).slice(0, 8)
      : (entry.fix ? [String(entry.fix).slice(0, 300)] : []),
    context: entry.context && typeof entry.context === 'object' ? entry.context : null
  };
  list.unshift(item);
  db.siteErrors = list.slice(0, SITE_ERROR_CAP);
  return item;
}

export function clearSiteErrors(db) {
  db.siteErrors = [];
  return true;
}

/** Map common sync/upstream failures to actionable Chinese tips. */
export function tipsForCode(code, extra = {}) {
  const map = {
    missing_credentials: [
      '打开管理后台「Beibeihai同步」或「vip1129同步」',
      '填写上游登录邮箱和密码并保存',
      '或在本地 start-local.ps1 写入对应环境变量后重启'
    ],
    login_failed: [
      '核对上游账号密码是否正确（区分大小写）',
      '在上游网站手动登录确认账号未被封禁',
      '保存后点「保存并探测登录」再试'
    ],
    no_group_map: [
      '在同步页为本地模型组选择上游分组 ID',
      '保存映射后再让用户新建密钥'
    ],
    create_failed: [
      '查看上游账户余额/配额是否充足',
      '确认映射的上游分组仍然可用',
      '到上游 /keys 页面尝试手动建钥对比'
    ],
    create_no_secret: [
      '上游建钥接口未返回完整密钥，检查上游版本或权限',
      '联系上游客服确认 API 是否返回 key 字段'
    ],
    upstream_disabled: [
      '在对应同步页将「启用同步」设为启用'
    ],
    maintenance: [
      '该模型组暂不支持自助开通',
      '请通过网站联系方式联系站长购买',
      '或改用其它可用模型组'
    ],
    channel_no_key: [
      'vip1129/Beibeihai 渠道的渠道级 API Key 可以为空，对话和健康检查会注入已同步的 sk-',
      '请先在对应同步页登录并映射分组，然后新建一把该模型组的密钥',
      '若是其它直连渠道，请在「渠道」里填写渠道级 API Key'
    ],
    invite_invalid: [
      '检查邀请码是否抄错（不区分大小写）',
      '邀请码为空时可以不填；填写了就必须是有效码',
      '向邀请人重新索取邀请码'
    ],
    invite_expired: [
      '该邀请码已过期，请向邀请人索取新码，或留空后自行注册'
    ],
    channel_down: [
      '检查渠道 URL 是否可访问',
      '检查 API Key 是否有效',
      '使用管理后台「诊断测试」里的渠道探测'
    ],
    db_write: [
      '确认 data/ 目录可写',
      '关闭占用 db.json 的其它程序后重试'
    ],
    public_base_url: [
      '在「站点网址」填写公网 https 地址（不要末尾斜杠）',
      '上线后用该地址作为客户端 Base URL'
    ],
    gateway_incomplete: [
      '在「聚合支付」补全 apiUrl / pid / key / siteUrl',
      '或关闭聚合支付，继续使用个人收款码+备注确认'
    ]
  };
  return map[code] || [
    extra.hint || '查看详情后到对应管理页检查配置',
    '仍无法解决可把错误码与时间发给开发排查'
  ];
}

export function failPayload(status, error, opts = {}) {
  const code = opts.code || null;
  const fix = opts.fix || (code ? tipsForCode(code, opts) : undefined);
  const body = { error: String(error) };
  if (code) body.code = code;
  if (fix) body.fix = fix;
  if (opts.detail) body.detail = String(opts.detail).slice(0, 500);
  return { status, body };
}
