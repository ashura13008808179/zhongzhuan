/**
 * Per-user file store for OpenAI-compatible /v1/files and native-account
 * add / edit / read workflows. Content lives on disk; metadata in db.files.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_STORED_FILE_BYTES = 32 * 1024 * 1024;
const TEXT_LIKE = /^(text\/|application\/(json|xml|javascript|x-javascript|sql|yaml|x-yaml|toml)|image\/svg)/i;

export function filesRoot(dataDir) {
  return path.join(String(dataDir || ''), 'user-files');
}

export function ensureFilesArray(db) {
  if (!db) return [];
  if (!Array.isArray(db.files)) db.files = [];
  return db.files;
}

function publicFile(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    object: 'file',
    bytes: Number(row.bytes) || 0,
    created_at: Number(row.created_at) || Math.floor(Date.now() / 1000),
    filename: row.filename || 'upload.bin',
    purpose: row.purpose || 'assistants',
    status: row.status || 'processed',
    ...extra
  };
}

function userDir(root, userId) {
  const safe = String(userId || 'anon').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(root, safe);
}

function filePath(root, userId, id) {
  const safeId = String(id || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(userDir(root, userId), safeId);
}

export function guessUploadFilename(contentType, raw) {
  const header = String(contentType || '');
  const text = raw && raw.length < 64 * 1024 ? raw.toString('utf8') : raw ? raw.subarray(0, 4096).toString('utf8') : '';
  const fromDisp = text.match(/filename\*?=(?:UTF-8''|")?([^\r\n";]+)/i);
  if (fromDisp) {
    try { return decodeURIComponent(fromDisp[1].replace(/"/g, '').trim()); } catch { return fromDisp[1].replace(/"/g, '').trim(); }
  }
  if (/json/i.test(header)) {
    try {
      const parsed = JSON.parse(text);
      if (parsed?.filename) return String(parsed.filename);
      if (parsed?.file?.filename) return String(parsed.file.filename);
    } catch { /* ignore */ }
  }
  return 'upload.bin';
}

function parseMultipart(contentType, raw) {
  const m = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m || !raw || !raw.length) return null;
  const boundary = `--${(m[1] || m[2] || '').trim()}`;
  const body = raw.toString('latin1');
  const chunks = body.split(boundary);
  for (const chunk of chunks) {
    if (!chunk || chunk === '--' || chunk === '--\r\n') continue;
    const split = chunk.indexOf('\r\n\r\n');
    if (split < 0) continue;
    const head = chunk.slice(0, split);
    if (!/name="file"|filename=/i.test(head) && !/name="content"/i.test(head)) {
      if (!/filename=/i.test(head)) continue;
    }
    let payload = chunk.slice(split + 4);
    if (payload.endsWith('\r\n')) payload = payload.slice(0, -2);
    if (payload.endsWith('--')) payload = payload.slice(0, -2);
    const fn = head.match(/filename\*?=(?:UTF-8''|")?([^\r\n";]+)/i);
    const filename = fn ? fn[1].replace(/"/g, '').trim() : 'upload.bin';
    const ct = (head.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1] || 'application/octet-stream';
    return {
      filename: filename || 'upload.bin',
      bytes: Buffer.from(payload, 'latin1'),
      contentType: ct.trim()
    };
  }
  return null;
}

export function parseUpload(contentType, raw, fallbackName = 'upload.bin') {
  const header = String(contentType || '');
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || '');
  if (/multipart\/form-data/i.test(header)) {
    const part = parseMultipart(header, buf);
    if (part) {
      return {
        filename: part.filename || fallbackName,
        purpose: 'assistants',
        bytes: part.bytes,
        contentType: part.contentType
      };
    }
  }
  if (/json/i.test(header) && buf.length) {
    try {
      const parsed = JSON.parse(buf.toString('utf8'));
      const filename = String(parsed.filename || parsed.file?.filename || fallbackName);
      const purpose = String(parsed.purpose || 'assistants');
      let bytes;
      if (typeof parsed.content === 'string') {
        bytes = Buffer.from(parsed.content, parsed.encoding === 'base64' ? 'base64' : 'utf8');
      } else if (typeof parsed.file?.content === 'string') {
        bytes = Buffer.from(parsed.file.content, parsed.file.encoding === 'base64' ? 'base64' : 'utf8');
      } else {
        bytes = Buffer.from(String(parsed.text || parsed.body || ''), 'utf8');
      }
      return {
        filename,
        purpose,
        bytes,
        contentType: parsed.content_type || parsed.mime || 'application/octet-stream'
      };
    } catch { /* fall through */ }
  }
  return {
    filename: guessUploadFilename(header, buf) || fallbackName,
    purpose: 'assistants',
    bytes: buf,
    contentType: header.split(';')[0].trim() || 'application/octet-stream'
  };
}

