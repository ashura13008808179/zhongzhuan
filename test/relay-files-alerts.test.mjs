import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseUpload,
  createStoredFile,
  listStoredFiles,
  findStoredFile,
  readStoredFileBytes,
  updateStoredFile,
  deleteStoredFile,
  hydratePayloadFiles
} from '../lib/relay-files.js';
import { buildBillingAlerts } from '../lib/billing-alerts.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-files-'));
const db = { files: [], settings: { providers: [{ id: 'grp_gpt_pro', name: 'GPT PRO', upstreamSync: 'vip1129' }] } };

const parsed = parseUpload('application/json', Buffer.from(JSON.stringify({
  filename: 'hello.txt',
  content: 'hello native',
  purpose: 'assistants'
})));
assert.equal(parsed.filename, 'hello.txt');
assert.equal(parsed.bytes.toString('utf8'), 'hello native');

const created = createStoredFile(db, {
  dataDir: tmp,
  userId: 'usr_a',
  filename: parsed.filename,
  purpose: parsed.purpose,
  bytes: parsed.bytes,
  contentType: 'text/plain'
});
assert.match(created.id, /^file_/);
assert.equal(created.object, 'file');
assert.equal(listStoredFiles(db, 'usr_a').length, 1);
assert.equal(listStoredFiles(db, 'usr_b').length, 0);
assert.equal(readStoredFileBytes(tmp, findStoredFile(db, created.id, 'usr_a')).toString('utf8'), 'hello native');

const updated = updateStoredFile(db, {
  dataDir: tmp,
  fileId: created.id,
  userId: 'usr_a',
  filename: 'hello.txt',
  bytes: Buffer.from('edited')
});
assert.equal(updated.bytes, 6);
assert.equal(readStoredFileBytes(tmp, findStoredFile(db, created.id, 'usr_a')).toString('utf8'), 'edited');

const chat = {
  model: 'gpt-5.6-terra',
  messages: [{ role: 'user', content: `读取文件 ${created.id}` }],
  tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }]
};
hydratePayloadFiles(chat, db, { dataDir: tmp, userId: 'usr_a' });
assert.match(String(chat.messages[0].content), /edited/);
assert.equal(chat.tools[0].function.name, 'read_file');

const responses = {
  model: 'gpt-5.6-terra',
  input: [{ role: 'user', content: [{ type: 'input_text', text: '看这个文件' }, { type: 'input_file', file_id: created.id }] }],
  tools: [{ type: 'function', name: 'apply_patch' }]
};
hydratePayloadFiles(responses, db, { dataDir: tmp, userId: 'usr_a' });
assert.ok(JSON.stringify(responses.input).includes('edited'));
assert.equal(responses.tools[0].name, 'apply_patch');

assert.equal(deleteStoredFile(db, { dataDir: tmp, fileId: created.id, userId: 'usr_a' }), true);
assert.equal(findStoredFile(db, created.id, 'usr_a'), null);

const emptyAlerts = buildBillingAlerts({ logs: [], upstreamBills: [], settings: { providers: [] } });
assert.equal(emptyAlerts.open, 0);
assert.equal(emptyAlerts.openCount, 0);
assert.deepEqual(emptyAlerts.alerts, []);

const day = new Date().toISOString();
const inverted = buildBillingAlerts({
  logs: [{
    id: 'log_1',
    createdAt: day,
    providerId: 'grp_deepseek',
    chargedAmount: 0.001,
    upstreamCost: 0.01,
    model: 'deepseek-chat'
  }],
  upstreamBills: [],
  settings: { providers: [{ id: 'grp_deepseek', name: 'DeepSeek', upstreamSync: 'beibeihai' }] }
});
assert.equal(inverted.open, 1);
assert.equal(inverted.alerts[0].status, 'open');
assert.ok(inverted.open !== undefined);

const vipOk = buildBillingAlerts({
  logs: [{
    id: 'log_vip',
    createdAt: day,
    providerId: 'grp_gpt_pro',
    chargedAmount: 0.0004,
    upstreamCost: 0.00014,
    upstreamReportedCost: 0.001,
    upstreamCostTrue: true,
    model: 'gpt-5.6-terra'
  }],
  upstreamBills: [],
  settings: { providers: [{ id: 'grp_gpt_pro', name: 'GPT PRO', upstreamSync: 'vip1129' }] }
});
assert.equal(vipOk.open, 0, 'VIP charged 0.4x reported vs true cost reported/7 should not invert');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('relay-files-alerts.test.mjs: all assertions passed');
