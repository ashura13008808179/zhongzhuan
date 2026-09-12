const $=s=>document.querySelector(s);let token=localStorage.getItem('relay_token'),me=null,data=null;
const authView=$('#authView'),dash=$('#dashboard'),page=$('#page');
function esc(x=''){return String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function api(url,opts={}){const r=await fetch(url,{...opts,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})}});const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||'请求失败');return j}
function msg(t,ok=false){const e=$('#authMessage');e.textContent=t;e.className=`auth-message ${ok?'ok':''}`}
function setAuthMode(mode){
  document.querySelectorAll('[data-auth]').forEach(x=>{
    const on=x.dataset.auth===mode;
    x.classList.toggle('active',on);
    x.setAttribute('aria-selected',on?'true':'false');
  });
  $('#loginForm').hidden=mode!=='login';
  $('#registerForm').hidden=mode!=='register';
  $('#authCard')?.classList.toggle('is-register',mode==='register');
  $('#authCard')?.classList.toggle('is-login',mode==='login');
  msg('');
}
document.querySelectorAll('[data-auth]').forEach(b=>b.onclick=()=>setAuthMode(b.dataset.auth));
setAuthMode('login');
$('#loginForm').onsubmit=async e=>{e.preventDefault();try{const j=await api('/api/auth/login',{method:'POST',body:JSON.stringify({login:$('#loginIdentifier').value.trim(),password:$('#loginPassword').value})});token=j.token;localStorage.setItem('relay_token',token);await boot()}catch(err){msg(err.message)}};
$('#registerForm').onsubmit=async e=>{e.preventDefault();try{const j=await api('/api/auth/register',{method:'POST',body:JSON.stringify({email:$('#regEmail').value.trim(),username:$('#regUsername').value.trim(),name:$('#regName').value.trim(),password:$('#regPassword').value,inviteCode:$('#regInvite').value.trim()})});token=j.token;localStorage.setItem('relay_token',token);await boot()}catch(err){msg(err.message)}};
$('#logoutBtn').onclick=async()=>{try{if(token)await api('/api/auth/logout',{method:'POST'});}catch{}localStorage.removeItem('relay_token');location.reload()};
async function boot(){try{data=await api('/api/dashboard');me=data.user;authView.hidden=true;dash.hidden=false;$('#sideName').textContent=me.name;$('#sideEmail').textContent=me.username?`@${me.username}`:me.email;$('#sideAvatar').textContent=(me.name||me.username||'?')[0].toUpperCase();$('#topAvatar').textContent=(me.name||me.username||'?')[0].toUpperCase();render('overview')}catch{localStorage.removeItem('relay_token');token=null}}
function shell(title,kicker,html){$('#pageTitle').textContent=title;page.innerHTML=`<div class="page-head"><div><p class="eyebrow">${kicker}</p><h1>${title}</h1><p class="sub">管理你的 Relay Station 账户与 API 服务</p></div></div>${html}`}
function render(name){
  document.querySelectorAll('[data-page]').forEach(a=>a.classList.toggle('active',a.dataset.page===name));
  if(name==='overview')shell('数据概览','ACCOUNT OVERVIEW',`<div class="metric-grid"><article><small>账户余额</small><strong>¥${me.balance.toFixed(2)}</strong><span class="green">可用于 API 调用</span></article><article><small>累计请求</small><strong>${data.stats.requests.toLocaleString()}</strong><span>成功率 ${data.stats.requests?Math.round(data.stats.success/data.stats.requests*100):100}%</span></article><article><small>剩余 API 配额</small><strong>${data.stats.availableTokens.toLocaleString()}</strong><span>已使用 ${data.stats.usedTokens.toLocaleString()} / ${data.stats.quotaTokens.toLocaleString()}</span></article><article><small>邀请奖励</small><strong>¥${me.bonusBalance.toFixed(2)}</strong><span>已邀请 ${data.inviteCount} 位用户</span></article></div><div class="content-grid"><section class="card"><div class="card-head"><div><p class="eyebrow">RECENT REQUESTS</p><h2>最近请求</h2></div><button class="link-btn" data-page="logs">查看全部 →</button></div><table><thead><tr><th>模型</th><th>Token</th><th>延迟</th><th>状态</th><th>时间</th></tr></thead><tbody>${data.logs.slice(0,8).map(l=>`<tr><td>${esc(l.model)}</td><td>${l.tokens}</td><td>${l.latency}ms</td><td><span class="tag success">成功</span></td><td>${new Date(l.createdAt).toLocaleString('zh-CN')}</td></tr>`).join('')||'<tr><td colspan="5" class="empty">暂无请求记录</td></tr>'}</tbody></table></section><section class="card balance-card"><p class="eyebrow">QUICK ACTIONS</p><h2>快捷操作</h2><button class="action" data-page="api"><span>◈</span><div><b>查看 API 接入</b><small>复制你的专属调用密钥</small></div><i>→</i></button><button class="action" data-page="billing"><span>◇</span><div><b>卡密充值</b><small>充值后立即到账</small></div><i>→</i></button><button class="action" data-page="referral"><span>♧</span><div><b>邀请好友</b><small>每位好友奖励 ¥20</small></div><i>→</i></button></section></div>`);
  if(name==='api'){shell('API 接入','DEVELOPER ACCESS',`<section class="card api-card"><div class="card-head"><div><p class="eyebrow">YOUR RELAY KEY</p><h2>专属 API 密钥</h2></div><span class="tag success">已启用</span></div><p class="sub">将此密钥放入你的应用中，即可调用 Relay Station 的统一接口。</p><div class="key-box"><code id="keyValue">${esc(me.apiKey)}</code><button id="copyKey">复制密钥</button></div><div class="code-box"><div><span class="method">POST</span> https://你的域名/v1/chat/completions</div><pre>curl https://你的域名/v1/chat/completions \\
  -H "Authorization: Bearer ${esc(me.apiKey)}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"你好"}]}'</pre></div><p class="warning">请妥善保管密钥。该密钥仅用于访问 Relay Station API。</p></section>`);$('#copyKey')?.addEventListener('click',()=>{navigator.clipboard.writeText(me.apiKey);$('#copyKey').textContent='已复制 ✓'});}
  if(name==='logs')shell('使用日志','REQUEST LOGS',`<section class="card"><div class="card-head"><div><p class="eyebrow">AUDIT TRAIL</p><h2>全部请求记录</h2></div><span class="sub">最近 30 条</span></div><table><thead><tr><th>时间</th><th>模型</th><th>Token</th><th>延迟</th><th>状态</th></tr></thead><tbody>${data.logs.map(l=>`<tr><td>${new Date(l.createdAt).toLocaleString('zh-CN')}</td><td>${esc(l.model)}</td><td>${l.tokens}</td><td>${l.latency}ms</td><td><span class="tag success">成功</span></td></tr>`).join('')||'<tr><td colspan="5" class="empty">暂无日志</td></tr>'}</tbody></table></section>`);
  if(name==='billing'){shell('卡密充值','BILLING & RECHARGE',`<div class="billing-grid"><section class="card recharge-card"><p class="eyebrow">REDEEM CODE</p><h2>使用充值卡密</h2><p class="sub">输入卡密，余额会立即到账。</p><form id="redeemForm"><input id="redeemCode" placeholder="例如：RELAY-XXXX-XXXX" required><button class="primary-btn">立即充值 ↗</button></form><div id="redeemMsg" class="inline-msg"></div></section><section class="card"><p class="eyebrow">PAYMENT</p><h2>购买卡密</h2><p class="sub">请联系支持获取卡密，或扫码付款后联系客服。</p><div class="qr-placeholder"><img src="${esc(window.appConfig?.paymentQr||'/payment-qr.svg')}" alt="微信收款二维码" onerror="this.style.display='none'"><span>微信收款二维码<br><small>由服务端 PAYMENT_QR 配置</small></span></div><p class="contact-line">微信：${esc(window.appConfig?.contactWechat||'RelaySupport')}</p></section></div>`);$('#redeemForm')?.addEventListener('submit',async e=>{e.preventDefault();try{const j=await api('/api/recharge/redeem',{method:'POST',body:JSON.stringify({code:$('#redeemCode').value.trim()})});me=j.user;$('#redeemMsg').textContent=j.message;$('#redeemMsg').className='inline-msg ok'}catch(err){$('#redeemMsg').textContent=err.message;$('#redeemMsg').className='inline-msg'}});}
  if(name==='referral'){shell('邀请返利','REFERRAL PROGRAM',`<section class="card referral-card"><div class="referral-hero"><div><p class="eyebrow">YOUR INVITE CODE</p><h2>邀请好友，一起获得奖励</h2><p class="sub">好友注册后你得 ¥20，好友得 ¥10。</p></div><div class="reward">¥20<span>/ 人</span></div></div><div class="invite-box"><code>${data.inviteCode}</code><button id="copyInvite">复制邀请码</button></div><div class="ref-stats"><div><b>${data.inviteCount}</b><span>已邀请好友</span></div><div><b>¥${me.bonusBalance.toFixed(2)}</b><span>累计奖励</span></div></div></section>`);$('#copyInvite')?.addEventListener('click',()=>{navigator.clipboard.writeText(data.inviteCode);$('#copyInvite').textContent='已复制 ✓'});}
  if(name==='contact')shell('联系支持','SUPPORT CENTER',`<div class="contact-grid"><section class="card"><p class="eyebrow">WE ARE HERE TO HELP</p><h2>需要帮助？</h2><p class="sub">遇到接入、充值或账单问题，工作日我们会尽快回复。</p><div class="contact-item"><span>◎</span><div><small>客服微信</small><b>${esc(window.appConfig?.contactWechat||'RelaySupport')}</b></div></div><div class="contact-item"><span>✉</span><div><small>支持邮箱</small><b>${esc(window.appConfig?.contactEmail||'support@example.com')}</b></div></div></section><section class="card"><p class="eyebrow">ACCOUNT</p><h2>账号信息</h2><div class="account-row"><span>用户名</span><b>@${esc(me.username||'-')}</b></div><div class="account-row"><span>显示名称</span><b>${esc(me.name)}</b></div><div class="account-row"><span>登录邮箱</span><b>${esc(me.email)}</b></div><div class="account-row"><span>注册时间</span><b>${new Date(me.createdAt).toLocaleDateString('zh-CN')}</b></div></section></div>`);
  page.querySelectorAll('[data-page]').forEach(a=>a.onclick=()=>render(a.dataset.page));
  document.querySelectorAll('[data-page]').forEach(a=>a.onclick=()=>render(a.dataset.page));
}

