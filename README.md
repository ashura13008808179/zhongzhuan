# Relay Station 商业化 AI API 中转站

这是一个可直接上传服务器运行的 Node.js 全栈版本。用户前端只看到自己的账号信息、专属 Relay API Key、请求日志、数据概览、卡密充值、邀请返利和客服联系信息；上游模型密钥只存在服务端环境变量中。

## 运行

```powershell
npm start
```

默认访问 `http://localhost:8787`。服务器需要 Node.js 18+。

## 生产环境变量

```powershell
$env:PORT="8787"
$env:UPSTREAM_URL="https://api.openai.com/v1/chat/completions"
$env:UPSTREAM_API_KEY="sk-your-authorized-key"
$env:UPSTREAM_MODEL="gpt-4o-mini"
$env:UPSTREAM_PRICE_PER_1K="0.01"
$env:BALANCE_SAFETY_BUFFER="0.01"
$env:ADMIN_EMAIL="admin@your-domain.com"
$env:ADMIN_PASSWORD="change-to-a-strong-password"
$env:CONTACT_EMAIL="support@your-domain.com"
$env:CONTACT_WECHAT="YourSupportWechat"
$env:PAYMENT_QR="/payment-qr.svg"
$env:RECHARGE_CODES="RELAY-100-A:100,RELAY-300-B:300"
npm start
```

`RECHARGE_CODES` 仅用于首次启动时导入卡密，格式为 `卡密:金额:Token配额`，多个卡密用逗号分隔。例如 `RELAY-100-A:100:1000000` 表示充值 ¥100 并增加 1,000,000 Token 配额；省略第三段时默认增加 100,000 Token。用户注册时会自动生成自己的 Relay API Key；调用兼容接口时使用：

每个账号都有独立的 `quotaTokens`、`usedTokens` 和并发预留额度。用户配额按上游实际 Token 消耗的 2 倍计费：上游返回 `usage.total_tokens = N` 时，账号扣除 `2N`。请求在连接上游前会按 2 倍上限预留额度；配额不足直接返回 HTTP `402`，不会建立上游连接。`max_tokens` 会被服务端限制在账号剩余额度内，前端无法绕过。用户界面和日志中的 `tokens` 显示计费 Token（2N），日志另存 `upstreamTokens` 作为上游实际值，并保留 `billedTokens` 与倍率字段用于核对。

金额也按相同倍率结算：`UPSTREAM_PRICE_PER_1K` 是上游每 1,000 Token 的成本，用户扣款为 `实际上游 Token / 1000 × UPSTREAM_PRICE_PER_1K × 2`。数据库日志保存 `upstreamCost` 与 `chargedAmount`，用户余额扣除 `chargedAmount`。

余额保护：`BALANCE_SAFETY_BUFFER` 是账号必须保留的安全余额。请求前会从可用余额中扣除本次预算和安全缓冲，预算不足直接返回 `402`，不会发送请求；成功结算后若余额低于安全缓冲，系统会将余额归零、标记账号停用并停止后续 API 请求。已支持 `stream: true`（预授权 + 结束结算 + 中断释放预留）。

```text
POST /v1/chat/completions
Authorization: Bearer rk_xxx
Content-Type: application/json
```

## 数据与收款二维码

用户、卡密和请求日志保存在服务器 `data/db.json`，请纳入备份但不要提交到公开仓库。将你自己的微信收款二维码放到 `public/payment-qr.svg` 或其他图片路径，再将 `PAYMENT_QR` 设置为对应路径；当前页面提供了收款位置和联系客服提示。不要把真实收款码、上游密钥提交到 Git。

生产部署建议使用 Nginx/Caddy 反向代理并启用 HTTPS，同时增加限流、邮件验证、订单支付回调、管理员后台、数据库（PostgreSQL/MySQL）和审计告警。当前版本的卡密是手工导入/兑换，适合作为可运行的 MVP 基础。

## 多渠道与实时定价

使用 `ADMIN_EMAIL` 和 `ADMIN_PASSWORD` 登录后，侧栏会显示“运营配置”。在这里可以实时切换 2x、3x、4x 计费倍率，并录入多个模型渠道。渠道配置按模型名称路由，每个渠道分别填写：

- `models`：该渠道负责的模型数组；例如 `gpt-4o-mini`
- `inputPricePer1K`：该渠道输入每千 Token 实际成本
- `outputPricePer1K`：该渠道输出每千 Token 实际成本
- `url` 和 `apiKey`：该渠道私有连接信息，仅保存于服务器

请求会匹配模型对应的渠道，并以该渠道真实输入/输出成本乘当前倍率计算用户扣款和用户可见 Token。渠道密钥、地址和真实成本不会通过用户接口返回。倍率和渠道改动对之后的新请求实时生效；已开始的请求固定使用发起时的快照价格。


## 管理员接口（需 role=admin）

```text
GET  /api/admin/pricing
PUT  /api/admin/pricing
PUT  /api/admin/providers
GET  /api/admin/users
PUT  /api/admin/users/:id
GET  /api/admin/codes
POST /api/admin/codes
GET  /api/admin/audit
GET  /api/admin/orders
```

管理员登录后侧栏「运营配置」提供倍率、渠道表单、用户、卡密、审计、订单 Tab。渠道密钥不会返回给普通用户接口。数据仍使用 `data/db.json`（MySQL 暂缓）。

认证限流约 60 次/分钟/IP，聊天接口约 120 次/分钟/IP。`POST /api/auth/logout` 可清除会话。
