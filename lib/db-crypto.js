import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DB_MAGIC = Buffer.from('ZZENC1');
export const MASTER_KEY_NAME = '.master.key';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export function emptyDb() {
  return {
    users: [],
    rechargeCodes: [],
    logs: [],
    upstreamBills: [],
    auditLogs: [],
    sessions: {},
    settings: {},
    checkIns: [],
    paymentOrders: [],
    siteErrors: [],
    securityAlerts: [],
    billingAlerts: []
  };
}

export function isEncryptedDb(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < DB_MAGIC.length + IV_LEN + TAG_LEN) return false;
  return buf.subarray(0, DB_MAGIC.length).equals(DB_MAGIC);
}

export function keyFromSecret(secret) {
  const s = String(secret || '').trim();
  if (!s) return null;
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  return crypto.scryptSync(s, 'zhongzhuan-db-v1', KEY_LEN);
}

export function loadOrCreateDataKey(dataDir) {
  const keyPath = path.join(dataDir, MASTER_KEY_NAME);
  const fromEnv = keyFromSecret(process.env.RELAY_DATA_KEY || '');
  if (fromEnv) {
    if (!fs.existsSync(keyPath)) {
      try { fs.writeFileSync(keyPath, fromEnv.toString('hex'), { encoding: 'utf8', mode: 0o600 }); } catch { /* ignore */ }
    }
    return fromEnv;
  }
  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath, 'utf8').trim();
    const key = keyFromSecret(raw);
    if (key) return key;
  }
  const generated = crypto.randomBytes(KEY_LEN);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(keyPath, generated.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  return generated;
}

export function encryptDb(obj, key) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([DB_MAGIC, iv, tag, ciphertext]);
}

export function decryptDb(buf, key) {
  if (!isEncryptedDb(buf)) throw new Error('db_not_encrypted');
  const iv = buf.subarray(DB_MAGIC.length, DB_MAGIC.length + IV_LEN);
  const tag = buf.subarray(DB_MAGIC.length + IV_LEN, DB_MAGIC.length + IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(DB_MAGIC.length + IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

export function readDbFile(file, key) {
  const buf = fs.readFileSync(file);
  if (isEncryptedDb(buf)) return decryptDb(buf, key);
  const text = buf.toString('utf8').trim();
  if (text.startsWith('{')) return JSON.parse(text);
  throw new Error('db_unreadable');
}

export function writeDbFileAtomic(file, obj, key) {
  const packed = encryptDb(obj, key);
  const tempFile = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tempFile, packed);
  fs.renameSync(tempFile, file);
}

export function openDbDir(dataDir, fileName = 'db.json') {
  const file = path.join(dataDir, fileName);
  const key = loadOrCreateDataKey(dataDir);
  return {
    file,
    key,
    read() { return readDbFile(file, key); },
    write(obj) { writeDbFileAtomic(file, obj, key); }
  };
}

export function looksLikePlainJsonFile(file) {
  if (!fs.existsSync(file)) return false;
  const buf = fs.readFileSync(file);
  if (!buf.length) return false;
  if (isEncryptedDb(buf)) return false;
  return buf.toString('utf8').trim().startsWith('{');
}
