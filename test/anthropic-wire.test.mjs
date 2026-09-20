import assert from 'node:assert/strict';
import {
  messagesEndpointFromChatUrl,
  normalizeAnthropicUsage,
  mergeAnthropicStreamUsage,
  anthropicStreamFinished,
  anthropicToChatPayload,
  chatToAnthropicPayload,
  anthropicMessageToChatCompletion,
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

const roundTrip = chatToAnthropicPayload(converted);
assert.equal(roundTrip.tools[0].name, 'read_local_file');
assert.equal(roundTrip.max_tokens, 64);
assert.ok(roundTrip.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'tool_use' && p.name === 'read_local_file')));
assert.ok(roundTrip.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'tool_result')));

const writeTools = chatToAnthropicPayload({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 32,
  tools: [{
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file',
      parameters: { type: 'object', properties: { path: { type: 'string' }, contents: { type: 'string' } }, required: ['path', 'contents'] }
    }
  }],
  messages: [{ role: 'user', content: '添加文件 notes.txt' }]
});
assert.equal(writeTools.tools[0].name, 'write_file');
assert.equal(writeTools.messages[0].content, '添加文件 notes.txt');

const fromAnth = anthropicMessageToChatCompletion({
  id: 'msg_1',
  model: 'claude-haiku-4-5-20251001',
  content: [{ type: 'tool_use', id: 'toolu_w', name: 'write_file', input: { path: 'notes.txt', contents: 'hi' } }],
  stop_reason: 'tool_use',
  usage: { input_tokens: 9, output_tokens: 4, actual_cost: 0.001 }
}, 'claude-haiku-4-5-20251001');
assert.equal(fromAnth.choices[0].finish_reason, 'tool_calls');
assert.equal(fromAnth.choices[0].message.tool_calls[0].function.name, 'write_file');
assert.equal(fromAnth.usage.actual_cost, 0.001);

console.log('anthropic-wire.test.mjs: all assertions passed');