fetch('/api/config').then(r=>r.json()).then(c=>window.appConfig=c);

const baseRender = render;
render = function(name) { return name === 'operations' ? renderOperations() : baseRender(name); };

let adminTab = 'rates';
let adminProvidersCache = [];
let adminDefaultProviderId = null;

function adminTabsHtml() {
  const tabs = [
    ['rates', '倍率'],
    ['channels', '渠道'],
    ['users', '用户'],
    ['codes', '卡密'],
    ['audit', '审计'],
    ['orders', '订单']
  ];
  return `<div class="admin-tabs">${tabs.map(([id, label]) => `<button class="admin-tab ${adminTab===id?'active':''}" data-admin-tab="${id}">${label}</button>`).join('')}</div>`;
}

function modelPricesEditorHtml(provider, idx) {
  const entries = Object.entries(provider.modelPrices || {});
  const rows = entries.map(([model, price], pi) => `
    <div class="model-price-row" data-p="${idx}" data-mp="${pi}">
      <input data-mp-field="model" value="${esc(model)}" placeholder="模型名">
      <input data-mp-field="input" type="number" step="0.0001" min="0" value="${esc(price.inputPricePer1K ?? 0)}" placeholder="输入/1K">
      <input data-mp-field="output" type="number" step="0.0001" min="0" value="${esc(price.outputPricePer1K ?? 0)}" placeholder="输出/1K">
      <button type="button" class="ghost-btn" data-remove-mp="${idx}:${pi}">删除</button>
    </div>`).join('');
  return `<div class="model-prices" data-provider-mp="${idx}"><div class="model-price-head"><span>模型</span><span>输入价/1K</span><span>输出价/1K</span><span></span></div>${rows || '<p class="sub">暂无按模型价格，将使用渠道默认输入/输出价。</p>'}<button type="button" class="ghost-btn" data-add-mp="${idx}">+ 添加模型价格</button></div>`;
}

