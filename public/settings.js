// Settings page: edits the whole configuration in the browser and saves it in one validated step.
// Secrets are write-only: the page sees only their names and whether they have a value.
const $ = (sel) => document.querySelector(sel);
const ICON_CDN = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/';
const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

const state = { config: null, saved: '', types: {}, secrets: [], me: '', section: 'users', selected: null };

// ---------------------------------------------------------------- DOM helper

/** h('div.class', { attr, onclick }, ...children) — children may be strings, nodes, arrays or null. */
function h(spec, attrs = {}, ...children) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

let uid = 0;
const field = (label, control, help) => {
  const id = control.id || (control.id = `f${++uid}`);
  return h('div.field', {}, h('label', { for: id }, label), control, help ? h('p.help', {}, help) : null);
};

const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const uniqueId = (base, taken) => { let id = base || 'item'; for (let i = 2; taken[id]; i++) id = `${base}-${i}`; return id; };

// Reading and writing "a.b" paths (widget fields like items.title).
const getAt = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function setAt(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const chain = [obj];
  for (const k of keys) chain.push((chain.at(-1)[k] ??= {}));
  if (value === '' || value == null) delete chain.at(-1)[last];
  else chain.at(-1)[last] = value;
  // An emptied object (e.g. theme with no fields left) is removed rather than saved as {}.
  for (let i = keys.length - 1; i >= 0 && !Object.keys(chain[i + 1]).length; i--) delete chain[i][keys[i]];
}

// ---------------------------------------------------------------- inputs bound to the model

function changed() {
  const dirty = JSON.stringify(state.config) !== state.saved;
  $('#savebar').hidden = !dirty;
  return dirty;
}

function text(obj, key, opts = {}) {
  return h('input', {
    type: opts.type || 'text', value: getAt(obj, key) ?? '', placeholder: opts.placeholder, autocomplete: 'off', spellcheck: 'false',
    oninput: (e) => {
      const v = opts.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value;
      setAt(obj, key, opts.list ? v.split(',').map((s) => s.trim()).filter(Boolean) : v);
      opts.onchange?.(v);
      changed();
    },
  });
}

function listText(obj, key, placeholder) {
  const input = text(obj, key, { list: true, placeholder });
  input.value = (getAt(obj, key) || []).join(', ');
  return input;
}

function select(obj, key, options, opts = {}) {
  const current = getAt(obj, key) ?? '';
  return h('select', {
    onchange: (e) => { setAt(obj, key, e.target.value); opts.onchange?.(e.target.value); changed(); },
  }, options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(current) }, label)));
}

function checkbox(obj, key, label, opts = {}) {
  return h('label.check', {}, h('input', {
    type: 'checkbox', checked: getAt(obj, key) === true,
    onchange: (e) => { setAt(obj, key, e.target.checked ? true : ''); opts.onchange?.(e.target.checked); changed(); },
  }), label);
}

