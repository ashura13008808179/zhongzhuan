const $=s=>document.querySelector(s);
const TOKEN_KEY='relay_token', REMEMBER_KEY='relay_remember', LOGIN_KEY='relay_login';
const AVATARS=[
  {id:'letter',label:'首字母'},
  {id:'lime',label:'青柠'},
  {id:'cyan',label:'湖青'},
  {id:'sunset',label:'暮光'},
  {id:'mint',label:'薄荷'},
  {id:'violet',label:'紫雾'},
  {id:'ember',label:'熔岩'},
  {id:'slate',label:'岩灰'}
];
function readStoredToken(){ return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY); }
function persistToken(value, remember){
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  if(!value) return;
  (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, value);
}
function rememberPrefill(){
  const remember = localStorage.getItem(REMEMBER_KEY) === '1';
  const box = $('#rememberMe');
  if(box) box.checked = remember;
  const saved = localStorage.getItem(LOGIN_KEY) || '';
  const loginInput = $('#loginIdentifier');
  if(loginInput && saved && !loginInput.value) loginInput.value = saved;
}
function avatarIdOf(user){ return AVATARS.some(a=>a.id===user?.avatar) ? user.avatar : 'letter'; }
function initialOf(user){ return String(user?.name||user?.username||'?').trim().slice(0,1).toUpperCase() || '?'; }
function paintAvatar(el, user){
  if(!el) return;
  const id = avatarIdOf(user);
  const extras = [...el.classList].filter(c=>c!=='avatar' && !c.startsWith('is-'));
  el.className = ['avatar', 'is-'+id, ...extras].join(' ');
  el.innerHTML = id==='letter' ? esc(initialOf(user)) : '<span class="avatar-mark" aria-hidden="true"></span>';
}
function paintUserAvatars(){
  paintAvatar($('#sideAvatar'), me);
  paintAvatar($('#topAvatar'), me);
}
function closeAvatarMenu(){
  const menu = $('#avatarMenu');
  if(menu) menu.hidden = true;
  ['#topAvatar','#sideAvatar'].forEach(sel=>{
    const btn=$(sel);
    if(btn) btn.setAttribute('aria-expanded','false');
  });
}
function openAvatarMenu(anchor){
  const menu = $('#avatarMenu'), grid = $('#avatarGrid');
  if(!menu || !grid) return;
  const current = avatarIdOf(me);
  grid.innerHTML = AVATARS.map(a=>`<button type="button" class="avatar-choice ${current===a.id?'selected':''}" data-avatar="${a.id}" title="${esc(a.label)}"><span class="avatar is-${a.id}">${a.id==='letter'?esc(initialOf(me)):'<span class="avatar-mark"></span>'}</span><small>${esc(a.label)}</small></button>`).join('');
  grid.querySelectorAll('[data-avatar]').forEach(btn=>{
    btn.onclick = async ()=>{
      const next = btn.dataset.avatar;
      try{
        const j = await api('/api/me', { method:'PATCH', body: JSON.stringify({ avatar: next }) });
        me = { ...me, ...j.user };
        paintUserAvatars();
        closeAvatarMenu();
      }catch(err){
        btn.classList.add('error');
        btn.title = err.message;
      }
    };
  });
  menu.hidden = false;
  if(anchor){
    const r = anchor.getBoundingClientRect();
    const width = Math.min(280, window.innerWidth - 16);
    let left = r.right - width;
    if(left < 8) left = 8;
    let top = r.bottom + 8;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.width = `${width}px`;
    requestAnimationFrame(()=>{
      const box = menu.getBoundingClientRect();
      if(box.bottom > window.innerHeight - 8){
        menu.style.top = `${Math.max(8, r.top - box.height - 8)}px`;
      }
    });
    anchor.setAttribute('aria-expanded','true');
  }
}
let token=readStoredToken(),me=null,data=null,checkin=null;
const authView=$('#authView'),dash=$('#dashboard'),page=$('#page');
function isMobileNav(){ return window.matchMedia('(max-width: 600px)').matches; }
function setMobileNav(open){
  if(!dash) return;
  dash.classList.toggle('nav-open', !!open);
  document.body.classList.toggle('nav-lock', !!open);
  const btn=$('#menuBtn'), backdrop=$('#sidebarBackdrop'), side=$('#appSidebar');
  if(btn){
    btn.setAttribute('aria-expanded', open?'true':'false');
    btn.setAttribute('aria-label', open?'关闭菜单':'打开菜单');
  }
  if(backdrop) backdrop.hidden=!open;
  if(side){
    if(isMobileNav()) side.setAttribute('aria-hidden', open?'false':'true');
    else side.removeAttribute('aria-hidden');
  }
}
function closeMobileNav(){ setMobileNav(false); }
function toggleMobileNav(){ setMobileNav(!dash?.classList.contains('nav-open')); }
$('#menuBtn')?.addEventListener('click', e=>{ e.stopPropagation(); toggleMobileNav(); });
$('#sidebarBackdrop')?.addEventListener('click', closeMobileNav);
document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeMobileNav(); });
window.matchMedia('(max-width: 600px)').addEventListener('change', e=>{
  if(!e.matches) closeMobileNav();
  else setMobileNav(false);
});

function fmtRate(n){
  const x=Number(n);
  if(!Number.isFinite(x)) return '1';
  return String(Math.round(x*10000)/10000);
}
function spentTokens(l){
  const n=Number(l?.billedTokens ?? l?.tokens ?? 0);
  return Math.round(Number.isFinite(n)?n:0);
}
function logIsPending(l){
  return !!(l?.pendingActual || l?.status==='pending_actual_cost');
}
function logStatusTag(l){
  if(logIsPending(l)) return '<span class="tag warn">待对齐账单</span>';
  if(l?.status==='stream_incomplete' || l?.status==='client_abort') return '<span class="tag warn">未完成</span>';
  if(l?.status && l.status!=='success') return `<span class="tag danger">${esc(l.status)}</span>`;
  return '<span class="tag success">成功</span>';
}
function logChargeText(l){
  const amt=Number(l?.collectedAmount ?? l?.alreadyCharged ?? l?.chargedAmount ?? 0);
  if(logIsPending(l)) return '¥'+amt.toFixed(4)+' · 对齐中';
  return '¥'+Number(l?.chargedAmount||0).toFixed(4);
}
function groupRateSuffix(g){
  const n=Number(g?.displayMultiplier);
  if(!Number.isFinite(n)) return '';
  return `（${fmtRate(n)}x）`;
}
function groupOptionLabel(g){
  const maint=g?.maintenance?`（${g.maintenanceMessage||'请联系站长购买'}）`:'';
  return `${g?.name||''}${groupRateSuffix(g)}${maint}`;
}
function rateEquals(a,b){ return Math.abs(Number(a)-Number(b))<1e-8; }
function esc(x=''){return String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function api(url,opts={}){const r=await fetch(url,{...opts,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})}});const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||'请求失败');return j}
function diagTag(r){
  if(!r.ok) return {tag:'失败', cls:'danger'};
  if(r.level==='warn') return {tag:'警告', cls:'warn'};
  return {tag:'通过', cls:'success'};
}
function fmtDiagRate(n){
  const x=Number(n);
  if(!Number.isFinite(x)) return '—';
  return `${Math.round(x*10000)/10000}x`;
}
function diagReportHtml(report){
  if(!report) return '<p class="sub">尚未运行过诊断。</p>';
  const s=report.summary||{};
  const list=report.results||[];
  if(!list.length){
    return `<p class="sub">上次：${esc((report.at||'').replace('T',' ').slice(0,19))} · 通过 ${s.passed??'-'} / 警告 ${s.warned??'-'} / 失败 ${s.failed??'-'}。明细未保存，请再点一次「运行全部测试」。</p>`;
  }
  const rows=list.map(r=>{
    const {tag,cls}=diagTag(r);
    const latency=(r.latencyMs==null||r.latencyMs==='')?'—':`${r.latencyMs}ms`;
    const rate=(r.billingMultiplier!=null||r.displayMultiplier!=null)
      ? `扣 ${fmtDiagRate(r.billingMultiplier)} / 展 ${fmtDiagRate(r.displayMultiplier)}`
      : '—';
    const showFix=Array.isArray(r.fix)&&r.fix.length&&(!r.ok||r.level==='warn');
    return `<tr>
      <td><span class="tag ${cls}">${tag}</span></td>
      <td>${esc(r.name)}</td>
      <td>${esc(latency)}</td>
      <td>${esc(rate)}</td>
      <td>
        <div>${esc(r.message||'')}</div>
        ${r.detail?`<div class="sub">${esc(r.detail)}</div>`:''}
        ${showFix?`<ol class="fix-list">${r.fix.map(f=>`<li>${esc(f)}</li>`).join('')}</ol>`:''}
      </td>
    </tr>`;
  }).join('');
  const when=report.at?esc(String(report.at).replace('T',' ').slice(0,19)):'';
  return `
    <p class="sub" style="margin:8px 0">${when?`时间 ${when} · `:''}通过 ${s.passed||0} · 警告 ${s.warned||0} · 失败 ${s.failed||0}</p>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>结果</th><th>项目</th><th>延迟</th><th>倍率</th><th>说明 / 报错 / 解决办法</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${s.failed?`<p class="sub">失败项已写入「网站错误」栏。</p>`:''}`;
}
function msg(t,ok=false){const e=$('#authMessage');e.textContent=t;e.className=`auth-message ${ok?'ok':''}`}
function setAuthMode(mode){
  document.querySelectorAll('[data-auth]').forEach(x=>{
    const on=x.dataset.auth===mode;
    x.classList.toggle('active',on);
    x.setAttribute('aria-selected',on?'true':'false');
  });
  const login=$('#loginForm'), reg=$('#registerForm');
  if(login){ login.hidden = mode!=='login'; login.style.display = mode==='login' ? '' : 'none'; }
  if(reg){ reg.hidden = mode!=='register'; reg.style.display = mode==='register' ? '' : 'none'; }
  $('#authCard')?.classList.toggle('is-register', mode==='register');
  msg('');
}
document.querySelectorAll('[data-auth]').forEach(b=>b.onclick=()=>setAuthMode(b.dataset.auth));
setAuthMode('login');
rememberPrefill();
$('#loginForm').onsubmit=async e=>{e.preventDefault();try{const identifier=$('#loginIdentifier').value.trim();const remember=!!$('#rememberMe')?.checked;const j=await api('/api/auth/login',{method:'POST',body:JSON.stringify({login:identifier,password:$('#loginPassword').value})});token=j.token;localStorage.setItem(REMEMBER_KEY,remember?'1':'0');if(remember) localStorage.setItem(LOGIN_KEY,identifier);else localStorage.removeItem(LOGIN_KEY);persistToken(token,remember);await boot()}catch(err){msg(err.message)}};
$('#registerForm').onsubmit=async e=>{e.preventDefault();try{const j=await api('/api/auth/register',{method:'POST',body:JSON.stringify({email:$('#regEmail').value.trim(),username:$('#regUsername').value.trim(),name:$('#regName').value.trim(),password:$('#regPassword').value,inviteCode:$('#regInvite').value.trim()})});token=j.token;persistToken(token,true);localStorage.setItem(REMEMBER_KEY,'1');const ident=$('#regUsername').value.trim()||$('#regEmail').value.trim();if(ident) localStorage.setItem(LOGIN_KEY,ident);await boot()}catch(err){msg(err.message)}};
$('#logoutBtn').onclick=async()=>{try{if(token)await api('/api/auth/logout',{method:'POST'});}catch{}stopPayLive();persistToken(null);location.reload()};
$('#payLiveCopy')?.addEventListener('click',async()=>{
  const code=$('#payLiveCode')?.textContent||'';
  if(!code) return;
  try{
    await navigator.clipboard.writeText(code);
    $('#payLiveCopy').textContent='已复制 ✓';
    setTimeout(()=>{ const b=$('#payLiveCopy'); if(b) b.textContent='复制'; },1200);
  }catch(_e){}
});
$('#payLiveClose')?.addEventListener('click',()=>{ const m=$('#payLiveModal'); if(m) m.hidden=true; });
$('#payLiveGo')?.addEventListener('click',()=>{
  const code=$('#payLiveCode')?.textContent||'';
  const m=$('#payLiveModal'); if(m) m.hidden=true;
  window.__pendingRedeemCode=code;
  render('billing');
});
async function boot(){try{data=await api('/api/dashboard');me=data.user;try{checkin=await api('/api/checkin/status')}catch{checkin=null}authView.hidden=true;dash.hidden=false;$('#sideName').textContent=me.name;$('#sideEmail').textContent=me.username?`@${me.username}`:me.email;paintUserAvatars();render('overview')}catch{persistToken(null);token=null}}
$('#helpTip')?.addEventListener('click',()=>{ closeMobileNav(); render('contact'); });
['#topAvatar','#sideAvatar'].forEach(sel=>{
  $(sel)?.addEventListener('click', e=>{
    e.stopPropagation();
    const menu=$('#avatarMenu');
    if(menu && !menu.hidden && e.currentTarget.getAttribute('aria-expanded')==='true'){ closeAvatarMenu(); return; }
    openAvatarMenu(e.currentTarget);
  });
});
document.addEventListener('click', e=>{
  const menu=$('#avatarMenu');
  if(!menu || menu.hidden) return;
  if(menu.contains(e.target) || e.target.closest('#topAvatar,#sideAvatar')) return;
  closeAvatarMenu();
});
  document.addEventListener('keydown', e=>{ if(e.key==='Escape'){ closeAvatarMenu(); const m=$('#payLiveModal'); if(m && !m.hidden) m.hidden=true; } });
