/**
 * Anthropic Messages wire helpers for Claude Code.
 * Native /v1/messages passthrough keeps tools; conversion is fallback only.
 */

export function messagesEndpointFromChatUrl(url) {
  const raw = String(url || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  if (/\/messages$/i.test(raw)) return raw;
  if (/\/chat\/completions$/i.test(raw)) return raw.replace(/\/chat\/completions$/i, '/messages');
  if (/\/responses$/i.test(raw)) return raw.replace(/\/responses$/i, '/messages');
  if (/\/v1$/i.test(raw)) return `${raw}/messages`;
  const v1 = raw.indexOf('/v1/');
  if (v1 >= 0) return `${raw.slice(0, v1 + 3)}/messages`;
  return `${raw}/messages`;
}

export function normalizeAnthropicUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }
  const prompt = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
  const completion = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
  const cached = Number(usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? 0) || 0;
  const cacheCreation = Number(usage.cache_creation_input_tokens ?? usage.cache_creation_tokens ?? 0) || 0;
  const out = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(usage.total_tokens) || (prompt + completion),
    input_tokens: prompt,
    output_tokens: completion,
    cache_read_tokens: cached,
    cached_tokens: cached,
    cache_creation_tokens: cacheCreation
  };
  if (cached > 0) {
    out.prompt_tokens_details = { cached_tokens: cached };
  }
  for (const k of ['actual_cost', 'actualCost', 'total_cost', 'totalCost', 'cost']) {
    if (usage[k] != null) out[k] = usage[k];
  }
  return out;
}

export function mergeAnthropicStreamUsage(current, parsed) {
  const next = current && typeof current === 'object' ? { ...current } : {};
  const u = parsed?.usage || parsed?.message?.usage;
  if (!u || typeof u !== 'object') return next;
  for (const k of [
    'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens',
    'actual_cost', 'total_cost', 'cost'
  ]) {
    if (u[k] != null) next[k] = u[k];
  }
  return next;
}

export function anthropicStreamFinished(parsed, dataLine) {
  if (dataLine === '[DONE]') return true;
  const t = parsed && parsed.type;
  return t === 'message_stop' || t === 'error';
}

function partText(part) {
  if (part == null) return '';
  if (typeof part === 'string') return part;
  if (typeof part !== 'object') return '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string') return part.content;
  return '';
}

export function anthropicContentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return partText(content);
  return content.map(partText).join('');
}

function toolResultText(part) {
  if (!part || typeof part !== 'object') return '';
  if (typeof part.content === 'string') return part.content;
  if (Array.isArray(part.content)) return anthropicContentToText(part.content);
  if (part.content != null) {
    try { return JSON.stringify(part.content); } catch { return String(part.content); }
  }
  return anthropicContentToText(part);
}

/** Map Claude Code / Anthropic body onto OpenAI chat (lossy fallback). Keeps tools. */
export function anthropicToChatPayload(raw) {
  const messages = [];
  if (raw && raw.system != null) {
    const sys = anthropicContentToText(raw.system);
    if (sys) messages.push({ role: 'system', content: sys });
  }
  const src = Array.isArray(raw && raw.messages) ? raw.messages : [];
  for (const m of src) {
    if (!m || typeof m !== 'object') continue;
    const content = m.content;
    if (typeof content === 'string') {
      const role = m.role === 'assistant' ? 'assistant' : (m.role === 'system' ? 'system' : 'user');
      if (content) messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) {
      const text = anthropicContentToText(content);
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      if (text) messages.push({ role, content: text });
      continue;
    }
    const toolUses = content.filter((p) => p && p.type === 'tool_use');
    const toolResults = content.filter((p) => p && p.type === 'tool_result');
    const texts = content.filter((p) => !p || (p.type !== 'tool_use' && p.type !== 'tool_result'));
    const text = anthropicContentToText(texts);
    if (toolUses.length) {
      const msg = {
        role: 'assistant',
        content: text || null,
        tool_calls: toolUses.map((tu) => ({
          id: tu.id || tu.tool_use_id || `tool_${Math.random().toString(36).slice(2, 10)}`,
          type: 'function',
          function: {
            name: tu.name || 'tool',
            arguments: JSON.stringify(tu.input != null ? tu.input : {})
          }
        }))
      };
      messages.push(msg);
    } else if (text) {
      const role = m.role === 'assistant' ? 'assistant' : (m.role === 'system' ? 'system' : 'user');
      messages.push({ role, content: text });
    }
    for (const tr of toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: tr.tool_use_id || tr.id || '',
        content: toolResultText(tr)
      });
    }
  }
  const payload = {
    model: raw && raw.model,
    messages,
    stream: raw && raw.stream === true
  };
  if (raw && raw.temperature !== undefined) payload.temperature = raw.temperature;
  if (raw && raw.max_tokens != null) payload.max_tokens = raw.max_tokens;
  if (Array.isArray(raw && raw.tools) && raw.tools.length) {
    payload.tools = raw.tools.map((t) => {
      if (t && t.type === 'function' && t.function) return t;
      return {
        type: 'function',
        function: {
          name: t?.name || 'tool',
          description: t?.description || '',
          parameters: t?.input_schema || t?.parameters || { type: 'object', properties: {} }
        }
      };
    });
    if (raw.tool_choice != null) payload.tool_choice = raw.tool_choice === 'any' ? 'required' : raw.tool_choice;
  }
  return payload;
}