export function createStoredFile(db, { dataDir, userId, filename, purpose, bytes, contentType }) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '');
  if (buf.length > MAX_STORED_FILE_BYTES) {
    const err = new Error('payload_too_large');
    err.code = 'PAYLOAD_TOO_LARGE';
    throw err;
  }
  const id = `file_${crypto.randomBytes(12).toString('hex')}`;
  const row = {
    id,
    userId: String(userId || ''),
    filename: String(filename || 'upload.bin').slice(0, 180),
    purpose: String(purpose || 'assistants').slice(0, 64),
    bytes: buf.length,
    created_at: Math.floor(Date.now() / 1000),
    status: 'processed',
    contentType: String(contentType || 'application/octet-stream').slice(0, 120)
  };
  const destDir = userDir(filesRoot(dataDir), row.userId);
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(filePath(filesRoot(dataDir), row.userId, id), buf);
  ensureFilesArray(db).unshift(row);
  return publicFile(row);
}

export function findStoredFile(db, fileId, userId = null) {
  const id = String(fileId || '').trim();
  if (!id) return null;
  const row = ensureFilesArray(db).find((f) => f && f.id === id);
  if (!row) return null;
  if (userId && String(row.userId) !== String(userId)) return null;
  return row;
}

export function listStoredFiles(db, userId) {
  return ensureFilesArray(db)
    .filter((f) => f && String(f.userId) === String(userId))
    .map((f) => publicFile(f));
}

export function readStoredFileBytes(dataDir, row) {
  if (!row) return null;
  const p = filePath(filesRoot(dataDir), row.userId, row.id);
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

export function updateStoredFile(db, { dataDir, fileId, userId, filename, purpose, bytes, contentType }) {
  const row = findStoredFile(db, fileId, userId);
  if (!row) return null;
  const buf = bytes == null ? readStoredFileBytes(dataDir, row) : (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || ''));
  if (!buf) return null;
  if (buf.length > MAX_STORED_FILE_BYTES) {
    const err = new Error('payload_too_large');
    err.code = 'PAYLOAD_TOO_LARGE';
    throw err;
  }
  if (filename) row.filename = String(filename).slice(0, 180);
  if (purpose) row.purpose = String(purpose).slice(0, 64);
  if (contentType) row.contentType = String(contentType).slice(0, 120);
  row.bytes = buf.length;
  row.status = 'processed';
  const destDir = userDir(filesRoot(dataDir), row.userId);
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(filePath(filesRoot(dataDir), row.userId, row.id), buf);
  return publicFile(row);
}

export function deleteStoredFile(db, { dataDir, fileId, userId }) {
  const row = findStoredFile(db, fileId, userId);
  if (!row) return false;
  db.files = ensureFilesArray(db).filter((f) => f.id !== row.id);
  try { fs.unlinkSync(filePath(filesRoot(dataDir), row.userId, row.id)); } catch { /* ignore */ }
  return true;
}

function looksText(row, buf) {
  if (!buf) return false;
  if (row?.contentType && TEXT_LIKE.test(row.contentType)) return true;
  if (/\.(txt|md|json|js|mjs|ts|tsx|py|go|rs|java|c|h|css|html|xml|yml|yaml|toml|sh|sql|csv)$/i.test(row?.filename || '')) return true;
  const sample = buf.subarray(0, 800);
  let odd = 0;
  for (const b of sample) if (b === 0 || (b < 9 && b !== 9 && b !== 10 && b !== 13)) odd += 1;
  return odd < 4;
}

export function fileAsPromptText(row, buf, limit = 12000) {
  if (!row) return '';
  if (buf && looksText(row, buf)) {
    const text = buf.toString('utf8').slice(0, limit);
    return `【文件 ${row.filename} id=${row.id}】\n${text}`;
  }
  if (buf && /^image\//i.test(row.contentType || '')) {
    return `【图片文件 ${row.filename} id=${row.id} bytes=${buf.length}】`;
  }
  return `【文件 ${row.filename} id=${row.id} bytes=${row.bytes || buf?.length || 0}】`;
}

