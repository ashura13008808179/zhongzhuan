const TOKEN_KEY = 'relay_admin_app_token';
const $ = (s) => document.querySelector(s);
let token = localStorage.getItem(TOKEN_KEY) || '';
let tab = 'home';
let lastNotifyIds = JSON.parse(localStorage.getItem('relay_admin_notify_ids') || '[]');
let pollTimer = null;

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
    const j = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ login: loginId, password }) });
    if (!j.user?.isAdmin && j.user?.role !== 'admin') throw Error('需要管理员账号');
    token = j.token;
    localStorage.setItem(TOKEN_KEY, token);
    tellNative('onLogin', token);
    showApp();
    $('#hello').textContent = j.user.username || j.user.name || '管理员';
    startPoll();
    render();
  } catch (err) {
    $('#loginMsg').textContent = err.message || '登录失败';
    $('#loginMsg').className = 'msg err';
  }
}

function logout() {
  token = '';
  localStorage.removeItem(TOKEN_KEY);
  stopPoll();
  showLogin('');
}

function startPoll() {
  stopPoll();
  tickInbox();
  pollTimer = setInterval(tickInbox, 15000);
}
function stopPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function tickInbox() {
  if (!token) return;
  try {
    const inbox = await api('/api/admin/mobile/inbox');
    const ids = inbox.notifyIds || [];
    const seeded = localStorage.getItem('relay_admin_notify_seeded') === '1';
    if (!seeded) {
      lastNotifyIds = ids;
      localStorage.setItem('relay_admin_notify_ids', JSON.stringify(ids));
      localStorage.setItem('relay_admin_notify_seeded', '1');
    } else {
      const fresh = ids.filter(id => !lastNotifyIds.includes(id));
      if (fresh.length) {
        const first = (inbox.pending || []).find(o => o.id === fresh[0]);
        const title = `待核对充值 ${fresh.length} 笔`;
        const body = first
          ? `${first.username || first.email || '用户'} ¥${Number(first.amount || 0).toFixed(0)} · ${methodLabel(first.method)} · 备注 ${first.payNote || '-'}`
          : '请打开值班台确认到账';
        tellNative('onNewOrders', JSON.stringify({ title, body, count: fresh.length, ids: fresh }));
        if (navigator.vibrate) navigator.vibrate([180, 80, 180, 80, 320]);
        const badge = document.querySelector('[data-tab="orders"]');
        if (badge && tab !== 'orders') badge.textContent = `充值(${inbox.pendingCount})`;
      }
      lastNotifyIds = ids;
      localStorage.setItem('relay_admin_notify_ids', JSON.stringify(ids));
    }
    if (tab === 'home' || tab === 'orders') render(inbox);
  } catch (err) {
    if (String(err.message).includes('未登录') || String(err.message).includes('需要管理员')) logout();
  }
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
          <div class="card"><small>渠道异常</small><b class="${down.length ? 'bad' : 'ok'}">${down.length}</b></div>
        </div>
        <p class="sub">诊断上次：${inbox.diagnostics?.at ? when(inbox.diagnostics.at) : '尚未运行'} · 失败 ${inbox.diagnostics?.summary?.failed ?? '-'}</p>
        <div class="row"><button class="primary" id="goOrders">去确认充值</button></div>
        ${inbox.paymentQr?.wechat?.expired || inbox.paymentQr?.alipay?.expired
          ? `<article class="item" style="margin-top:12px"><h3 class="bad">收款码已过期</h3><p class="sub">${esc([inbox.paymentQr?.wechat?.expired ? '微信' : '', inbox.paymentQr?.alipay?.expired ? '支付宝' : ''].filter(Boolean).join(' / '))} 需要按金额分别换图。</p><button class="primary" id="goQr">去替换收款码</button></article>`
          : ''}`;
      $('#goOrders').onclick = () => { tab = 'orders'; syncTabs(); render(); };
      $('#goQr')?.addEventListener('click', () => { tab = 'qr'; syncTabs(); render(); });
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
      const [site, pricing] = await Promise.all([
        api('/api/admin/site-settings'),
        api('/api/admin/pricing')
      ]);
      pane.innerHTML = `
        <label>站点公网地址<input id="pubUrl" value="${esc(site.publicBaseUrl || '')}" placeholder="https://你的域名"></label>
        <label>真实扣费倍率<input id="rate" type="number" min="0.01" max="10" step="0.01" value="${esc(pricing.multiplier)}"></label>
        <button class="primary" id="saveSet">保存后端设置</button>
        <p class="sub" id="setMsg"></p>
        <button class="ghost" id="editServer" type="button" style="width:100%;margin-top:12px">更换 APK 连接的网站地址</button>
        <p class="sub">渠道同步、聚合支付仍可在电脑后台处理。用户余额加减和封号已可在本页「用户」操作。</p>`;
      $('#saveSet').onclick = async () => {
        const msg = $('#setMsg');
        try {
          await api('/api/admin/site-settings', { method: 'PUT', body: JSON.stringify({ publicBaseUrl: $('#pubUrl').value.trim() }) });
          await api('/api/admin/pricing', { method: 'PUT', body: JSON.stringify({ multiplier: Number($('#rate').value) }) });
          msg.textContent = '已保存';
          msg.className = 'sub ok';
        } catch (err) {
          msg.textContent = err.message;
          msg.className = 'sub bad';
        }
      };
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