function parseToolArguments(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return { raw: String(raw) };
  try { return JSON.parse(raw); } catch { return { raw }; }
}

function openaiToolToAnthropic(tool) {
  if (!tool || typeof tool !== 'object') return null;
  if (tool.type === 'function' && tool.function) {
    return {
      name: tool.function.name || 'tool',
      description: tool.function.description || '',
      input_schema: tool.function.parameters || tool.function.input_schema || { type: 'object', properties: {} }
    };
  }
  if (tool.name) {
    return {
      name: tool.name,
      description: tool.description || '',
      input_schema: tool.input_schema || tool.parameters || { type: 'object', properties: {} }
    };
  }
  return null;
}

/** Map OpenAI chat body onto Anthropic /v1/messages (keeps tools / tool_use). */
export function chatToAnthropicPayload(raw) {
  const src = Array.isArray(raw && raw.messages) ? raw.messages : [];
  const systemParts = [];
  const messages = [];
  for (const m of src) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role;
    if (role === 'system') {
      const sys = anthropicContentToText(m.content);
      if (sys) systemParts.push(sys);
      continue;
    }
    if (role === 'tool') {
      const last = messages[messages.length - 1];
      const block = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id || m.id || '',
        content: toolResultText({ content: m.content })
      };
      if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else messages.push({ role: 'user', content: [block] });
      continue;
    }
    const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    if (role === 'assistant' && toolCalls.length) {
      const content = [];
      const text = anthropicContentToText(m.content);
      if (text) content.push({ type: 'text', text });
      for (const tc of toolCalls) {
        const fn = tc && tc.function ? tc.function : {};
        content.push({
          type: 'tool_use',
          id: tc.id || tc.tool_use_id || `toolu_${Math.random().toString(36).slice(2, 10)}`,
          name: fn.name || tc.name || 'tool',
          input: parseToolArguments(fn.arguments)
        });
      }
      messages.push({ role: 'assistant', content });
      continue;
    }
    const text = anthropicContentToText(m.content);
    const mappedRole = role === 'assistant' ? 'assistant' : 'user';
    if (Array.isArray(m.content)) {
      const parts = [];
      for (const part of m.content) {
        if (part == null) continue;
        if (typeof part === 'string') {
          if (part) parts.push({ type: 'text', text: part });
          continue;
        }
        if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
          const t = partText(part);
          if (t) parts.push({ type: 'text', text: t });
          continue;
        }
        if (part.type === 'image_url' || part.type === 'image' || part.type === 'input_image') {
          const url = part.image_url?.url || part.url || part.source?.data || '';
          const media = String(url).match(/^data:([^;]+);base64,(.+)$/);
          if (media) {
            parts.push({
              type: 'image',
              source: { type: 'base64', media_type: media[1], data: media[2] }
            });
          } else if (url) {
            parts.push({ type: 'text', text: `[image ${url}]` });
          }
          continue;
        }
        const t = partText(part);
        if (t) parts.push({ type: 'text', text: t });
      }
      if (parts.length) messages.push({ role: mappedRole, content: parts });
      else if (text) messages.push({ role: mappedRole, content: text });
      continue;
    }
    if (text) messages.push({ role: mappedRole, content: text });
  }
  const payload = {
    model: raw && raw.model,
    messages,
    max_tokens: Math.max(1, Number(raw && (raw.max_tokens ?? raw.max_output_tokens)) || 1024),
    stream: raw && raw.stream === true
  };
  if (systemParts.length) payload.system = systemParts.join('\n');
  if (raw && raw.temperature !== undefined) payload.temperature = raw.temperature;
  if (Array.isArray(raw && raw.tools) && raw.tools.length) {
    payload.tools = raw.tools.map(openaiToolToAnthropic).filter(Boolean);
    if (raw.tool_choice != null) {
      payload.tool_choice = raw.tool_choice === 'required' ? 'any' : raw.tool_choice;
    }
  }
  return payload;
}

