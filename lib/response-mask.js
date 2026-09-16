const CHAT_CHOICE_KEYS = new Set(['index', 'message', 'delta', 'finish_reason', 'logprobs']);
const MESSAGE_KEYS = new Set(['role', 'content', 'name', 'tool_calls', 'tool_call_id', 'refusal']);
const UPSTREAM_MARK = /beibeihai|vip1129|sub\.beibeihai|one-api|new-api|just-api|siliconflow|relay-station|上游/i;

export function sanitizeChatCompletion(raw, model) {
  if (!raw || typeof raw !== 'object') return raw;
  if (raw.error) {
    return {
      error: {
        message: '模型服务暂时不可用，请稍后重试',
        type: 'server_error',
        code: null
      }
    };
  }
  const out = {
    id: typeof raw.id === 'string' ? raw.id : undefined,
    object: raw.object || 'chat.completion',
    created: Number.isFinite(Number(raw.created)) ? Number(raw.created) : Math.floor(Date.now() / 1000),
    model: model || raw.model,
    choices: Array.isArray(raw.choices) ? raw.choices.map(sanitizeChoice) : []
  };
  if (raw.usage && typeof raw.usage === 'object') {
    out.usage = {
      prompt_tokens: Number(raw.usage.prompt_tokens) || 0,
      completion_tokens: Number(raw.usage.completion_tokens) || 0,
      total_tokens: Number(raw.usage.total_tokens) || 0
    };
    if (raw.usage.prompt_tokens_details) out.usage.prompt_tokens_details = raw.usage.prompt_tokens_details;
    if (raw.usage.completion_tokens_details) out.usage.completion_tokens_details = raw.usage.completion_tokens_details;
  }
  return out;
}

export function sanitizeChatChunk(raw, model) {
  if (!raw || typeof raw !== 'object') return raw;
  if (raw.error) {
    return { error: { message: '模型服务暂时不可用，请稍后重试', type: 'server_error', code: null } };
  }
  const out = {
    id: typeof raw.id === 'string' ? raw.id : undefined,
    object: raw.object || 'chat.completion.chunk',
    created: Number.isFinite(Number(raw.created)) ? Number(raw.created) : Math.floor(Date.now() / 1000),
    model: model || raw.model,
    choices: Array.isArray(raw.choices) ? raw.choices.map(sanitizeChoice) : []
  };
  if (raw.usage && typeof raw.usage === 'object') {
    out.usage = {
      prompt_tokens: Number(raw.usage.prompt_tokens) || 0,
      completion_tokens: Number(raw.usage.completion_tokens) || 0,
      total_tokens: Number(raw.usage.total_tokens) || 0
    };
  }
  return out;
}

function sanitizeChoice(choice) {
  if (!choice || typeof choice !== 'object') return choice;
  const out = {};
  for (const key of CHAT_CHOICE_KEYS) {
    if (!(key in choice)) continue;
    if (key === 'message') out.message = sanitizeMessage(choice.message);
    else if (key === 'delta') out.delta = sanitizeMessage(choice.delta);
    else out[key] = choice[key];
  }
  return out;
}

function sanitizeMessage(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  const out = {};
  for (const key of MESSAGE_KEYS) {
    if (key in msg) out[key] = msg[key];
  }
  return out;
}

export function sanitizeSseDataLine(line, model) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('data:')) return null;
  const data = trimmed.slice(5).trim();
  if (!data) return null;
  if (data === '[DONE]') return 'data: [DONE]\n\n';
  try {
    const parsed = JSON.parse(data);
    return `data: ${JSON.stringify(sanitizeChatChunk(parsed, model))}\n\n`;
  } catch {
    return null;
  }
}

export function publicErrorMessage(raw, fallback = '服务暂时不可用，请稍后重试') {
  const text = String(raw || '');
  if (!text || UPSTREAM_MARK.test(text)) return fallback;
  return text.slice(0, 180);
}
