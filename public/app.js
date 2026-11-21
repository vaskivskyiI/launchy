const $ = (sel) => document.querySelector(sel);
const store = {
  get(key) { try { return localStorage.getItem(`launchy.${key}`); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(`launchy.${key}`, value); } catch { /* private mode */ } },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ICON_CDN = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/';

let cfg;            // public config of the current viewer (a user or the public view)
let provider;       // active search provider
const timers = [];  // polling intervals, cleared when the viewer changes

// ---------------------------------------------------------------- boot

async function load() {
  timers.splice(0).forEach(clearInterval);
  const res = await fetch('/api/config');
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) return showLogin({ required: true, title: body.title });
  if (!res.ok) throw new Error(body.error || res.statusText);
  cfg = body;
  document.body.classList.remove('locked');

  document.title = cfg.title;
  applyTheme(cfg.viewer.theme);
  renderAccount();
  provider = cfg.search.providers.find((p) => p.id === store.get(`provider.${cfg.viewer.id}`))
    || cfg.search.providers.find((p) => p.id === cfg.viewer.search) || cfg.search.providers[0];
  renderProvider();
  renderApps();
  renderWidgets();
  refreshStatus();
  timers.push(setInterval(refreshStatus, 60_000));
  tickClock();
}

function applyTheme(theme) {
  const root = document.documentElement;
  root.style.setProperty('--accent', theme.accent || '#5b6cff');
  if (theme.mode === 'light' || theme.mode === 'dark') root.dataset.theme = theme.mode; else delete root.dataset.theme;
  if (theme.font) root.style.setProperty('--font', theme.font);
  const backdrop = $('.backdrop');
  backdrop.classList.toggle('image', Boolean(theme.background));
  backdrop.style.backgroundImage = theme.background ? `url("${theme.background.replace(/["\\\s]/g, encodeURIComponent)}")` : '';
}

// ---------------------------------------------------------------- account

const loginDialog = $('#login');
const loginForm = $('#login-form');

function renderAccount() {
  const el = $('#account');
  if (cfg.viewer.user) {
    el.innerHTML = `<span class="who">${esc(cfg.viewer.name)}</span><button type="button" class="pill" id="logout">Sign out</button>`;
    $('#logout').addEventListener('click', logout);
  } else {
    el.innerHTML = cfg.canLogin ? '<button type="button" class="pill" id="signin">Sign in</button>' : '';
    $('#signin')?.addEventListener('click', () => showLogin({ required: false }));
  }
}

function showLogin({ required, title }) {
  if (required) {
    document.body.classList.add('locked');
    if (title) document.title = title;
  }
  loginDialog.dataset.required = String(required);
  $('#login-error').textContent = '';
  loginForm.reset();
  if (!loginDialog.open) loginDialog.showModal();
}

loginDialog.addEventListener('cancel', (e) => { if (loginDialog.dataset.required === 'true') e.preventDefault(); });
$('#login-cancel').addEventListener('click', () => {
  if (loginDialog.dataset.required !== 'true') loginDialog.close();
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = loginForm.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: loginForm.username.value, password: loginForm.password.value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Sign-in failed.');
    loginDialog.close();
    await load();
  } catch (err) {
    $('#login-error').textContent = err.message;
    loginForm.password.select();
  } finally {
    button.disabled = false;
  }
});

async function logout() {
  await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await load();
}

function tickClock() {
  const now = new Date();
  $('#time').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const h = now.getHours();
  const part = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const name = cfg?.viewer.greeting ? `, ${cfg.viewer.greeting}` : '';
  $('#greeting').textContent = `${part}${name} · ${now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}`;
}

// ---------------------------------------------------------------- apps

function iconHtml(icon, name) {
  const mono = `<span class="monogram">${esc((name || '?').trim().charAt(0).toUpperCase())}</span>`;
  if (!icon) return mono;
  let src;
  if (/^(https?:)?\/\//.test(icon) || icon.startsWith('/')) src = icon;
  else if (/^[a-z0-9-]+$/.test(icon)) src = `${ICON_CDN}${icon}.svg`;
  else return `<span class="emoji">${esc(icon)}</span>`;
  // Fall back to the monogram if the icon cannot load.
  return `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML=this.dataset.fallback" data-fallback="${esc(mono)}">`;
}

function renderApps() {
  $('#apps').innerHTML = cfg.groups.map((g) => `
    <section class="group">
      <h2>${esc(g.title)}</h2>
      <div class="grid">
        ${g.apps.map((a) => `
          <a class="tile" href="${esc(a.url)}" data-key="${esc(a.key)}" title="${esc(a.description || a.url)}">
            <span class="icon">${iconHtml(a.icon, a.name)}</span>
            <span class="text"><div class="name">${esc(a.name)}</div>${a.description ? `<div class="desc">${esc(a.description)}</div>` : ''}</span>
            ${a.monitored ? '<span class="dot" role="img" aria-label="status unknown"></span>' : ''}
          </a>`).join('')}
      </div>
    </section>`).join('');
}

async function refreshStatus() {
  const res = await fetch('/api/status').catch(() => null);
  if (!res?.ok) return;
  const status = await res.json();
  for (const tile of document.querySelectorAll('.tile[data-key]')) {
    const dot = tile.querySelector('.dot');
    const s = status[tile.dataset.key];
    if (!dot || !s) continue;
    dot.className = `dot ${s}`;
    dot.setAttribute('aria-label', s === 'up' ? 'online' : 'offline');
  }
}

// ---------------------------------------------------------------- widgets

function renderText(text) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => /^[-*•]\s/.test(l));
  if (bullets.length && bullets.length === lines.length) {
    return `<ul>${bullets.map((l) => `<li>${inline(l.replace(/^[-*•]\s+/, ''))}</li>`).join('')}</ul>`;
  }
  return lines.map((l) => `<p>${inline(l)}</p>`).join('');
}