function shell(title,kicker,html){$('#pageTitle').textContent=title;page.innerHTML=`<div class="page-head"><div><p class="eyebrow">${kicker}</p><h1>${title}</h1><p class="sub">管理你的 Relay Station 账户与 API 服务</p></div></div>${html}`}
let myPayOrdersPollTimer=null;
let myPayOrdersPrevSnap={};
let payLiveAbort=null;
let payLiveSeq=-1;
const shownPayCodes=new Set();
function stopMyPayOrdersPoll(){
  if(myPayOrdersPollTimer){ clearInterval(myPayOrdersPollTimer); myPayOrdersPollTimer=null; }
}
function stopPayLive(){
  if(payLiveAbort){ try{ payLiveAbort.abort(); }catch(_e){} payLiveAbort=null; }
}
function showIssuedCodeLive(code, amount){
  if(!code || shownPayCodes.has(code)) return;
  shownPayCodes.add(code);
  const input=$('#redeemCode');
  if(input) input.value=code;
  const billingModal=$('#codeModal');
  const billingCode=$('#modalCode');
  if(billingModal && billingCode){
    const eyebrow=$('#modalEyebrow');
    const title=$('#modalTitle');
    const sub=$('#modalSub');
    const codeBox=billingModal.querySelector('.key-box');
    if(eyebrow) eyebrow.textContent='CARD CODE';
    if(title) title.textContent='付款已确认，卡密已发放';
    if(sub) sub.textContent='请复制卡密并兑换；也可一键填入左侧兑换框。无需刷新页面。';
    if(codeBox) codeBox.hidden=false;
    billingCode.textContent=code;
    const fill=$('#modalFill');
    if(fill) fill.hidden=false;
    billingModal.hidden=false;
    return;
  }
  const modal=$('#payLiveModal');
  if(!modal) return;
  $('#payLiveCode').textContent=code;
  $('#payLiveSub').textContent=`¥${Number(amount||0).toFixed(0)} 已确认到账并发放卡密。请复制后兑换，无需刷新页面。`;
  modal.hidden=false;
}
function startPayLive(){
  stopPayLive();
  if(!token) return;
  payLiveAbort=new AbortController();
  const signal=payLiveAbort.signal;
  (async()=>{
    while(token && !signal.aborted){
      try{
        const r=await fetch('/api/recharge/wait?after='+payLiveSeq,{
          headers:{ Authorization:'Bearer '+token },
          signal
        });
        const j=await r.json().catch(()=>({}));
        if(r.status===401){ stopPayLive(); return; }
        if(!r.ok){
          await new Promise(res=>setTimeout(res,1500));
          continue;
        }
        if(Number.isFinite(Number(j.seq))) payLiveSeq=Number(j.seq);
        for(const ev of j.events||[]){
          if(ev.kind==='confirmed' && ev.code){
            showIssuedCodeLive(ev.code, ev.amount);
            const refresh=$('#refreshPayOrders');
            if(refresh) refresh.click();
          }
        }
      }catch(e){
        if(signal.aborted) return;
        await new Promise(res=>setTimeout(res,1500));
      }
    }
  })();
}
function render(name){
  stopMyPayOrdersPoll();
  document.querySelectorAll('[data-page]').forEach(a=>a.classList.toggle('active',a.dataset.page===name));
  if(name==='overview')shell('数据概览','ACCOUNT OVERVIEW',`<div class="metric-grid"><article><small>账户余额</small><strong>${me.unlimited||me.isAdmin?'无限':('¥'+Number(me.balance||0).toFixed(2))}</strong><span class="green">${me.unlimited||me.isAdmin?'管理员不扣本地余额':'可用于 API 调用'}</span></article><article><small>累计请求</small><strong>${data.stats.requests.toLocaleString()}</strong><span>成功率 ${data.stats.requests?Math.round(data.stats.success/data.stats.requests*100):100}%</span></article><article><small>累计用量</small><strong>${Number(data.stats.usedTokens||data.stats.billedTokens||0).toLocaleString()}</strong><span>账户已计费用量</span></article><article><small>累计花销</small><strong>¥${Number(data.stats.totalSpent||0).toFixed(2)}</strong><span>API 调用累计扣费</span></article></div><div class="content-grid"><section class="card"><div class="card-head"><div><p class="eyebrow">RECENT REQUESTS</p><h2>最近请求</h2></div><button class="link-btn" data-page="logs">查看全部 →</button></div><table><thead><tr><th>模型</th><th>Token</th><th>花销</th><th>延迟</th><th>状态</th><th>时间</th></tr></thead><tbody>${data.logs.slice(0,8).map(l=>`<tr><td>${esc(l.model)}</td><td>${spentTokens(l)}</td><td>${logChargeText(l)}</td><td>${l.latency}ms</td><td>${logStatusTag(l)}</td><td>${new Date(l.createdAt).toLocaleString('zh-CN')}</td></tr>`).join('')||'<tr><td colspan="6" class="empty">暂无请求记录</td></tr>'}</tbody></table></section><section class="card balance-card"><p class="eyebrow">QUICK ACTIONS</p><h2>快捷操作</h2><button class="action" data-page="checkin"><span>✦</span><div><b>每日签到</b><small>${checkin?.checkedInToday?`今日已领 ¥${Number(checkin.todayAmount||0).toFixed(2)}`:'随机领取 ¥0.05–¥0.50'}</small></div><i>→</i></button><button class="action" data-page="api"><span>◈</span><div><b>查看 API 接入</b><small>复制你的专属调用密钥</small></div><i>→</i></button><button class="action" data-page="billing"><span>◇</span><div><b>卡密充值</b><small>充值后立即到账</small></div><i>→</i></button><button class="action" data-page="referral"><span>♧</span><div><b>邀请好友</b><small>好友付费后返利 5%</small></div><i>→</i></button></section></div>`);
  if(name==='checkin'){renderCheckIn();return;}
  if(name==='operations'){renderOperations();return;}
  if(name==='api'){renderApiKeys();return;}
  if(name==='logs')shell('使用日志','REQUEST LOGS',`<section class="card"><div class="card-head"><div><p class="eyebrow">AUDIT TRAIL</p><h2>全部请求记录</h2></div></div><table><thead><tr><th>时间</th><th>模型</th><th>Token</th><th>花销</th><th>延迟</th><th>状态</th></tr></thead><tbody>${data.logs.map(l=>`<tr><td>${new Date(l.createdAt).toLocaleString('zh-CN')}</td><td>${esc(l.model)}</td><td>${spentTokens(l)}</td><td>${logChargeText(l)}</td><td>${l.latency}ms</td><td>${logStatusTag(l)}</td></tr>`).join('')||'<tr><td colspan="6" class="empty">暂无日志</td></tr>'}</tbody></table></section>`);
  if(name==='billing'){
  shell('卡密充值','BILLING & RECHARGE','<section class="card"><p class="sub">正在加载充值方案…</p></section>');
  (async () => {
    await ensureAppConfig();
    renderBillingContent();
  })();
  return;
}
function renderBillingContent(){

  const plans=(window.appConfig?.paymentPlans||[{amount:10,qr:''},{amount:30,qr:''},{amount:50,qr:''},{amount:100,qr:''}]);
  shell('卡密充值','BILLING & RECHARGE',`<div class="billing-grid">
    <section class="card recharge-card"><p class="eyebrow">REDEEM CODE</p><h2>使用充值卡密</h2><p class="sub">每张卡密只能兑换一次。付款确认后发给你的卡密仅本人可用，别人乱试兑不了。</p><form id="redeemForm"><input id="redeemCode" placeholder="例如：R10-XXXX" required><button class="primary-btn">立即充值 ↗</button></form><div id="redeemMsg" class="inline-msg"></div></section>
    <section class="card"><p class="eyebrow">PAYMENT</p><h2>购买卡密</h2><p class="sub">选择金额并确认购买后扫码付款；付款备注请填写你的用户名，付完再提交确认，管理员核对后发卡。</p>
      <div class="pay-method-tabs" id="payMethodTabs">
        <button type="button" class="pay-method-btn active" data-method="wechat">微信支付</button>
        <button type="button" class="pay-method-btn" data-method="alipay">支付宝</button>
      </div>
      <div class="amount-grid" id="amountGrid">${plans.map(p=>{
        const credit=Number(p.creditAmount||p.amount);
        const bonus=credit>Number(p.amount);
        return `<button type="button" class="amount-btn" data-amount="${p.amount}">¥${p.amount}${bonus?`<small>到账 ¥${credit}</small>`:''}</button>`;
      }).join('')}</div>
      <button class="primary-btn" id="confirmPayBtn" type="button" disabled style="margin-top:14px;width:100%">确认购买</button>
      <div id="payPanel" class="pay-panel" hidden>
        <p class="sub" id="payHint"></p>
        <div class="pay-note-box" id="payNoteBox" hidden>
          <p class="eyebrow">付款备注</p>
          <p class="sub">请用微信/支付宝付款码支付时，在<strong>备注</strong>里填写你的用户名，方便管理员核对到账：</p>
          <div class="key-box"><code id="payNoteCode"></code><button type="button" id="copyPayNote">复制用户名</button></div>
        </div>
        <div class="pay-expiry-tip" id="payExpiryTip" hidden></div>
        <div class="qr-placeholder" id="payQrBox"><img id="payQrImg" alt="付款码" hidden><span id="payQrFallback">请先选择金额</span></div>
        <p class="pay-soft-tip" id="paySoftTip">若扫码提示二维码已过期或无法支付，请切换另一种付款方式，或联系客服更换收款码。</p>
        <button class="primary-btn" id="paidClaimBtn" type="button" style="width:100%;margin-top:12px">我已付款，提交确认</button>
        <div id="claimMsg" class="inline-msg"></div>
      </div>
    </section>
    <section class="card" style="grid-column:1/-1"><div class="card-head"><div><p class="eyebrow">MY ORDERS</p><h2>我的付款订单</h2><p class="sub">付款时请在备注填写你的用户名。管理员确认到账后，这里才会出现可复制的卡密。</p></div><button type="button" class="link-btn" id="refreshPayOrders">刷新</button></div><div id="myPayOrders"><p class="sub">加载中…</p></div></section>
  </div>
  <div id="codeModal" class="modal" hidden>
    <div class="modal-card">
      <p class="eyebrow" id="modalEyebrow">PENDING</p>
      <h2 id="modalTitle">已提交，等待确认</h2>
      <p class="sub" id="modalSub">管理员确认到账后才会发放卡密。可在下方「我的付款订单」查看进度。</p>
      <div class="key-box"><code id="modalCode"></code><button type="button" id="modalCopy">复制</button></div>
      <div class="ops-cell" style="margin-top:14px">
        <button class="primary-btn" type="button" id="modalFill">填入兑换框</button>
        <button class="ghost-btn" type="button" id="modalClose">关闭</button>
      </div>
    </div>
  </div>`);
  if(window.__pendingRedeemCode){
    const input=$('#redeemCode');
    if(input) input.value=window.__pendingRedeemCode;
    window.__pendingRedeemCode='';
  }
  let selectedAmount=null;
  let selectedMethod='wechat';
  let currentPayOrderId=null;
  let currentPayNote=null;
  const methodLabels={wechat:'微信',alipay:'支付宝'};
  const grid=$('#amountGrid');
  const confirmBtn=$('#confirmPayBtn');
  const panel=$('#payPanel');
  const modal=$('#codeModal');
  const showPendingModal=(j)=>{
    const eyebrow=$('#modalEyebrow');
    const title=$('#modalTitle');
    const sub=$('#modalSub');
    const codeBox=modal.querySelector('.key-box');
    if(eyebrow) eyebrow.textContent='PENDING';
    if(title) title.textContent='已提交，等待确认到账';
    if(sub) sub.textContent=(j&&j.message)||'管理员确认收款后才会发放卡密，请勿重复提交。';
    if(codeBox) codeBox.hidden=true;
    const fill=$('#modalFill');
    if(fill) fill.hidden=true;
    modal.hidden=false;
  };
  const showCodeModal=(code)=>{
    const eyebrow=$('#modalEyebrow');
    const title=$('#modalTitle');
    const sub=$('#modalSub');
    const codeBox=modal.querySelector('.key-box');
    if(eyebrow) eyebrow.textContent='CARD CODE';
    if(title) title.textContent='付款已确认，卡密已发放';
    if(sub) sub.textContent='请复制卡密并兑换；也可一键填入左侧兑换框。';
    if(codeBox) codeBox.hidden=false;
    $('#modalCode').textContent=code;
    const fill=$('#modalFill');
    if(fill) fill.hidden=false;
    modal.hidden=false;
  };
  const loadMyPayOrders=async()=>{
    const box=$('#myPayOrders');
    if(!box){ stopMyPayOrdersPoll(); return; }
    try{
      const j=await api('/api/recharge/orders');
      const orders=j.orders||[];
      const statusText={awaiting_payment:'待支付',pending:'待核对',confirmed:'已确认',rejected:'已拒绝'};
      const methodText={wechat:'微信',alipay:'支付宝'};
      const nextSnap={};
      for(const o of orders){
        const prev=myPayOrdersPrevSnap[o.id];
        if(prev && (prev==='awaiting_payment'||prev==='pending') && o.status==='confirmed' && o.code){
          try{ showIssuedCodeLive(o.code, o.amount); }catch(_e){}
        }
        nextSnap[o.id]=o.status;
      }
      myPayOrdersPrevSnap=nextSnap;
      const rows=orders.map(o=>{
        const st=statusText[o.status]||o.status;
        let extra='';
        if(o.status==='confirmed' && o.code){
          extra=`<div class="order-code-cell"><code>${esc(o.code)}</code>
            <button type="button" class="link-btn copy-issued-code" data-code="${esc(o.code)}">复制卡密</button>
            <button type="button" class="link-btn fill-issued-code" data-code="${esc(o.code)}">填入兑换框</button></div>`;
        }else if(o.status==='awaiting_payment'){
          extra=`<span class="sub">待支付 · 付款备注请填用户名</span>`;
        }else if(o.status==='pending'){
          extra=`<span class="sub">待核对（备注应为用户名）</span>`;
        }else if(o.status==='rejected'){
          extra=`<span class="warning">${esc(o.rejectReason||'未确认到账')}</span>`;
        }else{
          extra='-';
        }
        return `<tr><td>${esc(methodText[o.method]||o.method)}</td><td>¥${Number(o.amount).toFixed(0)}</td><td>${esc(st)}</td><td>${o.createdAt?new Date(o.createdAt).toLocaleString('zh-CN'):'-'}</td><td>${extra}</td></tr>`;
      }).join('')||'<tr><td colspan="5" class="empty">暂无付款订单</td></tr>';
      box.innerHTML=`<table class="admin-table"><thead><tr><th>方式</th><th>金额</th><th>状态</th><th>提交时间</th><th>卡密</th></tr></thead><tbody>${rows}</tbody></table>`;
      box.querySelectorAll('.copy-issued-code').forEach(btn=>{
        btn.onclick=async()=>{
          try{
            await navigator.clipboard.writeText(btn.dataset.code||'');
            btn.textContent='已复制';
            setTimeout(()=>{btn.textContent='复制卡密';},1200);
          }catch(_e){
            showCodeModal(btn.dataset.code);
          }
        };
      });
      box.querySelectorAll('.fill-issued-code').forEach(btn=>{
        btn.onclick=()=>{
          const input=$('#redeemCode');
          if(input){ input.value=btn.dataset.code||''; input.focus(); }
        };
      });
      const hasOpen=orders.some(o=>o.status==='awaiting_payment'||o.status==='pending');
      stopMyPayOrdersPoll();
      if(hasOpen) myPayOrdersPollTimer=setInterval(()=>{ loadMyPayOrders(); }, 2000);
    }catch(err){
      box.innerHTML=`<p class="inline-msg">${esc(err.message||'加载失败')}</p>`;
    }
  };

  const qrFor=(plan, method)=>{
    if(!plan) return '';
    if(plan.methods && plan.methods[method]) return String(plan.methods[method]||'').trim();
    if(method==='alipay') return String(plan.alipay||'').trim();
    return String(plan.wechat||plan.qr||'').trim();
  };
  $('#payMethodTabs')?.querySelectorAll('.pay-method-btn').forEach(btn=>{
    btn.onclick=()=>{
      $('#payMethodTabs').querySelectorAll('.pay-method-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      selectedMethod=btn.dataset.method||'wechat';
      currentPayOrderId=null;
      currentPayNote=null;
      const nb=$('#payNoteBox'); if(nb) nb.hidden=true;
      panel.hidden=true;
      $('#claimMsg').textContent='';
    };
  });
  grid?.querySelectorAll('.amount-btn').forEach(btn=>{
    btn.onclick=()=>{
      grid.querySelectorAll('.amount-btn').forEach(b=>b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedAmount=Number(btn.dataset.amount);
      currentPayOrderId=null;
      currentPayNote=null;
      const nb=$('#payNoteBox'); if(nb) nb.hidden=true;
      confirmBtn.disabled=false;
      panel.hidden=true;
      $('#claimMsg').textContent='';
    };
  });
  confirmBtn?.addEventListener('click',async()=>{
    if(!selectedAmount)return;
    if(!(plans.find(p=>Number(p.amount)===selectedAmount && qrFor(p, selectedMethod)))){
      try { await ensureAppConfig(); const fresh=window.appConfig?.paymentPlans; if(Array.isArray(fresh)&&fresh.length){ plans.splice(0, plans.length, ...fresh); } } catch(_e){}
    }
    const plan=plans.find(p=>Number(p.amount)===selectedAmount)||{};
    const qr=qrFor(plan, selectedMethod);
    const mLabel=methodLabels[selectedMethod]||'微信';
    const msg=$('#claimMsg');
    if(msg){msg.textContent='正在生成付款备注…';msg.className='inline-msg';}
    confirmBtn.disabled=true;
    try{
      const prepared=await api('/api/recharge/prepare',{method:'POST',body:JSON.stringify({amount:selectedAmount,method:selectedMethod})});
      currentPayOrderId=prepared.orderId;
      currentPayNote=prepared.payNote||null;
      const noteBox=$('#payNoteBox');
      const noteCode=$('#payNoteCode');
      if(prepared.payMode==='gateway' && prepared.payUrl){
        if(noteBox) noteBox.hidden=true;
        $('#payHint').textContent=`已创建订单，正在跳转聚合支付（¥${selectedAmount} / ${mLabel}）。支付成功后卡密会自动发放，请稍后在「我的付款订单」查看。`;
        if(msg){msg.textContent='正在跳转支付…';msg.className='inline-msg ok';}
        panel.hidden=false;
        // hide personal QR panel image for gateway
        const img=$('#payQrImg'); const fb=$('#payQrFallback');
        if(img) img.hidden=true;
        if(fb){ fb.hidden=false; fb.textContent='请在打开的支付页完成付款'; }
        loadMyPayOrders();
        window.open(prepared.payUrl, '_blank');
        // also offer clickable link
        if(fb) fb.innerHTML=`若未自动跳转，请 <a href="${prepared.payUrl}" target="_blank" rel="noopener" style="color:var(--lime)">点击这里去支付</a>`;
        return;
      }
      const uname=(me&& (me.username||me.name||me.email)) || '';
      currentPayNote=uname;
      if(noteBox) noteBox.hidden=false;
      if(noteCode) noteCode.textContent=uname || '（请登录用户名）';
      $('#payHint').textContent=`请使用${mLabel}扫码支付 ¥${selectedAmount}。付款时请在备注填写你的用户名「${uname}」，方便核对。付完后点「我已付款，提交确认」。`;
      const img=$('#payQrImg');
      const fb=$('#payQrFallback');
      img.alt=`${mLabel}付款码`;
      const meta=window.appConfig?.paymentQrMeta||{};
      const st=(plan.status&&plan.status[selectedMethod])||meta[selectedMethod]||{};
      const tipEl=$('#payExpiryTip');
      const soft=$('#paySoftTip');
      const baseTip=plan.tip||meta.note||'若扫码提示二维码已过期或无法支付，请切换另一种付款方式，或联系客服更换收款码。';
      if(soft) soft.textContent=baseTip+' 付款备注请填写你的用户名，便于管理员核对。';
      if(tipEl){
        if(st.expired){ tipEl.hidden=false; tipEl.className='pay-expiry-tip is-expired'; tipEl.textContent=st.tip||'该付款码已到期失效，请勿付款，请联系客服更换。'; }
        else if(st.daysLeft!=null && st.daysLeft<=3){ tipEl.hidden=false; tipEl.className='pay-expiry-tip is-warn'; tipEl.textContent=st.tip||'付款码即将到期，若扫码失败请联系客服。'; }
        else if(st.tip && st.expiresAt){ tipEl.hidden=false; tipEl.className='pay-expiry-tip'; tipEl.textContent=st.tip; }
        else { tipEl.hidden=true; tipEl.textContent=''; }
      }
      if(qr){
        img.hidden=false;
        img.src=qr+(qr.includes('?')?'&':'?')+'t='+Date.now();
        img.onerror=()=>{img.hidden=true;fb.hidden=false;fb.textContent=`该金额的${mLabel}付款码图片尚未上传。`;};
        fb.hidden=true;
      }else{
        img.hidden=true;fb.hidden=false;fb.textContent=`该金额的${mLabel}付款码图片尚未上传。`;
      }
      panel.hidden=false;
      if(msg){msg.textContent=prepared.payMode==='gateway'?(prepared.message||'请完成支付'):`请支付并在备注填写用户名 ${uname||''}`;msg.className='inline-msg ok';}
      loadMyPayOrders();
    }catch(err){
      if(msg){msg.textContent=err.message||'生成备注失败';msg.className='inline-msg';}
    }finally{
      confirmBtn.disabled=false;
    }
  });
  $('#copyPayNote')?.addEventListener('click',async()=>{
    const note=$('#payNoteCode')?.textContent||currentPayNote||'';
    if(!note)return;
    try{await navigator.clipboard.writeText(note); const b=$('#copyPayNote'); if(b){b.textContent='已复制'; setTimeout(()=>b.textContent='复制备注',1000);} }catch(_e){}
  });
  $('#paidClaimBtn')?.addEventListener('click',async()=>{
    if(!selectedAmount)return;
    const msg=$('#claimMsg');
    if(!currentPayOrderId){
      msg.textContent='请先点「确认购买」生成付款备注，再支付并提交';msg.className='inline-msg';
      return;
    }
    msg.textContent='正在提交付款确认…';msg.className='inline-msg';
    try{
      const j=await api('/api/recharge/claim',{method:'POST',body:JSON.stringify({orderId:currentPayOrderId,amount:selectedAmount,method:selectedMethod})});
      msg.textContent=j.message||`已提交确认通知（备注 ${j.payNote||currentPayNote||''}）`;
      msg.className='inline-msg ok';
      if(modal) modal.hidden=true;
      loadMyPayOrders();
    }catch(err){msg.textContent=err.message;msg.className='inline-msg';}
  });
  $('#modalCopy')?.addEventListener('click',()=>{
    const code=$('#modalCode')?.textContent||'';
    navigator.clipboard.writeText(code);
    $('#modalCopy').textContent='已复制 ✓';
  });
  $('#modalFill')?.addEventListener('click',()=>{
    const code=$('#modalCode')?.textContent||'';
    const input=$('#redeemCode');
    if(input){input.value=code;input.focus();}
    modal.hidden=true;
  });
  $('#modalClose')?.addEventListener('click',()=>{modal.hidden=true;});
  $('#refreshPayOrders')?.addEventListener('click',()=>loadMyPayOrders());
  loadMyPayOrders();

  modal?.addEventListener('click',e=>{if(e.target===modal)modal.hidden=true;});
  $('#redeemForm')?.addEventListener('submit',async e=>{e.preventDefault();try{const j=await api('/api/recharge/redeem',{method:'POST',body:JSON.stringify({code:$('#redeemCode').value.trim()})});me=j.user;$('#redeemMsg').textContent=j.message;$('#redeemMsg').className='inline-msg ok'}catch(err){$('#redeemMsg').textContent=err.message;$('#redeemMsg').className='inline-msg'}});

}
  if(name==='referral'){shell('邀请返利','REFERRAL PROGRAM',`<section class="card referral-card"><div class="referral-hero"><div><p class="eyebrow">YOUR INVITE CODE</p><h2>邀请好友，一起获得奖励</h2><p class="sub">好友使用你的邀请码注册后，每当好友充值付费，你获得其充值金额的 5% 返利。</p></div><div class="reward">5%<span>/ 充值</span></div></div><div class="invite-box"><code>${data.inviteCode}</code><button id="copyInvite">复制邀请码</button></div><div class="ref-stats"><div><b>${data.inviteCount}</b><span>已邀请好友</span></div><div><b>¥${me.bonusBalance.toFixed(2)}</b><span>累计奖励</span></div></div></section>`);$('#copyInvite')?.addEventListener('click',()=>{navigator.clipboard.writeText(data.inviteCode);$('#copyInvite').textContent='已复制 ✓'});}
  if(name==='contact')shell('联系支持','SUPPORT CENTER',`<div class="contact-grid"><section class="card"><p class="eyebrow">WE ARE HERE TO HELP</p><h2>需要帮助？</h2><p class="sub">遇到接入、充值或账单问题，工作日我们会尽快回复。</p><div class="contact-item"><span>◎</span><div><small>客服 QQ</small><b>${esc(window.appConfig?.contactQq||'3845440106')}</b></div></div><div class="contact-item"><span>♧</span><div><small>QQ 群</small><b>${esc(window.appConfig?.contactQqGroup||'1061247399')}</b></div></div><div class="contact-item"><span>✉</span><div><small>支持邮箱</small><b>${esc(window.appConfig?.contactEmail||'3845440106@qq.com')}</b></div></div></section><section class="card"><p class="eyebrow">ACCOUNT</p><h2>账号信息</h2><div class="account-row"><span>用户名</span><b>@${esc(me.username||'-')}</b></div><div class="account-row"><span>显示名称</span><b>${esc(me.name)}</b></div><div class="account-row"><span>登录邮箱</span><b>${esc(me.email)}</b></div><div class="account-row"><span>注册时间</span><b>${new Date(me.createdAt).toLocaleDateString('zh-CN')}</b></div></section></div>`);
  page.querySelectorAll('[data-page]').forEach(a=>a.onclick=()=>render(a.dataset.page));
  document.querySelectorAll('[data-page]').forEach(a=>a.onclick=()=>render(a.dataset.page));
}

async function renderCheckIn(){
  shell('每日签到','DAILY CHECK-IN','<section class="card"><p class="sub">正在加载签到状态…</p></section>');
  try{
    checkin=await api('/api/checkin/status');
  }catch(err){
    shell('每日签到','DAILY CHECK-IN',`<section class="card"><h2>无法加载签到</h2><p class="sub">${esc(err.message||'请求失败')}</p></section>`);
    return;
  }
  const done=!!checkin.checkedInToday;
  const todayAmt=done?Number(checkin.todayAmount||0).toFixed(2):null;
  const streak=Number(checkin.streak||0);
  const bonus=Number(checkin.checkInBonus||me.checkInBonus||0).toFixed(2);
  const recent=checkin.recent||[];
  const rows=recent.map(r=>`<tr><td>${esc(r.date)}</td><td>¥${Number(r.amount||0).toFixed(2)}</td><td>${r.at?new Date(r.at).toLocaleString('zh-CN'):'-'}</td></tr>`).join('')||'<tr><td colspan="3" class="empty">暂无签到记录</td></tr>';
  shell('每日签到','DAILY CHECK-IN',`<section class="card checkin-card">
    <div class="checkin-hero">
      <div>
        <p class="eyebrow">${done?'CHECKED IN':'READY TO CLAIM'}</p>
        <h2>${done?'今日已签到':'领取今日奖励'}</h2>
        <p class="sub">每个北京时间自然日（Asia/Shanghai）可签到一次，随机获得 ¥0.05–¥0.50 余额。奖励计入账户余额，与邀请返利分开统计。</p>
      </div>
      <div class="reward">${done?('¥'+todayAmt):'¥0.00'}</div>
    </div>
    <button class="primary-btn checkin-btn" id="checkinBtn" ${done?'disabled':''} type="button">${done?'今日已领取':'立即签到 ↗'}</button>
    <div id="checkinMsg" class="inline-msg${done?' ok':''}">${done?`今日奖励 ¥${todayAmt} 已到账`:'签到后立即到账，可用于 API 调用'}</div>
    <div class="ref-stats">
      <div><b>${streak}</b><span>连续签到（天）</span></div>
      <div><b>¥${bonus}</b><span>累计签到奖励</span></div>
      <div><b>${esc(checkin.date||'')}</b><span>今日日期 · 北京时间</span></div>
    </div>
  </section>
  <section class="card" style="margin-top:16px">
    <div class="card-head"><div><p class="eyebrow">HISTORY</p><h2>最近签到</h2></div><span class="sub">最近 ${recent.length} 条</span></div>
    <table><thead><tr><th>日期</th><th>金额</th><th>时间</th></tr></thead><tbody>${rows}</tbody></table>
  </section>`);
  $('#checkinBtn')?.addEventListener('click',async()=>{
    const btn=$('#checkinBtn');
    const msg=$('#checkinMsg');
    if(!btn||btn.disabled)return;
    btn.disabled=true;
    if(msg){msg.textContent='正在签到…';msg.className='inline-msg';}
    try{
      const j=await api('/api/checkin',{method:'POST',body:'{}'});
      if(me){me.balance=j.balance;me.checkInBonus=Number((me.checkInBonus||0)+j.amount);}
      if(data?.user){data.user.balance=j.balance;}
      checkin={...checkin,checkedInToday:true,todayAmount:j.amount,streak:(checkin.streak||0)+((checkin.checkedInToday)?0:1),checkInBonus:Number(me?.checkInBonus||0),recent:[{date:j.date,amount:j.amount,at:new Date().toISOString()},...(checkin.recent||[])]};
      renderCheckIn();
    }catch(err){
      if(msg){msg.textContent=err.message||'签到失败';msg.className='inline-msg';}
      btn.disabled=false;
    }
  });
}

function keyLimitLabel(key){
  return key.spendLimit>0
    ? `额度 ¥${Number(key.spendUsed||0).toFixed(2)} / ${Number(key.spendLimit).toFixed(2)}`
    : '额度不限';
}

function keyFormFields(prefix, key, options){
  const k=key||{};
  const groups=options?.groups||[];
  const groupId=k.groupId||'';
  const spendVal=k.spendLimit?Number(k.spendLimit):'';
  return `
    <label class="span-2">名称<input data-kf="${prefix}-name" value="${esc(k.name||'')}" placeholder="例如：生产密钥" required></label>
    <div class="span-2">
      <p class="field-label">模型组</p>
      <select data-kf="${prefix}-group" required>
        <option value="" ${!groupId?'selected':''} disabled>请选择模型组</option>
        ${groups.map(g=>`<option value="${esc(g.id)}" ${groupId===g.id?'selected':''} ${g.maintenance?'disabled':''}>${esc(groupOptionLabel(g))}</option>`).join('')}
      </select>
    </div>
    <label class="span-2">额度限额（元）<input data-kf="${prefix}-spend" type="number" min="0" step="0.01" value="${esc(spendVal)}" placeholder="留空或 0 表示不限"><small class="hint">空白或 0 = 不限制，仍受账户余额约束</small></label>
    <label class="check-label"><input data-kf="${prefix}-enabled" type="checkbox" ${k.enabled!==false?'checked':''}> 启用该密钥</label>`;
}

function readKeyForm(prefix, options){
  const spendEl=$(`[data-kf="${prefix}-spend"]`);
  const spendLimit=(!spendEl||spendEl.value===''||spendEl.value==null)?0:Number(spendEl.value||0);
  const groupId=$(`[data-kf="${prefix}-group"]`)?.value||'';
  const groups=options?.groups||[];
  const g=groups.find(x=>x.id===groupId);
  const models=g?.models?[...g.models]:[];
  return {
    name: $(`[data-kf="${prefix}-name"]`)?.value.trim()||'未命名密钥',
    groupId: groupId||null,
    models,
    spendLimit: Number.isFinite(spendLimit)?Math.max(0,spendLimit):0,
    enabled: Boolean($(`[data-kf="${prefix}-enabled"]`)?.checked)
  };
}

function wireKeyForm(prefix, options){
  // 模型组选择即可，无需勾选模型
}

async function renderApiKeys(){
  shell('API 接入','DEVELOPER ACCESS','<section class="card"><p class="sub">正在加载密钥…</p></section>');
  try{
    const [{keys},options]=await Promise.all([api('/api/keys'),api('/api/key-options')]);
    const models=options.models||[];
    const first=keys[0];
    const sample=first?.key||'rk_your_key';
    const recommendedModel=(window.appConfig?.recommendedModel)||'gpt-5.6-terra';
    const modelSample=esc(recommendedModel);
    const configured=(window.appConfig?.publicBaseUrl||'').replace(/\/$/,'');
    const origin=(configured||location.origin).replace(/\/$/,'');
    const baseUrl=window.appConfig?.apiBaseUrl || `${origin}/v1`;
    const chatUrl=`${baseUrl.replace(/\/$/,'')}/chat/completions`;
    const groupName=id=>{
      const g=(options.groups||[]).find(x=>x.id===id);
      return g?`${g.name}${groupRateSuffix(g)}`:id;
    };
    const ccLink=(app)=>{
      const p=new URLSearchParams({
        resource:'provider',
        app,
        name:'Relay Station',
        endpoint:baseUrl,
        apiKey:sample,
        model:recommendedModel,
        homepage:origin,
        notes:'OpenAI 兼容接口 Base URL 填到 /v1，不要再拼 /chat/completions'
      });
      return `ccswitch://v1/import?${p.toString()}`;
    };
    shell('API 接入','DEVELOPER ACCESS',`<section class="card">
      <div class="card-head"><div><p class="eyebrow">API KEYS</p><h2>密钥管理</h2><p class="sub">创建密钥时可选模型组与额度。密钥仅对 /v1/chat/completions 等开放接口生效。</p></div></div>
      <div class="access-grid" style="margin-bottom:16px">
        <div class="code-box"><b>基础 URL（Base URL）</b><pre id="baseUrlText">${esc(baseUrl)}</pre><button type="button" class="link-btn" id="copyBaseUrl">复制</button></div>
        <div class="code-box"><b>完整对话地址</b><pre id="chatUrlText">${esc(chatUrl)}</pre><button type="button" class="link-btn" id="copyChatUrl">复制</button></div>
      </div>
      <p class="sub" style="margin-bottom:14px">客户端请填写<strong>本站</strong>地址（上线后为你的域名）和 <code>rk_</code> 开头的密钥。不要填上游网站，也不要把密钥填到 OpenAI / Claude 官方。</p>
      <div class="key-list">${keys.map(k=>`<article class="key-card" data-key-id="${esc(k.id)}">
        <div class="card-head">
          <div><h2>${esc(k.name)}</h2><p class="sub">${esc(keyLimitLabel(k))}${k.groupId?` · 组 ${esc(groupName(k.groupId))}`:''}</p></div>
          <span class="tag ${k.enabled?'success':'danger'}">${k.enabled?'已启用':'已停用'}</span>
        </div>
        <div class="key-box"><code>${esc(k.key)}</code><button type="button" data-copy-key="${esc(k.key)}">复制密钥</button></div>
        <details class="key-edit"><summary>编辑</summary>
          <form class="form-grid key-edit-form" data-edit-key="${esc(k.id)}">${keyFormFields('e-'+k.id,k,options)}<button class="primary-btn" type="submit">保存</button></form>
        </details>
        <div class="ops-cell">
          <button class="ghost-btn" data-rotate-key="${esc(k.id)}">轮换密钥</button>
          <button class="ghost-btn danger" data-delete-key="${esc(k.id)}">删除</button>
        </div>
      </article>`).join('')||'<p class="sub">还没有密钥。请在下方创建，创建后才会生成可用的 API Key。</p>'}</div>
    </section>
    <section class="card" style="margin-top:16px">
      <p class="eyebrow">CREATE KEY</p>
      <h2>创建新密钥</h2>
      <form id="createKeyForm" class="form-grid">${keyFormFields('new',{name:'新密钥',models:[],spendLimit:0,enabled:true},options)}<button class="primary-btn" type="submit">创建密钥</button></form>
      <div id="keyMsg" class="inline-msg"></div>
    </section>
    <section class="card" style="margin-top:16px">
      <p class="eyebrow">ACCESS GUIDE</p>
      <h2>接入帮助</h2>
      <p class="sub">本站提供 <b>OpenAI Chat Completions 兼容</b> 接口。多数客户端只需填 Base URL + API Key + 模型名。</p>
      <div class="access-grid">
        <div class="access-item"><small>API Base URL</small><div class="key-box"><code id="cfgBase">${esc(baseUrl)}</code><button type="button" data-copy-text="${esc(baseUrl)}">复制</button></div><p class="hint">填到 /v1 为止，不要带 /chat/completions，末尾不要多余 /</p></div>
        <div class="access-item"><small>完整对话地址</small><div class="key-box"><code>${esc(chatUrl)}</code><button type="button" data-copy-text="${esc(chatUrl)}">复制</button></div><p class="hint">仅 curl / 自写代码时用；Cursor / Cherry / CC Switch 一般只填 Base URL</p></div>
        <div class="access-item"><small>API Key</small><div class="key-box"><code>${esc(sample)}</code><button type="button" data-copy-text="${esc(sample)}">复制</button></div><p class="hint">${keys.length?'使用上方选中/最新密钥':'请先创建密钥后再导入客户端'}</p></div>
        <div class="access-item"><small>推荐模型</small><div class="key-box"><code>${modelSample}</code><button type="button" data-copy-text="${modelSample}">复制</button></div><p class="hint">以控制台可选模型为准，模型名必须完全一致</p></div>
      </div>
      <div class="cc-import">
        <h3>一键导入 CC Switch</h3>
        <p class="sub">需已安装 <a href="https://github.com/farion1231/cc-switch" target="_blank" rel="noopener">CC Switch</a>。点击后浏览器会唤起应用，确认导入即可。</p>
        <div class="ops-cell" style="margin-top:12px">
          <a class="primary-btn cc-btn" href="${esc(ccLink('codex'))}">导入到 CC Switch · Codex</a>
          <a class="ghost-btn cc-btn" href="${esc(ccLink('opencode'))}">导入 · OpenCode</a>
        </div>
        <p class="hint">Codex 场景：Base URL 用 <code>${esc(baseUrl)}</code>。若供应商只支持 Chat Completions，请在 CC Switch 中按需开启本地路由。</p>
        <p class="hint">没有密钥时链接里是占位 Key，导入后请改成你刚创建的真实密钥。</p>
      </div>
      <div class="docs-tabs" role="tablist">
        <button type="button" class="active" data-docs="curl">cURL</button>
        <button type="button" data-docs="openai">OpenAI SDK</button>
        <button type="button" data-docs="cursor">Cursor</button>
        <button type="button" data-docs="claudecode">Claude Code</button>
        <button type="button" data-docs="cherry">Cherry Studio</button>
        <button type="button" data-docs="ccswitch">CC Switch 手动</button>
      </div>
      <div class="docs-pane" data-pane="curl">
        <div class="code-box"><div><span class="method">POST</span> ${esc(chatUrl)}</div><pre>curl ${esc(chatUrl)} \
  -H "Authorization: Bearer ${esc(sample)}" \
  -H "Content-Type: application/json" \
  -d '{"model":"${modelSample}","messages":[{"role":"user","content":"你好"}],"stream":false}'</pre></div>
      </div>
      <div class="docs-pane" data-pane="openai" hidden>
        <div class="code-box"><pre># Python (openai>=1.0)
from openai import OpenAI
client = OpenAI(api_key="${esc(sample)}", base_url="${esc(baseUrl)}")
r = client.chat.completions.create(
  model="${modelSample}",
  messages=[{"role":"user","content":"你好"}]
)
print(r.choices[0].message.content)

# Node.js
import OpenAI from "openai";
const client = new OpenAI({ apiKey: "${esc(sample)}", baseURL: "${esc(baseUrl)}" });
const r = await client.chat.completions.create({
  model: "${modelSample}",
  messages: [{ role: "user", content: "你好" }]
});</pre></div>
      </div>
      <div class="docs-pane" data-pane="cursor" hidden>
        <ol class="guide-list">
          <li>打开 Cursor → Settings → Models</li>
          <li>开启 Override OpenAI Base URL，填入 <code>${esc(baseUrl)}</code></li>
          <li>OpenAI API Key 填入本站密钥（不是官方 OpenAI Key）</li>
          <li>添加自定义模型，Model ID 填 <code>${modelSample}</code>（与中转站完全一致）</li>
          <li>关掉不需要的官方模型勾选，保存后重启 Cursor 再试对话</li>
        </ol>
        <p class="warning">常见错误：Base URL 少了 /v1、多写了 /chat/completions、模型名写错、Key 前后有空格。</p>
      </div>
      <div class="docs-pane" data-pane="claudecode" hidden>
        <ol class="guide-list">
          <li>用本站 <b>CC-MAX / Claude-Kiro</b> 渠道创建密钥（不要用 GPT PRO 的 Codex 密钥）</li>
          <li>环境变量 <code>ANTHROPIC_API_KEY</code> 填该密钥</li>
          <li><code>ANTHROPIC_BASE_URL</code> 填站点根地址（到域名为止，<b>不要</b>加 /v1；客户端会请求 /v1/messages）</li>
          <li>模型名与控制台完全一致，例如 <code>claude-fable-5</code></li>
          <li>本站会原样转发 tools / tool_use，Claude Code 才能像官方一样读写本机文件</li>
        </ol>
        <div class="code-box"><pre>set ANTHROPIC_API_KEY=${esc(sample)}
set ANTHROPIC_BASE_URL=${esc(String(baseUrl||'').replace(/\/v1\/?$/,''))}
set ANTHROPIC_MODEL=claude-fable-5
claude</pre></div>
      </div>
      <div class="docs-pane" data-pane="cherry" hidden>
        <ol class="guide-list">
          <li>设置 → 模型服务 → 添加 → 类型选 OpenAI</li>
          <li>API 地址填 <code>${esc(baseUrl)}</code></li>
          <li>API 密钥填本站密钥</li>
          <li>模型管理中添加 <code>${modelSample}</code> 等你要用的模型 ID</li>
          <li>启用该服务商后，在对话页切换模型测试</li>
        </ol>
      </div>
      <div class="docs-pane" data-pane="ccswitch" hidden>
        <ol class="guide-list">
          <li>打开 CC Switch，顶部切换到 Codex（或 OpenCode）</li>
          <li>添加供应商 → 自定义 / OpenAI Compatible</li>
          <li>Name：Relay Station；Endpoint / Base URL：<code>${esc(baseUrl)}</code></li>
          <li>API Key：粘贴本站密钥；Model：<code>${modelSample}</code></li>
          <li>保存并启用。也可用上方「一键导入」按钮自动填好这些字段</li>
        </ol>
        <p class="sub">深度链接格式：<code>ccswitch://v1/import?resource=provider&amp;app=codex&amp;name=...&amp;endpoint=...&amp;apiKey=...</code></p>
      </div>
      <p class="warning" style="margin-top:14px">请妥善保管密钥。泄露后请立刻轮换或删除。调用计费按账户余额与密钥额度扣减。</p>
    </section>`);
    
    $('#copyBaseUrl')?.addEventListener('click',async()=>{ try{ await navigator.clipboard.writeText(baseUrl); }catch(_e){} });
    $('#copyChatUrl')?.addEventListener('click',async()=>{ try{ await navigator.clipboard.writeText(chatUrl); }catch(_e){} });

    wireKeyForm('new',options);
    keys.forEach(k=>wireKeyForm('e-'+k.id,options));
    const flash=(t,ok=false)=>{const e=$('#keyMsg');if(e){e.textContent=t;e.className=`inline-msg ${ok?'ok':''}`;}};
    $('#createKeyForm')?.addEventListener('submit',async e=>{
      e.preventDefault();
      try{await api('/api/keys',{method:'POST',body:JSON.stringify(readKeyForm('new',options))});flash('已创建密钥',true);renderApiKeys();}
      catch(err){flash(err.message);}
    });
    page.querySelectorAll('[data-edit-key]').forEach(form=>form.onsubmit=async e=>{
      e.preventDefault();
      try{await api(`/api/keys/${form.dataset.editKey}`,{method:'PUT',body:JSON.stringify(readKeyForm('e-'+form.dataset.editKey,options))});flash('已保存',true);renderApiKeys();}
      catch(err){flash(err.message);}
    });
    const copyText=(text,btn)=>{navigator.clipboard.writeText(text);if(btn){const old=btn.textContent;btn.textContent='已复制 ✓';setTimeout(()=>btn.textContent=old,1200);}};
    page.querySelectorAll('[data-copy-key]').forEach(btn=>btn.onclick=()=>copyText(btn.dataset.copyKey,btn));
    page.querySelectorAll('[data-copy-text]').forEach(btn=>btn.onclick=()=>copyText(btn.dataset.copyText,btn));
    page.querySelectorAll('[data-rotate-key]').forEach(btn=>btn.onclick=async()=>{
      try{await api(`/api/keys/${btn.dataset.rotateKey}/rotate`,{method:'POST'});flash('密钥已轮换。请用 rk_ 新密钥，并把客户端地址填成本站 /v1，不要填上游。',true);renderApiKeys();}
      catch(err){flash(err.message);}
    });
    page.querySelectorAll('[data-delete-key]').forEach(btn=>btn.onclick=async()=>{
      try{await api(`/api/keys/${btn.dataset.deleteKey}`,{method:'DELETE'});flash('已删除',true);renderApiKeys();}
      catch(err){flash(err.message);}
    });
    page.querySelectorAll('[data-docs]').forEach(btn=>btn.onclick=()=>{
      page.querySelectorAll('[data-docs]').forEach(x=>x.classList.toggle('active',x===btn));
      page.querySelectorAll('[data-pane]').forEach(p=>{p.hidden=p.dataset.pane!==btn.dataset.docs;});
    });
  }catch(err){
    shell('API 接入','DEVELOPER ACCESS',`<section class="card"><h2>无法加载密钥</h2><p class="sub">${esc(err.message)}</p></section>`);
  }
}

window.appConfigReady = fetch('/api/config').then(r=>r.json()).then(c=>{ window.appConfig=c; paintWelfareBanner(c.welfareBanner); return c; }).catch(err=>{ console.warn('config_load_failed', err); return window.appConfig || {}; });
function paintWelfareBanner(banner){
  const el=document.getElementById('welfareBanner');
  if(!el) return;
  if(!banner || !banner.text){
    el.hidden=true;
    el.innerHTML='';
    return;
  }
  const imgs=(banner.images||[]).map(u=>`<img src="${esc(u)}" alt="">`).join('');
  const item=`<span class="welfare-item">${imgs}<b>${esc(banner.text)}</b></span>`;
  el.innerHTML=`<div class="welfare-track">${item}${item}${item}${item}</div>`;
  el.hidden=false;
}
async function ensureAppConfig(){
  if (window.appConfig && Array.isArray(window.appConfig.paymentPlans) && window.appConfig.paymentPlans.length) {
    paintWelfareBanner(window.appConfig.welfareBanner);
    return window.appConfig;
  }
  if (window.appConfigReady) {
    try { return await window.appConfigReady; } catch { /* fall through */ }
  }
  try {
    const c = await fetch('/api/config').then(r=>r.json());
    window.appConfig = c;
    paintWelfareBanner(c.welfareBanner);
    return c;
  } catch (err) {
    console.warn('config_reload_failed', err);
    return window.appConfig || {};
  }
}

const baseRender = render;
render = function(name) {
  closeMobileNav();
  return name === 'operations' ? renderOperations() : baseRender(name);
};

let adminTab = 'rates';
let adminProvidersCache = [];
let adminDefaultProviderId = null;
let opsRenderSeq = 0;

function adminTabsHtml() {
  const tabs = [
    ['rates', '倍率'],
    ['channels', '渠道'],
    ['users', '用户'],
    ['codes', '卡密'],
    ['audit', '审计'],
    ['orders', '订单'],
    ['payments', '付款确认'],
    ['site', '站点网址'],
    ['gateway', '聚合支付'],
    ['upstream', 'vip1129同步'],
    ['beibeihai', 'Beibeihai同步'],
    ['errors', '网站错误'],
    ['diag', '诊断测试'],
    ['pool', '今日财务'],
    ['checkin', '签到'],
    ['welfare', '福利']
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
      <input data-mp-field="cache" type="number" step="0.0001" min="0" value="${esc(price.cacheReadPricePer1K ?? '')}" placeholder="缓存读/1K">
      <button type="button" class="ghost-btn" data-remove-mp="${idx}:${pi}">删除</button>
    </div>`).join('');
  return `<div class="model-prices" data-provider-mp="${idx}"><div class="model-price-head"><span>模型</span><span>输入价/1K</span><span>输出价/1K</span><span>缓存读/1K</span><span></span></div>${rows || '<p class="sub">暂无按模型价格，将使用渠道默认输入/输出/缓存价。</p>'}<button type="button" class="ghost-btn" data-add-mp="${idx}">+ 添加模型价格</button></div>`;
}

function providerHost(url) {
  try { return new URL(url).host + (new URL(url).pathname !== '/' ? new URL(url).pathname : ''); }
  catch { return url || '未填写上游地址'; }
}

function chargeRateHint(provider, settings) {
  const vip = provider?.upstreamSync === 'vip1129' || /vip1129/i.test(String(provider?.url || ''));
  const rate = vip ? (settings?.multiplierVip1129 ?? 1.5) : (settings?.multiplier ?? 2.5);
  return `真实花销倍率 ${fmtRate(rate)}x（${vip ? 'vip1129 / Codex' : 'beibeihai / 北海'} 全局）`;
}

function providerFormHtml(provider, idx, settings) {
  const health = provider.health || {};
  const healthLabel = health.ok === false ? '异常' : '正常';
  const healthClass = health.ok === false ? 'tag danger' : 'tag success';
  const models = provider.models || [];
  const perKey = Boolean(provider.usesPerKeyUpstream);
  const keyOn = Boolean(provider.apiKeyConfigured) || perKey;
  const synced = provider.modelsSyncedAt ? new Date(provider.modelsSyncedAt).toLocaleString('zh-CN') : '';
  return `<article class="card provider-form channel-card" data-provider-idx="${idx}">
    <div class="card-head">
      <div>
        <p class="eyebrow">渠道 #${idx + 1}</p>
        <h2>${esc(provider.name || '未命名渠道')}</h2>
        <p class="sub">${esc(providerHost(provider.url || ''))}</p>
      </div>
      <div class="provider-head-actions">
        <span class="tag ${provider.enabled !== false ? 'success' : 'danger'}">${provider.enabled !== false ? '启用' : '停用'}</span>
        <span class="tag ${keyOn ? 'success' : 'danger'}">${perKey ? `上游同步 ${esc(provider.upstreamSync || '')}`.trim() : (keyOn ? '密钥已配置' : '密钥未配置')}</span>
        <span class="${healthClass}">${healthLabel}</span>
        <button type="button" class="ghost-btn" data-sync-models="${esc(provider.id || '')}">同步上游模型</button>
        <button type="button" class="ghost-btn danger" data-remove-provider="${idx}">删除</button>
      </div>
    </div>
    <div class="model-chip-row static">${models.length ? models.map(m => `<span class="model-chip on">${esc(m)}</span>`).join('') : '<span class="sub">等待自动同步上游模型…</span>'}</div>
    <p class="sub" style="margin:8px 0 0">${synced ? `上次同步：${esc(synced)}` : '尚未从上游同步'}${provider.modelsSource ? ` · ${esc(provider.modelsSource)}` : ''}</p>
    <div class="form-grid">
      <label>内部名称<input data-f="name" value="${esc(provider.name || '')}" placeholder="仅管理员可见"></label>
      <label>渠道 ID<input data-f="id" value="${esc(provider.id || '')}" ${provider.id ? 'readonly' : ''}></label>
      <label class="span-2">上游地址<input data-f="url" value="${esc(provider.url || '')}" placeholder="https://api.example.com/v1/chat/completions"></label>
      <label class="span-2">API 密钥
        <input data-f="apiKey" type="password" placeholder="${keyOn ? '•••• 已配置，留空则保留原密钥' : '新渠道必填'}" autocomplete="new-password">
        <small class="hint">${perKey ? '该渠道走用户密钥同步，渠道级 Key 可留空；对话和健康检查会注入已同步的 sk-' : (keyOn ? '密钥已配置（不会回显明文）' : '填写后点击同步上游模型')}</small>
      </label>
      <label>默认模型<input data-f="defaultModel" value="${esc(provider.defaultModel || '')}" placeholder="同步后自动填第一个"></label>
      <label>优先级（越小越高）<input data-f="priority" type="number" value="${esc(provider.priority ?? 100)}"></label>
      <label>计费倍率<input data-f="billingMultiplier" type="number" step="0.01" min="0.01" max="10" value="${esc(fmtRate(provider.billingMultiplier ?? 2.5))}"><small class="hint">摆设，不参与扣费。${esc(chargeRateHint(provider, settings))}</small></label>
      <label>展示倍率<input data-f="displayMultiplier" type="number" step="0.01" min="0.01" max="10" value="${esc(fmtRate(provider.displayMultiplier ?? 0.2))}"><small class="hint">写在用户端模型组名称后面，仅展示，不参与扣费。</small></label>
      <label>输入价/1K<input data-f="inputPricePer1K" type="number" step="0.0001" min="0" value="${esc(provider.inputPricePer1K ?? 0)}"></label>
      <label>输出价/1K<input data-f="outputPricePer1K" type="number" step="0.0001" min="0" value="${esc(provider.outputPricePer1K ?? 0)}"></label>
      <label>缓存读价/1K<input data-f="cacheReadPricePer1K" type="number" step="0.0001" min="0" value="${esc(provider.cacheReadPricePer1K ?? '')}"><small class="hint">对齐上游 cache / cached_tokens，空则按输入价 10%。</small></label>
      <label>上游分组倍率<input data-f="upstreamRateMultiplier" type="number" step="0.01" min="0" value="${esc(provider.upstreamRateMultiplier ?? 1)}"><small class="hint">vip1129/北海 group rate_multiplier。估算上游成本 = 基价 × 此倍率；有实扣字段时以实扣为准。</small></label>
      <label>超时 ms<input data-f="timeoutMs" type="number" min="1000" value="${esc(provider.timeoutMs ?? 60000)}"></label>
      <label>重试次数<input data-f="maxRetries" type="number" min="0" max="5" value="${esc(provider.maxRetries ?? 0)}"></label>
      <label class="check-label"><input data-f="enabled" type="checkbox" ${provider.enabled !== false ? 'checked' : ''}> 启用</label>
      <label class="check-label"><input data-f="isDefault" type="checkbox" ${adminDefaultProviderId === provider.id ? 'checked' : ''}> 设为默认渠道</label>
    </div>
    <p class="eyebrow" style="margin-top:16px">按模型价格（可选）</p>
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
    const previous = adminProvidersCache.find(p => p.id === id);
    const models = previous?.models || [];
    const modelPrices = {};
    card.querySelectorAll('.model-price-row').forEach(row => {
      const model = row.querySelector('[data-mp-field="model"]')?.value.trim();
      if (!model) return;
      modelPrices[model] = {
        inputPricePer1K: Number(row.querySelector('[data-mp-field="input"]')?.value || 0),
        outputPricePer1K: Number(row.querySelector('[data-mp-field="output"]')?.value || 0),
        cacheReadPricePer1K: Number(row.querySelector('[data-mp-field="cache"]')?.value || 0)
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
      cacheReadPricePer1K: Number(get('cacheReadPricePer1K')?.value || previous?.cacheReadPricePer1K || 0),
      upstreamRateMultiplier: Number(get('upstreamRateMultiplier')?.value ?? previous?.upstreamRateMultiplier ?? 1),
      priority: Number(get('priority')?.value || 100),
      billingMultiplier: Number(get('billingMultiplier')?.value || 2.5),
      displayMultiplier: Number(get('displayMultiplier')?.value || 0.2),
      timeoutMs: Number(get('timeoutMs')?.value || 60000),
      maxRetries: Number(get('maxRetries')?.value || 0),
      enabled,
      apiKey,
      modelPrices,
      apiKeyConfigured: Boolean(apiKey) || Boolean(previous?.apiKeyConfigured),
      upstreamSync: previous?.upstreamSync || null,
      usesPerKeyUpstream: Boolean(previous?.usesPerKeyUpstream),
      maintenance: Boolean(previous?.maintenance),
      maintenanceMessage: previous?.maintenanceMessage || null,
      modelsSyncedAt: previous?.modelsSyncedAt || null,
      modelsSource: previous?.modelsSource || null,
      health: previous?.health || { ok: true, lastCheckedAt: null, lastError: null }
    });
  }
  return { providers, defaultProviderId };
}

async function renderOperations() {
  document.querySelectorAll('[data-page]').forEach(a => a.classList.toggle('active', a.dataset.page === 'operations'));
  if (!me?.isAdmin) {
    shell('运营配置', 'ADMIN CONSOLE', `<section class="card"><h2>无权访问</h2><p class="sub">仅管理员账户可查看运营数据。</p></section>`);
    return;
  }
  const renderId = ++opsRenderSeq;
  const stillCurrent = () => renderId === opsRenderSeq;
  try {
    if (adminTab === 'rates' || adminTab === 'channels') {
      const settings = await api('/api/admin/pricing');
      if (!stillCurrent()) return;
      adminProvidersCache = settings.providers || [];
      adminDefaultProviderId = settings.defaultProviderId;
      if (adminTab === 'rates') {
        shell('运营配置', 'ADMIN CONSOLE', `${adminTabsHtml()}<section class="card"><p class="eyebrow">REAL-TIME PRICING</p><h2>客户计费倍率</h2><p class="sub">真实扣费按<strong>上游全局倍率</strong>分两档：beibeihai / 北海 与 vip1129 / Codex 直连中转。默认只按上游账单 <code>actual_cost</code> 实时扣款：客户花销 = 上游实扣 × 对应上游全局倍率。估价结算默认关闭，避免估低亏本。</p>
<div class="rate-block" style="margin:1rem 0;padding:1rem;border:1px solid rgba(255,255,255,.08);border-radius:12px"><h3 style="margin:0 0 .5rem">扣费方式</h3><label style="display:flex;align-items:flex-start;gap:.6rem;margin:.5rem 0"><input id="allowEstimate" type="checkbox" ${settings.allowEstimatedBilling ? 'checked' : ''}><span>允许估价结算（仅当拿不到上游 <code>actual_cost</code> 时）。<br><small class="sub">关闭时：只认上游实时实扣；实扣未到会挂起继续对齐，不会用价表定稿。</small></span></label><button class="primary-btn" id="saveEstimateMode">保存扣费方式</button></div>
<div class="rate-block" style="margin:1rem 0;padding:1rem;border:1px solid rgba(255,255,255,.08);border-radius:12px"><h3 style="margin:0 0 .5rem">beibeihai / 北海 全局倍率</h3><p class="sub">绑定 <code>settings.billingMultiplier</code>，默认 <b>2.5x</b>。当前 <b>${esc(fmtRate(settings.multiplier))}x</b></p><div class="inline-form"><input id="customRate" type="number" min="0.01" max="10" step="0.01" value="${esc(fmtRate(settings.multiplier))}"><button class="primary-btn" id="saveCustomRate">保存北海倍率</button></div><p class="sub">快捷选择：</p><div class="rate-buttons" id="beibeiRates">${[1,1.5,2,2.5,3,4].map(rate=>`<button class="rate-btn ${rateEquals(settings.multiplier,rate)?'selected':''}" data-rate="${rate}" data-which="beibei">${fmtRate(rate)}x <small>北海</small></button>`).join('')}</div></div>
<div class="rate-block" style="margin:1rem 0;padding:1rem;border:1px solid rgba(255,255,255,.08);border-radius:12px"><h3 style="margin:0 0 .5rem">vip1129 / Codex 直连中转 全局倍率</h3><p class="sub">绑定 <code>settings.billingMultiplierVip1129</code> / <code>settings.multiplierVip1129</code>，默认 <b>1.5x</b>。当前 <b>${esc(fmtRate(settings.multiplierVip1129 ?? 1.5))}x</b></p><div class="inline-form"><input id="customRateVip" type="number" min="0.01" max="10" step="0.01" value="${esc(fmtRate(settings.multiplierVip1129 ?? 1.5))}"><button class="primary-btn" id="saveCustomRateVip">保存 vip1129 倍率</button></div><p class="sub">快捷选择：</p><div class="rate-buttons" id="vipRates">${[1,1.5,2,2.5,3,4].map(rate=>`<button class="rate-btn ${rateEquals(settings.multiplierVip1129 ?? 1.5,rate)?'selected':''}" data-rate="${rate}" data-which="vip">${fmtRate(rate)}x <small>vip1129</small></button>`).join('')}</div></div>
<p id="rateResult" class="inline-msg"></p><p class="sub">渠道列表（仅展示摆设倍率；真实扣费看上方对应上游全局倍率）：</p><div class="health-summary">${(settings.providers||[]).map(p=>`<div class="account-row"><span>${esc(p.name)}</span><b>展示倍率 ${esc(fmtRate(p.displayMultiplier))}x（摆设）· 真实扣费看上游全局倍率</b></div>`).join('')||'<p class="sub">暂无渠道。</p>'}</div>
<div class="rate-block" style="margin:1rem 0;padding:1rem;border:1px solid rgba(255,255,255,.08);border-radius:12px"><h3 style="margin:0 0 .5rem">对照账单校准估价</h3><p class="sub">用近期账单反推每个渠道组、每个模型的 Token 单价（元/1K），用于没拉到实扣时的 1.2 倍占位。不会改历史账单、也不会改全局扣费倍率。</p><button class="primary-btn" type="button" id="calibrateRates">立即校准</button><div id="calibrateRatesMsg" class="inline-msg"></div></div></section>`);
        page.querySelectorAll('[data-rate]').forEach(button => button.onclick = async () => {
          try {
            const which = button.dataset.which;
            const body = which === 'vip' ? { multiplierVip1129: Number(button.dataset.rate) } : { multiplier: Number(button.dataset.rate) };
            await api('/api/admin/pricing', { method: 'PUT', body: JSON.stringify(body) });
            renderOperations();
          } catch (error) { $('#rateResult').textContent = error.message; }
        });
        $('#saveCustomRate')?.addEventListener('click', async () => {
          try {
            await api('/api/admin/pricing', { method: 'PUT', body: JSON.stringify({ multiplier: Number($('#customRate').value) }) });
            $('#rateResult').textContent = '北海全局倍率已更新';
            $('#rateResult').className = 'inline-msg ok';
            renderOperations();
          } catch (error) { $('#rateResult').textContent = error.message; $('#rateResult').className = 'inline-msg'; }
        });
        $('#saveCustomRateVip')?.addEventListener('click', async () => {
          try {
            await api('/api/admin/pricing', { method: 'PUT', body: JSON.stringify({ multiplierVip1129: Number($('#customRateVip').value) }) });
            $('#rateResult').textContent = 'vip1129 全局倍率已更新';
            $('#rateResult').className = 'inline-msg ok';
            renderOperations();
          } catch (error) { $('#rateResult').textContent = error.message; $('#rateResult').className = 'inline-msg'; }
        });
        $('#saveEstimateMode')?.addEventListener('click', async () => {
          try {
            await api('/api/admin/pricing', { method: 'PUT', body: JSON.stringify({ allowEstimatedBilling: !!$('#allowEstimate')?.checked }) });
            $('#rateResult').textContent = $('#allowEstimate')?.checked ? '已开启估价结算（仅实扣缺失时）' : '已关闭估价结算，只按上游实扣扣费';
            $('#rateResult').className = 'inline-msg ok';
            renderOperations();
          } catch (error) { $('#rateResult').textContent = error.message; $('#rateResult').className = 'inline-msg'; }
        });
        $('#customRate')?.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); $('#saveCustomRate')?.click(); } });
        $('#customRateVip')?.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); $('#saveCustomRateVip')?.click(); } });
        $('#calibrateRates')?.addEventListener('click', async () => {
          const msg = $('#calibrateRatesMsg');
          if (msg) { msg.textContent = '正在对照账单校准…'; msg.className = 'inline-msg'; }
          try {
            const j = await api('/api/admin/providers/calibrate-prices', { method: 'POST', body: '{}' });
            if (msg) { msg.textContent = j.message || '已校准'; msg.className = 'inline-msg ok'; }
          } catch (err) {
            if (msg) { msg.textContent = err.message || '校准失败'; msg.className = 'inline-msg'; }
          }
        });
      } else {
        shell('运营配置', 'ADMIN CONSOLE', `${adminTabsHtml()}<div class="admin-actions-bar"><div><p class="eyebrow">CHANNEL POOL</p><h2 style="margin:0">渠道管理</h2><p class="sub">填写上游地址和 API Key 后会自动同步模型；后台每小时自动探测渠道是否可用。</p></div><button class="primary-btn" id="addProvider">+ 添加渠道</button><button class="ghost-btn" id="probeHealth">立即探测渠道</button><button class="ghost-btn" id="syncAllModels">同步全部上游模型</button><button class="ghost-btn" id="calibratePrices">对照账单校准估价</button><button class="primary-btn" id="saveProviders">保存全部渠道</button><span id="providerResult" class="inline-msg"></span></div><div id="providersList">${adminProvidersCache.map((p, i) => providerFormHtml(p, i, settings)).join('') || '<section class="card"><p class="sub">尚未配置渠道，请点击添加。</p></section>'}</div>`);
        wireProviderEditor();
        $('#calibratePrices')?.addEventListener('click', async () => {
          const msg = $('#providerResult');
          if (msg) { msg.textContent = '正在对照账单校准…'; msg.className = 'inline-msg'; }
          try {
            const j = await api('/api/admin/providers/calibrate-prices', { method: 'POST', body: '{}' });
            if (msg) { msg.textContent = j.message || '已校准'; msg.className = 'inline-msg ok'; }
            renderOperations();
          } catch (err) {
            if (msg) { msg.textContent = err.message || '校准失败'; msg.className = 'inline-msg'; }
          }
        });
      }
    } else if (adminTab === 'users') {
      const { users } = await api('/api/admin/users');
      if (!stillCurrent()) return;
      shell('运营配置', 'ADMIN CONSOLE', `${adminTabsHtml()}<section class="card"><div class="card-head"><div><p class="eyebrow">USERS</p><h2>用户管理</h2><p class="sub">用户名和显示名称全站唯一。可加余额、减余额、改余额、封号。</p></div><span class="sub">${users.length} 位用户</span></div><div id="usersMsg" class="inline-msg"></div><table class="admin-table"><thead><tr><th>邮箱</th><th>用户名</th><th>名称</th><th>余额</th><th>配额</th><th>已用</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>${users.map(u => `<tr data-user="${esc(u.id)}">
        <td>${esc(u.email)}</td>
        <td>@${esc(u.username||'-')}</td>
        <td>${esc(u.name)}</td>
        <td><input class="mini-input" data-edit="balance" type="number" step="0.01" min="0" value="${u.balance}"></td>
        <td><input class="mini-input" data-edit="quotaTokens" type="number" min="0" value="${u.quotaTokens}"></td>
        <td>${Number(u.usedTokens||0).toLocaleString()}</td>
        <td><select data-edit="role"><option value="user" ${u.role==='user'?'selected':''}>user</option><option value="admin" ${u.role==='admin'?'selected':''}>admin</option></select></td>
        <td><span class="tag ${u.banned?'danger':(u.accountActive?'success':'danger')}">${u.banned?'已封禁':(u.accountActive?'启用':'未激活')}</span></td>
        <td class="ops-cell">
          <button class="ghost-btn" data-delta="${esc(u.id)}" data-sign="1">加余额</button>
          <button class="ghost-btn" data-delta="${esc(u.id)}" data-sign="-1">减余额</button>
          <button class="ghost-btn" data-toggle-ban="${esc(u.id)}" data-banned="${u.banned? 'true':'false'}">${u.banned?'解封':'封号'}</button>
          <button class="ghost-btn" data-save-user="${esc(u.id)}">保存余额</button>
        </td>
      </tr>`).join('')}</tbody></table></section>`);
      const showUsersErr = (err) => { const el = $('#usersMsg'); if (el) { el.textContent = err.message || String(err); el.className = 'inline-msg'; } };
      page.querySelectorAll('[data-toggle-ban]').forEach(btn => btn.onclick = async () => {
        try {
          const banned = btn.dataset.banned === 'true';
          await api(`/api/admin/users/${btn.dataset.toggleBan}`, { method: 'PUT', body: JSON.stringify({ banned: !banned }) });
          renderOperations();
        } catch (err) { showUsersErr(err); }
      });
      page.querySelectorAll('[data-delta]').forEach(btn => btn.onclick = async () => {
        const sign = Number(btn.dataset.sign);
        const raw = prompt(sign > 0 ? '增加多少余额（元）' : '减少多少余额（元）', '10');
        if (raw == null) return;
        const amount = Number(raw);
        if (!Number.isFinite(amount) || amount <= 0) { showUsersErr(Error('请输入大于 0 的金额')); return; }
        try {
          await api(`/api/admin/users/${btn.dataset.delta}`, { method: 'PUT', body: JSON.stringify({ balanceDelta: sign * amount }) });
          renderOperations();
        } catch (err) { showUsersErr(err); }
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
        } catch (err) { showUsersErr(err); }
      });
    } else if (adminTab === 'codes') {
      const { codes } = await api('/api/admin/codes?limit=200');
      if (!stillCurrent()) return;
      shell('运营配置', 'ADMIN CONSOLE', `${adminTabsHtml()}<div class="content-grid"><section class="card"><p class="eyebrow">GENERATE</p><h2>生成卡密</h2><form id="genCodesForm" class="stack-form"><label>数量<input name="count" type="number" min="1" max="200" value="5" required></label><label>金额 ¥<input name="amount" type="number" min="0" step="0.01" value="10" required></label><label>Token 配额<input name="quotaTokens" type="number" min="0" value="100000" required></label><label>前缀<input name="prefix" value="RELAY"></label><button class="primary-btn" type="submit">生成</button></form><div id="codesMsg" class="inline-msg"></div></section><section class="card"><p class="eyebrow">CODES</p><h2>卡密列表</h2><table class="admin-table"><thead><tr><th>卡密</th><th>金额</th><th>配额</th><th>状态</th><th>用户</th></tr></thead><tbody>${codes.slice().reverse().slice(0,100).map(c=>`<tr><td><code>${esc(c.code)}</code></td><td>¥${Number(c.amount).toFixed(2)}${c.creditAmount && Number(c.creditAmount)!==Number(c.amount) ? ` → ¥${Number(c.creditAmount).toFixed(2)}` : ''}</td><td>${Number(c.quotaTokens).toLocaleString()}</td><td><span class="tag ${c.usedAt?'danger':'success'}">${c.usedAt?'已用':'未用'}</span></td><td>${esc(c.userId||'-')}</td></tr>`).join('')||'<tr><td colspan="5" class="empty">暂无卡密</td></tr>'}</tbody></table></section></div>`);
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
      if (!stillCurrent()) return;
      shell('运营配置', 'ADMIN CONSOLE', `${adminTabsHtml()}<section class="card"><div class="card-head"><div><p class="eyebrow">AUDIT LOG</p><h2>最近审计</h2></div><span class="sub">最多 200 条</span></div><table class="admin-table"><thead><tr><th>时间</th><th>操作</th><th>目标</th><th>操作者</th><th>详情</th></tr></thead><tbody>${entries.map(e=>`<tr><td>${new Date(e.createdAt).toLocaleString('zh-CN')}</td><td>${esc(e.action)}</td><td>${esc(e.target||'-')}</td><td>${esc(e.actorId||'-')}</td><td><code class="detail-code">${esc(JSON.stringify(e.detail||{}))}</code></td></tr>`).join('')||'<tr><td colspan="5" class="empty">暂无审计记录</td></tr>'}</tbody></table></section>`);
    } else if (adminTab === 'errors') {
      const data = await api('/api/admin/site-errors');
      if (!stillCurrent()) return;
      const errors = data.errors || [];
      const rows = errors.length ? errors.map(e => `
        <tr>
          <td>${esc((e.at||'').replace('T',' ').slice(0,19))}</td>
          <td><code>${esc(e.source||'')}</code> / <code>${esc(e.code||'')}</code></td>
          <td>
            <div><strong>${esc(e.message||'')}</strong></div>
            ${e.detail?`<div class="sub" style="margin-top:4px">${esc(e.detail)}</div>`:''}
            ${(e.fix&&e.fix.length)?`<ol class="fix-list">${e.fix.map(f=>`<li>${esc(f)}</li>`).join('')}</ol>`:'<p class="sub">暂无解决建议</p>'}
          </td>
        </tr>`).join('') : `<tr><td colspan="3" class="sub">暂无错误记录。可先到「诊断测试」跑一遍。</td></tr>`;
      shell('运营配置', 'ADMIN CONSOLE', `${adminTabsHtml()}
      <section class="card"><div class="card-head"><div><p class="eyebrow">SITE ERRORS</p><h2>网站错误</h2>
        <p class="sub">系统自动记录同步失败、上游对话失败、诊断失败等。每条都尽量带「怎么解决」。</p></div>
        <div style="display:flex;gap:8px"><button class="ghost-btn" type="button" id="refreshErrorsBtn">刷新</button>
        <button class="ghost-btn" type="button" id="clearErrorsBtn">清空</button></div></div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>时间</th><th>来源/错误码</th><th>问题与解决</th></tr></thead><tbody>${rows}</tbody></table></div>
        <p class="sub" style="margin-top:8px">共 ${data.total||0} 条（最多保留 ${data.cap||200}）</p>
      </section>`);
      $('#refreshErrorsBtn')?.addEventListener('click', () => renderOperations());
      $('#clearErrorsBtn')?.addEventListener('click', async () => {
        if (!confirm('确定清空全部网站错误记录？')) return;
        await api('/api/admin/site-errors', { method: 'DELETE' });
        toast('已清空');
        renderOperations();
      });
    } else if (adminTab === 'diag') {
      const last = (await api('/api/admin/diagnostics/last').catch(()=>({}))).last;
      if (!stillCurrent()) return;
      shell('运营配置', 'ADMIN CONSOLE', `${adminTabsHtml()}
      <section class="card"><div class="card-head"><div><p class="eyebrow">DIAGNOSTICS</p><h2>诊断测试</h2>
        <p class="sub">一键测数据库、上游登录、分组映射、每个渠道能否对话（延迟 / 报错）、扣费与展示倍率、卡密库存与兑换拦截、收款码与支付。不会真的兑换卡密，也不会改用户余额。手机值班请打开 <a href="/admin-app/" target="_blank">/admin-app/</a> 或安装 APK。</p></div>
        <button class="primary-btn" type="button" id="runDiagBtn">运行全部测试</button></div>
        <div id="diagOut">${diagReportHtml(last)}</div>
      </section>`);
      $('#runDiagBtn')?.addEventListener('click', async () => {
        const btn = $('#runDiagBtn');
        btn.disabled = true;
        const prev = btn.textContent;
        btn.textContent = '测试进行中…';
        $('#diagOut').innerHTML = '<p class="sub">正在探测各渠道对话、延迟、倍率与充值逻辑，大约需要几分钟，请勿关闭页面…</p>';
        try {
          const report = await api('/api/admin/diagnostics/run', { method: 'POST', body: '{}' });
          const s = report.summary || {};
          $('#diagOut').innerHTML = diagReportHtml(report);
          toast(s.failed ? `诊断完成：${s.failed} 项失败` : (s.warned ? `诊断完成：${s.warned} 项警告` : '诊断全部通过'));
        } catch (err) {
          $('#diagOut').innerHTML = `<p class="sub">诊断请求失败：${esc(err.message||String(err))}</p>`;
          toast('诊断失败');
        } finally {
          btn.disabled = false;
          btn.textContent = prev || '运行全部测试';
        }
      });
    
    } else if (adminTab === 'beibeihai') {
      const data = await api('/api/admin/upstream-beibeihai');
      if (!stillCurrent()) return;
      const u = data.upstream || {};
      const groups = data.groups || [];
      const localGroups = data.localGroups || [];
      const mapRows = localGroups.map(lg => {
        const cur = (u.groupMap && u.groupMap[lg.id] != null) ? u.groupMap[lg.id] : '';
        return `<label>${esc(lg.name)} <code>${esc(lg.id)}</code>
          <select data-bb-map="${esc(lg.id)}">
            <option value="">不同步</option>
            ${groups.map(g => `<option value="${g.id}" ${String(cur)===String(g.id)?'selected':''}>${esc(g.name)} (#${g.id})</option>`).join('')}
          </select>
        </label>`;
      }).join('') || '<p class="sub">暂无指向 Beibeihai 的本地渠道</p>';
      shell('运营配置', 'ADMIN CONSOLE', `${adminTabsHtml()}
      <section class="card"><div class="card-head"><div><p class="eyebrow">BEIBEIHAI SYNC</p><h2>Beibeihai 上游密钥同步</h2>
        <p class="sub">Grok / DeepSeek / CC-MAX 等渠道：用户建钥时同步到 Beibeihai，并把 sk- 发给用户。Cursor 账号池为维护中，不参与同步。</p></div>
        <span class="tag ${u.ready?'success':''}">${u.ready?'已就绪':'未就绪'}</span></div>
        <div class="pay-meta-grid">
          <label>启用同步
            <select id="bbEnabled"><option value="true" ${u.enabled!==false?'selected':''}>启用</option><option value="false" ${u.enabled===false?'selected':''}>关闭</option></select>
          </label>
          <label>上游地址<input id="bbBaseUrl" value="${esc(u.baseUrl||'https://sub.beibeihai.xyz')}"></label>
          <label>登录邮箱<input id="bbEmail" value="${esc(u.email||'')}"></label>
          <label>登录密码<input id="bbPassword" type="password" placeholder="${u.hasPassword?'已保存，留空不修改':'输入密码'}" value=""></label>
        </div>
        <div class="pay-meta-grid" style="margin-top:12px">${mapRows}</div>
        <p class="sub" style="margin-top:12px">${u.lastError?('上次错误：'+esc(u.lastError)):('Token：'+(u.hasToken?'已缓存':'未登录'))}</p>
        <button class="primary-btn" type="button" id="saveBeibeihaiBtn" style="margin-top:12px">保存并探测登录</button>
      </section>`);
      $('#saveBeibeihaiBtn')?.addEventListener('click', async () => {
        const groupMap = {};
        document.querySelectorAll('[data-bb-map]').forEach(el => {
          const id = el.getAttribute('data-bb-map');
          groupMap[id] = el.value ? Number(el.value) : '';
        });
        const body = {
          enabled: $('#bbEnabled').value === 'true',
          baseUrl: $('#bbBaseUrl').value.trim(),
          email: $('#bbEmail').value.trim(),
          groupMap
        };
        const pw = $('#bbPassword').value;
        if (pw) body.password = pw;
        const j = await api('/api/admin/upstream-beibeihai', { method: 'PUT', body: JSON.stringify(body) });
        toast(j.probe && j.probe.ok ? 'Beibeihai 登录成功，已保存' : (j.probe && j.probe.error ? ('已保存，登录探测失败：'+j.probe.error) : '已保存'));
        renderOperations();
      });
    
    } else if (adminTab === 'upstream') {
      const data = await api('/api/admin/upstream-vip1129');
      if (!stillCurrent()) return;
      const u = data.upstream || {};
      const groups = data.groups || [];
      const localGroups = data.localGroups || [];
      const mapRows = localGroups.map(lg => {
        const cur = (u.groupMap && u.groupMap[lg.id] != null) ? u.groupMap[lg.id] : '';
        return `<label>${esc(lg.name)} <code>${esc(lg.id)}</code>
          <select data-up-map="${esc(lg.id)}">
            <option value="">不同步</option>
            ${groups.map(g => `<option value="${g.id}" ${String(cur)===String(g.id)?'selected':''}>${esc(g.name)} (#${g.id})</option>`).join('')}
          </select>
        </label>`;
      }).join('') || '<p class="sub">暂无指向 vip1129 的本地渠道。请在「渠道」里把 GPT 组 URL 设为 https://api.vip1129.cc/v1/chat/completions</p>';
      shell('运营配置', 'ADMIN CONSOLE', `${adminTabsHtml()}
      <section class="card"><div class="card-head"><div><p class="eyebrow">UPSTREAM SYNC</p><h2>vip1129 上游密钥同步</h2>
        <p class="sub">用户新建 API 密钥时，若所选模型组已映射，会在 vip1129 同步建钥，并把上游 sk- 密钥发给用户；对话请求用该密钥转发，便于实时看用量。</p></div>
        <span class="tag ${u.ready?'success':''}">${u.ready?'已就绪':'未就绪'}</span></div>
        <div class="pay-meta-grid">
          <label>启用同步
            <select id="upEnabled"><option value="true" ${u.enabled!==false?'selected':''}>启用</option><option value="false" ${u.enabled===false?'selected':''}>关闭</option></select>
          </label>
          <label>上游地址<input id="upBaseUrl" value="${esc(u.baseUrl||'https://api.vip1129.cc')}"></label>
          <label>登录邮箱<input id="upEmail" value="${esc(u.email||'')}"></label>
          <label>登录密码<input id="upPassword" type="password" placeholder="${u.hasPassword?'已保存，留空不修改':'输入密码'}" value=""></label>
        </div>
        <div class="pay-meta-grid" style="margin-top:12px">${mapRows}</div>
        <p class="sub" style="margin-top:12px">${u.lastError?('上次错误：'+esc(u.lastError)):('Token：'+(u.hasToken?'已缓存':'未登录'))}</p>
        <button class="primary-btn" type="button" id="saveUpstreamBtn" style="margin-top:12px">保存并探测登录</button>
      </section>`);
      $('#saveUpstreamBtn')?.addEventListener('click', async () => {
        const groupMap = {};
        document.querySelectorAll('[data-up-map]').forEach(el => {
          const id = el.getAttribute('data-up-map');
          groupMap[id] = el.value ? Number(el.value) : '';
        });
        const body = {
          enabled: $('#upEnabled').value === 'true',
          baseUrl: $('#upBaseUrl').value.trim(),
          email: $('#upEmail').value.trim(),
          groupMap
        };
        const pw = $('#upPassword').value;
        if (pw) body.password = pw;
        const j = await api('/api/admin/upstream-vip1129', { method: 'PUT', body: JSON.stringify(body) });
        toast(j.probe && j.probe.ok ? '上游登录成功，已保存' : (j.probe && j.probe.error ? ('已保存，登录探测失败：'+j.probe.error) : '已保存'));
        renderOperations();
      });
    
    } else if (adminTab === 'pool') {
      const stats = await api('/api/admin/code-pool');
      if (!stillCurrent()) return;
      shell('运营配置', 'ADMIN CONSOLE', `${adminTabsHtml()}
      <div class="metric-grid admin-finance">
        <article><small>今日收入</small><strong>¥${Number(stats.incomeToday||0).toFixed(2)}</strong><span class="green">付款领取卡密面额</span></article>
        <article><small>卡密支出</small><strong>¥${Number(stats.cardSpendToday||0).toFixed(2)}</strong><span>今日兑换成余额</span></article>
        <article><small>上游 API 开销${stats.upstreamCostIsEstimate===false?"（实扣）":"（估算）"}</small><strong>¥${Number(stats.upstreamCostToday||0).toFixed(4)}</strong><span>今日上游成本 · ${Number(stats.requestCountToday||0)} 次请求${stats.upstreamCostReportedCount?` · 实扣${stats.upstreamCostReportedCount}`:""}</span></article>
        <article><small>客户实扣</small><strong>¥${Number(stats.chargedToday||0).toFixed(4)}</strong><span>今日向用户扣费</span></article>
      </div>
      <section class="card" style="margin-top:16px"><div class="card-head"><div><p class="eyebrow">UPSTREAM LEDGER</p><h2>上游账单同步</h2><p class="sub">以每把上游 Key 的 <code>actual_cost</code> 为准。活跃 Key 每 2 秒结算，空闲 Key 每分钟核对；首次同步会补齐历史漏账。</p></div><button class="primary-btn" id="syncUpstreamBilling">立即同步</button></div><p id="upstreamBillingMsg" class="inline-msg">${stats.upstreamUsageSync?.lastRunAt ? `上次同步：${new Date(stats.upstreamUsageSync.lastRunAt).toLocaleString('zh-CN')} · 本次账本 ${Number(stats.upstreamLedgerRows||0)} 条` : '等待首次账单同步'}</p></section>
      <section class="card" id="payMetaCard"><div class="card-head"><div><p class="eyebrow">PAYMENT QR</p><h2>付款码有效期</h2><p class="sub">微信/支付宝不会回调本站。可在此登记预计到期日；到期或临近时，用户付款页与此处都会提示。</p></div></div>
        <div id="payMetaBanner" class="pay-expiry-tip" hidden></div>
        <div class="pay-meta-grid">
          <label>微信收款码到期日<input id="wechatExpiresAt" type="date"></label>
          <label>支付宝收款码到期日<input id="alipayExpiresAt" type="date"></label>
        </div>
        <label style="display:block;margin-top:12px;font-size:11px;color:var(--muted)">用户提示文案<textarea id="payMetaNote" rows="3" style="width:100%;margin-top:6px;background:#161a23;border:1px solid #303646;border-radius:7px;color:var(--text);padding:10px;font:12px Space Grotesk, Arial, sans-serif"></textarea></label>
        <button class="primary-btn" type="button" id="savePayMetaBtn" style="margin-top:12px">保存有效期设置</button>
        <div id="payMetaMsg" class="inline-msg"></div>
      </section>
      <section class="card"><div class="card-head"><div><p class="eyebrow">TODAY ISSUE</p><h2>今日发卡统计</h2><p class="sub">仅管理员可见。日期：${esc(stats.day)} · 库存目标每档 ${stats.target} 张</p></div><div><b>今日发放 ${stats.issuedTodayCount} 张 / ¥${Number(stats.issuedTodaySum).toFixed(0)}</b><br><span class="sub">今日兑换 ${stats.redeemedTodayCount} 张 / ¥${Number(stats.redeemedTodaySum).toFixed(0)}</span></div></div><table class="admin-table"><thead><tr><th>金额</th><th>可用库存</th><th>今日发放</th><th>今日发放金额</th><th>今日兑换</th><th>今日兑换金额</th></tr></thead><tbody>${(stats.byAmount||[]).map(r=>`<tr><td>¥${r.amount}</td><td>${r.available}</td><td>${r.issuedToday}</td><td>¥${r.issuedTodaySum}</td><td>${r.redeemedToday}</td><td>¥${r.redeemedTodaySum}</td></tr>`).join('')}</tbody></table></section>
      <section class="card" style="margin-top:16px"><div class="card-head"><div><p class="eyebrow">UPSTREAM COST</p><h2>今日上游开销明细</h2><p class="sub">按渠道汇总当日 upstreamCost（优先上游返回实扣；否则为单价×token×渠道上游倍率，非 displayMultiplier）</p></div></div><table class="admin-table"><thead><tr><th>渠道</th><th>请求数</th><th>上游开销</th><th>客户实扣</th></tr></thead><tbody>${(stats.upstreamByProvider||[]).map(r=>`<tr><td>${esc(r.providerName||r.providerId)}</td><td>${r.requests}</td><td>¥${Number(r.upstreamCost).toFixed(4)}</td><td>¥${Number(r.chargedAmount).toFixed(4)}</td></tr>`).join('')||'<tr><td colspan="4" class="empty">今日暂无上游调用</td></tr>'}</tbody></table></section>`);

      document.getElementById('syncUpstreamBilling')?.addEventListener('click', async () => {
        const button = document.getElementById('syncUpstreamBilling');
        const msg = document.getElementById('upstreamBillingMsg');
        if (button) button.disabled = true;
        if (msg) { msg.textContent = '正在读取上游实际账单…'; msg.className = 'inline-msg'; }
        try {
          const j = await api('/api/admin/upstream-billing/sync', { method:'POST', body: JSON.stringify({ fullBackfill:true }) });
          if (msg) { msg.textContent = `同步完成：${Number(j.synced?.rows||0)} 条上游账单，补入 ${Number(j.synced?.imported||0)} 条本地消费记录`; msg.className = 'inline-msg ok'; }
          setTimeout(() => renderOperations(), 500);
        } catch (err) {
          if (msg) { msg.textContent = err.message || '同步失败'; msg.className = 'inline-msg'; }
        } finally { if (button) button.disabled = false; }
      });

      // payment QR expiry settings
      (async () => {
        const toDateInput = (iso) => {
          if (!iso) return '';
          const d = new Date(iso);
          if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
          const local = new Date(d.getTime() - d.getTimezoneOffset()*60000);
          return local.toISOString().slice(0, 10);
        };
        const paintMeta = (meta) => {
          if (!meta) return;
          const wx = meta.wechat || {};
          const ali = meta.alipay || {};
          const banner = document.getElementById('payMetaBanner');
          const msgs = [];
          if (wx.expired) msgs.push('微信：' + (wx.tip || '已到期'));
          else if (wx.daysLeft != null && wx.daysLeft <= 3) msgs.push('微信：' + (wx.tip || '即将到期'));
          if (ali.expired) msgs.push('支付宝：' + (ali.tip || '已到期'));
          else if (ali.daysLeft != null && ali.daysLeft <= 3) msgs.push('支付宝：' + (ali.tip || '即将到期'));
          if (banner) {
            if (msgs.length) {
              banner.hidden = false;
              banner.className = 'pay-expiry-tip' + ((wx.expired || ali.expired) ? ' is-expired' : ' is-warn');
              banner.textContent = msgs.join('；');
            } else {
              banner.hidden = true;
              banner.textContent = '';
            }
          }
          const wIn = document.getElementById('wechatExpiresAt');
          const aIn = document.getElementById('alipayExpiresAt');
          const note = document.getElementById('payMetaNote');
          if (wIn) wIn.value = toDateInput(meta.wechatExpiresAt);
          if (aIn) aIn.value = toDateInput(meta.alipayExpiresAt);
          if (note) note.value = meta.note || '';
        };
        try {
          const j = await api('/api/admin/payment-qrs');
          paintMeta(j.paymentQrMeta);
        } catch (err) {
          const msg = document.getElementById('payMetaMsg');
          if (msg) msg.textContent = err.message || '加载付款码设置失败';
        }
        document.getElementById('savePayMetaBtn')?.addEventListener('click', async () => {
          const msg = document.getElementById('payMetaMsg');
          if (msg) { msg.textContent = '保存中…'; msg.className = 'inline-msg'; }
          try {
            const body = {
              paymentQrMeta: {
                wechatExpiresAt: document.getElementById('wechatExpiresAt')?.value || null,
                alipayExpiresAt: document.getElementById('alipayExpiresAt')?.value || null,
                note: document.getElementById('payMetaNote')?.value || ''
              }
            };
            const j = await api('/api/admin/payment-qrs', { method: 'PUT', body: JSON.stringify(body) });
            paintMeta(j.paymentQrMeta);
            if (window.appConfig) window.appConfig.paymentQrMeta = j.paymentQrMeta;
            if (msg) { msg.textContent = '已保存'; msg.className = 'inline-msg ok'; }
          } catch (err) {
            if (msg) { msg.textContent = err.message || '保存失败'; msg.className = 'inline-msg'; }
          }
        });
      })();



    } else if (adminTab === 'site') {
      const data = await api('/api/admin/site-settings');
      if (!stillCurrent()) return;
      shell('运营配置', 'ADMIN CONSOLE', `${adminTabsHtml()}
      <section class="card"><div class="card-head"><div><p class="eyebrow">SITE URL</p><h2>站点网址 / API 基础地址</h2>
        <p class="sub">给用户和客户端看的 Base URL。你上线域名后填这里；留空则自动用当前访问域名。上游中转地址（如 vip1129）在「渠道」里单独配置，不会展示给普通用户。</p></div></div>
        <label>公网站点网址<input id="publicBaseUrlInput" placeholder="https://api.your-domain.com" value="${esc(data.publicBaseUrl||'')}"></label>
        <label style="margin-top:12px">推荐模型<input id="recommendedModelInput" placeholder="gpt-5.6-terra" value="${esc(data.recommendedModel||'gpt-5.6-terra')}"></label>
        <p class="sub" style="margin-top:10px">当前解析：<code>${esc(data.resolvedBaseUrl||'(未设置)')}</code></p>
        <p class="sub">用户 API Base URL：<code>${esc(data.apiBaseUrl||'')}</code></p>
        <p class="sub">推荐模型会写入 API 接入示例和 CC Switch 导入链接。默认用 gpt-5.6-terra，不要填 gpt-5.6 或 gpt-5.6-sol。</p>
        <button class="primary-btn" type="button" id="saveSiteUrlBtn" style="margin-top:12px">保存站点设置</button>
        <div id="siteUrlMsg" class="inline-msg"></div>
      </section>`);
      $('#saveSiteUrlBtn')?.addEventListener('click', async () => {
        const msg = $('#siteUrlMsg');
        msg.textContent = '保存中…'; msg.className = 'inline-msg';
        try {
          const j = await api('/api/admin/site-settings', { method: 'PUT', body: JSON.stringify({ publicBaseUrl: $('#publicBaseUrlInput').value.trim(), recommendedModel: $('#recommendedModelInput').value.trim() }) });
          if (window.appConfig) {
            window.appConfig.publicBaseUrl = j.resolvedBaseUrl || j.publicBaseUrl || '';
            window.appConfig.apiBaseUrl = j.apiBaseUrl || '';
            window.appConfig.recommendedModel = j.recommendedModel || 'gpt-5.6-terra';
          }
          msg.textContent = j.message || '已保存'; msg.className = 'inline-msg ok';
        } catch (err) {
          msg.textContent = err.message || '保存失败'; msg.className = 'inline-msg';
        }
      });
    } else if (adminTab === 'gateway') {
      const data = await api('/api/admin/payment-gateway');
      if (!stillCurrent()) return;
      const g = data.gateway || {};
      shell('运营配置', 'ADMIN CONSOLE', `${adminTabsHtml()}
      <section class="card"><div class="card-head"><div><p class="eyebrow">AGGREGATOR</p><h2>聚合支付（易支付兼容）</h2>
        <p class="sub">配置后，用户确认购买会跳转网关支付；支付成功回调自动发卡，无需手填备注。个人收款码仅在未启用或配置不完整时使用。</p></div>
        <span class="tag ${g.ready?'success':''}">${g.ready?'已就绪':'未就绪'}</span></div>
        <div class="pay-meta-grid">
          <label>启用聚合支付
            <select id="gwEnabled"><option value="true" ${g.enabled?'selected':''}>启用</option><option value="false" ${!g.enabled?'selected':''}>关闭</option></select>
          </label>
          <label>显示名称<input id="gwName" value="${esc(g.name||'易支付')}"></label>
          <label>网关 API 地址<input id="gwApiUrl" placeholder="https://pay.example.com" value="${esc(g.apiUrl||'')}"></label>
          <label>商户 ID (pid)<input id="gwPid" value="${esc(g.pid||'')}"></label>
          <label>商户密钥 (key)<input id="gwKey" type="password" placeholder="${g.keySet?'已保存，留空不修改':'输入密钥'}" value=""></label>
          <label>网站公网地址 (siteUrl)<input id="gwSiteUrl" placeholder="https://你的域名" value="${esc(g.siteUrl||'')}"><small class="hint">用于拼 notify/return 回调，必须公网可访问</small></label>
        </div>
        <p class="sub" style="margin-top:12px">回调地址：<code>${esc((g.siteUrl||'https://你的域名') + '/api/pay/epay/notify')}</code></p>
        <button class="primary-btn" type="button" id="saveGatewayBtn" style="margin-top:12px">保存聚合支付配置</button>
        <div id="gwMsg" class="inline-msg"></div>
      </section>`);
      $('#saveGatewayBtn')?.addEventListener('click', async () => {
        const msg = $('#gwMsg');
        msg.textContent = '保存中…'; msg.className = 'inline-msg';
        try {
          const body = {
            enabled: $('#gwEnabled').value === 'true',
            name: $('#gwName').value.trim(),
            apiUrl: $('#gwApiUrl').value.trim(),
            pid: $('#gwPid').value.trim(),
            key: $('#gwKey').value,
            siteUrl: $('#gwSiteUrl').value.trim()
          };
          const j = await api('/api/admin/payment-gateway', { method: 'PUT', body: JSON.stringify(body) });
          msg.textContent = j.message || '已保存'; msg.className = 'inline-msg ok';
          if (window.appConfig) window.appConfig.paymentGateway = { enabled: !!(j.gateway&&j.gateway.ready), type: 'epay', name: body.name, configured: !!(j.gateway&&j.gateway.ready) };
        } catch (err) {
          msg.textContent = err.message || '保存失败'; msg.className = 'inline-msg';
        }
      });
    } else if (adminTab === 'payments') {
      const data = await api('/api/admin/payment-orders');
      if (!stillCurrent()) return;
      const orders = data.orders || [];
      const methodText={wechat:'微信',alipay:'支付宝'};
      const statusText={awaiting_payment:'待支付',pending:'待核对',confirmed:'已确认',rejected:'已拒绝'};
      shell('运营配置', 'ADMIN CONSOLE', `${adminTabsHtml()}
      <section class="card"><div class="card-head"><div><p class="eyebrow">PAYMENT CONFIRM</p><h2>付款确认</h2><p class="sub">请在微信/支付宝账单中按「用户名备注」+金额核对到账后确认发卡。待核对 ${Number(data.pendingCount||0)} 笔。</p></div>
        <div><button class="ghost-btn" type="button" data-admin-tab="payments">刷新</button></div></div>
        <table class="admin-table"><thead><tr><th>时间</th><th>用户</th><th>方式</th><th>金额</th><th>付款备注</th><th>状态</th><th>卡密</th><th>操作</th></tr></thead>
        <tbody>${orders.map(o=>`<tr>
          <td>${o.createdAt?new Date(o.createdAt).toLocaleString('zh-CN'):'-'}</td>
          <td>${esc(o.username||o.email||o.userId||'-')}<div class="sub">${esc(o.userId||'')}</div></td>
          <td>${esc(methodText[o.method]||o.method)}</td>
          <td>¥${Number(o.amount).toFixed(0)}</td>
          <td><code>${esc(o.payNote||'-')}</code></td>
          <td>${esc(statusText[o.status]||o.status)}</td>
          <td>${o.code?`<code>${esc(o.code)}</code>`:'-'}</td>
          <td>${(o.status==='pending'||o.status==='awaiting_payment')?`<button class="primary-btn pay-confirm" data-id="${esc(o.id)}" data-note="${esc(o.payNote||'')}" data-user="${esc(o.username||o.email||o.userId||'')}" style="height:32px;padding:0 10px;margin-right:6px">确认到账</button><button class="ghost-btn pay-reject" data-id="${esc(o.id)}">拒绝</button>`:'-'}</td>
        </tr>`).join('')||'<tr><td colspan="8" class="empty">暂无付款订单</td></tr>'}</tbody></table>
      </section>`);
      document.querySelectorAll('.pay-confirm').forEach(btn=>{
        btn.onclick=async()=>{
          const who=btn.dataset.user||'该用户';
          if(!confirm(`请到微信/支付宝账单确认：备注里有用户名「${who}」且金额正确。确认到账后发卡？`)) return;
          try{
            await api('/api/admin/payment-orders/'+encodeURIComponent(btn.dataset.id)+'/confirm',{method:'POST',body:JSON.stringify({})});
            renderOperations();
          }catch(err){alert(err.message||'确认失败');}
        };
      });
      document.querySelectorAll('.pay-reject').forEach(btn=>{
        btn.onclick=async()=>{
          const reason=prompt('拒绝原因（可选）','未确认到账')||'未确认到账';
          try{
            await api('/api/admin/payment-orders/'+encodeURIComponent(btn.dataset.id)+'/reject',{method:'POST',body:JSON.stringify({reason})});
            renderOperations();
          }catch(err){alert(err.message||'拒绝失败');}
        };
      });
    } else if (adminTab === 'checkin') {
      const stats = await api('/api/admin/checkin');
      if (!stillCurrent()) return;
      const recent = stats.recent || [];
      const rows = recent.map(r => `<tr><td>${esc(r.date)}</td><td>@${esc(r.username||'-')}</td><td>${esc(r.email||'-')}</td><td>¥${Number(r.amount||0).toFixed(2)}</td><td>${r.at?new Date(r.at).toLocaleString('zh-CN'):'-'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">暂无签到记录</td></tr>';
      shell('运营配置', 'ADMIN CONSOLE', `${adminTabsHtml()}
      <div class="metric-grid admin-finance">
        <article><small>今日签到人数</small><strong>${Number(stats.today?.users||0)}</strong><span class="green">${esc(stats.today?.date||'')} · 北京时间</span></article>
        <article><small>今日发放</small><strong>¥${Number(stats.today?.amount||0).toFixed(2)}</strong><span>签到奖励合计</span></article>
        <article><small>累计记录</small><strong>${Number(stats.totals?.records||0)}</strong><span>${Number(stats.totals?.users||0)} 位用户</span></article>
        <article><small>累计发放</small><strong>¥${Number(stats.totals?.amount||0).toFixed(2)}</strong><span>全部签到奖励</span></article>
      </div>
      <section class="card"><div class="card-head"><div><p class="eyebrow">CHECK-IN LOG</p><h2>最近签到</h2><p class="sub">日期按 Asia/Shanghai 自然日计算，奖励计入用户余额（不计入邀请返利）。</p></div><span class="sub">${recent.length} 条</span></div>
      <table class="admin-table"><thead><tr><th>日期</th><th>用户名</th><th>邮箱</th><th>金额</th><th>时间</th></tr></thead><tbody>${rows}</tbody></table></section>`);
    } else if (adminTab === 'welfare') {
      const data = await api('/api/admin/welfare');
      if (!stillCurrent()) return;
      const promo = data.promo || {};
      const preview = (data.preview || []).map(p => `<span>付 ¥${p.amount} → 到账 ¥${p.creditAmount}</span>`).join(' · ');
      const thumbs = (promo.images || []).map((u, i) => `<span class="welfare-thumb"><img src="${esc(u)}" alt=""><button type="button" class="ghost-btn" data-rm-img="${i}">移除</button></span>`).join('');
      const until = promo.expiresAt ? new Date(promo.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '今晚 24:00';
      shell('运营配置', 'ADMIN CONSOLE', `${adminTabsHtml()}
      <section class="card"><div class="card-head"><div><p class="eyebrow">WELFARE</p><h2>充值福利</h2>
        <p class="sub">只在后台配置。开启后用户端只看到顶部滚动横幅，以及购卡时的到账金额。福利到今晚 24:00（北京时间）截止；购卡时把倍率写进卡密，过点兑换仍按发卡时的到账额。</p></div>
        <span class="tag ${data.active?'success':'danger'}">${data.active?'进行中':'未开启'}</span></div>
        <form id="welfareForm" class="stack-form">
          <label class="check-label"><input id="welfareOn" type="checkbox" ${promo.enabled?'checked':''}> 开启今日福利</label>
          <label>福利倍率<input id="welfareMul" type="number" min="1" max="10" step="0.01" value="${esc(promo.multiplier ?? 1.1)}"></label>
          <p class="sub">1.1 倍：10 元卡密到账 11 元；2 倍：10 元到账 20 元。截止：${esc(until)}</p>
          <p class="sub">${preview || ''}</p>
          <label>横幅文案（可留空用默认）<textarea id="welfareText" placeholder="今日充值福利开启！卡密按 {mul} 倍到账，付 10 得 {ten}，今晚 24:00 截止。">${esc(promo.text||'')}</textarea></label>
          <p class="sub">占位符：{mul} {ten} {thirty} {fifty} {hundred}</p>
          <div class="welfare-thumbs">${thumbs || '<p class="sub">还没有横幅图片，可在下方上传。</p>'}</div>
          <label>上传横幅图片<input id="welfareFile" type="file" accept="image/*"></label>
          <button class="primary-btn" type="submit">保存福利设置</button>
          <div id="welfareMsg" class="inline-msg"></div>
        </form>
      </section>`);
      const images = [...(promo.images || [])];
      const saveWelfare = async (extra = {}) => {
        const msg = $('#welfareMsg');
        try {
          const j = await api('/api/admin/welfare', {
            method: 'PUT',
            body: JSON.stringify({
              enabled: !!$('#welfareOn')?.checked,
              multiplier: Number($('#welfareMul')?.value),
              text: $('#welfareText')?.value || '',
              images,
              ...extra
            })
          });
          if (window.appConfig) window.appConfig.welfareBanner = j.banner || null;
          paintWelfareBanner(j.banner);
          if (msg) { msg.textContent = j.active ? '已开启，横幅对用户可见' : '已保存（当前未在有效期内，用户看不到横幅）'; msg.className = 'inline-msg ok'; }
          renderOperations();
        } catch (err) {
          if (msg) { msg.textContent = err.message || '保存失败'; msg.className = 'inline-msg'; }
        }
      };
      $('#welfareForm')?.addEventListener('submit', e => { e.preventDefault(); saveWelfare(); });
      page.querySelectorAll('[data-rm-img]').forEach(btn => {
        btn.onclick = () => {
          images.splice(Number(btn.dataset.rmImg), 1);
          saveWelfare({ refreshExpiry: false });
        };
      });
      $('#welfareFile')?.addEventListener('change', async e => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const msg = $('#welfareMsg');
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result || ''));
            r.onerror = () => reject(new Error('读取图片失败'));
            r.readAsDataURL(file);
          });
          const j = await api('/api/admin/welfare/upload', { method: 'POST', body: JSON.stringify({ image: dataUrl }) });
          images.splice(0, images.length, ...(j.promo?.images || images));
          if (msg) { msg.textContent = '图片已上传'; msg.className = 'inline-msg ok'; }
          renderOperations();
        } catch (err) {
          if (msg) { msg.textContent = err.message || '上传失败'; msg.className = 'inline-msg'; }
        }
      });
    } else if (adminTab === 'orders') {
      const { orders } = await api('/api/admin/orders');
      if (!stillCurrent()) return;
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
      cacheReadPricePer1K: 0,
      upstreamRateMultiplier: 1,
      priority: 100,
      billingMultiplier: 2.5,
      displayMultiplier: 0.2,
      timeoutMs: 60000,
      maxRetries: 0,
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

  const addModelAt = (idx, value) => {
    const name = String(value || '').trim();
    if (!name) return;
    refreshFromDom();
    adminProvidersCache[idx].models = adminProvidersCache[idx].models || [];
    if (!adminProvidersCache[idx].models.includes(name)) adminProvidersCache[idx].models.push(name);
    renderOperations();
  };
  page.querySelectorAll('[data-add-model]').forEach(btn => btn.onclick = () => {
    const idx = Number(btn.dataset.addModel);
    const input = page.querySelector(`[data-add-model-input="${idx}"]`);
    addModelAt(idx, input?.value);
  });
  page.querySelectorAll('[data-add-model-input]').forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addModelAt(Number(input.dataset.addModelInput), input.value);
      }
    });
  });
  page.querySelectorAll('[data-remove-model]').forEach(btn => btn.onclick = () => {
    refreshFromDom();
    const [pIdx, mIdx] = btn.dataset.removeModel.split(':').map(Number);
    (adminProvidersCache[pIdx].models || []).splice(mIdx, 1);
    renderOperations();
  });

  page.querySelectorAll('[data-add-mp]').forEach(btn => btn.onclick = () => {
    refreshFromDom();
    const idx = Number(btn.dataset.addMp);
    adminProvidersCache[idx].modelPrices = adminProvidersCache[idx].modelPrices || {};
    let n = 1;
    while (adminProvidersCache[idx].modelPrices[`model-${n}`]) n += 1;
    adminProvidersCache[idx].modelPrices[`model-${n}`] = { inputPricePer1K: 0, outputPricePer1K: 0, cacheReadPricePer1K: 0 };
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

  
  const runSyncModels = async (ids) => {
    const result = $('#providerResult');
    if (result) { result.textContent = '正在从上游同步模型…'; result.className = 'inline-msg'; }
    try {
      const collected = collectProvidersFromDom();
      await api('/api/admin/providers', { method: 'PUT', body: JSON.stringify(collected) });
      const j = await api('/api/admin/providers/sync-models', {
        method: 'POST',
        body: JSON.stringify(ids?.length ? { ids } : {})
      });
      adminProvidersCache = j.providers || adminProvidersCache;
      if (result) { result.textContent = j.message || '同步完成'; result.className = 'inline-msg ok'; }
      renderOperations();
    } catch (err) {
      if (result) { result.textContent = err.message; result.className = 'inline-msg'; }
    }
  };
  $('#probeHealth')?.addEventListener('click', async () => {
    const result = $('#providerResult');
    if (result) { result.textContent = '正在探测渠道可用性…'; result.className = 'inline-msg'; }
    try {
      const collected = collectProvidersFromDom();
      await api('/api/admin/providers', { method: 'PUT', body: JSON.stringify(collected) });
      const j = await api('/api/admin/providers/health-check', { method: 'POST', body: '{}' });
      adminProvidersCache = j.providers || adminProvidersCache;
      if (result) { result.textContent = j.message || '探测完成'; result.className = 'inline-msg ok'; }
      renderOperations();
    } catch (err) {
      if (result) { result.textContent = err.message; result.className = 'inline-msg'; }
    }
  });
  $('#syncAllModels')?.addEventListener('click', () => runSyncModels(null));
  page.querySelectorAll('[data-sync-models]').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.syncModels;
      if (!id) { $('#providerResult').textContent = '请先保存渠道后再同步'; return; }
      runSyncModels([id]);
    };
  });

  $('#saveProviders')?.addEventListener('click', async () => {
    try {
      const { providers, defaultProviderId } = collectProvidersFromDom();
      if (!providers.length) throw Error('至少保留一个渠道');
      for (const p of providers) {
        if (!p.name || !p.url || !/^https:\/\//.test(p.url)) throw Error('渠道内部名称和 HTTPS 上游地址不能为空');
              }
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
  startPayLive();
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
