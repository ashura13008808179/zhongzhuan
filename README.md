# Relay Station 商业化 AI API 中转站

这是一个可直接上传服务器运行的 Node.js 全栈版本。用户前端只看到自己的账号信息、专属 Relay API Key、请求日志、数据概览、卡密充值、邀请返利和客服联系信息；上游模型密钥只存在服务端环境变量中。

## 验证

```powershell
npm test
node --check server.js
```

`npm test` 覆盖：上游同步密钥解析、Beibeihai 分组自动匹配、无效邀请码拒绝、空邀请码注册（余额为 0）、`GET /api/admin/providers` 别名。不会连接真实上游，也不会写入密钥。

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
$env:ADMIN_USERNAME="admin"
$env:ADMIN_PASSWORD="change-me"
$env:ADMIN_EMAIL="admin@your-domain.com"
$env:CONTACT_EMAIL="3845440106@qq.com"
$env:CONTACT_WECHAT=""
$env:CONTACT_QQ="3845440106"
$env:CONTACT_QQ_GROUP="1061247399"
$env:PAYMENT_QR="/payment-qr.svg"
$env:RECHARGE_CODES="RELAY-100-A:100,RELAY-300-B:300"
npm start
```

`RECHARGE_CODES` 仅用于首次启动时导入卡密，格式为 `卡密:金额:Token配额`，多个卡密用逗号分隔。例如 `RELAY-100-A:100:1000000` 表示充值 ¥100 并增加 1,000,000 Token 配额；省略第三段时默认增加 100,000 Token。用户可在「API 接入」创建多个 Relay API Key，勾选允许的模型，并设置消费上限、Token 上限、每分钟请求数（RPM）和每分钟 Token 数（TPM）。这些限制在 `POST /v1/chat/completions` 与 `POST /api/chat` 上强制执行。调用兼容接口时使用：

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

使用环境变量中的 `ADMIN_USERNAME` / `ADMIN_PASSWORD`（以及可选 `ADMIN_EMAIL`）登录后，侧栏会显示“运营配置”。在这里可以实时切换 2x、3x、4x 计费倍率，并在「渠道」页用卡片配置上游：上游地址、支持的模型（芯片）、掩码 API 密钥（留空保留原密钥，接口不回显明文）、内部名称、启用、优先级与价格。渠道配置按模型名称路由，每个渠道分别填写：

- `models`：该渠道负责的模型数组；例如 `gpt-4o-mini`
- `inputPricePer1K`：该渠道输入每千 Token 实际成本
- `outputPricePer1K`：该渠道输出每千 Token 实际成本
- `url` 和 `apiKey`：该渠道私有连接信息，仅保存于服务器

请求会匹配模型对应的渠道，并以该渠道真实输入/输出成本乘当前倍率计算用户扣款和用户可见 Token。渠道密钥、地址和真实成本不会通过用户接口返回。倍率和渠道改动对之后的新请求实时生效；已开始的请求固定使用发起时的快照价格。



## 管理员凭据（保密）

管理员用户名与密码**只**通过本机环境变量或 gitignore 的 `start-local.ps1` 配置，**不要**写进仓库、前端页面或公开文档。密码也**不会**出现在任何 API 响应里。普通用户无法注册保留用户名（如 `admin`）。

## 管理员接口（需 role=admin）

```text
GET  /api/admin/pricing
GET  /api/admin/providers   # 与 pricing 相同（兼容旧引用）
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

## 每日签到

登录用户每天可签到一次，按 **Asia/Shanghai（北京时间）** 的 `YYYY-MM-DD` 自然日计算，不可重复领取。奖励金额在 ¥0.05–¥0.50（含两端，两位小数）之间按逆幂加权抽样：高额更少见，离散分布的理论均值约为 ¥0.10。奖励直接计入用户 `balance`，来源写入 `db.checkIns` 与账单日志 `checkin_bonus`；累计签到额记在 `checkInBonus`，**不会**写入邀请返利的 `bonusBalance`。

```text
POST /api/checkin            # 领取今日奖励 → { amount, balance, alreadyCheckedIn, date }
GET  /api/checkin/status     # { checkedInToday, todayAmount?, streak, recent }
GET  /api/admin/checkin      # 管理员：今日人数/金额与最近记录
```

同一自然日再次领取返回 HTTP 409，中文提示「今日已签到，请明天再来」。

```powershell
npm test
```

`npm test` 会验证抽样均值并跑一轮签到 API（独立临时目录，不写生产 `data/db.json`）。


## 聚合支付（易支付兼容）

在管理后台「运营配置 → 聚合支付」填写：

- 网关 API 地址（如 `https://pay.xxx.com`）
- 商户 ID `pid`、密钥 `key`
- 网站公网 `siteUrl`（用于回调）

启用后用户购买将跳转 `submit.php` 支付；异步通知地址：

`{siteUrl}/api/pay/epay/notify`

支付成功且验签通过后自动发放卡密。未启用时回退个人收款码 + 备注核对。


## 站点网址（用户侧 Base URL）

用户 / Cursor / CC Switch 应填写**你的中转站**地址，不是 OpenAI 或上游：

- 环境变量：`PUBLIC_BASE_URL=https://你的域名`
- 或管理后台「运营配置 → 站点网址」

客户端 Base URL 形如：`https://你的域名/v1`  
完整对话：`https://你的域名/v1/chat/completions`

上游渠道（如 Codex 直连 vip1129）只配在管理后台「渠道」，不对用户展示。

## Windows ECS 部署（已有 VIP1129_* / BEIBEIHAI_*）

代码更新后在服务器上拉最新并重启 Node 即可。启动时会：

1. 给 GPT 组打上 `upstreamSync=vip1129`，给 DeepSeek / Grok / CC-MAX / Claude-Cursor 打上 `upstreamSync=beibeihai`，并把仍指向官方厂商的旧 URL 改到对应中转 `/v1/chat/completions`
2. Cursor账号池保持维护中
3. 登录上游成功后按分组名自动填 `groupMap`（仍可在「Beibeihai同步 / vip1129同步」里手改）

```powershell
cd C:\path\to\zhongzhuan
git pull
# 环境变量保持原样，例如：
# $env:VIP1129_EMAIL / $env:VIP1129_PASSWORD / $env:VIP1129_BASE_URL
# $env:BEIBEIHAI_EMAIL / $env:BEIBEIHAI_PASSWORD / $env:BEIBEIHAI_BASE_URL
# 若用 NSSM / 任务计划 / start-local.ps1 托管，重启该进程
npm start
```

重启后打开运营配置 → 诊断测试。GPT 健康检查应注入已同步的 `sk-`，不再因渠道级 Key 为空而报 `API_KEY_REQUIRED`。Beibeihai 映射数应大于 0；若仍提示未映射，到同步页保存一次登录，让 `listAvailableGroups` 自动匹配。
