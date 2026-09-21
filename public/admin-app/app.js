const TOKEN_KEY = 'relay_admin_app_token';
const $ = (s) => document.querySelector(s);
let token = localStorage.getItem(TOKEN_KEY) || '';
let tab = 'home';
let pollTimer = null;
let pollCtl = null;

function bridge() {
  return window.AdminBridge || window.Android || null;
}
function tellNative(method, ...args) {
  const b = bridge();
  if (b && typeof b[method] === 'function') {
    try { b[method](...args); } catch { /* ignore */ }
  }
}
async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {})
    }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(j.error || '请求失败');
  return j;
}
function esc(x = '') {
  return String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(n) {
  const x = Number(n);
  return Number.isFinite(x) ? `¥${x.toFixed(2)}` : '—';
}
function when(t) {
  if (!t) return '—';
  return String(t).replace('T', ' ').slice(0, 19);
}
function statusLabel(s) {
  return ({ awaiting_payment: '待支付', pending: '待核对', confirmed: '已确认', rejected: '已拒绝' })[s] || s;
}
function methodLabel(s) {
  return ({ wechat: '微信', alipay: '支付宝' })[s] || s;
}
function dateInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}
function qrStatusHtml(st) {
  if (!st) return '<span class="tag">未知</span>';
  if (st.expired) return '<span class="tag bad">已过期</span>';
  if (st.daysLeft != null && st.daysLeft <= 3) return `<span class="tag warn">还剩 ${st.daysLeft} 天</span>`;
  if (st.expiresAt) return `<span class="tag">有效至 ${esc(String(st.expiresAt).slice(0, 10))}</span>`;
  return '<span class="tag">未设到期日</span>';
}
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}
function compressQrImage(dataUrl, maxEdge = 1200) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => reject(new Error('图片无法打开'));
    img.src = dataUrl;
  });
}

function showLogin(msg) {
  $('#appView').hidden = true;
  $('#loginView').hidden = false;
  if (msg) {
    $('#loginMsg').textContent = msg;
    $('#loginMsg').className = 'msg err';
  }
  tellNative('onLogout');
}
function showApp() {
  $('#loginView').hidden = true;
  $('#appView').hidden = false;
}

async function login() {
  const loginId = $('#loginId').value.trim();
  const password = $('#loginPw').value;
  $('#loginMsg').textContent = '登录中…';
  $('#loginMsg').className = 'msg';
  try {
    const phoneBox = $('#phoneBox');
    const phoneInput = $('#loginPhone');
    if (phoneBox && !phoneBox.hidden && phoneInput) {
      const phone = String(phoneInput.value || '').replace(/\D/g, '');
      if (!/^1[3-9]\d{9}$/.test(phone)) throw Error('请输入正确的11位手机号');
      const done = await api('/api/auth/login/phone', { method: 'POST', body: JSON.stringify({ ticket: window.__adminPhoneTicket, phone }) });
      return finishAdminLogin(done);
    }
    const j = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ login: loginId, password }) });
    if (j.needPhone) {
      window.__adminPhoneTicket = j.ticket;
      if (phoneBox) phoneBox.hidden = false;
      const hint = $('#phoneHint');
      if (hint) hint.textContent = j.enroll ? '首次登录请绑定管理员手机号。' : '请输入已绑定的管理员手机号。';
      $('#loginMsg').textContent = j.message || '请填写手机号后再次点登录';
      $('#loginMsg').className = 'msg';
      phoneInput?.focus();
      return;
    }
    finishAdminLogin(j);
  } catch (err) {
    $('#loginMsg').textContent = err.message || '登录失败';
    $('#loginMsg').className = 'msg err';
  }
}
function finishAdminLogin(j) {
  if (!j.user?.isAdmin && j.user?.role !== 'admin') throw Error('需要管理员账号');
  token = j.token;
  localStorage.setItem(TOKEN_KEY, token);
  tellNative('onLogin', token);
  showApp();
  $('#hello').textContent = j.user.username || j.user.name || '管理员';
  startPoll();
  render();
}

