// Loads config.yaml, substitutes ${ENV} references, reloads when the file changes,
// and builds the secret-free view the browser receives.
import fs from 'node:fs';
import YAML from 'yaml';
import { widgetRefresh } from './widgets.js';

const CONFIG_PATH = process.env.LAUNCHY_CONFIG || 'config/config.yaml';

let cached = null; // { mtimeMs, config }

const ENV_REF = /\$\{([A-Z0-9_]+)\}/gi;
const isUnset = (name) => !process.env[name];

function substituteEnv(value) {
  if (typeof value === 'string') return value.replace(ENV_REF, (_, name) => process.env[name] ?? '');
  if (Array.isArray(value)) return value.map(substituteEnv);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteEnv(v)]));
  }
  return value;
}

const USERNAME = /^[a-z0-9_-]{1,32}$/;

function validate(cfg) {
  const errors = [];
  const groups = cfg.groups || {};
  const widgets = cfg.widgets || {};
  const users = cfg.users || {};
  if (cfg.profiles) errors.push('"profiles" was replaced by "users" (with passwords) and "public"');
  if (!cfg.public && !Object.keys(users).length) errors.push('define a "public" view, at least one user, or both');
  const views = [...(cfg.public ? [['public', cfg.public]] : []), ...Object.entries(users)];
  for (const [id, v] of views) {
    for (const g of v.groups || []) if (!groups[g]) errors.push(`${id} references unknown group "${g}"`);
    for (const w of v.widgets || []) if (!widgets[w]) errors.push(`${id} references unknown widget "${w}"`);
  }
  for (const [id, u] of Object.entries(users)) {
    if (!USERNAME.test(id)) errors.push(`user name "${id}" may only use a-z, 0-9, "-" and "_"`);
    if (!/^scrypt:[A-Za-z0-9+/]{22}==:[A-Za-z0-9+/]{43}=$/.test(String(u.password || ''))) errors.push(`user "${id}" needs a password hash (npm run hash-password)`);
  }
  for (const [id, w] of Object.entries(widgets)) {
    for (const s of w.sources || []) if (!widgets[s]) errors.push(`widget "${id}" references unknown source "${s}"`);
  }
  if (errors.length) throw new Error(errors.join('; '));
  return cfg;
}

/** Returns the current config, re-reading the file only when it changed. Keeps the last good config on errors. */
export function getConfig() {
  const { mtimeMs } = fs.statSync(CONFIG_PATH);
  if (cached && cached.mtimeMs === mtimeMs) return cached.config;
  try {
    const raw = YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
    const config = validate(substituteEnv(raw));
    // A widget whose ${SECRET} is unset is "not set up yet" (shown as such) rather than failing against its API.
    const notSetUp = [];
    for (const [id, w] of Object.entries(raw.widgets || {})) {
      const missing = [...new Set([...JSON.stringify(w).matchAll(ENV_REF)].map((m) => m[1]))].filter(isUnset);
      config.widgets[id].missing = missing;
      if (missing.length) notSetUp.push(`${id} (${missing.join(', ')})`);
    }
    cached = { mtimeMs, config };
    console.log(`[config] loaded ${CONFIG_PATH}${notSetUp.length ? `; not set up yet: ${notSetUp.join(', ')}` : ''}`);
  } catch (err) {
    if (!cached) throw err;
    console.error(`[config] reload failed, keeping previous config: ${err.message}`);
    cached.mtimeMs = mtimeMs; // don't retry until the file changes again
  }
  return cached.config;
}

/** What a request may see: the signed-in user's view, else the public view, else nothing (login required). */
export function resolveViewer(cfg, username) {
  if (username && cfg.users?.[username]) return { id: username, user: true, view: cfg.users[username] };
  if (cfg.public) return { id: 'public', user: false, view: cfg.public };
  return null;
}

/** Apps of a view, each with a stable key `group:index` shared by the client and the status checker. */
export function viewApps(cfg, view) {
  return (view.groups || []).flatMap((gid) =>
    (cfg.groups[gid].apps || []).map((app, i) => ({ ...app, key: `${gid}:${i}` })));
}

/** Everything the browser needs for one view. Never includes passwords, widget settings, ping targets or secrets. */
export function publicConfig(cfg, viewer) {
  const v = viewer.view;
  const providers = (cfg.search?.providers || []).map(({ id, name, url, bang, suggest }) =>
    ({ id, name, url, bang, suggest: Boolean(suggest) }));
  return {
    title: cfg.title || 'Launchy',
    viewer: {
      id: viewer.id,
      user: viewer.user,
      name: v.name || viewer.id,
      greeting: v.greeting || '',
      theme: v.theme || {},
      search: v.search || cfg.search?.default || providers[0]?.id,
    },
    canLogin: Object.keys(cfg.users || {}).length > 0,
    search: { providers },
    groups: (v.groups || []).map((gid) => ({
      id: gid,
      title: cfg.groups[gid].title || gid,
      apps: (cfg.groups[gid].apps || []).map((a, i) => ({
        key: `${gid}:${i}`, name: a.name, url: a.url, icon: a.icon, description: a.description, tags: a.tags || [],
        monitored: a.ping !== false,
      })),
    })),
    widgets: (v.widgets || []).map((wid) => {
      const w = cfg.widgets[wid];
      return { id: wid, type: w.type, title: w.title || wid, url: w.link, refresh: widgetRefresh(w) };
    }),
  };
}
