// Settings: loads config.yaml (and secrets.yaml), resolves ${SECRET} references, reloads when either file
// changes, validates, saves edits from the settings page, and builds the secret-free view a browser receives.
//
// Shape (version 2):
//   apps:    { <id>: { name, url, icon?, description?, tags?, ping?, android?, appLink? } }   every service, once
//   groups:  { <id>: { title, apps: [<app id>, …] } }
//   widgets: { <id>: { type, title?, app?, link?, refresh?, …type fields } }  app: shown in that app's panel
//   users:   { <name>: { name?, password, admin?, groups: […], widgets: […], theme?, search?, greeting? } }
//   public:  { groups, widgets }   optional view for visitors who are not signed in
//   title, search, llm
// Version 1 files (apps written inside groups) are converted when loaded and saved as version 2.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { widgetRefresh, WIDGET_TYPES } from './widgets.js';

const CONFIG_PATH = process.env.LAUNCHY_CONFIG || 'config/config.yaml';
const DIR = path.dirname(CONFIG_PATH);
const SECRETS_PATH = process.env.LAUNCHY_SECRETS || path.join(DIR, 'secrets.yaml');
const HISTORY_DIR = path.join(DIR, 'history');
const HISTORY_KEEP = 20;

export const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const USERNAME = /^[a-z0-9_-]{1,32}$/;
const PASSWORD_HASH = /^scrypt:[A-Za-z0-9+/]{22}==:[A-Za-z0-9+/]{43}=$/;
const REF = /\$\{([A-Z0-9_]+)\}/gi;
// Installed apps: an Android package id, and/or a link scheme the app registers (myapp://…) for desktop and iOS.
const ANDROID_PACKAGE = /^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/;
const isAppLink = (u) => /^[a-z][a-z0-9+.-]*:\S+$/i.test(u) && !/^(javascript|data|vbscript|file|blob):/i.test(u);

let cached = null; // { stamp, raw, config }

// ---------------------------------------------------------------- files

function atomicWrite(file, text, mode) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

const mtime = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };

export function readSecrets() {
  try { return YAML.parse(fs.readFileSync(SECRETS_PATH, 'utf8')) || {}; } catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
}

export function writeSecrets(secrets) {
  const sorted = Object.fromEntries(Object.entries(secrets).sort(([a], [b]) => a.localeCompare(b)));
  atomicWrite(SECRETS_PATH, `# Launchy secrets, set from the settings page. Referenced in config.yaml as \${NAME}.\n${YAML.stringify(sorted)}`, 0o600);
  cached = null;
}

/** Every secret name in use or stored, whether it has a value, and where it comes from. */
export function secretStatus(raw) {
  const stored = readSecrets();
  const used = new Set([...JSON.stringify(raw).matchAll(REF)].map((m) => m[1]));
  return [...new Set([...used, ...Object.keys(stored)])].sort().map((name) => ({
    name,
    used: used.has(name),
    source: stored[name] ? 'settings' : process.env[name] ? 'environment' : null,
  }));
}

// ---------------------------------------------------------------- version 1 → 2

const slug = (s) => String(s || 'app').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'app';

export function migrate(input) {
  const cfg = structuredClone(input || {});
  if (cfg.profiles && !cfg.users) throw new Error('"profiles" was replaced by "users" (with passwords) and "public"');
  cfg.apps ||= {};
  const seen = new Map(); // inline app object (or name|url) → id
  for (const g of Object.values(cfg.groups || {})) {
    g.apps = (g.apps || []).map((a) => {
      if (typeof a === 'string') return a;
      const key = `${a.name}|${a.url}`;
      if (!seen.has(key)) {
        let id = slug(a.name);
        for (let i = 2; cfg.apps[id]; i++) id = `${slug(a.name)}-${i}`;
        cfg.apps[id] = a;
        seen.set(key, id);
      }
      return seen.get(key);
    });
  }
  return cfg;
}

// ---------------------------------------------------------------- validation

