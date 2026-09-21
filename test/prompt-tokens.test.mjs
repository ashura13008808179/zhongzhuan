import assert from 'node:assert/strict';
import { estimatePromptTokens, PROMPT_TOKEN_HOLD_CAP } from '../lib/prompt-tokens.js';
import { parseRelayBodyLimit } from '../lib/http-security.js';

assert.equal(parseRelayBodyLimit(undefined), Infinity);
assert.equal(parseRelayBodyLimit('0'), Infinity);
assert.equal(parseRelayBodyLimit('unlimited'), Infinity);
assert.equal(parseRelayBodyLimit('1048576'), 1048576);

const small = estimatePromptTokens({
  model: 'gpt-5.6-terra',
  input: 'hello world'
});
assert.ok(small >= 256);
assert.ok(small < 400);

const blob = 'A'.repeat(40 * 1024);
const withFile = estimatePromptTokens({
  model: 'gpt-5.6-terra',
  input: [
    { role: 'user', content: [
      { type: 'input_text', text: '看看这个文件' },
      { type: 'input_file', filename: 'big.pdf', file_data: `data:application/pdf;base64,${blob}` }
    ] }
  ]
});
assert.ok(withFile <= PROMPT_TOKEN_HOLD_CAP);
assert.ok(withFile < 8000, `file payload must not be counted as text tokens, got ${withFile}`);

const asChars = Math.ceil((40 * 1024) / 3);
assert.ok(withFile < asChars, 'hold must be below byte/3 estimate for the blob');

console.log('prompt-tokens.test.mjs: all assertions passed');
