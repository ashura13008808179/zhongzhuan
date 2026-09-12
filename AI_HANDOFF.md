# Relay Station 开发交接文档

## 项目目标

这是一个商业化 AI API 服务平台。终端用户注册后获得平台 API Key，可查看数据概览、余额、计费 Token、调用日志、卡密充值、邀请奖励和联系方式。管理员可配置多个私有模型渠道，并实时设置客户计费倍率。

用户侧必须保持 Relay Station 统一品牌体验。不得将渠道 URL、渠道密钥、真实成本、渠道名称或内部路由规则返回到普通用户接口或页面。

## 当前技术栈

- Node.js 原生 HTTP 服务，无第三方依赖
- 前端：原生 HTML / CSS / JavaScript
- 数据存储：`data/db.json`（用户选择暂缓 MySQL，继续使用 JSON）
- 启动：`npm start`
- 本地地址：`http://localhost:8787`

主要文件：

- `server.js`：认证、计费、渠道路由、用户 API、管理员 API、静态资源服务
- `public/index.html`：登录和用户控制台入口
- `public/app.js`：用户控制台与管理员运营配置页
- `public/styles.css`：页面样式
- `public/terms.html` / `privacy.html` / `refund.html`：简体中文法律页
- `README.md`：部署说明
- `data/db.json`：运行数据，不应提交到公开仓库

## 当前已实现功能

- 注册与登录：登录标识为用户名或邮箱 + 密码；注册写入唯一 `username`；`safeUser` 返回 `username`
- 默认管理员用户名来自 `ADMIN_USERNAME`（默认 `ashura`），可用用户名或邮箱登录；密码仅来自 `ADMIN_PASSWORD`，仓库中不要写入真实密码
- 用户可创建多个 API Key：选择允许的模型，设置消费上限 / Token 上限 / RPM / TPM；`/v1/chat/completions` 与 `/api/chat` 会强制校验
- 会话令牌：内存 Map + 可选持久化到 `db.sessions`（启动时加载）
- `POST /api/auth/logout` 清除会话
- 每个用户可有多个平台 API Key：`rk_...`（`GET/POST /api/keys`，`PUT/DELETE /api/keys/:id`，`POST /api/keys/:id/rotate`）
- OpenAI Chat Completions 兼容入口：`POST /v1/chat/completions`
- 网页测试入口：`POST /api/chat`
- **流式响应**：`stream: true` 时转发上游 SSE；结束时按 usage 或估算结算并释放预留；客户端中断时释放预留
- 用户余额、Token 配额、调用日志、卡密兑换、邀请返利
- 请求前配额与金额预留，避免并发超额
- 余额安全阈值：接近耗尽时主动停用账户并拒绝后续请求
- 多渠道按模型名称路由，并按 `priority`（越小越高）排序
- **渠道故障转移**：主渠道失败后按优先级尝试下一匹配渠道，按实际成功渠道结算
- 每个渠道独立输入/输出成本，支持 `modelPrices[model]` 覆盖
- 渠道字段：`priority`、`timeoutMs`、`maxRetries`、`health`、`modelPrices`
- 上游尝试时更新 `provider.health`；管理员定价接口返回健康摘要（不含 apiKey）
- 管理员实时设置计费倍率（1x–10x）
- **管理员控制台**（运营配置页 Tabs）：倍率、渠道表单编辑器、用户管理、卡密生成、审计、订单
- 审计日志 `db.auditLogs`（上限 5000）：倍率变更、渠道保存、用户更新、卡密生成
- 轻量 IP 限流：`/api/auth/*` 60/min，`/v1/chat/completions` 与 `/api/chat` 120/min → 429
- 服务条款 / 隐私政策 / 退款规则静态页

## 用户 API

### OpenAI 兼容调用

```http
POST /v1/chat/completions
Authorization: Bearer rk_user_key
Content-Type: application/json

{
  "model": "gpt-4o-mini",
  "messages": [{ "role": "user", "content": "你好" }],
  "max_tokens": 512,
  "stream": false
}
```

也支持 `x-api-key: rk_user_key`。密钥可限制 `models`、`spendLimit`、`tokenLimit`、`rpm`、`tpm`；空模型列表表示允许全部已上线模型。

```text
GET    /api/models
GET    /api/keys
POST   /api/keys                 # { name, models[], spendLimit, tokenLimit, rpm, tpm, enabled }
PUT    /api/keys/:id
DELETE /api/keys/:id
POST   /api/keys/:id/rotate
```

已支持 `stream: true`：建立流前足额预留；流结束精确结算；断流/错误释放预留。

## 多渠道路由与结算

渠道保存在 `db.settings.providers`。每个渠道数据形状：

