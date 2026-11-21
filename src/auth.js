// Password hashing, signed session cookies and login throttling. No server-side session store:
// the cookie carries user + expiry, signed with the server secret and the user's password hash,
// so changing a password signs that user out everywhere.
import crypto from 'node:crypto';

const COOKIE = 'launchy_session';
const SESSION_DAYS = 30;
const SECRET = process.env.LAUNCHY_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.LAUNCHY_SECRET) console.warn('[auth] LAUNCHY_SECRET is not set: sessions end when the server restarts');

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sign = (user, exp, passwordHash) =>
  crypto.createHmac('sha256', SECRET).update(`${user}|${exp}|${passwordHash}`).digest('base64url');

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, v.join('=')]));
}

/** Username of a valid session, or null. */
export function sessionUser(req, users) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  const [user, exp, sig] = (token || '').split('.');
  if (!user || !users?.[user] || !(Number(exp) > Date.now())) return null;
  const expected = sign(user, exp, users[user].password);
  return sig && sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? user : null;
}

const cookieAttrs = (req) =>
  `Path=/; HttpOnly; SameSite=Lax${req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : ''}`;

export function sessionCookie(req, user, passwordHash) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  return `${COOKIE}=${user}.${exp}.${sign(user, exp, passwordHash)}; Max-Age=${SESSION_DAYS * 86400}; ${cookieAttrs(req)}`;
}

export const clearCookie = (req) => `${COOKIE}=; Max-Age=0; ${cookieAttrs(req)}`;

// ---------------------------------------------------------------- throttling: 5 failures per IP per 15 minutes

const WINDOW = 15 * 60_000;
const MAX_FAILURES = 5;
const failures = new Map(); // ip -> { count, since }

export function clientIp(req) {
  // Behind a reverse proxy the socket address is the proxy (or podman's port forwarder); trust
  // X-Real-IP / X-Forwarded-For only when the connection comes from loopback or a private network.
  const direct = req.socket.remoteAddress || '';
  const fromProxy = /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|^::1$|^f[cd]/i.test(direct);
  return (fromProxy && (req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim())) || direct;
}

export function isThrottled(ip) {
  const f = failures.get(ip);
  if (f && Date.now() - f.since > WINDOW) failures.delete(ip);
  return (failures.get(ip)?.count || 0) >= MAX_FAILURES;
}

export function recordFailure(ip) {
  const f = failures.get(ip) || { count: 0, since: Date.now() };
  f.count += 1;
  failures.set(ip, f);
}

export const clearFailures = (ip) => failures.delete(ip);
