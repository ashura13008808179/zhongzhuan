import assert from 'node:assert/strict';
import {
  messagesEndpointFromChatUrl,
  normalizeAnthropicUsage,
  mergeAnthropicStreamUsage,
  anthropicStreamFinished,
  anthropicToChatPayload,
  chatCompletionToAnthropic
} from '../lib/anthropic-wire.js';

assert.equal(
  messagesEndpointFromChatUrl('https://sub.beibeihai.xyz/v1/chat/completions'),
  'https://sub.beibeihai.xyz/v1/messages'
);
assert.equal(
  messagesEndpointFromChatUrl('https://api.vip1129.cc/v1/chat/completions'),
  'https://api.vip1129.cc/v1/messages'
);

const usage = normalizeAnthropicUsage({
  input_tokens: 10,
  output_tokens: 4,
  cache_read_input_tokens: 3
});
assert.equal(usage.prompt_tokens, 10);
assert.equal(usage.completion_tokens, 4);
assert.equal(usage.cache_read_tokens, 3);

const merged = mergeAnthropicStreamUsage(
  { input_tokens: 10 },
  { type: 'message_delta', usage: { output_tokens: 7 } }
);
assert.equal(merged.input_tokens, 10);
assert.equal(merged.output_tokens, 7);
assert.equal(anthropicStreamFinished({ type: 'message_stop' }), true);
assert.equal(anthropicStreamFinished({ type: 'content_block_delta' }), false);

const converted = anthropicToChatPayload({
  model: 'claude-fable-5',
  max_tokens: 64,
  tools: [{
    name: 'read_local_file',
    description: 'Read a file',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }],
  messages: [
    { role: 'user', content: 'Read probe-in.txt' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_local_file', input: { path: 'probe-in.txt' } }]
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'AGENT_IO_OK_915' }]
    }
  ]
});
assert.equal(converted.tools[0].function.name, 'read_local_file');
assert.equal(converted.messages.some(m => m.tool_calls && m.tool_calls[0].function.name === 'read_local_file'), true);
assert.equal(converted.messages.some(m => m.role === 'tool' && m.content.includes('AGENT_IO_OK_915')), true);

const anth = chatCompletionToAnthropic({
  id: 'chatcmpl-x',
  model: 'claude-fable-5',
  choices: [{
    finish_reason: 'tool_calls',
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'read_local_file', arguments: '{"path":"probe-in.txt"}' }
      }]
    }
  }],
  usage: { prompt_tokens: 8, completion_tokens: 2 }
}, (p) => `${p}_x`);
assert.equal(anth.stop_reason, 'tool_use');
assert.equal(anth.content[0].type, 'tool_use');
assert.equal(anth.content[0].name, 'read_local_file');
assert.equal(anth.content[0].input.path, 'probe-in.txt');

console.log('anthropic-wire.test.mjs: all assertions passed');