export function validate(cfg) {
  const errors = [];
  const { apps = {}, groups = {}, widgets = {}, users = {} } = cfg;
  const isUrl = (u) => { try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; } };

  for (const [id, a] of Object.entries(apps)) {
    if (!ID.test(id)) errors.push(`App id "${id}": use a-z, 0-9, "-" and "_"`);
    if (!a?.name) errors.push(`App "${id}" needs a name`);
    if (!isUrl(a?.url)) errors.push(`App "${id}" needs an http(s) address`);
    if (a?.ping && a.ping !== false && !isUrl(a.ping)) errors.push(`App "${id}": the status-check address must be http(s)`);
    if (a?.android && !ANDROID_PACKAGE.test(a.android)) errors.push(`App "${id}": the Android app id looks like com.example.app`);
    if (a?.appLink && !isAppLink(a.appLink)) errors.push(`App "${id}": the app link must look like myapp://… (not javascript:, data: or file:)`);
  }
  for (const [id, g] of Object.entries(groups)) {
    if (!ID.test(id)) errors.push(`Group id "${id}": use a-z, 0-9, "-" and "_"`);
    for (const a of g?.apps || []) if (!apps[a]) errors.push(`Group "${id}" lists unknown app "${a}"`);
  }
  for (const [id, w] of Object.entries(widgets)) {
    if (!ID.test(id)) errors.push(`Widget id "${id}": use a-z, 0-9, "-" and "_"`);
    if (!WIDGET_TYPES[w?.type]) errors.push(`Widget "${id}" has unknown type "${w?.type}"`);
    if (w?.app && !apps[w.app]) errors.push(`Widget "${id}" belongs to unknown app "${w.app}"`);
    for (const s of w?.sources || []) if (!widgets[s]) errors.push(`Widget "${id}" uses unknown source "${s}"`);
  }
  const views = [...(cfg.public ? [['The public view', cfg.public]] : []), ...Object.entries(users).map(([u, v]) => [`User "${u}"`, v])];
  for (const [who, v] of views) {
    for (const g of v?.groups || []) if (!groups[g]) errors.push(`${who} shows unknown group "${g}"`);
    for (const w of v?.widgets || []) if (!widgets[w]) errors.push(`${who} shows unknown widget "${w}"`);
  }
  for (const [id, u] of Object.entries(users)) {
    if (!USERNAME.test(id)) errors.push(`User name "${id}": use a-z, 0-9, "-" and "_" (at most 32)`);
    if (!PASSWORD_HASH.test(String(u?.password || ''))) errors.push(`User "${id}" needs a password`);
  }
  if (!cfg.public && !Object.keys(users).length) errors.push('Define a public view, at least one user, or both');
  for (const p of cfg.search?.providers || []) {
    if (!p.id || !p.name || !String(p.url || '').includes('{q}')) errors.push(`Search engine "${p.name || p.id || '?'}" needs an id, a name and an address containing {q}`);
  }
  return errors;
}

// ---------------------------------------------------------------- loading