```json
{
  "id": "provider-a",
  "name": "Internal label only",
  "url": "https://example.com/v1/chat/completions",
  "apiKey": "private-provider-key",
  "defaultModel": "gpt-4o-mini",
  "models": ["gpt-4o-mini", "gpt-4o"],
  "inputPricePer1K": 0.01,
  "outputPricePer1K": 0.02,
  "enabled": true,
  "priority": 10,
  "timeoutMs": 60000,
  "maxRetries": 0,
  "modelPrices": {
    "gpt-4o": { "inputPricePer1K": 0.02, "outputPricePer1K": 0.06 }
  },
  "health": { "ok": true, "lastCheckedAt": null, "lastError": null }
}
```

路由优先级：

1. 匹配 `models` 中包含请求 `model` 的已启用渠道，按 `priority` 升序。
2. 未匹配时使用 `defaultProviderId`。
3. 再未匹配则使用第一个可用渠道。
4. 上游失败时依次尝试下一匹配渠道（failover）。

实际成本优先使用 `modelPrices[model]`，否则回退渠道级 input/output：

```text
真实成本 = prompt_tokens / 1000 * inputPricePer1K
         + completion_tokens / 1000 * outputPricePer1K
客户金额 = 真实成本 * billingMultiplier
客户 Token = 上游实际 total_tokens * billingMultiplier
```

普通用户的 `/api/dashboard` 会把日志 `tokens` 映射为 `billedTokens`，不得改变这一行为。

## 管理员 API

管理员由用户对象的 `role: "admin"` 标识。默认管理员由环境变量 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 初始化。非管理员访问返回 403。

```text
GET  /api/admin/pricing          # 倍率、渠道摘要（无 apiKey）、健康摘要
PUT  /api/admin/pricing          # { multiplier }
PUT  /api/admin/providers        # { providers, defaultProviderId }
GET  /api/admin/users            # 安全字段列表（apiKey 仅掩码后 4 位）
PUT  /api/admin/users/:id        # { accountActive?, balance?, quotaTokens?, role? } + 审计
GET  /api/admin/codes            # 卡密列表
POST /api/admin/codes            # { count, amount, quotaTokens, prefix? }
GET  /api/admin/audit            # 最近审计
GET  /api/admin/orders           # 卡密兑换订单 stub
```

保存渠道时，已有渠道的 `apiKey` 可传空字符串以保留旧密钥；新渠道必须提供 API Key。管理员 GET 不返回完整私钥，只返回 `apiKeyConfigured`。

## 余额与安全控制

每个用户包含：

- `balance` / `reservedBalance`
- `quotaTokens` / `usedTokens` / `reservedTokens`
- `accountActive`

请求前按目标渠道成本、输出上限和当前倍率预留。不足返回 HTTP `402`。成功后按实际 usage 结算；流式失败/中断释放预留。

## 环境变量

```powershell
$env:PORT="8787"
$env:ADMIN_EMAIL="admin@your-domain.com"
$env:ADMIN_USERNAME="ashura"
$env:ADMIN_PASSWORD="change-me"
$env:CONTACT_EMAIL="support@your-domain.com"
$env:CONTACT_WECHAT="YourSupportWechat"
$env:PAYMENT_QR="/payment-qr.svg"
$env:RECHARGE_CODES="CARD-100:100:1000000"
$env:BILLING_MULTIPLIER="2"
$env:BALANCE_SAFETY_BUFFER="0.01"
```

旧版单渠道环境变量仍会在首次启动时迁移为一个默认渠道。

## 重要约束

- 不要在前端、用户日志、用户错误信息或用户 API 中泄露渠道资料。
- 不要接受来自前端的价格、倍率、余额、渠道 ID 或结算金额；全部由服务器计算。
- 路由、预留、结算必须使用同一个成功渠道和同一个倍率快照。
- 上游失败、超时或 JSON 解析失败时必须释放预留（或 failover 到下一渠道）。
- 生产部署需使用 HTTPS。
- 不要把 `data/db.json`、生产密钥、收款码提交到公开 Git 仓库。
- **MySQL / 事务存储仍待用户决定后迁移；当前刻意保持 JSON。**

## 后续开发优先级

1. 替换 JSON 文件存储为 PostgreSQL/MySQL，并把预留/结算放入事务（用户已暂缓）。
2. 真实支付订单与支付回调。
3. API Key 轮换、密码重置、邮箱验证。
4. 更完善的渠道主动健康探活与重试策略（`maxRetries` 字段已预留）。
5. 多实例部署时的共享会话与限流。

## 验证命令

```powershell
node --check server.js
node --check public/app.js
npm start
```

管理员登录后检查：运营配置 Tabs、倍率/渠道/用户/卡密/审计/订单、普通用户 403、余额不足 402、流式与 failover。
