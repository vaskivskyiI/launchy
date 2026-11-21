import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, resolveViewer, publicConfig, viewApps } from './config.js';
import { sessionUser, sessionCookie, clearCookie, verifyPassword, clientIp, isThrottled, recordFailure, clearFailures } from './auth.js';
import { getWidget, fetchJson } from './widgets.js';

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

// ---------------------------------------------------------------- app status

const STATUS_TTL = 60_000;
const statusCache = new Map(); // ping url -> { at, up }

async function ping(url) {
  const hit = statusCache.get(url);
  if (hit && Date.now() - hit.at < STATUS_TTL) return hit.up;
  let up;
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(4000) });
    res.body?.cancel();
    up = res.status < 500;
  } catch (err) {
    // A TLS complaint (self-signed cert on the LAN) still proves the service answers.
    up = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(err.cause?.code || '');
  }
  statusCache.set(url, { at: Date.now(), up });
  return up;
}

async function appStatus(cfg, view) {
  const apps = viewApps(cfg, view).filter((a) => a.ping !== false && (a.ping || a.url));
  const results = await Promise.all(apps.map((a) => ping(a.ping || a.url)));
  return Object.fromEntries(apps.map((a, i) => [a.key, results[i] ? 'up' : 'down']));
}

// ---------------------------------------------------------------- search suggestions

async function suggest(cfg, providerId, q) {
  const provider = cfg.search?.providers?.find((p) => p.id === providerId);
  if (!provider?.suggest || !q.trim()) return [];
  const data = await fetchJson(provider.suggest.replace('{q}', encodeURIComponent(q)), { timeout: 2500 });
  return (Array.isArray(data) ? data[1] : []).filter((s) => typeof s === 'string').slice(0, 6); // OpenSearch format
}

// ---------------------------------------------------------------- http

function send(res, status, body, type = 'application/json', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function serveStatic(req, res, pathname) {
  const file = path.resolve(PUBLIC_DIR, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

async function readJson(req) {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw Object.assign(new Error('expected JSON'), { status: 415 });
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) throw Object.assign(new Error('request too large'), { status: 413 });
  }
  return JSON.parse(body || '{}');
}

async function login(req, res, cfg) {
  const ip = clientIp(req);
  if (isThrottled(ip)) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
  const { username, password } = await readJson(req);
  const user = cfg.users?.[String(username || '').trim().toLowerCase()];
  // Hash even for unknown users so response time doesn't reveal which names exist.
  const ok = verifyPassword(password, user?.password || 'scrypt:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=') && user;
  if (!ok) {
    recordFailure(ip);
    console.warn(`[auth] failed sign-in for "${String(username).slice(0, 32)}" from ${ip}`);
    return send(res, 401, { error: 'Wrong user name or password.' });
  }
  clearFailures(ip);
  const name = String(username).trim().toLowerCase();
  console.log(`[auth] ${name} signed in from ${ip}`);
  send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': sessionCookie(req, name, user.password) });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
  try {
    if (pathname === '/api/health') return send(res, 200, { ok: true });
    const cfg = getConfig();
    if (req.method === 'POST' && pathname === '/api/login') return await login(req, res, cfg);
    if (req.method === 'POST' && pathname === '/api/logout') {
      await readJson(req); // JSON content type keeps cross-site form posts out
      return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': clearCookie(req) });
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });

    const viewer = resolveViewer(cfg, sessionUser(req, cfg.users));
    if (!viewer) return send(res, 401, { error: 'sign in required', canLogin: true, title: cfg.title || 'Launchy' });
    if (pathname === '/api/config') return send(res, 200, publicConfig(cfg, viewer));
    if (pathname === '/api/status') return send(res, 200, await appStatus(cfg, viewer.view));
    if (pathname === '/api/suggest') {
      return send(res, 200, await suggest(cfg, url.searchParams.get('provider'), url.searchParams.get('q') || '').catch(() => []));
    }
    const widget = pathname.match(/^\/api\/widget\/([\w-]+)$/);
    if (widget) {
      const id = widget[1];
      if (!(viewer.view.widgets || []).includes(id)) return send(res, 404, { error: 'widget not available' });
      try {
        return send(res, 200, await getWidget(cfg, id));
      } catch (err) {
        console.error(`[widget ${id}] ${err.message}`);
        return send(res, 502, { error: err.message });
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof SyntaxError || err.status) return send(res, err.status || 400, { error: err.message });
    console.error(err);
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => console.log(`Launchy on http://localhost:${PORT}`));