function renderWidgetData(body, data) {
  if (data.notice) { body.innerHTML = `<p class="widget-notice">${esc(data.notice)}</p>`; return; }
  let html = '';
  if (data.stats?.length) {
    html += `<div class="stats">${data.stats.map((s) => `
      <div class="stat ${s.tone ? esc(s.tone) : ''}"><div class="value">${esc(s.value)}</div><div class="label">${esc(s.label)}</div></div>`).join('')}</div>`;
  }
  if (data.items?.length) {
    html += `<ul class="items">${data.items.map((it) => {
      const inner = `<span class="main"><div class="title">${esc(it.title)}</div>${it.subtitle ? `<div class="sub">${esc(it.subtitle)}</div>` : ''}</span>
        ${it.meta ? `<span class="meta">${esc(it.meta)}</span>` : ''}`;
      return `<li>${it.url && /^https?:/.test(it.url) ? `<a class="row" href="${esc(it.url)}" target="_blank" rel="noopener">${inner}</a>` : `<div class="row">${inner}</div>`}</li>`;
    }).join('')}</ul>`;
  }
  if (data.text) html += `<div class="widget-text">${renderText(data.text)}</div>`;
  body.innerHTML = html || '<div class="widget-text"><p>No data.</p></div>';
}

function renderWidgets() {
  const aside = $('#widgets');
  aside.innerHTML = '';
  $('.layout').classList.toggle('no-widgets', !cfg.widgets.length);
  for (const w of cfg.widgets) {
    const el = $('#widget-tpl').content.firstElementChild.cloneNode(true);
    el.querySelector('h2').textContent = w.title;
    el.dataset.type = w.type;
    if (w.url) Object.assign(el.querySelector('.widget-link'), { href: w.url, hidden: false });
    aside.append(el);
    const body = el.querySelector('.widget-body');
    const update = async () => {
      try {
        const res = await fetch(`/api/widget/${encodeURIComponent(w.id)}`);
        if (res.status === 401) return load(); // session ended (signed out elsewhere or password changed)
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        renderWidgetData(body, data);
      } catch (err) {
        body.innerHTML = `<p class="widget-error">${esc(err.message)}</p>`;
      }
    };
    update();
    timers.push(setInterval(update, Math.max(w.refresh, 15) * 1000));
  }
}

// ---------------------------------------------------------------- search

const input = $('#q');
const resultsEl = $('#results');
const providerBtn = $('#provider');
const providerMenu = $('#provider-menu');
let results = [];
let selected = 0;
let suggestions = [];
let suggestTimer;
let suggestSeq = 0;

function renderProvider() {
  providerBtn.textContent = provider?.name || 'Search';
  providerMenu.innerHTML = cfg.search.providers.map((p) => `
    <li role="option" data-id="${esc(p.id)}" aria-selected="${p.id === provider?.id}">
      <span>${esc(p.name)}</span>${p.bang ? `<span class="bang">!${esc(p.bang)}</span>` : ''}
    </li>`).join('');
}

function setProviderMenu(open) {
  providerMenu.hidden = !open;
  providerBtn.setAttribute('aria-expanded', String(open));
  if (open) closeResults();
}

providerBtn.addEventListener('click', () => setProviderMenu(providerMenu.hidden));
providerMenu.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  provider = cfg.search.providers.find((p) => p.id === li.dataset.id);
  store.set(`provider.${cfg.viewer.id}`, provider.id);
  renderProvider();
  setProviderMenu(false);
  input.focus();
  update();
});

const searchUrl = (p, q) => p.url.replace('{q}', encodeURIComponent(q));
const looksLikeUrl = (q) => /^https?:\/\/\S+$/i.test(q) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(q) || /^localhost(:\d+)?(\/\S*)?$/.test(q);