/** An ordered selection (groups of a user, apps of a group, sources of a briefing): reorder, remove, add. */
function picker(obj, key, options, { empty = 'Nothing selected yet.' } = {}) {
  const box = h('div.picker');
  const labels = new Map(options);
  const draw = () => {
    const value = getAt(obj, key) || [];
    const rest = options.filter(([id]) => !value.includes(id));
    const move = (i, d) => { const v = [...value]; [v[i], v[i + d]] = [v[i + d], v[i]]; setAt(obj, key, v); draw(); changed(); };
    box.replaceChildren(
      value.length ? h('ol.picked', {}, value.map((id, i) => h('li', {},
        h('span', {}, labels.get(id) || `${id} (missing)`),
        h('button.icon-btn', { type: 'button', title: 'Move up', 'aria-label': `Move ${labels.get(id)} up`, disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
        h('button.icon-btn', { type: 'button', title: 'Move down', 'aria-label': `Move ${labels.get(id)} down`, disabled: i === value.length - 1, onclick: () => move(i, 1) }, '↓'),
        h('button.icon-btn', { type: 'button', title: 'Remove', 'aria-label': `Remove ${labels.get(id)}`, onclick: () => { setAt(obj, key, value.filter((x) => x !== id)); draw(); changed(); } }, '×'),
      ))) : h('p.muted', {}, empty),
      rest.length ? h('select.add', {
        'aria-label': 'Add',
        onchange: (e) => { if (!e.target.value) return; setAt(obj, key, [...value, e.target.value]); draw(); changed(); },
      }, h('option', { value: '' }, '+ Add…'), rest.map(([id, label]) => h('option', { value: id }, label))) : null,
    );
  };
  draw();
  return box;
}

/** A secret field holds a ${NAME} reference. "Set value" stores the value on the server and fills in the reference. */
function secretField(obj, key, suggestedName) {
  const input = text(obj, key, { placeholder: '${SECRET_NAME}', onchange: () => drawStatus() });
  const status = h('span.secret-status');
  const drawStatus = () => {
    const names = [...String(getAt(obj, key) || '').matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1]);
    const missing = names.filter((n) => !state.secrets.find((s) => s.name === n && s.source));
    status.textContent = !names.length ? (getAt(obj, key) ? 'stored in the settings file — prefer a secret' : '')
      : missing.length ? `no value for ${missing.join(', ')}` : 'value set';
    status.className = `secret-status ${missing.length || !names.length ? 'warn' : 'ok'}`;
  };
  drawStatus();
  const button = h('button.pill', {
    type: 'button',
    onclick: async () => {
      const current = String(getAt(obj, key) || '').match(/\$\{([A-Z0-9_]+)\}/)?.[1];
      const result = await ask('Set secret value', [
        { name: 'name', label: 'Secret name', value: current || suggestedName, pattern: SECRET_NAME, help: 'A-Z, 0-9 and _' },
        { name: 'value', label: 'Value', type: 'password' },
      ]);
      if (!result) return;
      await putSecret(result.name, result.value);
      setAt(obj, key, `\${${result.name}}`);
      input.value = `\${${result.name}}`;
      drawStatus();
      changed();
    },
  }, 'Set value…');
  return h('div.secret-field', {}, input, button, status);
}

function headersEditor(obj, key) {
  const box = h('div.headers');
  const draw = () => {
    const entries = Object.entries(getAt(obj, key) || {});
    const write = (list) => { setAt(obj, key, Object.fromEntries(list.filter(([k]) => k))); changed(); };
    box.replaceChildren(
      ...entries.map(([k, v], i) => h('div.header-row', {},
        h('input', { value: k, placeholder: 'Header', 'aria-label': 'Header name', oninput: (e) => { entries[i][0] = e.target.value; write(entries); } }),
        h('input', { value: v, placeholder: 'Value, e.g. Bearer ${TOKEN}', 'aria-label': 'Header value', oninput: (e) => { entries[i][1] = e.target.value; write(entries); } }),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Remove header', onclick: () => { entries.splice(i, 1); write(entries); draw(); } }, '×'))),
      h('button.pill', { type: 'button', onclick: () => { entries.push(['Authorization', '']); write(entries); draw(); } }, '+ Header'),
    );
  };
  draw();
  return box;
}

function iconPreview(icon, name) {
  const mono = h('span.monogram', {}, (name || '?').trim().charAt(0).toUpperCase());
  if (!icon) return mono;
  const src = /^(https?:)?\/\//.test(icon) || icon.startsWith('/') ? icon : /^[a-z0-9-]+$/.test(icon) ? `${ICON_CDN}${icon}.svg` : null;
  if (!src) return h('span.emoji', {}, icon);
  const img = h('img', { src, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(mono));
  return img;
}

// ---------------------------------------------------------------- server

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) { location.href = '/'; throw new Error('Sign in as an administrator'); }
  if (!res.ok) throw Object.assign(new Error((data.errors || [data.error || res.statusText]).join('\n')), { errors: data.errors });
  return data;
}

async function putSecret(name, value) {
  const data = await api('PUT', `/api/admin/secrets/${encodeURIComponent(name)}`, { value });
  state.secrets = data.secrets;
  toast(`Secret ${name} saved`);
}

async function save() {
  $('#save').disabled = true;
  try {
    const data = await api('PUT', '/api/admin/settings', { config: state.config });
    state.config = data.config;
    state.secrets = data.secrets;
    state.saved = JSON.stringify(state.config);
    showErrors([]);
    changed();
    render();
    toast('Saved. The start page uses the new settings now.');
  } catch (err) {
    showErrors(err.errors || [err.message]);
  } finally {
    $('#save').disabled = false;
  }
}

function showErrors(list) {
  const box = $('#errors');
  box.hidden = !list.length;
  box.replaceChildren(list.length ? h('div', {}, h('strong', {}, 'Not saved:'), h('ul', {}, list.map((e) => h('li', {}, e)))) : '');
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

/** A small form in a dialog. Resolves to { name: value } or null. */
function ask(title, fields) {
  const dialog = $('#ask');
  $('#ask-title').textContent = title;
  $('#ask-error').textContent = '';
  const inputs = fields.map((f) => {
    const input = h('input', { type: f.type || 'text', value: f.value || '', autocomplete: 'off', spellcheck: 'false', required: true });
    return { f, input, el: field(f.label, input, f.help) };
  });
  $('#ask-fields').replaceChildren(...inputs.map((i) => i.el));
  dialog.showModal();
  inputs[0].input.select();
  return new Promise((resolve) => {
    const form = $('#ask-form');
    const onCancel = () => done(null);
    const done = (value) => {
      form.removeEventListener('submit', onSubmit);
      dialog.removeEventListener('cancel', onCancel);
      $('#ask-cancel').onclick = null;
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onSubmit = (e) => {
      e.preventDefault();
      const out = {};
      for (const { f, input } of inputs) {
        const v = input.value.trim();
        if (f.pattern && !f.pattern.test(v)) { $('#ask-error').textContent = `${f.label}: ${f.help || 'not valid'}`; input.focus(); return; }
        if (f.taken?.[v]) { $('#ask-error').textContent = `${f.label} "${v}" already exists`; input.focus(); return; }
        out[f.name] = f.type === 'password' ? input.value : v;
      }
      done(out);
    };
    form.addEventListener('submit', onSubmit);
    $('#ask-cancel').onclick = onCancel;
    dialog.addEventListener('cancel', onCancel);
  });
}

// ---------------------------------------------------------------- references between things

const options = {
  apps: () => Object.entries(state.config.apps || {}).map(([id, a]) => [id, a.name || id]),
  groups: () => Object.entries(state.config.groups || {}).map(([id, g]) => [id, g.title || id]),
  widgets: () => Object.entries(state.config.widgets || {}).map(([id, w]) => [id, `${w.title || id} (${state.types[w.type]?.label || w.type})`]),
};

/** Removes every reference to a deleted app, group or widget so the settings stay valid. */
function removeRefs(kind, id) {
  const c = state.config;
  const views = [c.public, ...Object.values(c.users || {})].filter(Boolean);
  if (kind === 'apps') {
    for (const g of Object.values(c.groups || {})) g.apps = (g.apps || []).filter((a) => a !== id);
    for (const w of Object.values(c.widgets || {})) if (w.app === id) delete w.app;
  }
  if (kind === 'groups') for (const v of views) v.groups = (v.groups || []).filter((g) => g !== id);
  if (kind === 'widgets') {
    for (const v of views) v.widgets = (v.widgets || []).filter((w) => w !== id);
    for (const w of Object.values(c.widgets || {})) if (w.sources) w.sources = w.sources.filter((s) => s !== id);
  }
}

function usedBy(kind, id) {
  const c = state.config;
  const out = [];
  const views = [...(c.public ? [['public view', c.public]] : []), ...Object.entries(c.users || {})];
  if (kind === 'apps') for (const [gid, g] of Object.entries(c.groups || {})) if ((g.apps || []).includes(id)) out.push(`group ${g.title || gid}`);
  if (kind === 'groups') for (const [u, v] of views) if ((v.groups || []).includes(id)) out.push(u);
  if (kind === 'widgets') for (const [u, v] of views) if ((v.widgets || []).includes(id)) out.push(u);
  return out;
}

// ---------------------------------------------------------------- sections

const newEngines = new WeakSet();

/** App ids of common self-hosted apps, keyed by their dashboard-icons name (offered, never applied silently). */
const KNOWN_APPS = {
  'home-assistant': { android: 'io.homeassistant.companion.android', appLink: 'homeassistant://navigate/lovelace' },
  immich: { android: 'app.alextran.immich', appLink: 'immich://' },
  jellyfin: { android: 'org.jellyfin.mobile' },
  vaultwarden: { android: 'com.x8bit.bitwarden', appLink: 'bitwarden://' },
  bitwarden: { android: 'com.x8bit.bitwarden', appLink: 'bitwarden://' },
  seafile: { android: 'com.seafile.seadroid2' },
  nextcloud: { android: 'com.nextcloud.client', appLink: 'nc://' },
  'paperless-ngx': { android: 'de.astubenbord.paperless_mobile' },
  stripe: { android: 'com.stripe.android.dashboard' },
  instagram: { android: 'com.instagram.android', appLink: 'instagram://' },
  github: { android: 'com.github.android' },
  'microsoft-outlook': { android: 'com.microsoft.office.outlook', appLink: 'ms-outlook://' },
  syncthing: { android: 'com.github.catfriend1.syncthingandroid' },
};

const SECTIONS = [
  ['users', 'Users'], ['apps', 'Apps'], ['groups', 'Groups'], ['widgets', 'Widgets'],
  ['general', 'Start page'], ['search', 'Search'], ['ai', 'AI'], ['secrets', 'Secrets'],
];

/** A list of items on the left and the selected item's form on the right. */
function masterDetail({ kind, title, items, describe, editor, add, removable = () => true }) {
  const list = h('ul.md-list', {}, items.map(([id, item]) => h('li', {}, h('button', {
    type: 'button', class: state.selected === id ? 'active' : null, 'aria-current': state.selected === id ? 'true' : null,
    onclick: () => { state.selected = id; render(); },
  }, describe(id, item)))));
  const item = state.selected && items.find(([id]) => id === state.selected)?.[1];
  const detail = item
    ? h('div.md-detail', {},
      h('div.md-head', {}, h('h3', {}, item.name || item.title || state.selected), h('code', {}, state.selected),
        removable(state.selected) ? h('button.pill.danger', {
          type: 'button',
          onclick: () => {
            const used = usedBy(kind, state.selected);
            if (!confirm(`Delete ${state.selected}?${used.length ? `\nIt is removed from: ${used.join(', ')}.` : ''}`)) return;
            delete state.config[kind][state.selected];
            removeRefs(kind, state.selected);
            state.selected = null;
            changed();
            render();
          },
        }, 'Delete') : null),
      editor(state.selected, item))
    : h('div.md-detail.empty', {}, h('p.muted', {}, items.length ? `Choose ${title} on the left, or add one.` : `No ${title} yet.`));
  return h('div.md', {}, h('div.md-side', {}, h('button.primary', { type: 'button', onclick: add }, `+ Add ${title}`), list), detail);
}

const sectionRenderers = {
  users() {
    const c = state.config;
    c.users ||= {};
    return masterDetail({
      kind: 'users', title: 'user',
      items: Object.entries(c.users),
      describe: (id, u) => [h('strong', {}, u.name || id), h('span.muted', {}, ` ${id}${u.admin ? ' · admin' : ''}`)],
      removable: (id) => id !== state.me,
      add: async () => {
        const r = await ask('New user', [{ name: 'id', label: 'User name (for signing in)', pattern: /^[a-z0-9_-]{1,32}$/, help: 'a-z, 0-9, - and _', taken: c.users }]);
        if (!r) return;
        c.users[r.id] = { name: r.id, groups: [], widgets: [] };
        state.selected = r.id;
        changed(); render();
      },
      editor: (id, u) => h('div.form', {},
        h('div.row2', {}, field('Display name', text(u, 'name')), field('Greeting', text(u, 'greeting'), 'Shown as "Good morning, …"')),
        h('div.row2', {},
          field(u.passwordSet ? 'New password (leave empty to keep)' : 'Password', h('input', {
            type: 'password', autocomplete: 'new-password', value: u.newPassword || '',
            oninput: (e) => { setAt(u, 'newPassword', e.target.value); changed(); },
          }), u.passwordSet ? 'A password is set.' : 'At least 8 characters.'),
          h('div.field', {}, h('span.label', {}, 'Rights'), checkbox(u, 'admin', 'Administrator (can open these settings)'))),
        field('Groups on the start page', picker(u, 'groups', options.groups())),
        field('Widgets', picker(u, 'widgets', options.widgets()), 'A widget that belongs to an app appears in that app\'s panel; others (like the briefing) on the start page.'),
        h('h4', {}, 'Look'),
        h('div.row3', {},
          field('Accent colour', h('input', { type: 'color', value: u.theme?.accent || '#5b6cff', oninput: (e) => { setAt(u, 'theme.accent', e.target.value); changed(); } })),
          field('Light / dark', select(u, 'theme.mode', [['', 'Follow the device'], ['light', 'Light'], ['dark', 'Dark']])),
          field('Search engine', select(u, 'search', [['', 'Default'], ...(c.search?.providers || []).map((p) => [p.id, p.name])]))),
        h('div.row2', {}, field('Font (CSS)', text(u, 'theme.font', { placeholder: 'Georgia, serif' })), field('Background image address', text(u, 'theme.background', { type: 'url' })))),
    });
  },

  apps() {
    const c = state.config;
    c.apps ||= {};
    return masterDetail({
      kind: 'apps', title: 'app',
      items: Object.entries(c.apps).sort(([, a], [, b]) => String(a.name).localeCompare(b.name)),
      describe: (id, a) => [h('span.md-icon', {}, iconPreview(a.icon, a.name)), h('span', {}, a.name || id)],
      add: async () => {
        const r = await ask('New app', [{ name: 'name', label: 'Name' }, { name: 'url', label: 'Address', value: 'https://' }]);
        if (!r) return;
        const id = uniqueId(slug(r.name), c.apps);
        c.apps[id] = { name: r.name, url: r.url };
        state.selected = id;
        changed(); render();
      },
      editor: (id, a) => {
        const preview = h('span.icon-preview', {}, iconPreview(a.icon, a.name));
        const pingMode = a.ping === false ? 'off' : a.ping ? 'custom' : 'url';
        const pingBox = h('div');
        const drawPing = (mode) => pingBox.replaceChildren(mode === 'custom' ? field('Status check address', text(a, 'ping', { type: 'url', placeholder: 'http://192.168.1.10:8080' }), 'An internal address the server can reach.') : '');
        drawPing(pingMode);
        return h('div.form', {},
          h('div.row2', {}, field('Name', text(a, 'name')), field('Description', text(a, 'description'))),
          field('Address', text(a, 'url', { type: 'url' })),
          h('div.row-icon', {}, field('Icon', text(a, 'icon', { onchange: () => preview.replaceChildren(iconPreview(a.icon, a.name)) }),
            h('span', {}, 'A name from ', h('a', { href: 'https://dashboard-icons.dev', target: '_blank', rel: 'noopener' }, 'dashboard-icons.dev'), ', an image address, or an emoji.')), preview),
          field('Search words', listText(a, 'tags', 'movies, tv'), 'Comma-separated; the search box also finds the app by these.'),
          h('h4', {}, 'Installed app'),
          h('p.help', {}, 'Where the app is installed, a click on the tile opens it instead of the web page (Ctrl+click and the panel still offer the web page). Leave empty to always use the web page.'),
          h('div.row2', {},
            field('Android app id', text(a, 'android', { placeholder: 'io.homeassistant.companion.android' }), 'From the app\'s Play Store address (…?id=…).'),
            field('App link (computer, iPhone)', text(a, 'appLink', { placeholder: 'homeassistant://' }), 'A link scheme the app registers, e.g. bitwarden://')),
          KNOWN_APPS[a.icon] && (a.android !== KNOWN_APPS[a.icon].android || a.appLink !== KNOWN_APPS[a.icon].appLink)
            ? h('button.pill', { type: 'button', onclick: () => { Object.assign(a, KNOWN_APPS[a.icon]); for (const k of ['android', 'appLink']) if (!a[k]) delete a[k]; changed(); render(); } },
              `Use the known ${a.name} app ids`)
            : null,
          field('Status dot', h('select', {
            onchange: (e) => { const m = e.target.value; if (m === 'off') a.ping = false; else if (m === 'url') delete a.ping; else a.ping ||= ''; drawPing(m); changed(); },
          }, [['url', 'Check the address above'], ['custom', 'Check another address'], ['off', 'No status dot']].map(([v, l]) => h('option', { value: v, selected: v === pingMode }, l)))),
          pingBox,
          h('p.muted', {}, `In groups: ${usedBy('apps', id).join(', ') || 'none'}`));
      },
    });
  },

  groups() {
    const c = state.config;
    c.groups ||= {};
    return masterDetail({
      kind: 'groups', title: 'group',
      items: Object.entries(c.groups),
      describe: (id, g) => [h('span', {}, g.title || id), h('span.muted', {}, ` ${(g.apps || []).length}`)],
      add: async () => {
        const r = await ask('New group', [{ name: 'title', label: 'Title' }]);
        if (!r) return;
        const id = uniqueId(slug(r.title), c.groups);
        c.groups[id] = { title: r.title, apps: [] };
        state.selected = id;
        changed(); render();
      },
      editor: (id, g) => h('div.form', {},
        field('Title', text(g, 'title')),
        field('Apps', picker(g, 'apps', options.apps())),
        h('p.muted', {}, `Shown to: ${usedBy('groups', id).join(', ') || 'nobody yet'}`)),
    });
  },

  widgets() {
    const c = state.config;
    c.widgets ||= {};
    const typeOptions = Object.entries(state.types).map(([t, d]) => [t, d.label]);
    return masterDetail({
      kind: 'widgets', title: 'widget',
      items: Object.entries(c.widgets),
      describe: (id, w) => h('span.two-line', {}, h('span', {}, w.title || id, h('span.muted', {}, ` ${w.app ? `→ ${c.apps?.[w.app]?.name || w.app}` : '· start page'}`)), h('small.muted', {}, id)),
      add: async () => {
        const r = await ask('New widget', [{ name: 'title', label: 'Title' }]);
        if (!r) return;
        const id = uniqueId(slug(r.title), c.widgets);
        c.widgets[id] = { type: 'http', title: r.title };
        state.selected = id;
        changed(); render();
      },
      editor: (id, w) => {
        const typeBox = h('div.form');
        const drawType = () => typeBox.replaceChildren(...(state.types[w.type]?.fields || []).map((f) => {
          const control = f.type === 'secret' ? secretField(w, f.key, `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${f.key.toUpperCase()}`)
            : f.type === 'select' ? select(w, f.key, f.options)
            : f.type === 'headers' ? headersEditor(w, f.key)
            : f.type === 'widgets' ? picker(w, f.key, options.widgets().filter(([wid]) => wid !== id && c.widgets[wid].type !== 'ai'))
            : text(w, f.key, { type: f.type === 'number' ? 'number' : f.type === 'url' ? 'url' : 'text' });
          return field(`${f.label}${f.required ? '' : ''}`, control, f.help);
        }));
        drawType();
        return h('div.form', {},
          h('div.row2', {}, field('Title', text(w, 'title')),
            field('Type', select(w, 'type', typeOptions, { onchange: () => drawType() }))),
          field('Shown in', select(w, 'app', [['', 'The start page (like the briefing)'], ...options.apps().map(([a, n]) => [a, `${n} — app panel`])]),
            'In an app\'s panel it also puts a badge on the app\'s tile when there is something to look at.'),
          typeBox,
          h('p.muted', {}, `Shown to: ${usedBy('widgets', id).join(', ') || 'nobody yet — add it to a user'}`));
      },
    });
  },

  general() {
    const c = state.config;
    const pub = c.public;
    return h('div.form.narrow', {},
      field('Page title', text(c, 'title', { placeholder: 'Launchy' })),
      h('h4', {}, 'Without signing in'),
      h('label.check', {}, h('input', {
        type: 'checkbox', checked: Boolean(pub),
        onchange: (e) => { if (e.target.checked) c.public = { name: 'Guest', groups: [], widgets: [] }; else delete c.public; changed(); render(); },
      }), 'Show a public start page to visitors who are not signed in'),
      pub ? [
        field('Groups', picker(pub, 'groups', options.groups())),
        field('Widgets', picker(pub, 'widgets', options.widgets()), 'Anything shown here is visible to anyone who can open the page.'),
      ] : h('p.muted', {}, 'Visitors see only the sign-in form.'));
  },

  search() {
    const c = state.config;
    c.search ||= { providers: [] };
    c.search.providers ||= [];
    const rows = c.search.providers.map((p, i) => h('tr', {},
      ['name', 'bang', 'url', 'suggest'].map((k) => h('td', {}, h('input', {
        value: p[k] || '', 'aria-label': k, placeholder: { url: 'https://…?q={q}', suggest: 'optional', bang: 'g' }[k],
        oninput: (e) => {
          // A new engine's id follows its name until saved; existing ids stay (users may refer to them).
          if (k === 'name' && newEngines.has(p)) p.id = slug(e.target.value);
          setAt(p, k, e.target.value);
          changed();
        },
      }))),
      h('td', {}, h('button.icon-btn', { type: 'button', 'aria-label': `Remove ${p.name}`, onclick: () => { c.search.providers.splice(i, 1); changed(); render(); } }, '×'))));
    return h('div.form', {},
      field('Default engine', select(c.search, 'default', c.search.providers.map((p) => [p.id, p.name]))),
      h('table.engines', {}, h('thead', {}, h('tr', {}, ['Name', 'Shortcut (!x)', 'Address ({q} = query)', 'Suggestions address', ''].map((t) => h('th', {}, t)))), h('tbody', {}, rows)),
      h('button.pill', { type: 'button', onclick: () => { const p = { id: '', name: '', url: '' }; newEngines.add(p); c.search.providers.push(p); changed(); render(); } }, '+ Engine'),
      h('p.help', {}, 'Suggestions must return OpenSearch JSON: ["query", ["suggestion", …]].'));
  },

  ai() {
    const c = state.config;
    c.llm ||= { provider: 'local' };
    const l = c.llm;
    return h('div.form.narrow', {},
      field('Model provider', select(l, 'provider', [['local', 'My own server (Ollama, llama.cpp, LM Studio, vLLM)'], ['claude', 'Claude (Anthropic API)']], { onchange: () => render() })),
      l.provider === 'claude'
        ? [field('Model', text(l, 'model', { placeholder: 'claude-opus-5-5' })), field('API key', secretField(l, 'key', 'ANTHROPIC_API_KEY')),
          field('Effort', select(l, 'effort', [['', 'Low (default)'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]))]
        : [field('Server address', text(l, 'url', { type: 'url', placeholder: 'http://192.168.1.10:11434/v1' }), 'OpenAI-compatible endpoint; for Ollama end it with /v1.'),
          field('Model', text(l, 'model', { placeholder: 'gemma3:12b' }))],
      h('p.help', {}, 'Briefings (widgets of type "AI briefing") use this model.'));
  },

  secrets() {
    const rows = state.secrets.map((s) => h('tr', {},
      h('td', {}, h('code', {}, s.name)),
      h('td', {}, s.source === 'settings' ? 'set here' : s.source === 'environment' ? 'from the server environment' : h('span.warn', {}, 'no value')),
      h('td', {}, s.used ? 'in use' : h('span.muted', {}, 'not used')),
      h('td.actions', {},
        h('button.pill', { type: 'button', onclick: async () => { const r = await ask(`Value of ${s.name}`, [{ name: 'value', label: 'Value', type: 'password' }]); if (r) { await putSecret(s.name, r.value); render(); } } }, s.source ? 'Replace…' : 'Set…'),
        s.source === 'settings' ? h('button.pill.danger', {
          type: 'button',
          onclick: async () => { if (!confirm(`Remove the value of ${s.name}?`)) return; state.secrets = (await api('DELETE', `/api/admin/secrets/${s.name}`)).secrets; render(); },
        }, 'Remove') : null)));
    return h('div.form', {},
      h('p.help', {}, 'Tokens and keys are stored on the server and never shown again. Settings refer to them as ${NAME}.'),
      h('table.secrets', {}, h('tbody', {}, rows)),
      h('button.primary', {
        type: 'button',
        onclick: async () => {
          const r = await ask('New secret', [{ name: 'name', label: 'Name', pattern: SECRET_NAME, help: 'A-Z, 0-9 and _' }, { name: 'value', label: 'Value', type: 'password' }]);
          if (r) { await putSecret(r.name, r.value); render(); }
        },
      }, '+ Add secret'));
  },
};

// ---------------------------------------------------------------- page

function render() {
  $('#nav').replaceChildren(...SECTIONS.map(([id, label]) => h('a', {
    href: `#${id}`, class: state.section === id ? 'active' : null, 'aria-current': state.section === id ? 'page' : null,
  }, label)));
  const [, label] = SECTIONS.find(([id]) => id === state.section);
  $('#main').replaceChildren(h('h2', {}, label), sectionRenderers[state.section]());
}

window.addEventListener('hashchange', () => {
  const section = location.hash.slice(1);
  if (sectionRenderers[section] && section !== state.section) { state.section = section; state.selected = null; render(); }
});
$('#save').addEventListener('click', save);
$('#discard').addEventListener('click', () => {
  if (!confirm('Discard all unsaved changes?')) return;
  state.config = JSON.parse(state.saved);
  showErrors([]); changed(); render();
});
window.addEventListener('beforeunload', (e) => { if (state.config && changed()) e.preventDefault(); });
document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (changed()) save(); } });

try {
  const data = await api('GET', '/api/admin/settings');
  Object.assign(state, { config: data.config, types: data.types, secrets: data.secrets, me: data.me, saved: JSON.stringify(data.config) });
  const section = location.hash.slice(1);
  if (sectionRenderers[section]) state.section = section;
  render();
} catch (err) {
  $('#main').replaceChildren(h('p.widget-error', {}, err.message));
}
