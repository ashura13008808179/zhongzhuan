/**
 * Normalizers shared by the upstream usage synchronizer and its tests.
 * An upstream usage id is the only durable idempotency key available to us.
 */

export function upstreamUsageId(row) {
  const value = row?.id ?? row?.usage_id ?? row?.usageId;
  return value == null || value === '' ? '' : String(value);
}

export function upstreamUsageApiKeyId(row) {
  const value = row?.api_key_id ?? row?.apiKeyId ?? row?.key_id ?? row?.keyId;
  return value == null || value === '' ? '' : String(value);
}

export function upstreamUsageCreatedAt(row) {
  const value = row?.created_at ?? row?.createdAt ?? row?.timestamp ?? null;
  const at = value ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toISOString() : null;
}

export function upstreamUsageCost(row) {
  const value = Number(row?.actual_cost ?? row?.actualCost ?? 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function upstreamUsageTokens(row) {
  const input = Math.max(0, Number(row?.input_tokens ?? row?.inputTokens ?? 0) || 0);
  const cacheRead = Math.max(0, Number(row?.cache_read_tokens ?? row?.cacheReadTokens ?? 0) || 0);
  const cacheWrite = Math.max(0, Number(row?.cache_creation_tokens ?? row?.cacheCreationTokens ?? 0) || 0);
  const output = Math.max(0, Number(row?.output_tokens ?? row?.outputTokens ?? 0) || 0);
  return {
    promptTokens: input + cacheRead + cacheWrite,
    completionTokens: output,
    totalTokens: input + cacheRead + cacheWrite + output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite
  };
}

export function upstreamBillId(kind, row) {
  const usageId = upstreamUsageId(row);
  return usageId ? `${String(kind)}:${usageId}` : '';
}

export function usagePageHasMore(rows, pageSize) {
  return Array.isArray(rows) && rows.length >= Math.max(1, Number(pageSize) || 1);
}