function parseQuery(raw) {
  const m = raw.match(/^!(\S+)\s*(.*)$/);
  const bangProvider = m && cfg.search.providers.find((p) => p.bang === m[1]);
  return bangProvider ? { p: bangProvider, q: m[2] } : { p: provider, q: raw };
}

function scoreApp(app, q) {
  const name = app.name.toLowerCase();
  if (name.startsWith(q)) return 3;
  if (name.split(/[\s\-_.]+/).some((w) => w.startsWith(q))) return 2;
  if (name.includes(q)) return 1;
  if ([app.description, ...app.tags].some((t) => t?.toLowerCase().includes(q))) return 0.5;
  return 0;
}

function update() {
  const raw = input.value.trim();
  if (!raw) return closeResults();
  const { p, q } = parseQuery(raw);
  const lower = q.toLowerCase();
  const apps = lower ? cfg.groups.flatMap((g) => g.apps)
    .map((a) => ({ a, s: scoreApp(a, lower) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).slice(0, 5) : [];
  const appResults = apps.map(({ a }) => ({ kind: 'App', label: a.name, icon: iconHtml(a.icon, a.name), url: a.url }));
  const web = q ? [{ kind: p.name, label: q, icon: '⌕', url: searchUrl(p, q), primary: true }] : [];
  const go = looksLikeUrl(raw) ? [{ kind: 'Open', label: raw, icon: '↗', url: /^https?:/i.test(raw) ? raw : `http://${raw}` }] : [];
  const sugg = suggestions.filter((s) => s.toLowerCase() !== lower)
    .map((s) => ({ kind: '', label: s, icon: '⌕', url: searchUrl(p, s) }));
  const strongApp = apps[0]?.s >= 2 && p === provider; // a bang means "search", not "open app"
  results = [...go, ...(strongApp ? [...appResults, ...web] : [...web, ...appResults]), ...sugg];
  selected = 0;
  renderResults();
  queueSuggest(p, q);
}

function renderResults() {
  if (!results.length) return closeResults();
  resultsEl.innerHTML = results.map((r, i) => `
    <li role="option" id="r${i}" aria-selected="${i === selected}" data-i="${i}">
      <span class="ico">${r.icon.startsWith('<') ? r.icon : esc(r.icon)}</span>
      <span>${esc(r.label)}</span>
      <span class="kind">${esc(r.kind)}</span>
    </li>`).join('');
  resultsEl.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-activedescendant', `r${selected}`);
}

function closeResults() {
  results = [];
  resultsEl.hidden = true;
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}

function queueSuggest(p, q) {
  clearTimeout(suggestTimer);
  if (!p.suggest || !q) { suggestions = []; return; }
  suggestTimer = setTimeout(async () => {
    const seq = ++suggestSeq;
    const res = await fetch(`/api/suggest?provider=${encodeURIComponent(p.id)}&q=${encodeURIComponent(q)}`).catch(() => null);
    const list = res?.ok ? await res.json() : [];
    if (seq !== suggestSeq || parseQuery(input.value.trim()).q !== q) return; // stale
    suggestions = list;
    const keep = results[selected]?.url;
    update();
    const idx = results.findIndex((r) => r.url === keep);
    if (idx > 0) { selected = idx; renderResults(); }
  }, 160);
}

function open(url, newTab) {
  if (newTab) window.open(url, '_blank', 'noopener');
  else location.href = url;
}

input.addEventListener('input', () => { suggestions = []; update(); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!results.length) return;
    e.preventDefault();
    selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
    renderResults();
  } else if (e.key === 'Enter' && results.length) {
    e.preventDefault();
    open(results[selected].url, e.ctrlKey || e.metaKey);
  } else if (e.key === 'Escape') {
    if (!resultsEl.hidden) closeResults(); else { input.value = ''; input.blur(); }
  }
});
$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = input.value.trim();
  if (!raw) return;
  const { p, q } = parseQuery(raw);
  if (q) open(searchUrl(p, q));
});
resultsEl.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  e.preventDefault();
  open(results[Number(li.dataset.i)].url, e.ctrlKey || e.metaKey || e.button === 1);
});
input.addEventListener('blur', () => setTimeout(closeResults, 100));

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === '/' && !typing) { e.preventDefault(); input.focus(); }
  else if (!typing && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) input.focus(); // type anywhere to search
  else if (e.key === 'Escape' && !providerMenu.hidden) { setProviderMenu(false); providerBtn.focus(); }
});
document.addEventListener('click', (e) => {
  if (!providerMenu.hidden && !e.target.closest('#provider, #provider-menu')) setProviderMenu(false);
});

// ---------------------------------------------------------------- start

setInterval(() => cfg && tickClock(), 1000);
load().catch((err) => {
  $('#apps').innerHTML = `<p class="widget-error">Could not load settings: ${esc(err.message)}</p>`;
});