function collectFileIds(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') {
    const m = value.match(/\bfile_[a-zA-Z0-9]+\b/g);
    if (m) for (const id of m) if (!out.includes(id)) out.push(id);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFileIds(item, out);
    return out;
  }
  if (typeof value !== 'object') return out;
  if (value.file_id) collectFileIds(String(value.file_id), out);
  if (value.file?.id) collectFileIds(String(value.file.id), out);
  if (value.id && String(value.id).startsWith('file_')) collectFileIds(String(value.id), out);
  for (const [k, v] of Object.entries(value)) {
    if (k === 'file_id' || k === 'attachments' || k === 'content' || k === 'input' || k === 'messages' || k === 'file') {
      collectFileIds(v, out);
    }
  }
  return out;
}

/** Content parts that are local file refs — not valid for most upstream chat APIs (e.g. Beibeihai/Grok → 400). */
function isFileRefPart(part) {
  if (!part || typeof part !== 'object') return false;
  const t = String(part.type || '').toLowerCase();
  if (t === 'file' || t === 'input_file' || t === 'document') return true;
  if (t === 'image_url' || t === 'input_image' || t === 'image' || t === 'text' || t === 'input_text' || t === 'output_text') return false;
  if (part.file_id) return true;
  if (part.file && (part.file.file_id || part.file.id)) return true;
  return false;
}

function stripFileRefParts(content) {
  if (!Array.isArray(content)) return content;
  const kept = content.filter((p) => !isFileRefPart(p));
  return kept;
}

function injectIntoContent(content, texts) {
  if (!texts.length) return Array.isArray(content) ? stripFileRefParts(content) : content;
  const block = texts.join('\n\n');
  if (typeof content === 'string') return content ? `${content}\n\n${block}` : block;
  if (Array.isArray(content)) {
    // Drop local {type:'file'|input_file,...} parts after expanding to text —
    // Grok/Beibeihai reject unknown part types with HTTP 400 → relay masks as 502.
    const kept = stripFileRefParts(content);
    return [...kept, { type: 'text', text: block }];
  }
  return block;
}

/** Remove residual file refs from the whole payload after text hydration. */
function scrubHydratedFileRefs(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (Array.isArray(payload.messages)) {
    for (const m of payload.messages) {
      if (m && Array.isArray(m.content)) m.content = stripFileRefParts(m.content);
    }
  }
  if (Array.isArray(payload.input)) {
    for (const item of payload.input) {
      if (item && typeof item === 'object' && Array.isArray(item.content)) {
        item.content = stripFileRefParts(item.content);
      }
    }
    payload.input = payload.input.filter((item) => {
      if (!item || typeof item !== 'object') return true;
      const t = String(item.type || '').toLowerCase();
      return t !== 'input_file' && t !== 'file';
    });
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'attachments')) {
    delete payload.attachments;
  }
  return payload;
}

/**
 * Expand file_id / attachments in chat, Anthropic, or Responses payloads
 * so upstreams that do not host our files can still read the contents.
 * Also strips local file content-parts that strict upstreams (Grok) reject.
 */
export function hydratePayloadFiles(payload, db, { dataDir, userId } = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  const ids = collectFileIds(payload);
  if (!ids.length) {
    // Still scrub orphan file parts even if we cannot expand them.
    return scrubHydratedFileRefs(payload);
  }
  const texts = [];
  for (const id of ids) {
    const row = findStoredFile(db, id, userId);
    if (!row) continue;
    const buf = readStoredFileBytes(dataDir, row);
    const snippet = fileAsPromptText(row, buf);
    if (snippet) texts.push(snippet);
  }
  if (!texts.length) return scrubHydratedFileRefs(payload);
  if (Array.isArray(payload.messages) && payload.messages.length) {
    const lastUser = [...payload.messages].reverse().find((m) => m && m.role === 'user') || payload.messages[payload.messages.length - 1];
    lastUser.content = injectIntoContent(lastUser.content, texts);
  }
  if (payload.input != null) {
    if (typeof payload.input === 'string') payload.input = injectIntoContent(payload.input, texts);
    else if (Array.isArray(payload.input) && payload.input.length) {
      const last = payload.input[payload.input.length - 1];
      if (last && typeof last === 'object') {
        last.content = injectIntoContent(last.content != null ? last.content : last.text, texts);
      } else {
        payload.input.push({ role: 'user', content: texts.join('\n\n') });
      }
    }
  }
  return scrubHydratedFileRefs(payload);
}

export function fileObjectResponse(row) {
  return publicFile(row);
}