function providerFormHtml(provider, idx) {
  const health = provider.health || {};
  const healthLabel = health.ok === false ? '异常' : '正常';
  const healthClass = health.ok === false ? 'tag danger' : 'tag success';
  return `<article class="card provider-form" data-provider-idx="${idx}">
    <div class="card-head">
      <div><p class="eyebrow">PROVIDER #${idx + 1}</p><h2>${esc(provider.name || '未命名渠道')}</h2></div>
      <div class="provider-head-actions">
        <span class="${healthClass}">${healthLabel}</span>
        <button type="button" class="ghost-btn danger" data-remove-provider="${idx}">删除</button>
      </div>
    </div>
    <div class="form-grid">
      <label>ID<input data-f="id" value="${esc(provider.id || '')}" ${provider.id ? 'readonly' : ''}></label>
      <label>名称<input data-f="name" value="${esc(provider.name || '')}"></label>
      <label class="span-2">上游 URL<input data-f="url" value="${esc(provider.url || '')}" placeholder="https://..."></label>
      <label>默认模型<input data-f="defaultModel" value="${esc(provider.defaultModel || '')}"></label>
      <label>模型列表（逗号分隔）<input data-f="models" value="${esc((provider.models || []).join(', '))}"></label>
      <label>输入价/1K<input data-f="inputPricePer1K" type="number" step="0.0001" min="0" value="${esc(provider.inputPricePer1K ?? 0)}"></label>
      <label>输出价/1K<input data-f="outputPricePer1K" type="number" step="0.0001" min="0" value="${esc(provider.outputPricePer1K ?? 0)}"></label>
      <label>优先级（越小越高）<input data-f="priority" type="number" value="${esc(provider.priority ?? 100)}"></label>
      <label>超时 ms<input data-f="timeoutMs" type="number" min="1000" value="${esc(provider.timeoutMs ?? 60000)}"></label>
      <label>API Key（留空保留原密钥）<input data-f="apiKey" type="password" placeholder="${provider.apiKeyConfigured ? '•••• 已配置，留空保留' : '新渠道必填'}" autocomplete="new-password"></label>
      <label class="check-label"><input data-f="enabled" type="checkbox" ${provider.enabled !== false ? 'checked' : ''}> 启用渠道</label>
      <label class="check-label"><input data-f="isDefault" type="checkbox" ${adminDefaultProviderId === provider.id ? 'checked' : ''}> 设为默认渠道</label>
    </div>
    <p class="eyebrow" style="margin-top:16px">MODEL PRICES</p>
    ${modelPricesEditorHtml(provider, idx)}
    ${health.lastCheckedAt ? `<p class="sub" style="margin-top:10px">健康检查：${esc(new Date(health.lastCheckedAt).toLocaleString('zh-CN'))}${health.lastError ? ' · ' + esc(health.lastError) : ''}</p>` : ''}
  </article>`;
}

