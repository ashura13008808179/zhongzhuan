import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  emptyDb,
  encryptDb,
  decryptDb,
  isEncryptedDb,
  keyFromSecret,
  loadOrCreateDataKey,
  readDbFile,
  writeDbFileAtomic,
  looksLikePlainJsonFile
} from '../lib/db-crypto.js';

const key = keyFromSecret('a'.repeat(64));
assert.equal(key.length, 32);

const db = emptyDb();
db.users.push({ id: 'usr_1', email: 'secret@example.com', password: 'salt:hash', balance: 12.5 });
const packed = encryptDb(db, key);
assert.equal(isEncryptedDb(packed), true);
assert.equal(packed.toString('utf8').includes('secret@example.com'), false);
assert.equal(packed.toString('utf8').includes('salt:hash'), false);
const back = decryptDb(packed, key);
assert.equal(back.users[0].email, 'secret@example.com');
assert.equal(back.users[0].balance, 12.5);

const other = keyFromSecret('b'.repeat(64));
assert.throws(() => decryptDb(packed, other));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-crypto-'));
const file = path.join(dir, 'db.json');
fs.writeFileSync(file, JSON.stringify({ users: [{ id: 'usr_plain', email: 'plain@x.com' }] }));
assert.equal(looksLikePlainJsonFile(file), true);
const migrated = readDbFile(file, key);
assert.equal(migrated.users[0].email, 'plain@x.com');
writeDbFileAtomic(file, migrated, key);
assert.equal(looksLikePlainJsonFile(file), false);
assert.equal(isEncryptedDb(fs.readFileSync(file)), true);
assert.equal(fs.readFileSync(file).toString('utf8').includes('plain@x.com'), false);
assert.equal(readDbFile(file, key).users[0].id, 'usr_plain');

const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-key-'));
const k1 = loadOrCreateDataKey(dir2);
const k2 = loadOrCreateDataKey(dir2);
assert.equal(k1.toString('hex'), k2.toString('hex'));
assert.equal(fs.existsSync(path.join(dir2, '.master.key')), true);

console.log('db-crypto.test.mjs: all assertions passed');
