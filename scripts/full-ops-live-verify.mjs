/**
 * Live ops sweep against the relay: chat, concurrency, files, code edits, reasoning.
 * Never prints secrets. Writes scripts/full-ops-live-verify-result.json.
 *
 * RELAY_BASE defaults to production. Override to hit local:
 *   $env:RELAY_BASE="http://127.0.0.1:8787"; node scripts/full-ops-live-verify.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnvFile(path.join(root, '.env'));
const ps1 = path.join(root, 'start-local.ps1');
if (fs.existsSync(ps1)) {
  const txt = fs.readFileSync(ps1, 'utf8');
  for (const m of txt.matchAll(/\$env:(\w+)\s*=\s*"([^"]*)"/g)) {
    if (!process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const base = process.env.RELAY_BASE || 'http://47.114.44.213:8787';
const outPath = path.join(root, 'scripts', 'full-ops-live-verify-result.json');
const PLAY_LOGIN = 'play58819005';
const PLAY_PASS = 'PlayTest1234!';
const CHAT_TIMEOUT_MS = 180000;
const CONCUR = 8;

function clip(v, n = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').slice(0, n);
}

async function adminSession() {
  const step1 = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  if (step1.status === 200 && step1.body?.token) {
    return { ok: true, token: step1.body.token, via: 'password' };
  }
  if (step1.status === 200 && step1.body?.needPhone && step1.body?.ticket) {
    const phone = String(process.env.ADMIN_PHONE || '').trim();
    if (!phone) return { ok: false, status: step1.status, error: 'need_phone_but_ADMIN_PHONE_missing' };
    const step2 = await req('/api/auth/login/phone', {
      method: 'POST',
      body: JSON.stringify({ ticket: step1.body.ticket, phone })
    });
    if (step2.status === 200 && step2.body?.token) {
      return { ok: true, token: step2.body.token, via: 'phone' };
    }
    return { ok: false, status: step2.status, error: clip(step2.body?.error || 'phone_login_failed') };
  }
  return { ok: false, status: step1.status, error: clip(step1.body?.error || 'login_failed') };
}

async function req(pathname, opts = {}) {
  const headers = { ...(opts.json === false ? {} : { 'Content-Type': 'application/json' }), ...(opts.headers || {}) };
  const res = await fetch(`${base}${pathname}`, {
    ...opts,
    headers,
    signal: opts.signal || AbortSignal.timeout(opts.timeoutMs || 30000)
  });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: clip(text, 280) }; }
  return { status: res.status, ok: res.ok, body, text };
}

const features = [];
const calls = [];
function feat(name, ok, detail) {
  const row = { name, ok: !!ok, detail: clip(detail, 400) };
  features.push(row);
  console.log(`${row.ok ? 'PASS' : 'FAIL'} ${name}${row.detail ? ' · ' + row.detail : ''}`);
  return row.ok;
}

function pickModel(p) {
  const models = [...new Set([p.defaultModel, ...(p.models || [])].filter(Boolean).map(String))];
  const skip = /composer-2\.5|cursor-small/i;
  const prefer = [
    /gpt-5\.6-terra/i,
    /gpt-5\.6/i,
    /gpt-5/i,
    /grok-4\.6/i,
    /claude-sonnet-4-5/i,
    /claude-sonnet-4/i,
    /claude-fable/i,
    /deepseek-chat/i,
    /gemini-2\.5-flash/i,
    /kimi-k2/i,
    /glm-5/i
  ];
  for (const re of prefer) {
    const hit = models.find((m) => re.test(m) && !skip.test(m));
    if (hit) return hit;
  }
  return models.find((m) => !skip.test(m)) || models[0] || '';
}

function pickThinkingModel(p) {
  const models = [...new Set([p.defaultModel, ...(p.models || [])].filter(Boolean).map(String))];
  const hit = models.find((m) => /gpt-5|o3|o4|grok-4|sonnet-4-5|opus/i.test(m) && !/composer-2\.5/i.test(m));
  return hit || pickModel(p);
}

function isVip(p) {
  return p?.upstreamSync === 'vip1129' || /vip1129/i.test(String(p?.url || ''));
}

async function chat(key, model, extra = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: extra.messages || [{ role: 'user', content: extra.prompt || '只回复一个字：好' }],
        max_tokens: extra.max_tokens ?? 16,
        temperature: extra.temperature ?? 0,
        stream: extra.stream === true,
        ...(extra.tools ? { tools: extra.tools, tool_choice: extra.tool_choice || 'auto' } : {}),
        ...(extra.reasoning_effort ? { reasoning_effort: extra.reasoning_effort } : {})
      }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS)
    });
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: clip(text) }; }
    const msg = body?.choices?.[0]?.message || {};
    return {
      ok: res.ok,
      status: res.status,
      ms: Date.now() - t0,
      err: res.ok ? null : clip(body.error?.message || body.error || text),
      content: clip(msg.content || body.output_text || '', 180),
      toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls.length : 0,
      finish: msg.finish_reason || body.choices?.[0]?.finish_reason || null,
      usage: body.usage || null,
      streamed: extra.stream === true && /data:/.test(text)
    };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, err: clip(e.message || e), content: '', toolCalls: 0, finish: null, usage: null, streamed: false };
  }
}

async function responses(key, model, extra = {}) {
  const t0 = Date.now();
  try {
    const payload = {
      model,
      input: extra.input || extra.prompt || '只回复一个字：好',
      store: false,
      max_output_tokens: extra.max_output_tokens ?? 400,
      ...(extra.tools ? { tools: extra.tools } : {}),
      ...(extra.reasoning ? { reasoning: extra.reasoning } : {})
    };
    const res = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS)
    });
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: clip(text) }; }
    const outText = typeof body.output_text === 'string'
      ? body.output_text
      : JSON.stringify(body.output || body.choices || body).slice(0, 180);
    return {
      ok: res.ok,
      status: res.status,
      ms: Date.now() - t0,
      err: res.ok ? null : clip(body.error?.message || body.error || text),
      content: clip(outText, 180),
      usage: body.usage || null
    };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, err: clip(e.message || e), content: '', usage: null };
  }
}

async function messagesApi(key, model, extra = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: extra.max_tokens ?? 64,
        messages: extra.messages || [{ role: 'user', content: extra.prompt || '只回复一个字：好' }]
      }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS)
    });
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: clip(text) }; }
    const content = Array.isArray(body.content)
      ? body.content.map((c) => c.text || '').join('')
      : (body.content || '');
    return {
      ok: res.ok,
      status: res.status,
      ms: Date.now() - t0,
      err: res.ok ? null : clip(body.error?.message || body.error || text),
      content: clip(content, 180)
    };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, err: clip(e.message || e), content: '' };
  }
}

async function uploadFile(key, bytes, filename, purpose = 'assistants') {
  const t0 = Date.now();
  try {
    const form = new FormData();
    form.append('purpose', purpose);
    form.append('file', new Blob([bytes]), filename);
    const res = await fetch(`${base}/v1/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(180000)
    });
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: clip(text) }; }
    return {
      ok: res.ok,
      status: res.status,
      ms: Date.now() - t0,
      bytes: bytes.length,
      id: body.id || null,
      err: res.ok ? null : clip(body.error?.message || body.error || text)
    };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, bytes: bytes.length, id: null, err: clip(e.message || e) };
  }
}

function noteCall(row) {
  calls.push(row);
  console.log(`${row.ok ? 'OK' : 'FAIL'} ${row.kind} ${row.group || ''} ${row.model || ''} ${row.status} ${row.ms}ms ${row.err || ''}`);
}

const started = Date.now();
console.log(`ops-live-verify base=${base}`);

const home = await fetch(base + '/', { signal: AbortSignal.timeout(15000) });
feat('首页', home.status === 200, home.status);
const adminLogin = await adminSession();
feat('admin 登录', adminLogin.ok, adminLogin.ok ? adminLogin.via : `${adminLogin.status} ${adminLogin.error || ''}`);
if (!adminLogin.ok) {
  fs.writeFileSync(outPath, JSON.stringify({ ok: false, base, features, error: 'admin_login_failed' }, null, 2));
  process.exit(1);
}
const adminTok = { Authorization: 'Bearer ' + adminLogin.token };

const playLogin = await req('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ login: PLAY_LOGIN, password: PLAY_PASS })
});
feat('play 登录', playLogin.status === 200, playLogin.status);
const playTok = playLogin.status === 200 ? { Authorization: 'Bearer ' + playLogin.body.token } : null;

const cfg = await req('/api/config');
feat('公开配置', cfg.status === 200, cfg.body.recommendedModel);
const adminApp = await fetch(base + '/admin-app/', { signal: AbortSignal.timeout(15000) });
feat('值班台', adminApp.status === 200, adminApp.status);
const pricing = await req('/api/admin/pricing', { headers: adminTok });
feat('后台渠道', pricing.status === 200, `n=${(pricing.body.providers || []).length}`);
const pool0 = await req('/api/admin/code-pool', { headers: adminTok });
feat('今日财务', pool0.status === 200, `invert=${pool0.body.invertedCount || 0} charged=${pool0.body.chargedToday}`);
const alerts = await req('/api/admin/billing-alerts', { headers: adminTok });
feat('倒挂预警接口', alerts.status === 200, `open=${alerts.body.openCount || 0}`);

const providers = (pricing.body.providers || []).filter((p) => p.enabled !== false && !p.maintenance && p.id !== 'grp_cursor_pool');
feat('启用渠道数', providers.length > 0, providers.map((p) => p.id).join(','));

async function ensureGroupKeys(tok) {
  const listed = await req('/api/keys', { headers: tok });
  const raw = listed.body.keys || listed.body || [];
  const keys = Array.isArray(raw) ? raw : [];
  feat('读取密钥列表', listed.status === 200 && Array.isArray(raw), `${listed.status} n=${keys.length}`);
  const byGroup = new Map();
  for (const k of keys) {
    if (!k.groupId || k.enabled === false || !k.key) continue;
    if (!byGroup.has(k.groupId)) byGroup.set(k.groupId, []);
    byGroup.get(k.groupId).push(k);
  }
  for (const g of providers) {
    if ((byGroup.get(g.id) || []).length) continue;
    const created = await req('/api/keys', {
      method: 'POST',
      headers: tok,
      body: JSON.stringify({ name: `ops-${g.id}`, groupId: g.id }),
      timeoutMs: 60000
    });
    feat(`创建密钥 ${g.name || g.id}`, created.status === 200 || created.status === 201, created.status + ' ' + clip(created.body?.error || ''));
    const rec = created.body?.key || created.body;
    if (rec?.key) {
      if (!byGroup.has(g.id)) byGroup.set(g.id, []);
      byGroup.get(g.id).push(rec);
    }
  }
  return byGroup;
}

const adminKeys = await ensureGroupKeys(adminTok);
let playKeys = new Map();
if (playTok) playKeys = await ensureGroupKeys(playTok);

const gptGroup = providers.find((p) => isVip(p) && /gpt/i.test(p.id + p.name))
  || providers.find((p) => isVip(p));
const claudeGroup = providers.find((p) => /cc-max|claude|kiro/i.test(p.id + p.name));
const grokGroup = providers.find((p) => /grok/i.test(p.id + p.name));

for (const g of providers) {
  const rec = (adminKeys.get(g.id) || [])[0];
  const model = pickModel(g);
  if (!rec?.key || !model) {
    noteCall({ kind: 'chat-seq', group: g.id, model, ok: false, status: 0, ms: 0, err: 'no key/model' });
    feat(`对话 ${g.name}`, false, '无密钥或模型');
    continue;
  }
  const r = await chat(rec.key, model);
  noteCall({ kind: 'chat-seq', group: g.id, model, ok: r.ok, status: r.status, ms: r.ms, err: r.err });
  feat(`对话 ${g.name} (${model})`, r.ok, r.ok ? `${r.ms}ms ${r.content}` : r.err);
}

if (gptGroup) {
  const rec = (adminKeys.get(gptGroup.id) || [])[0];
  const model = pickModel(gptGroup);
  if (rec?.key && model) {
    const jobs = Array.from({ length: CONCUR }, (_, i) => chat(rec.key, model, {
      prompt: `并发探测 ${i + 1}，只回复数字 ${i + 1}`
    }).then((r) => {
      noteCall({ kind: 'chat-conc', group: gptGroup.id, model, i, ok: r.ok, status: r.status, ms: r.ms, err: r.err });
      return r;
    }));
    const t0 = Date.now();
    const rs = await Promise.all(jobs);
    const okN = rs.filter((r) => r.ok).length;
    feat(`同密钥 ${CONCUR} 并发 ${gptGroup.name}`, okN === CONCUR, `${okN}/${CONCUR} 成功 · ${Date.now() - t0}ms`);
  }
}

{
  const wave = [];
  for (const g of providers) {
    const rec = (adminKeys.get(g.id) || [])[0];
    const model = pickModel(g);
    if (!rec?.key || !model) continue;
    wave.push(chat(rec.key, model).then((r) => {
      noteCall({ kind: 'chat-wave', group: g.id, model, ok: r.ok, status: r.status, ms: r.ms, err: r.err });
      return { group: g.id, ...r };
    }));
  }
  const t0 = Date.now();
  const rs = await Promise.all(wave);
  const okN = rs.filter((r) => r.ok).length;
  feat(`全渠道同时各打 1 次`, okN === rs.length && rs.length > 0, `${okN}/${rs.length} · ${Date.now() - t0}ms`);
}

if (playTok && gptGroup) {
  const rec = (playKeys.get(gptGroup.id) || [])[0];
  const model = pickModel(gptGroup);
  if (rec?.key && model) {
    const r = await chat(rec.key, model);
    noteCall({ kind: 'chat-play', group: gptGroup.id, model, ok: r.ok, status: r.status, ms: r.ms, err: r.err });
    feat('普通用户对话扣费路径', r.ok, r.ok ? `${r.ms}ms` : r.err);
  } else {
    feat('普通用户对话扣费路径', false, 'play 无该组密钥');
  }
}

if (gptGroup) {
  const rec = (adminKeys.get(gptGroup.id) || [])[0];
  const model = pickModel(gptGroup);
  if (rec?.key) {
    const tiny = await uploadFile(rec.key, Buffer.from('hello relay file probe\n'), 'probe.txt');
    feat('上传小文件 /v1/files', tiny.ok, tiny.ok ? `${tiny.bytes}B id=${tiny.id}` : tiny.err);
    noteCall({ kind: 'file-small', group: gptGroup.id, ok: tiny.ok, status: tiny.status, ms: tiny.ms, err: tiny.err });

    const mid = await uploadFile(rec.key, Buffer.alloc(3 * 1024 * 1024, 97), 'mid-3mb.bin');
    feat('上传 3MB 文件', mid.ok, mid.ok ? `id=${mid.id} ${mid.ms}ms` : mid.err);
    noteCall({ kind: 'file-3mb', group: gptGroup.id, ok: mid.ok, status: mid.status, ms: mid.ms, err: mid.err });

    const big = await uploadFile(rec.key, Buffer.alloc(18 * 1024 * 1024, 98), 'big-18mb.bin');
    feat('上传 18MB 文件（原 256KB 会 413）', big.ok, big.ok ? `id=${big.id} ${big.ms}ms` : big.err);
    noteCall({ kind: 'file-18mb', group: gptGroup.id, ok: big.ok, status: big.status, ms: big.ms, err: big.err });

    if (tiny.ok && tiny.id) {
      const got = await fetch(`${base}/v1/files/${tiny.id}`, {
        headers: { Authorization: `Bearer ${rec.key}` },
        signal: AbortSignal.timeout(30000)
      });
      feat('读取已上传文件元数据', got.status === 200, got.status);
    }

    const addFile = await chat(rec.key, model, {
      max_tokens: 400,
      prompt: [
        '你是编码助手。请完成：1) 新增文件 src/hello.py，内容 print("ok")；',
        '2) 说明你会怎么添加这个文件。不要道歉，直接给文件路径和完整内容。'
      ].join('')
    });
    noteCall({ kind: 'ops-add-file', group: gptGroup.id, model, ok: addFile.ok, status: addFile.status, ms: addFile.ms, err: addFile.err });
    feat('对话：添加文件', addFile.ok && /hello\.py|print/i.test(addFile.content), addFile.ok ? addFile.content : addFile.err);

    const editFile = await chat(rec.key, model, {
      max_tokens: 400,
      prompt: [
        '现有文件 src/hello.py 内容是 print("ok")。',
        '请修改它：加上一行模块注释，并把 print 改成打印 hello。',
        '给出修改后的完整文件。'
      ].join('')
    });
    noteCall({ kind: 'ops-edit-file', group: gptGroup.id, model, ok: editFile.ok, status: editFile.status, ms: editFile.ms, err: editFile.err });
    feat('对话：修改文件', editFile.ok && /hello/i.test(editFile.content), editFile.ok ? editFile.content : editFile.err);

    const editCode = await chat(rec.key, model, {
      max_tokens: 500,
      prompt: [
        '下面这段 Python 有 bug，请修好并只输出修好后的代码：\n',
        'def avg(xs):\n    return sum(xs)/len(xs)\nprint(avg([]))\n'
      ].join('')
    });
    noteCall({ kind: 'ops-edit-code', group: gptGroup.id, model, ok: editCode.ok, status: editCode.status, ms: editCode.ms, err: editCode.err });
    feat('对话：修改代码', editCode.ok && /def avg/i.test(editCode.content), editCode.ok ? editCode.content : editCode.err);

    const tools = [{
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create or overwrite a text file in the workspace',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            contents: { type: 'string' }
          },
          required: ['path', 'contents']
        }
      }
    }];
    const toolRound = await chat(rec.key, model, {
      max_tokens: 400,
      tools,
      tool_choice: 'auto',
      prompt: '请调用 write_file 新建 src/added.py，内容是 print(1)。不要只口头说，必须发 tool call。'
    });
    noteCall({ kind: 'ops-tool-write', group: gptGroup.id, model, ok: toolRound.ok, status: toolRound.status, ms: toolRound.ms, err: toolRound.err, toolCalls: toolRound.toolCalls });
    feat('工具调用：添加文件', toolRound.ok && toolRound.toolCalls > 0, toolRound.ok ? `toolCalls=${toolRound.toolCalls} finish=${toolRound.finish}` : toolRound.err);

    const thinkModel = pickThinkingModel(gptGroup);
    const think = await chat(rec.key, thinkModel, {
      max_tokens: 600,
      reasoning_effort: 'medium',
      prompt: '深度思考：用两步推理判断 27*34 的个位数，只给个位数和一句理由。'
    });
    noteCall({ kind: 'ops-think-chat', group: gptGroup.id, model: thinkModel, ok: think.ok, status: think.status, ms: think.ms, err: think.err });
    feat('深度思考 chat', think.ok, think.ok ? `${think.ms}ms ${think.content}` : think.err);

    const respAdd = await responses(rec.key, model, {
      max_output_tokens: 500,
      input: '在仓库新增 README.probe.md，写一行 Hello Relay。给出路径和内容。'
    });
    noteCall({ kind: 'responses-add', group: gptGroup.id, model, ok: respAdd.ok, status: respAdd.status, ms: respAdd.ms, err: respAdd.err });
    feat('Codex /v1/responses 添加文件', respAdd.ok, respAdd.ok ? respAdd.content : respAdd.err);

    const respThink = await responses(rec.key, thinkModel, {
      max_output_tokens: 500,
      reasoning: { effort: 'medium' },
      input: '深度思考：比较插入排序和快排在 n=8 几乎有序数组上谁更合适，一句话结论。'
    });
    noteCall({ kind: 'responses-think', group: gptGroup.id, model: thinkModel, ok: respThink.ok, status: respThink.status, ms: respThink.ms, err: respThink.err });
    feat('Codex /v1/responses 深度思考', respThink.ok, respThink.ok ? respThink.content : respThink.err);

    const stream = await chat(rec.key, model, { stream: true, max_tokens: 32, prompt: '从 1 数到 5，空格分隔。' });
    noteCall({ kind: 'stream', group: gptGroup.id, model, ok: stream.ok || stream.streamed, status: stream.status, ms: stream.ms, err: stream.err });
    feat('流式对话', stream.ok || stream.streamed, stream.streamed ? `sse ${stream.ms}ms` : (stream.err || stream.status));
  }
}

if (claudeGroup) {
  const rec = (adminKeys.get(claudeGroup.id) || [])[0];
  const model = pickModel(claudeGroup);
  if (rec?.key && model) {
    const r = await messagesApi(rec.key, model, { prompt: '只回复一个字：好' });
    noteCall({ kind: 'anthropic-messages', group: claudeGroup.id, model, ok: r.ok, status: r.status, ms: r.ms, err: r.err });
    feat(`Anthropic /v1/messages ${claudeGroup.name}`, r.ok, r.ok ? r.content : r.err);
  }
}

if (grokGroup) {
  const rec = (adminKeys.get(grokGroup.id) || [])[0];
  const model = pickModel(grokGroup);
  if (rec?.key && model) {
    const r = await chat(rec.key, model, {
      max_tokens: 400,
      prompt: '深度思考：一句话说明 grok-4.6 适合什么任务。'
    });
    noteCall({ kind: 'grok-think', group: grokGroup.id, model, ok: r.ok, status: r.status, ms: r.ms, err: r.err });
    feat(`Grok 深度思考 (${model})`, r.ok, r.ok ? r.content : r.err);
  }
}

const pool1 = await req('/api/admin/code-pool', { headers: adminTok, timeoutMs: 20000 });
feat('测后财务可读', pool1.status === 200, `req=${pool1.body.requestCountToday} invert=${pool1.body.invertedCount || 0}`);

const failN = features.filter((f) => !f.ok).length;
const passN = features.filter((f) => f.ok).length;
const out = {
  ok: failN === 0,
  base,
  ms: Date.now() - started,
  at: new Date().toISOString(),
  summary: { pass: passN, fail: failN, calls: calls.length, callOk: calls.filter((c) => c.ok).length },
  finance: {
    invertedCount: pool1.body?.invertedCount || 0,
    invertedLossToday: pool1.body?.invertedLossToday || 0,
    chargedToday: pool1.body?.chargedToday,
    upstreamCostToday: pool1.body?.upstreamCostToday,
    requestCountToday: pool1.body?.requestCountToday
  },
  features,
  calls: calls.map((c) => ({ ...c, err: c.err ? clip(c.err, 180) : null }))
};
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`DONE pass=${passN} fail=${failN} calls=${calls.length} ms=${out.ms} file=${outPath}`);
process.exit(failN ? 2 : 0);
