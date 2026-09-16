import crypto from 'node:crypto';

export const REGISTER_BURST_COUNT = Number(process.env.REGISTER_BURST_COUNT || 8);
export const REGISTER_BURST_WINDOW_MS = Number(process.env.REGISTER_BURST_WINDOW_MS || 5 * 60 * 1000);
export const ADMIN_PHONE_TICKET_MS = 5 * 60 * 1000;

const signupWindow = [];
const phoneTickets = new Map();

export function normalizeCnMobile(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('86') && d.length === 13) d = d.slice(2);
  if (d.startsWith('0086') && d.length === 15) d = d.slice(4);
  if (!/^1[3-9]\d{9}$/.test(d)) return '';
  return d;
}

export function adminPhoneRequired(db) {
  if (String(process.env.RELAY_SKIP_ADMIN_PHONE || '') === '1') return false;
  const stored = getAdminPhoneHash(db);
  const envPhone = normalizeCnMobile(process.env.ADMIN_PHONE || '');
  const skipJobs = process.env.RELAY_SKIP_BOOT_JOBS === '1' || String(process.env.SKIP_BOOT_JOBS || '') === '1';
  if (skipJobs && !stored && !envPhone && process.env.RELAY_FORCE_ADMIN_PHONE !== '1') {
    return false;
  }
  return true;
}

export function getAdminPhoneHash(db) {
  return String(db?.settings?.adminPhoneHash || '').trim();
}

const SECRET_KEYS = /^(password|passwordHash|adminPhoneHash|adminPhoneBoundAt|adminPhone|ADMIN_PHONE|ADMIN_PASSWORD|RELAY_DATA_KEY|accessToken)$/i;

export function stripAdminSecrets(value, phone = normalizeCnMobile(process.env.ADMIN_PHONE || '')) {
  const walk = (v) => {
    if (typeof v === 'string') {
      if (phone && v.includes(phone)) return v.split(phone).join('');
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (SECRET_KEYS.test(k)) continue;
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

export function maskPhone(phone) {
  const d = normalizeCnMobile(phone);
  if (!d) return '';
  return `${d.slice(0, 3)}****${d.slice(-4)}`;
}

export function createPhoneTicket(userId, { enroll = false } = {}) {
  const ticket = crypto.randomBytes(24).toString('hex');
  phoneTickets.set(ticket, { userId, enroll: !!enroll, createdAt: Date.now() });
  return ticket;
}

export function takePhoneTicket(ticket) {
  const rec = phoneTickets.get(String(ticket || ''));
  if (!rec) return null;
  phoneTickets.delete(String(ticket || ''));
  if (Date.now() - rec.createdAt > ADMIN_PHONE_TICKET_MS) return null;
  return rec;
}

export function noteSignupAndMaybeAlert(db, user, ip) {
  const now = Date.now();
  signupWindow.push({ at: now, userId: user.id, username: user.username || '', email: user.email || '', ip: String(ip || '') });
  while (signupWindow.length && now - signupWindow[0].at > REGISTER_BURST_WINDOW_MS) signupWindow.shift();
  const recent = signupWindow.slice();
  const sameIp = recent.filter(x => x.ip && x.ip === String(ip || ''));
  const hit = recent.length >= REGISTER_BURST_COUNT || sameIp.length >= Math.max(5, Math.ceil(REGISTER_BURST_COUNT * 0.7));
  if (!hit) return null;
  db.securityAlerts ??= [];
  const last = db.securityAlerts[0];
  const reuse = last && last.kind === 'signup_burst' && last.status === 'open' && (now - Date.parse(last.createdAt || 0) < REGISTER_BURST_WINDOW_MS);
  const users = recent.map(x => ({ userId: x.userId, username: x.username, email: x.email, ip: x.ip }));
  if (reuse) {
    last.count = recent.length;
    last.users = users;
    last.updatedAt = new Date(now).toISOString();
    last.ip = String(ip || last.ip || '');
    return last;
  }
  const alert = {
    id: `alrt_${crypto.randomBytes(6).toString('hex')}`,
    kind: 'signup_burst',
    status: 'open',
    count: recent.length,
    ip: String(ip || ''),
    users,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  };
  db.securityAlerts.unshift(alert);
  db.securityAlerts = db.securityAlerts.slice(0, 200);
  return alert;
}

export function publicSecurityAlert(a) {
  if (!a) return null;
  return {
    id: a.id,
    kind: a.kind,
    status: a.status,
    count: a.count,
    ip: a.ip || '',
    users: a.users || [],
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    bannedCount: a.bannedCount || 0
  };
}

export function openSecurityAlerts(db) {
  return (db.securityAlerts || []).filter(a => a.status === 'open').map(publicSecurityAlert);
}