export function anthropicMessageToChatCompletion(result, model = '') {
  const content = Array.isArray(result && result.content) ? result.content : [];
  const texts = content.filter((p) => !p || p.type === 'text' || p.type === 'output_text');
  const toolUses = content.filter((p) => p && p.type === 'tool_use');
  const text = anthropicContentToText(texts);
  const message = { role: 'assistant', content: text || (toolUses.length ? null : '') };
  if (toolUses.length) {
    message.tool_calls = toolUses.map((tu) => ({
      id: tu.id || tu.tool_use_id || `call_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function',
      function: {
        name: tu.name || 'tool',
        arguments: JSON.stringify(tu.input != null ? tu.input : {})
      }
    }));
  }
  const usage = (result && result.usage) || {};
  const prompt = Number(usage.input_tokens ?? usage.prompt_tokens) || 0;
  const completion = Number(usage.output_tokens ?? usage.completion_tokens) || 0;
  const stop = result && result.stop_reason;
  const finish = toolUses.length || stop === 'tool_use'
    ? 'tool_calls'
    : (stop === 'max_tokens' ? 'length' : 'stop');
  const out = {
    id: (result && result.id) ? String(result.id).replace(/^msg[-_]?/i, 'chatcmpl-') : 'chatcmpl-anth',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: (result && result.model) || model || '',
    choices: [{
      index: 0,
      message,
      finish_reason: finish
    }],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: Number(usage.total_tokens) || (prompt + completion),
      input_tokens: prompt,
      output_tokens: completion
    }
  };
  for (const k of ['actual_cost', 'actualCost', 'total_cost', 'totalCost', 'cost']) {
    if (usage[k] != null) out.usage[k] = usage[k];
  }
  return out;
}

export function chatCompletionToAnthropic(result, makeId) {
  const newId = typeof makeId === 'function' ? makeId : (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
  const choice = result && result.choices && result.choices[0];
  const message = choice && choice.message ? choice.message : null;
  const text = anthropicContentToText(message ? message.content : '');
  const usage = (result && result.usage) || {};
  const toolCalls = Array.isArray(message && message.tool_calls) ? message.tool_calls : [];
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const tc of toolCalls) {
    const fn = tc && tc.function ? tc.function : {};
    let input = {};
    if (fn.arguments != null) {
      if (typeof fn.arguments === 'string') {
        try { input = JSON.parse(fn.arguments); } catch { input = { raw: fn.arguments }; }
      } else if (typeof fn.arguments === 'object') input = fn.arguments;
    }
    content.push({
      type: 'tool_use',
      id: tc.id || newId('toolu'),
      name: fn.name || tc.name || 'tool',
      input
    });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  const finish = choice && choice.finish_reason;
  const stop = toolCalls.length || finish === 'tool_calls'
    ? 'tool_use'
    : (finish === 'length' ? 'max_tokens' : 'end_turn');
  return {
    id: (result && result.id) ? String(result.id).replace(/^chatcmpl[-_]?/i, 'msg_') : newId('msg'),
    type: 'message',
    role: 'assistant',
    model: (result && result.model) || '',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens) || 0,
      output_tokens: Number(usage.completion_tokens) || 0
    }
  };
}
