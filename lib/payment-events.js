const MAX_EVENTS = 300;
const DEFAULT_WAIT_MS = 25000;
const MAX_WAIT_MS = 28000;
const MIN_WAIT_MS = 200;

let seq = 0;
const events = [];
const waiters = new Set();

export function currentSeq() {
  return seq;
}

export function clampWaitMs(timeoutMs) {
  const n = Number(timeoutMs);
  if (!Number.isFinite(n)) return DEFAULT_WAIT_MS;
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, n));
}

export function publicPaymentEvent(evt, { includeCode = false } = {}) {
  if (!evt) return null;
  const out = {
    seq: evt.seq,
    at: evt.at,
    kind: evt.kind,
    orderId: evt.orderId,
    userId: evt.userId,
    username: evt.username,
    amount: evt.amount,
    method: evt.method,
    payNote: evt.payNote,
    status: evt.status
  };
  if (includeCode && evt.code) out.code = evt.code;
  return out;
}

export function pushPaymentEvent(partial = {}) {
  const evt = {
    seq: ++seq,
    at: new Date().toISOString(),
    kind: String(partial.kind || ''),
    orderId: partial.orderId || null,
    userId: partial.userId || null,
    username: String(partial.username || ''),
    amount: Number(partial.amount || 0),
    method: String(partial.method || ''),
    payNote: partial.payNote || null,
    status: String(partial.status || ''),
    code: partial.code || null
  };
  events.push(evt);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  wakeWaiters(evt);
  return evt;
}

export function eventsAfter(afterSeq, { userId = null } = {}) {
  const n = Number(afterSeq) || 0;
  return events.filter(e => e.seq > n && (!userId || e.userId === userId));
}

/**
 * after < 0 或未传：从当前 seq 起等新事件（首次连接，不回放历史）。
 * after >= 0：返回 seq 更大的事件；若客户端序号大于服务端（进程重启），回放本进程缓冲。
 */
export function waitForEvents(afterSeq, { userId = null, timeoutMs = DEFAULT_WAIT_MS } = {}) {
  const raw = afterSeq === undefined || afterSeq === null || afterSeq === '' ? -1 : Number(afterSeq);
  let after;
  if (!Number.isFinite(raw) || raw < 0) {
    after = seq;
  } else if (raw > seq) {
    const replay = eventsAfter(0, { userId });
    if (replay.length) return Promise.resolve(replay);
    after = seq;
  } else {
    after = raw;
  }
  const ms = clampWaitMs(timeoutMs);

  return new Promise((resolve) => {
    const entry = { after, userId, resolve, timer: null, done: false };
    const finish = (list) => {
      if (entry.done) return;
      entry.done = true;
      if (entry.timer) clearTimeout(entry.timer);
      waiters.delete(entry);
      resolve(list);
    };
    waiters.add(entry);
    const already = eventsAfter(after, { userId });
    if (already.length) {
      finish(already);
      return;
    }
    entry.timer = setTimeout(() => finish([]), ms);
  });
}

function wakeWaiters(evt) {
  for (const w of [...waiters]) {
    if (w.done) continue;
    if (evt.seq <= w.after) continue;
    if (w.userId && evt.userId !== w.userId) continue;
    const list = eventsAfter(w.after, { userId: w.userId });
    if (!list.length) continue;
    w.done = true;
    if (w.timer) clearTimeout(w.timer);
    waiters.delete(w);
    w.resolve(list);
  }
}

export function __resetPaymentEventsForTests() {
  seq = 0;
  events.length = 0;
  for (const w of waiters) {
    if (w.timer) clearTimeout(w.timer);
    if (!w.done) {
      w.done = true;
      w.resolve([]);
    }
  }
  waiters.clear();
}