function resolve(raw, secrets) {
  const value = (name) => secrets[name] ?? process.env[name] ?? '';
  const walk = (v) => (typeof v === 'string' ? v.replace(REF, (_, n) => value(n))
    : Array.isArray(v) ? v.map(walk)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  const config = walk(raw);
  // A widget whose ${SECRET} has no value is "not set up yet" rather than failing against its API.
  for (const [id, w] of Object.entries(raw.widgets || {})) {
    config.widgets[id].missing = [...new Set([...JSON.stringify(w).matchAll(REF)].map((m) => m[1]))].filter((n) => !value(n));
  }
  return config;
}

/** The current settings, re-read only when config.yaml or secrets.yaml changed. Keeps the last good ones on errors. */
export function getConfig() { return load().config; }

/** The settings as written (version 2, ${SECRET} references unresolved), for the settings page. */
export function getRawConfig() { return load().raw; }

function load() {
  const stamp = `${mtime(CONFIG_PATH)}:${mtime(SECRETS_PATH)}`;
  if (cached?.stamp === stamp) return cached;
  try {
    const raw = migrate(YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {});
    const errors = validate(raw);
    if (errors.length) throw new Error(errors.join('; '));
    const config = resolve(raw, readSecrets());
    const notSetUp = Object.entries(config.widgets || {}).filter(([, w]) => w.missing.length).map(([id, w]) => `${id} (${w.missing.join(', ')})`);
    cached = { stamp, raw, config };
    console.log(`[config] loaded ${CONFIG_PATH}${notSetUp.length ? `; not set up yet: ${notSetUp.join(', ')}` : ''}`);
  } catch (err) {
    if (!cached) throw err;
    console.error(`[config] reload failed, keeping previous settings: ${err.message}`);
    cached.stamp = stamp; // don't retry until a file changes again
  }
  return cached;
}

/** Validates and writes new settings; the previous file is kept in history/. Returns a list of errors (empty = saved). */
export function saveConfig(raw) {
  const errors = validate(raw);
  if (errors.length) return errors;
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  if (fs.existsSync(CONFIG_PATH)) {
    fs.copyFileSync(CONFIG_PATH, path.join(HISTORY_DIR, `config-${new Date().toISOString().replace(/[:.]/g, '-')}.yaml`));
    const old = fs.readdirSync(HISTORY_DIR).filter((f) => f.startsWith('config-')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - HISTORY_KEEP))) fs.rmSync(path.join(HISTORY_DIR, f));
  }
  const order = ['title', 'public', 'users', 'llm', 'search', 'apps', 'groups', 'widgets'];
  const sorted = Object.fromEntries([...order.filter((k) => k in raw), ...Object.keys(raw).filter((k) => !order.includes(k))].map((k) => [k, raw[k]]));
  atomicWrite(CONFIG_PATH, `# Launchy settings (edited from the settings page; earlier versions are in history/).\n${YAML.stringify(sorted, { lineWidth: 0 })}`, 0o644);
  cached = null;
  return [];
}

// ---------------------------------------------------------------- what a browser sees

/** The signed-in user's view, else the public view, else nothing (sign-in required). */
export function resolveViewer(cfg, username) {
  if (username && cfg.users?.[username]) return { id: username, user: true, admin: cfg.users[username].admin === true, view: cfg.users[username] };
  if (cfg.public) return { id: 'public', user: false, admin: false, view: cfg.public };
  return null;
}

/** The distinct apps a view shows, keyed by app id (also the key of the status checks). */
export function viewApps(cfg, view) {
  const ids = [...new Set((view.groups || []).flatMap((g) => cfg.groups[g].apps || []))];
  return ids.map((id) => ({ ...cfg.apps[id], key: id }));
}

/** Everything the browser needs for one view. Never includes passwords, widget settings, ping targets or secrets. */
export function publicConfig(cfg, viewer) {
  const v = viewer.view;
  const providers = (cfg.search?.providers || []).map(({ id, name, url, bang, suggest }) => ({ id, name, url, bang, suggest: Boolean(suggest) }));
  const visibleApps = new Set(viewApps(cfg, v).map((a) => a.key));
  return {
    title: cfg.title || 'Launchy',
    viewer: {
      id: viewer.id, user: viewer.user, admin: viewer.admin,
      name: v.name || viewer.id, greeting: v.greeting || '', theme: v.theme || {},
      search: v.search || cfg.search?.default || providers[0]?.id,
    },
    canLogin: Object.keys(cfg.users || {}).length > 0,
    search: { providers },
    groups: (v.groups || []).map((gid) => ({
      id: gid,
      title: cfg.groups[gid].title || gid,
      apps: (cfg.groups[gid].apps || []).map((id) => {
        const a = cfg.apps[id];
        return { key: id, name: a.name, url: a.url, icon: a.icon, description: a.description, tags: a.tags || [], monitored: a.ping !== false,
          android: a.android, appLink: a.appLink };
      }),
    })),
    // A widget belongs to its app's panel when this view shows that app; otherwise it is on the main page.
    widgets: (v.widgets || []).map((wid) => {
      const w = cfg.widgets[wid];
      return { id: wid, type: w.type, title: w.title || wid, url: w.link, refresh: widgetRefresh(w), app: visibleApps.has(w.app) ? w.app : null };
    }),
  };
}