function logout() {
  token = '';
  localStorage.removeItem(TOKEN_KEY);
  stopPoll();
  showLogin('');
}

function startPoll() {
  stopPoll();
  const ctl = new AbortController();
  pollCtl = ctl;
  let afterRaw = localStorage.getItem('relay_admin_event_seq');
  let after = afterRaw == null || afterRaw === '' ? -1 : Number(afterRaw);
  (async () => {
    while (token && pollCtl === ctl && !ctl.signal.aborted) {
      try {
        const r = await fetch('/api/admin/mobile/inbox/wait?after=' + after, {
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
          },
          signal: ctl.signal
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw Error(j.error || '请求失败');
        after = Number.isFinite(Number(j.seq)) ? Number(j.seq) : after;
        localStorage.setItem('relay_admin_event_seq', String(after));
        const events = j.events || [];
        const alertable = events.filter(ev => ev.kind === 'placed' || ev.kind === 'paid' || ev.kind === 'signup_burst' || ev.kind === 'upstream_over_charge');
        if (alertable.length) {
          const burst = alertable.filter(e => e.kind === 'signup_burst');
          const over = alertable.filter(e => e.kind === 'upstream_over_charge');
          const pays = alertable.filter(e => e.kind === 'placed' || e.kind === 'paid');
          let title = '';
          let body = '';
          if (burst.length) {
            const first = burst[0];
            title = first.title || `注册暴增 ${first.count || ''}`.trim();
            body = first.body || `短时间内新注册 ${first.count || ''} 个账号`;
            const badge = document.querySelector('[data-tab="alerts"]');
            if (badge && tab !== 'alerts') badge.textContent = `告警(${burst.length})`;
          } else if (over.length) {
            const first = over[0];
            title = first.title || '上游实付倒挂';
            body = first.body || `Token 表收费低于上游实付 ${first.count || ''} 笔`;
            const badge = document.querySelector('[data-tab="alerts"]');
            if (badge && tab !== 'alerts') badge.textContent = `告警`;
          } else if (pays.length) {
            const first = pays.find(e => e.kind === 'paid') || pays[0];
            title = pays.some(e => e.kind === 'paid')
              ? `待核对充值 ${pays.length} 笔`
              : `有人发起充值 ${pays.length} 笔`;
            body = first
              ? `${first.username || '用户'} ¥${Number(first.amount || 0).toFixed(0)} · ${methodLabel(first.method)} · 备注 ${first.payNote || '-'}`
              : '请打开值班台确认到账';
            const badge = document.querySelector('[data-tab="orders"]');
            const inbox = j.inbox || {};
            if (badge && tab !== 'orders') badge.textContent = `充值(${inbox.pendingCount ?? pays.length})`;
          }
          try {
            const b = bridge();
            const vibeOn = !(b && typeof b.getVibrateEnabled === 'function') || String(b.getVibrateEnabled()) === '1';
            if (vibeOn && navigator.vibrate) navigator.vibrate([180, 80, 180, 80, 320]);
            tellNative('onNewOrders', JSON.stringify({ title, body }));
          } catch { /* ignore */ }
        }
        if ((tab === 'home' || tab === 'orders' || tab === 'alerts') && j.inbox) render(j.inbox);
      } catch (err) {
        if (ctl.signal.aborted) return;
        if (String(err.message || '').includes('未登录') || String(err.message || '').includes('需要管理员')) {
          logout();
          return;
        }
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  })();
}
function stopPoll() {
  if (pollCtl) {
    try { pollCtl.abort(); } catch { /* ignore */ }
    pollCtl = null;
  }
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function render(preloaded) {
  const pane = $('#pane');
  try {
    if (tab === 'home') {
      const inbox = preloaded || await api('/api/admin/mobile/inbox');
      const f = inbox.finance || {};
      const down = (inbox.providers || []).filter(p => p.enabled && !p.maintenance && p.healthOk === false);
      pane.innerHTML = `
        <div class="cards">
          <div class="card"><small>待核对充值</small><b class="${inbox.pendingCount ? 'bad' : 'ok'}">${inbox.pendingCount}</b></div>
          <div class="card"><small>待支付订单</small><b>${inbox.awaitingCount}</b></div>
          <div class="card"><small>今日发卡</small><b>${money(f.incomeToday)}</b></div>
          <div class="card"><small>注册告警</small><b class="${(inbox.securityAlerts || []).length ? 'bad' : 'ok'}">${(inbox.securityAlerts || []).length}</b></div>
        </div>
        <p class="sub">诊断上次：${inbox.diagnostics?.at ? when(inbox.diagnostics.at) : '尚未运行'} · 失败 ${inbox.diagnostics?.summary?.failed ?? '-'}${Number(f.invertedCount||0) ? ` · 计费倒挂 ${f.invertedCount} 笔 / ¥${Number(f.invertedLossToday||0).toFixed(4)}` : ''}</p>
        <div class="row"><button class="primary" id="goOrders">去确认充值</button><button class="ghost" id="goAlerts">看告警</button></div>
        ${Number(f.invertedCount || 0)
          ? `<article class="item" style="margin-top:12px"><h3 class="bad">上游实付超过 Token 表收费</h3><p class="sub">今日 ${Number(f.invertedCount)} 笔倒挂，合计 ¥${Number(f.invertedLossToday||0).toFixed(4)}。客户仍按价格表收费。</p></article>`
          : ''}
        ${inbox.paymentQr?.wechat?.expired || inbox.paymentQr?.alipay?.expired
          ? `<article class="item" style="margin-top:12px"><h3 class="bad">收款码已过期</h3><p class="sub">${esc([inbox.paymentQr?.wechat?.expired ? '微信' : '', inbox.paymentQr?.alipay?.expired ? '支付宝' : ''].filter(Boolean).join(' / '))} 需要按金额分别换图。</p><button class="primary" id="goQr">去替换收款码</button></article>`
          : ''}`;
      $('#goOrders').onclick = () => { tab = 'orders'; syncTabs(); render(); };
      $('#goAlerts')?.addEventListener('click', () => { tab = 'alerts'; syncTabs(); render(); });
      $('#goQr')?.addEventListener('click', () => { tab = 'qr'; syncTabs(); render(); });
    } else if (tab === 'alerts') {
      const data = await api('/api/admin/security-alerts');
      const list = data.alerts || [];
      const billing = data.billingAlerts || [];
      pane.innerHTML = `
        <p class="sub">计费倒挂待处理 ${data.billingOpenCount || 0} 条 · 注册告警待处理 ${data.openCount || 0} 条。</p>
        <div class="list">${billing.length ? billing.map(a => `
          <article class="item">
            <h3>${a.status === 'open' ? '<span class="tag warn">待处理</span>' : '<span class="tag">已忽略</span>'} 倒挂 ${Number(a.count || 0)} 笔 · ¥${Number(a.loss || 0).toFixed(4)}</h3>
            <p class="sub">${esc(when(a.createdAt))} · ${esc(a.day || '')}</p>
            <p class="sub">${(a.users || []).map(u => '@' + (u.username || u.userId)).join('、') || '-'}</p>
            ${a.status === 'open' ? `<div class="row"><button class="ghost" data-dismiss-billing="${esc(a.id)}">忽略</button></div>` : ''}
          </article>`).join('') : ''}
        ${list.length ? list.map(a => `
          <article class="item">
            <h3>${a.status === 'open' ? '<span class="tag warn">待处理</span>' : (a.status === 'banned' ? '<span class="tag">已封</span>' : '<span class="tag">已忽略</span>')} 注册 ${Number(a.count || 0)} 个</h3>
            <p class="sub">${esc(when(a.createdAt))} · IP ${esc(a.ip || '-')}</p>
            ${(a.users || []).map(u => `
              <div class="row" style="align-items:center">
                <p class="sub" style="flex:1;margin:0">@${esc(u.username || u.email || u.userId)}${u.banned ? '（已封）' : ''}</p>
                ${a.status === 'open' && !u.banned ? `<button class="ghost" data-ban-one="${esc(a.id)}" data-user="${esc(u.userId)}">封号</button>` : ''}
              </div>`).join('')}
            ${a.status === 'open' ? `<div class="row"><button class="primary" data-ban-all="${esc(a.id)}">一键封号</button><button class="ghost" data-dismiss="${esc(a.id)}">忽略</button></div>` : `<p class="sub">已处理 ${a.bannedCount || 0} 人</p>`}
          </article>`).join('') : (billing.length ? '' : '<p class="sub">暂无告警</p>')}</div>`;
      pane.querySelectorAll('[data-ban-all]').forEach(btn => btn.onclick = async () => {
        if (!confirm('确认封禁该批次全部新注册账号？')) return;
        await api(`/api/admin/security-alerts/${btn.dataset.banAll}/ban-all`, { method: 'POST', body: '{}' });
        render();
      });
      pane.querySelectorAll('[data-ban-one]').forEach(btn => btn.onclick = async () => {
        if (!confirm('确认封禁该账号？')) return;
        await api(`/api/admin/security-alerts/${btn.dataset.banOne}/ban-one`, { method: 'POST', body: JSON.stringify({ userId: btn.dataset.user }) });
        render();
      });
      pane.querySelectorAll('[data-dismiss]').forEach(btn => btn.onclick = async () => {
        await api(`/api/admin/security-alerts/${btn.dataset.dismiss}/dismiss`, { method: 'POST', body: '{}' });
        render();
      });
      pane.querySelectorAll('[data-dismiss-billing]').forEach(btn => btn.onclick = async () => {
        await api(`/api/admin/billing-alerts/${btn.dataset.dismissBilling}/dismiss`, { method: 'POST', body: '{}' });
        render();
      });
    } else if (tab === 'orders') {
      const inbox = preloaded || await api('/api/admin/mobile/inbox');
      const list = [...(inbox.pending || []), ...(inbox.awaiting || [])];
      pane.innerHTML = list.length ? `<div class="list">${list.map(o => `
        <article class="item">
          <h3>¥${Number(o.amount).toFixed(0)} · ${esc(methodLabel(o.method))}</h3>
          <p class="sub">${esc(o.username || o.email || o.userId)} · 备注 <code>${esc(o.payNote || '-')}</code></p>
          <p class="sub">${esc(statusLabel(o.status))} · ${esc(when(o.userReportedAt || o.createdAt))}</p>
          <div class="row">
            <button class="primary" data-ok="${esc(o.id)}">确认到账发卡</button>
            <button class="ghost" data-no="${esc(o.id)}">拒绝</button>
          </div>
        </article>`).join('')}</div>` : '<p class="sub">没有待处理充值。</p>';
      pane.querySelectorAll('[data-ok]').forEach(btn => {
        btn.onclick = async () => {
          if (!confirm('请先在微信/支付宝账单核对用户名备注和金额，确认到账？')) return;
          btn.disabled = true;
          try {
            await api('/api/admin/payment-orders/' + encodeURIComponent(btn.dataset.ok) + '/confirm', { method: 'POST', body: '{}' });
            render();
          } catch (err) { alert(err.message); btn.disabled = false; }
        };
      });
      pane.querySelectorAll('[data-no]').forEach(btn => {
        btn.onclick = async () => {
          const reason = prompt('拒绝原因', '未确认到账') || '未确认到账';
          try {
            await api('/api/admin/payment-orders/' + encodeURIComponent(btn.dataset.no) + '/reject', { method: 'POST', body: JSON.stringify({ reason }) });
            render();
          } catch (err) { alert(err.message); }
        };
      });
    } else if (tab === 'users') {
      const q = ($('#userQ')?.value || '').trim();
      const data = await api('/api/admin/users' + (q ? `?q=${encodeURIComponent(q)}` : ''));
      const list = data.users || [];
      pane.innerHTML = `
        <p class="sub">用户名和显示名称全站唯一。共 ${data.total ?? list.length} 人。</p>
        <label>搜索<input id="userQ" value="${esc(q)}" placeholder="用户名 / 名称 / 邮箱"></label>
        <button class="primary" type="button" id="userSearch">搜索</button>
        <div class="list" style="margin-top:12px">${list.length ? list.map(u => `
          <article class="item">
            <h3>@${esc(u.username || '-')} ${u.banned ? '<span class="tag bad">已封禁</span>' : (u.accountActive ? '<span class="tag">正常</span>' : '<span class="tag warn">未激活</span>')}</h3>
            <p class="sub">${esc(u.name || '')} · ${esc(u.email || '')}</p>
            <p><b class="${u.banned ? 'bad' : 'ok'}">${money(u.balance)}</b></p>
            <p class="sub">今日收费 ¥${Number(u.todayCharged||0).toFixed(4)} · 上游 ¥${Number(u.todayUpstream||0).toFixed(4)}${Number(u.todayInverted||0) ? ` · <b class="bad">倒挂 ${u.todayInverted}</b>` : ''}</p>
            <div class="row">
              <button class="primary" data-add="${esc(u.id)}">加余额</button>
              <button class="ghost" data-sub="${esc(u.id)}">减余额</button>
            </div>
            <div class="row">
              <button class="ghost" data-set="${esc(u.id)}" data-bal="${esc(u.balance)}">改余额</button>
              <button class="ghost" data-ban="${esc(u.id)}" data-banned="${u.banned ? '1' : '0'}">${u.banned ? '解封' : '封号'}</button>
            </div>
          </article>`).join('') : '<p class="sub">没有匹配的用户。</p>'}</div>`;
      $('#userSearch').onclick = () => render();
      $('#userQ')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); render(); } });
      const act = async (id, body) => {
        try {
          await api('/api/admin/users/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(body) });
          render();
        } catch (err) { alert(err.message); }
      };
      pane.querySelectorAll('[data-add]').forEach(btn => {
        btn.onclick = () => {
          const raw = prompt('增加多少余额（元）', '10');
          if (raw == null) return;
          const n = Number(raw);
          if (!Number.isFinite(n) || n <= 0) return alert('请输入大于 0 的金额');
          act(btn.dataset.add, { balanceDelta: n });
        };
      });
      pane.querySelectorAll('[data-sub]').forEach(btn => {
        btn.onclick = () => {
          const raw = prompt('减少多少余额（元）', '10');
          if (raw == null) return;
          const n = Number(raw);
          if (!Number.isFinite(n) || n <= 0) return alert('请输入大于 0 的金额');
          act(btn.dataset.sub, { balanceDelta: -n });
        };
      });
      pane.querySelectorAll('[data-set]').forEach(btn => {
        btn.onclick = () => {
          const raw = prompt('把余额改成多少（元）', btn.dataset.bal || '0');
          if (raw == null) return;
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0) return alert('余额必须是非负数');
          act(btn.dataset.set, { balance: n });
        };
      });
      pane.querySelectorAll('[data-ban]').forEach(btn => {
        btn.onclick = () => {
          const banned = btn.dataset.banned === '1';
          if (!banned && !confirm('确认封禁该用户？封禁后无法登录、充值和调用 API。')) return;
          act(btn.dataset.ban, { banned: !banned });
        };
      });
    } else if (tab === 'qr') {
      const data = await api('/api/admin/payment-qrs');
      const qrs = data.paymentQrs || {};
      const meta = data.paymentQrMeta || {};
      const amounts = [10, 30, 50, 100];
      const bust = Date.now();
      const card = (method, title) => {
        const st = meta[method] || {};
        const slots = amounts.map(a => {
          const src = qrs[method]?.[String(a)] || '';
          return `<article class="qr-slot">
            <h3>¥${a}</h3>
            ${src ? `<img class="qr-preview" alt="${title} ¥${a}" src="${esc(src)}?t=${bust}">` : '<p class="sub">还没有这张收款码</p>'}
            <label class="file-btn">替换这张图
              <input class="hidden-file" type="file" accept="image/*" data-method="${method}" data-amount="${a}">
            </label>
            <p class="sub" id="${method}-${a}-msg">${src ? '只改这一档金额' : '缺图'}</p>
          </article>`;
        }).join('');
        return `<article class="item">
          <h3>${title} ${qrStatusHtml(st)}</h3>
          <p class="sub">${esc(st.tip || '')}</p>
          <label>该支付方式到期日<input type="date" id="${method}Exp" value="${esc(dateInput(st.expiresAt || meta[method + 'ExpiresAt']))}"></label>
          <button class="ghost" type="button" data-save-exp="${method}" style="width:100%;margin-top:8px">只保存到期日</button>
          <p class="sub" id="${method}Msg">到期日按微信/支付宝整组计算，图片必须按金额分开换。</p>
          <div class="qr-list">${slots}</div>
        </article>`;
      };
      pane.innerHTML = `<p class="sub">¥10 / 30 / 50 / 100 各是一张收款码，过期或扫码失败时只替换对应金额的那张。</p>
        <div class="list">${card('wechat', '微信')}${card('alipay', '支付宝')}</div>`;
      const upload = async (method, amount, file) => {
        const msg = document.getElementById(`${method}-${amount}-msg`);
        if (!msg) return;
        msg.textContent = '处理图片…';
        msg.className = 'sub';
        try {
          const raw = await fileToDataUrl(file);
          const image = await compressQrImage(raw);
          msg.textContent = '上传中…';
          await api('/api/admin/payment-qrs/upload', {
            method: 'POST',
            body: JSON.stringify({
              method,
              amount: Number(amount),
              image
            })
          });
          msg.textContent = `已替换 ¥${amount}`;
          msg.className = 'sub ok';
          render();
        } catch (err) {
          msg.textContent = err.message || '上传失败';
          msg.className = 'sub bad';
        }
      };
      pane.querySelectorAll('input[data-amount]').forEach(input => {
        input.onchange = () => {
          const file = input.files && input.files[0];
          input.value = '';
          if (file) upload(input.dataset.method, input.dataset.amount, file);
        };
      });
      pane.querySelectorAll('[data-save-exp]').forEach(btn => {
        btn.onclick = async () => {
          const method = btn.dataset.saveExp;
          const msg = document.getElementById(method + 'Msg');
          const field = method === 'wechat' ? 'wechatExpiresAt' : 'alipayExpiresAt';
          try {
            await api('/api/admin/payment-qrs', {
              method: 'PUT',
              body: JSON.stringify({
                paymentQrMeta: {
                  wechatExpiresAt: document.getElementById('wechatExp')?.value || meta.wechatExpiresAt || null,
                  alipayExpiresAt: document.getElementById('alipayExp')?.value || meta.alipayExpiresAt || null,
                  [field]: document.getElementById(method + 'Exp')?.value || null
                }
              })
            });
            if (msg) { msg.textContent = '到期日已保存'; msg.className = 'sub ok'; }
            render();
          } catch (err) {
            if (msg) { msg.textContent = err.message; msg.className = 'sub bad'; }
          }
        };
      });
    } else if (tab === 'diag') {
      const last = (await api('/api/admin/diagnostics/last')).last;
      const s = last?.summary || {};
      pane.innerHTML = `
        <p class="sub">会真实探测各渠道对话、延迟、倍率和充值逻辑，大约需要一分钟。</p>
        <button class="primary" id="runDiag">一键测试全部渠道</button>
        <p class="sub" id="diagSum">${last ? `上次 ${when(last.at)} · 通过 ${s.passed || 0} / 警告 ${s.warned || 0} / 失败 ${s.failed || 0}` : '尚未运行'}</p>
        <button class="primary" id="calibratePrices" type="button" style="margin-top:10px">对照账单校准估价</button>
        <p class="sub" id="calibrateMsg"></p>
        <div id="diagList" class="list"></div>`;
      const paint = (report) => {
        const rows = (report.results || []).map(r => {
          const cls = r.ok ? (r.level === 'warn' ? 'warn' : 'ok') : 'bad';
          const tag = r.ok ? (r.level === 'warn' ? '警告' : '通过') : '失败';
          return `<article class="item"><span class="tag ${cls === 'ok' ? '' : cls}">${tag}</span>
            <h3>${esc(r.name)}</h3>
            <p class="sub">${esc(r.message || '')}</p>
            ${r.detail ? `<p class="sub">${esc(r.detail)}</p>` : ''}
            ${r.latencyMs != null ? `<p class="sub">延迟 ${r.latencyMs}ms</p>` : ''}</article>`;
        }).join('');
        $('#diagList').innerHTML = rows || '<p class="sub">无明细</p>';
      };
      if (last) paint(last);
      $('#runDiag').onclick = async () => {
        const btn = $('#runDiag');
        btn.disabled = true;
        btn.textContent = '测试进行中…';
        try {
          const report = await api('/api/admin/diagnostics/run', { method: 'POST', body: '{}' });
          $('#diagSum').textContent = `完成 · 通过 ${report.summary?.passed || 0} / 警告 ${report.summary?.warned || 0} / 失败 ${report.summary?.failed || 0}`;
          paint(report);
        } catch (err) {
          alert(err.message);
        } finally {
          btn.disabled = false;
          btn.textContent = '一键测试全部渠道';
        }
      };
      $('#calibratePrices').onclick = async () => {
        const msg = $('#calibrateMsg');
        const btn = $('#calibratePrices');
        btn.disabled = true;
        msg.textContent = '正在对照账单校准…';
        try {
          const j = await api('/api/admin/providers/calibrate-prices', { method: 'POST', body: '{}' });
          const lines = (j.results || []).slice(0, 8).map(r => {
            const models = (r.models || []).map(m => `${m.model} 入${Number(m.inputPer1K||0).toFixed(4)}/1K`).join('，');
            return `${r.name}：${models || '未测到'}`;
          });
          msg.textContent = j.message + (lines.length ? '\n' + lines.join('\n') : '');
          msg.className = 'sub ok';
        } catch (err) {
          msg.textContent = err.message;
          msg.className = 'sub bad';
        } finally {
          btn.disabled = false;
        }
      };
    } else if (tab === 'up') {
      pane.innerHTML = '<p class="sub">正在读取上游账号余额…</p>';
      const acc = await api('/api/admin/upstream-accounts');
      const card = (title, row) => {
        if (!row?.ok) {
          return `<article class="item"><h3>${esc(title)}</h3><p class="sub bad">${esc(row?.error || '读取失败')} · ${esc(row?.upstream?.email || '')}</p></article>`;
        }
        return `<article class="item"><h3>${esc(title)}</h3>
          <p class="sub">${esc(row.account.email)}</p>
          <p><b class="ok">${money(row.account.balance)}</b></p>
          <p class="sub">冻结 ${money(row.account.frozenBalance)} · 并发 ${row.account.concurrency ?? '-'} · ${esc(row.account.status || '')}</p></article>`;
      };
      pane.innerHTML = `<div class="list">${card('vip1129', acc.vip1129)}${card('Beibeihai', acc.beibeihai)}</div>
        <p class="sub">这是上游站账号余额，不是本站用户余额。</p>`;
    } else if (tab === 'set') {
      const [site, pricing, welfare] = await Promise.all([
        api('/api/admin/site-settings'),
        api('/api/admin/pricing'),
        api('/api/admin/welfare')
      ]);
      const promo = welfare.promo || {};
      pane.innerHTML = `
        <label>站点公开地址<input id="pubUrl" value="${esc(site.publicBaseUrl || '')}" placeholder="https://你的域名"></label>
        <label>贝贝海全局倍率<input id="rate" type="number" min="0.01" max="10" step="0.01" value="${esc(pricing.multiplier)}"></label>
        <label>vip1129/Codex倍率<input id="rateVip" type="number" min="0.01" max="10" step="0.01" value="${esc(pricing.multiplierVip1129 ?? pricing.multiplier ?? 1.5)}"></label>
        <label style="display:flex;align-items:center;gap:10px"><input id="allowEstimate" type="checkbox" style="width:auto" ${pricing.allowEstimatedBilling ? 'checked' : ''}><span>允许估价结算（拿不到上游实扣时）</span></label>
        <p class="sub">默认关闭估价。关闭后只按上游 actual_cost 实时扣费；实扣未到会挂起对齐，不会用价表定稿。</p>
        <button class="primary" id="saveSet">保存站点设置</button>
        <p class="sub" id="setMsg"></p>
        <h3 style="margin:22px 0 8px">充值福利</h3>
        <p class="sub">只在后台改。用户端只看到横幅和购卡到账金额。到今晚 24:00 截止。</p>
        <label style="display:flex;align-items:center;gap:10px"><input id="welfareOn" type="checkbox" style="width:auto" ${promo.enabled ? 'checked' : ''}><span>开启今日福利</span></label>
        <label>福利倍率<input id="welfareMul" type="number" min="1" max="10" step="0.01" value="${esc(promo.multiplier ?? 1.1)}"></label>
        <label>横幅文案（可留空）<input id="welfareText" value="${esc(promo.text || '')}" placeholder="今日充值福利开启！卡密按 {mul} 倍到账…"></label>
        <p class="sub">${(welfare.preview || []).map(p => `付${p.amount}→到账${p.creditAmount}`).join(' · ')}</p>
        <button class="primary" id="saveWelfare" type="button">保存福利</button>
        <p class="sub" id="welfareMsg"></p>
        <label style="display:flex;align-items:center;gap:10px;margin-top:16px">
          <input id="vibToggle" type="checkbox" style="width:auto">
          <span>新订单系统通知时震动（后台也生效）</span>
        </label>
        <button class="ghost" id="editServer" type="button" style="width:100%;margin-top:12px">更改 APK 连接的网站地址</button>
        <p class="sub">关掉震动后仍会弹系统通知。购卡/付款确认由原生服务长连接立即提醒，挂后台也会震动。</p>`;
      $('#saveSet').onclick = async () => {
        const msg = $('#setMsg');
        try {
          await api('/api/admin/site-settings', { method: 'PUT', body: JSON.stringify({ publicBaseUrl: $('#pubUrl').value.trim() }) });
          const body = { multiplier: Number($('#rate').value) };
          if ($('#rateVip')) body.multiplierVip1129 = Number($('#rateVip').value);
          body.allowEstimatedBilling = !!$('#allowEstimate')?.checked;
          await api('/api/admin/pricing', { method: 'PUT', body: JSON.stringify(body) });
          msg.textContent = '已保存';
          msg.className = 'sub ok';
        } catch (err) {
          msg.textContent = err.message;
          msg.className = 'sub bad';
        }
      };
      $('#saveWelfare').onclick = async () => {
        const msg = $('#welfareMsg');
        try {
          const j = await api('/api/admin/welfare', {
            method: 'PUT',
            body: JSON.stringify({
              enabled: !!$('#welfareOn')?.checked,
              multiplier: Number($('#welfareMul')?.value),
              text: $('#welfareText')?.value || ''
            })
          });
          msg.textContent = j.active ? '福利已开启' : '已保存（当前未生效）';
          msg.className = 'sub ok';
        } catch (err) {
          msg.textContent = err.message;
          msg.className = 'sub bad';
        }
      };
      try {
        const b = bridge();
        const on = !(b && typeof b.getVibrateEnabled === 'function') || String(b.getVibrateEnabled()) === '1';
        $('#vibToggle').checked = on;
        $('#vibToggle').onchange = () => {
          const v = $('#vibToggle').checked ? '1' : '0';
          tellNative('setVibrateEnabled', v);
        };
      } catch { /* browser without bridge */ }
      $('#editServer')?.addEventListener('click', () => tellNative('editServer'));
    }
  } catch (err) {
    pane.innerHTML = `<p class="msg err">${esc(err.message)}</p>`;
  }
}

function syncTabs() {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
}

$('#loginBtn').onclick = login;
$('#logoutBtn').onclick = logout;
document.querySelectorAll('.tabs button').forEach(b => {
  b.onclick = () => { tab = b.dataset.tab; syncTabs(); render(); };
});

if (token) {
  api('/api/me').then(j => {
    if (!j.user?.isAdmin && j.user?.role !== 'admin') throw Error('需要管理员');
    tellNative('onLogin', token);
    showApp();
    $('#hello').textContent = j.user.username || j.user.name || '管理员';
    startPoll();
    render();
  }).catch(() => logout());
}