function collectProvidersFromDom() {
  const cards = [...page.querySelectorAll('[data-provider-idx]')];
  const providers = [];
  let defaultProviderId = adminDefaultProviderId;
  for (const card of cards) {
    const get = (f) => card.querySelector(`[data-f="${f}"]`);
    const id = get('id')?.value.trim();
    const name = get('name')?.value.trim();
    const url = get('url')?.value.trim();
    const models = (get('models')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
    const modelPrices = {};
    card.querySelectorAll('.model-price-row').forEach(row => {
      const model = row.querySelector('[data-mp-field="model"]')?.value.trim();
      if (!model) return;
      modelPrices[model] = {
        inputPricePer1K: Number(row.querySelector('[data-mp-field="input"]')?.value || 0),
        outputPricePer1K: Number(row.querySelector('[data-mp-field="output"]')?.value || 0)
      };
    });
    const apiKey = get('apiKey')?.value || '';
    const enabled = Boolean(get('enabled')?.checked);
    if (get('isDefault')?.checked) defaultProviderId = id;
    providers.push({
      id,
      name,
      url,
      defaultModel: get('defaultModel')?.value.trim() || '',
      models,
      inputPricePer1K: Number(get('inputPricePer1K')?.value || 0),
      outputPricePer1K: Number(get('outputPricePer1K')?.value || 0),
      priority: Number(get('priority')?.value || 100),
      timeoutMs: Number(get('timeoutMs')?.value || 60000),
      enabled,
      apiKey,
      modelPrices,
      apiKeyConfigured: Boolean(apiKey) || Boolean(adminProvidersCache.find(p => p.id === id)?.apiKeyConfigured)
    });
  }
  return { providers, defaultProviderId };
}

async function renderOperations() {
  document.querySelectorAll('[data-page]').forEach(a => a.classList.toggle('active', a.dataset.page === 'operations'));
  try {
    if (adminTab === 'rates' || adminTab === 'channels') {
      const settings = await api('/api/admin/pricing');
      adminProvidersCache = settings.providers || [];
      adminDefaultProviderId = settings.defaultProviderId;
      if (adminTab === 'rates') {
        shell('运营配置', 'ADMIN CONSOLE', `${adminTabsHtml()}<section class="card"><p class="eyebrow">REAL-TIME PRICING</p><h2>客户计费倍率</h2><p class="sub">新请求将立即按所选倍率计算 Token 和金额；正在进行的请求保持发起时的价格。</p><div class="rate-buttons">${[2,3,4].map(rate=>`<button class="rate-btn ${settings.multiplier===rate?'selected':''}" data-rate="${rate}">${rate}x <small>成本倍率</small></button>`).join('')}</div><p class="sub">也可自定义 1–10：</p><div class="inline-form"><input id="customRate" type="number" min="1" max="10" step="0.1" value="${settings.multiplier}"><button class="primary-btn" id="saveCustomRate">保存倍率</button></div><p id="rateResult" class="inline-msg"></p><div class="health-summary">${(settings.healthSummary||[]).map(h=>`<div class="account-row"><span>${esc(h.name)}</span><b class="${h.health?.ok===false?'bad':'ok-text'}">${h.enabled===false?'已停用':(h.health?.ok===false?'异常':'正常')}</b></div>`).join('')||'<p class="sub">暂无渠道健康信息。</p>'}</div></section>`);
        page.querySelectorAll('[data-rate]').forEach(button => button.onclick = async () => {
          try {
            await api('/api/admin/pricing', { method: 'PUT', body: JSON.stringify({ multiplier: Number(button.dataset.rate) }) });
            renderOperations();
          } catch (error) { $('#rateResult').textContent = error.message; }
        });
        $('#saveCustomRate')?.addEventListener('click', async () => {
          try {
            await api('/api/admin/pricing', { method: 'PUT', body: JSON.stringify({ multiplier: Number($('#customRate').value) }) });
            $('#rateResult').textContent = '倍率已更新';
            $('#rateResult').className = 'inline-msg ok';
            renderOperations();
          } catch (error) { $('#rateResult').textContent = error.message; $('#rateResult').className = 'inline-msg'; }
        });
      } else {
        shell('运营配置', 'ADMIN CONSOLE', `${adminTabsHtml()}<div class="admin-actions-bar"><button class="primary-btn" id="addProvider">+ 添加渠道</button><button class="primary-btn" id="saveProviders">保存全部渠道</button><span id="providerResult" class="inline-msg"></span></div><div id="providersList">${adminProvidersCache.map((p, i) => providerFormHtml(p, i)).join('') || '<section class="card"><p class="sub">尚未配置渠道，请点击添加。</p></section>'}</div>`);
        wireProviderEditor();
      }
    } else if (adminTab === 'users') {
      const { users } = await api('/api/admin/users');
      shell('运营配置', 'ADMIN CONSOLE', `${adminTabsHtml()}<section class="card"><div class="card-head"><div><p class="eyebrow">USERS</p><h2>用户管理</h2></div><span class="sub">${users.length} 位用户</span></div><div id="usersMsg" class="inline-msg"></div><table class="admin-table"><thead><tr><th>邮箱</th><th>用户名</th><th>名称</th><th>余额</th><th>配额</th><th>已用</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>${users.map(u => `<tr data-user="${esc(u.id)}">
        <td>${esc(u.email)}</td>
        <td>@${esc(u.username||'-')}</td>
        <td>${esc(u.name)}</td>
        <td><input class="mini-input" data-edit="balance" type="number" step="0.01" min="0" value="${u.balance}"></td>
        <td><input class="mini-input" data-edit="quotaTokens" type="number" min="0" value="${u.quotaTokens}"></td>
        <td>${Number(u.usedTokens||0).toLocaleString()}</td>
        <td><select data-edit="role"><option value="user" ${u.role==='user'?'selected':''}>user</option><option value="admin" ${u.role==='admin'?'selected':''}>admin</option></select></td>
        <td><span class="tag ${u.accountActive?'success':'danger'}">${u.accountActive?'启用':'停用'}</span></td>
        <td class="ops-cell">
          <button class="ghost-btn" data-toggle-active="${esc(u.id)}" data-active="${u.accountActive}">${u.accountActive?'封禁':'启用'}</button>
          <button class="ghost-btn" data-save-user="${esc(u.id)}">保存</button>
        </td>
      </tr>`).join('')}</tbody></table></section>`);
      page.querySelectorAll('[data-toggle-active]').forEach(btn => btn.onclick = async () => {
        try {
          const active = btn.dataset.active === 'true';
          await api(`/api/admin/users/${btn.dataset.toggleActive}`, { method: 'PUT', body: JSON.stringify({ accountActive: !active }) });
          renderOperations();
        } catch (err) { $('#usersMsg').textContent = err.message; }
      });
      page.querySelectorAll('[data-save-user]').forEach(btn => btn.onclick = async () => {
        const row = btn.closest('tr');
        try {
          await api(`/api/admin/users/${btn.dataset.saveUser}`, {
            method: 'PUT',
            body: JSON.stringify({
              balance: Number(row.querySelector('[data-edit="balance"]').value),
              quotaTokens: Number(row.querySelector('[data-edit="quotaTokens"]').value),
              role: row.querySelector('[data-edit="role"]').value
            })
          });
          $('#usersMsg').textContent = '已保存';
          $('#usersMsg').className = 'inline-msg ok';
          renderOperations();
        } catch (err) { $('#usersMsg').textContent = err.message; $('#usersMsg').className = 'inline-msg'; }
      });
    } else if (adminTab === 'codes') {
      const { codes } = await api('/api/admin/codes');
      shell('运营配置', 'ADMIN CONSOLE', `${adminTabsHtml()}<div class="content-grid"><section class="card"><p class="eyebrow">GENERATE</p><h2>生成卡密</h2><form id="genCodesForm" class="stack-form"><label>数量<input name="count" type="number" min="1" max="200" value="5" required></label><label>金额 ¥<input name="amount" type="number" min="0" step="0.01" value="10" required></label><label>Token 配额<input name="quotaTokens" type="number" min="0" value="100000" required></label><label>前缀<input name="prefix" value="RELAY"></label><button class="primary-btn" type="submit">生成</button></form><div id="codesMsg" class="inline-msg"></div></section><section class="card"><p class="eyebrow">CODES</p><h2>卡密列表</h2><table class="admin-table"><thead><tr><th>卡密</th><th>金额</th><th>配额</th><th>状态</th><th>用户</th></tr></thead><tbody>${codes.slice().reverse().slice(0,100).map(c=>`<tr><td><code>${esc(c.code)}</code></td><td>¥${Number(c.amount).toFixed(2)}</td><td>${Number(c.quotaTokens).toLocaleString()}</td><td><span class="tag ${c.usedAt?'danger':'success'}">${c.usedAt?'已用':'未用'}</span></td><td>${esc(c.userId||'-')}</td></tr>`).join('')||'<tr><td colspan="5" class="empty">暂无卡密</td></tr>'}</tbody></table></section></div>`);
      $('#genCodesForm')?.addEventListener('submit', async e => {
        e.preventDefault();
        const fd = new FormData(e.target);
        try {
          const j = await api('/api/admin/codes', {
            method: 'POST',
            body: JSON.stringify({
              count: Number(fd.get('count')),
              amount: Number(fd.get('amount')),
              quotaTokens: Number(fd.get('quotaTokens')),
              prefix: String(fd.get('prefix') || 'RELAY')
            })
          });
          $('#codesMsg').textContent = `已生成 ${j.codes.length} 个卡密`;
          $('#codesMsg').className = 'inline-msg ok';
          renderOperations();
        } catch (err) { $('#codesMsg').textContent = err.message; $('#codesMsg').className = 'inline-msg'; }
      });
    } else if (adminTab === 'audit') {
      const { entries } = await api('/api/admin/audit');
      shell('运营配置', 'ADMIN CONSOLE', `${adminTabsHtml()}<section class="card"><div class="card-head"><div><p class="eyebrow">AUDIT LOG</p><h2>最近审计</h2></div><span class="sub">最多 200 条</span></div><table class="admin-table"><thead><tr><th>时间</th><th>操作</th><th>目标</th><th>操作者</th><th>详情</th></tr></thead><tbody>${entries.map(e=>`<tr><td>${new Date(e.createdAt).toLocaleString('zh-CN')}</td><td>${esc(e.action)}</td><td>${esc(e.target||'-')}</td><td>${esc(e.actorId||'-')}</td><td><code class="detail-code">${esc(JSON.stringify(e.detail||{}))}</code></td></tr>`).join('')||'<tr><td colspan="5" class="empty">暂无审计记录</td></tr>'}</tbody></table></section>`);
    } else if (adminTab === 'orders') {
      const { orders } = await api('/api/admin/orders');
      shell('运营配置', 'ADMIN CONSOLE', `${adminTabsHtml()}<section class="card"><div class="card-head"><div><p class="eyebrow">ORDERS</p><h2>兑换订单</h2></div><span class="sub">${orders.length} 笔</span></div><table class="admin-table"><thead><tr><th>订单 ID</th><th>卡密</th><th>金额</th><th>配额</th><th>用户</th><th>兑换时间</th></tr></thead><tbody>${orders.map(o=>`<tr><td>${esc(o.id)}</td><td><code>${esc(o.code)}</code></td><td>¥${Number(o.amount).toFixed(2)}</td><td>${Number(o.quotaTokens).toLocaleString()}</td><td>${esc(o.userId||'-')}</td><td>${o.redeemedAt?new Date(o.redeemedAt).toLocaleString('zh-CN'):'-'}</td></tr>`).join('')||'<tr><td colspan="6" class="empty">暂无订单</td></tr>'}</tbody></table></section>`);
    }
    page.querySelectorAll('[data-admin-tab]').forEach(btn => btn.onclick = () => { adminTab = btn.dataset.adminTab; renderOperations(); });
  } catch (error) {
    shell('运营配置', 'ADMIN CONSOLE', `${adminTabsHtml()}<section class="card"><h2>无法加载配置</h2><p class="sub">${esc(error.message)}</p></section>`);
    page.querySelectorAll('[data-admin-tab]').forEach(btn => btn.onclick = () => { adminTab = btn.dataset.adminTab; renderOperations(); });
  }
}

function wireProviderEditor() {
  const refreshFromDom = () => {
    const collected = collectProvidersFromDom();
    adminProvidersCache = collected.providers;
    adminDefaultProviderId = collected.defaultProviderId;
  };

  $('#addProvider')?.addEventListener('click', () => {
    refreshFromDom();
    adminProvidersCache.push({
      id: `provider_${Date.now().toString(36)}`,
      name: '新渠道',
      url: 'https://',
      defaultModel: '',
      models: [],
      inputPricePer1K: 0,
      outputPricePer1K: 0,
      priority: 100,
      timeoutMs: 60000,
      enabled: true,
      apiKey: '',
      apiKeyConfigured: false,
      modelPrices: {},
      health: { ok: true, lastCheckedAt: null, lastError: null }
    });
    renderOperations();
  });

  page.querySelectorAll('[data-remove-provider]').forEach(btn => btn.onclick = () => {
    refreshFromDom();
    const idx = Number(btn.dataset.removeProvider);
    adminProvidersCache.splice(idx, 1);
    renderOperations();
  });

  page.querySelectorAll('[data-add-mp]').forEach(btn => btn.onclick = () => {
    refreshFromDom();
    const idx = Number(btn.dataset.addMp);
    adminProvidersCache[idx].modelPrices = adminProvidersCache[idx].modelPrices || {};
    let n = 1;
    while (adminProvidersCache[idx].modelPrices[`model-${n}`]) n += 1;
    adminProvidersCache[idx].modelPrices[`model-${n}`] = { inputPricePer1K: 0, outputPricePer1K: 0 };
    renderOperations();
  });

  page.querySelectorAll('[data-remove-mp]').forEach(btn => btn.onclick = () => {
    refreshFromDom();
    const [pIdx, mpIdx] = btn.dataset.removeMp.split(':').map(Number);
    const keys = Object.keys(adminProvidersCache[pIdx].modelPrices || {});
    const key = keys[mpIdx];
    if (key) delete adminProvidersCache[pIdx].modelPrices[key];
    renderOperations();
  });

  $('#saveProviders')?.addEventListener('click', async () => {
    try {
      const { providers, defaultProviderId } = collectProvidersFromDom();
      if (!providers.length) throw Error('至少保留一个渠道');
      await api('/api/admin/providers', { method: 'PUT', body: JSON.stringify({ providers, defaultProviderId }) });
      $('#providerResult').textContent = '已保存，后续请求将按新渠道配置路由。';
      $('#providerResult').className = 'inline-msg ok';
      adminProvidersCache = providers;
      adminDefaultProviderId = defaultProviderId;
      renderOperations();
    } catch (error) {
      $('#providerResult').textContent = `保存失败：${error.message}`;
      $('#providerResult').className = 'inline-msg';
    }
  });
}

const bootBase = boot;
boot = async function() {
  await bootBase();
  if (me?.isAdmin && !$('#operationsNav')) {
    const nav = document.querySelector('.sidebar nav');
    const group = document.createElement('span');
    group.id = 'operationsNav';
    group.innerHTML = '<p>运营</p><a data-page="operations">⌘ 运营配置</a>';
    nav.appendChild(group);
    group.querySelector('[data-page]').onclick = () => render('operations');
  }
};
if (token) boot();
