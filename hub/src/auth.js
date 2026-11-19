import crypto from 'node:crypto';
import * as store from './state.js';

const COOKIE = 'allarr_session';
const TTL_MS = 30 * 24 * 3600 * 1000;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [alg, salt, hash] = stored.split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const got = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
    return crypto.timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

const sign = (payload) =>
  crypto.createHmac('sha256', store.get().secret).update(payload).digest('base64url');

export function sessionCookie(username, secure) {
  const payload = `${Buffer.from(username).toString('base64url')}.${Date.now() + TTL_MS}`;
  return `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}${secure ? '; Secure' : ''}`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Returns the logged-in username, or null. */
export function currentUser(req) {
  const cookie = parseCookies(req.headers.cookie)[COOKIE];
  if (!cookie) return null;
  const i = cookie.lastIndexOf('.');
  if (i < 0) return null;
  const payload = cookie.slice(0, i);
  const given = Buffer.from(cookie.slice(i + 1));
  const want = Buffer.from(sign(payload));
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  const [user, exp] = payload.split('.');
  if (Number(exp) < Date.now()) return null;
  const username = Buffer.from(user, 'base64url').toString();
  return username === store.get().admin?.username ? username : null;
}

/** Strip our session cookie before forwarding requests to the apps. */
export function stripSessionCookie(header = '') {
  return header
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith(`${COOKIE}=`))
    .join('; ');
}

// --- tiny login throttle: 8 attempts / minute / IP ---------------------------------
const attempts = new Map();
export function throttle(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.reset < now) {
    attempts.set(ip, { count: 1, reset: now + 60_000 });
    return true;
  }
  return ++a.count <= 8;
}
