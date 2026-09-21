/**
 * Pre-auth token hold for mixed text + file payloads.
 * Base64 / data-URL attachments are NOT counted as prompt characters.
 * Actual billing still uses upstream usage after the call.
 */

const DATA_URL = /^data:/i;
const LOOKS_BASE64 = /^[A-Za-z0-9+/]{240,}={0,2}$/;
export const PROMPT_TOKEN_HOLD_CAP = 16000;

function isBinaryBlob(value, key) {
  const text = String(value || '');
  if (DATA_URL.test(text)) return true;
  const k = String(key || '');
  if (/file_data|image_url|input_audio|data$/i.test(k) && text.length > 400) return true;
  return text.length > 800 && LOOKS_BASE64.test(text.slice(0, 1200));
}

function isImageBlob(value, key) {
  const text = String(value || '');
  if (/^data:image\//i.test(text)) return true;
  return /image/i.test(String(key || ''));
}

export function estimatePromptTokens(value) {
  let textChars = 0;
  let images = 0;
  let files = 0;
  const walk = (node, key = '') => {
    if (node == null) return;
    if (typeof node === 'string') {
      if (isBinaryBlob(node, key)) {
        if (isImageBlob(node, key)) images += 1;
        else files += 1;
        return;
      }
      textChars += node.length;
      return;
    }
    if (typeof node === 'number' || typeof node === 'boolean') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, key);
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, k);
    }
  };
  walk(value);
  const textTokens = Math.ceil(textChars / 3);
  const hold = textTokens + images * 2000 + files * 4000 + 256;
  return Math.min(PROMPT_TOKEN_HOLD_CAP, Math.max(256, hold));
}
