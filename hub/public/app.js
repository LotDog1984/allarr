import { api, setUnauthorizedHandler, connectEvents } from './api.js';
import { h, icon, button, badge, toast, copyText, modal, formatBytes, greeting, exposedUrl, spinner, fill, timeAgo } from './ui.js';
import { S, mod, go, refreshMe, loadCatalog, STATE_TEXT, progressList, progressSummary } from './store.js';
import { renderLogin, renderWizard, appPicker } from './wizard.js';

const root = document.getElementById('root');

// ─────────────────────────────────────────────────────────────── live status painting ───
const stateOf = (id) => S.statuses.get(id)?.state ?? 'stopped';
const enabled = () => S.catalog.modules.filter((m) => S.statuses.has(m.id));

function paintStatus() {
  for (const el of document.querySelectorAll('[data-dot]')) {
    el.className = `dot ${stateOf(el.dataset.dot)}`;
    el.title = STATE_TEXT[stateOf(el.dataset.dot)] ?? '';
  }
  for (const el of document.querySelectorAll('[data-state]')) {
    const st = stateOf(el.dataset.state);
    el.textContent = STATE_TEXT[st] ?? st;
    el.className = `pill ${st === 'running' ? 'pill-ok' : st === 'starting' ? 'pill-warn' : 'pill-err'}`;
  }
  for (const el of document.querySelectorAll('[data-hint]')) {
    const s = S.statuses.get(el.dataset.hint);
    el.textContent = s && !s.up && s.hint && ['crashed', 'missing'].includes(s.state) ? s.hint : '';
  }
  for (const el of document.querySelectorAll('[data-version]')) {
    const v = S.statuses.get(el.dataset.version)?.version;
    el.textContent = v ? `v${String(v).replace(/^v/, '').replace(/\.mock$/, '')}` : '';
  }
  const sum = document.querySelector('[data-summary]');
  if (sum) fill(sum, ...summaryNodes());
  paintUpdates();
}

function summaryNodes() {
  const list = enabled();
  const up = list.filter((m) => stateOf(m.id) === 'running').length;
  const starting = list.filter((m) => stateOf(m.id) === 'starting').length;
  const bad = list.length - up - starting;
  if (!list.length) return [h('span', { class: 'pill' }, 'No apps enabled')];
  if (bad) return [h('span', { class: 'pill pill-err' }, h('span', { class: 'dot crashed' }), `${bad} app${bad > 1 ? 's' : ''} need attention`)];
  if (starting) return [h('span', { class: 'pill pill-warn' }, h('span', { class: 'dot starting' }), `${starting} starting…`)];
  return [h('span', { class: 'pill pill-ok' }, h('span', { class: 'dot running' }), `All ${list.length} apps running`)];
}

// ─────────────────────────────────────────────────────────────────────── app shell ───
function shell(content, active) {
  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar' },
    h('div', { class: 'brand' }, h('img', { class: 'logo', src: '/favicon.svg', alt: '' }), 'Allarr'),
    h('nav', { class: 'nav', 'aria-label': 'Main' },
      navLink('#/', 'home', 'Dashboard', active === 'home'),
      S.catalog.groups.map((g) => {
        const mods = enabled().filter((m) => m.group === g.id);
        return mods.length ? [h('div', { class: 'nav-label' }, g.title), mods.map((m) => appLink(m, active === m.id))] : null;
      }),
      h('div', { class: 'nav-label' }, 'Manage'),
      h('a', { href: '#/updates', class: active === 'updates' ? 'active' : '' }, icon('download', 17), 'Updates',
        h('span', { class: 'count', 'data-update-count': '', hidden: true })),
      navLink('#/settings', 'settings', 'Settings', active === 'settings')),
    h('div', { class: 'foot' },
      h('div', { class: 'avatar' }, (S.me.username ?? '?')[0]),
      h('div', { class: 'grow small' }, h('div', { style: { fontWeight: 600 } }, S.me.username), h('div', { class: 'faint' }, `v${S.me.version}`)),
      h('button', { class: 'icon-btn', title: 'Sign out', 'aria-label': 'Sign out', onClick: async () => { await api('/logout', { method: 'POST' }); location.hash = '#/login'; location.reload(); } }, icon('logout', 17))));
  const main = h('main', { class: 'main' }, content);
  const menu = h('button', { class: 'icon-btn menu-btn', 'aria-label': 'Menu', onClick: () => sidebar.classList.toggle('open') }, icon('menu', 20));
  sidebar.addEventListener('click', (e) => e.target.closest('a') && sidebar.classList.remove('open'));
  fill(root, h('div', { class: 'shell' }, sidebar, main));
  return { menu };
}

const navLink = (href, ic, label, on) => h('a', { href, class: on ? 'active' : '', 'aria-current': on ? 'page' : null }, icon(ic, 17), label);

function appLink(m, on) {
  const link = h('a', { href: `#/app/${m.id}`, class: on ? 'active' : '', 'aria-current': on ? 'page' : null },
    badge(m, 22), m.name, h('span', { 'data-dot': m.id, class: `dot ${stateOf(m.id)}` }));
  if (!on || !m.basePath) return link;
  // The Hub has no top bar for embedded apps (so the app's own header is the only one); its actions live here.
  const act = (ic, label, fn) => h('button', { class: 'nav-sub-btn', title: label, onClick: fn }, icon(ic, 14), label);
  return [link, h('div', { class: 'nav-sub' },
    act('logs', 'Log', () => showLogs(m)),
    act('refresh', 'Restart', async () => { await api(`/modules/${m.id}/restart`, { method: 'POST' }); toast(`Restarting ${m.name}…`); }),
    act('external', 'New tab', () => window.open(`${m.basePath}/`, '_blank')))];
}

const openApp = (m) => (m.basePath ? go(`#/app/${m.id}`) : window.open(exposedUrl(m.exposedPort), '_blank', 'noopener'));

// ───────────────────────────────────────────────────────────────────────── dashboard ───
function dashboard() {
  const storageBox = h('div', { class: 'stack' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton', style: { width: '70%' } }));
  const todoBox = h('div', {}, h('div', { class: 'skeleton' }));
  const page = h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', { class: 'flex', style: { alignItems: 'flex-start' } },
        h('button', { class: 'icon-btn menu-btn', 'aria-label': 'Menu', onClick: () => document.getElementById('sidebar').classList.toggle('open') }, icon('menu', 20)),
        h('div', {}, h('h1', {}, `${greeting()}, ${S.me.username}`), h('div', { style: { marginTop: '8px' }, 'data-summary': '' }, summaryNodes()))),
      h('div', { class: 'flex' }, button('Re-apply connections', { kind: 'secondary', icon: 'refresh', onClick: () => runWiring('Re-applying connections') }))),
    h('div', { 'data-update-banner': '' }, updateBanner()),
    h('div', { class: 'grid grid-2' },
      h('div', { class: 'card' }, h('div', { class: 'card-title' }, icon('disk', 20), h('h3', {}, 'Storage')), storageBox),
      h('div', { class: 'card' }, h('div', { class: 'card-title' }, icon('check', 20), h('h3', {}, 'Finish setup')), todoBox)),
    h('div', {}, h('h3', { style: { marginBottom: '14px' } }, 'Your apps'),
      h('div', { class: 'grid grid-apps' }, enabled().map(appCard))));

  api('/storage').then((r) => {
    const used = r.totalBytes ? ((r.totalBytes - r.freeBytes) / r.totalBytes) * 100 : 0;
    fill(storageBox, 
      h('div', { class: 'flex wrap' },
        h('span', { class: 'pill mono' }, r.path),
        r.hardlinks ? h('span', { class: 'pill pill-ok' }, icon('check', 12), 'Hardlinks working') : h('span', { class: 'pill pill-warn' }, icon('alert', 12), 'Hardlinks unavailable'),
        r.sameFilesystem === false ? h('span', { class: 'pill pill-err' }, 'Split drives') : null),
      r.totalBytes ? h('div', {}, h('div', { class: 'flex small muted', style: { justifyContent: 'space-between', marginBottom: '6px' } }, h('span', {}, `${formatBytes(r.totalBytes - r.freeBytes)} used`), h('span', {}, `${formatBytes(r.freeBytes)} free`)),
        h('div', { class: 'stat-bar', role: 'img', 'aria-label': `${Math.round(used)}% used` }, h('i', { style: { width: `${used}%` } }))) : null,
      r.issues.map((i) => h('div', { class: `notice ${i.level === 'error' ? 'notice-err' : 'notice-warn'}` }, icon('alert', 18), h('div', {}, i.message, h('div', { class: 'hint' }, i.fix)))),
      h('div', { class: 'folders' }, ['downloads', 'movies', 'series', 'music'].map((f) => h('span', { class: 'folder-chip' }, icon('folder', 13), f))));
  }).catch((e) => fill(storageBox, h('div', { class: 'error-text' }, e.message)));

  loadTodos(todoBox);
  return page;
}

function appCard(m) {
  return h('div', { class: 'card app-card' },
    h('div', { class: 'top' }, badge(m, 44),
      h('div', { class: 'grow' }, h('div', { class: 'name' }, m.name), h('div', { class: 'muted small' }, m.role)),
      h('span', { 'data-state': m.id, class: 'pill' }, STATE_TEXT[stateOf(m.id)] ?? '')),
    h('div', { class: 'muted small', style: { minHeight: '38px' } }, m.blurb),
    h('div', { class: 'error-text small', 'data-hint': m.id }),
    h('div', { class: 'actions' },
      m.headless ? h('span', { class: 'faint small', style: { flex: '1' } }, 'Works in the background') : button('Open', { kind: 'primary', iconRight: m.basePath ? 'right' : 'external', cls: 'btn-sm', onClick: () => openApp(m) }),
      button('', { kind: 'secondary', icon: 'logs', cls: 'btn-sm', title: 'View log', onClick: () => showLogs(m) })),
    h('div', { class: 'flex faint small' }, h('span', { class: 'grow', 'data-version': m.id }),
      h('button', { class: 'pill pill-warn chip-update', 'data-update': m.id, hidden: true, title: 'Review this update', onClick: () => go('#/updates') })));
}

async function loadTodos(box) {
  try {
    const items = await api('/todos');
    const left = items.filter((t) => !t.done).length;
    const draw = () => {
      fill(box, 
        items.length ? h('div', { class: 'small muted', style: { marginBottom: '6px' } }, left ? `${left} of ${items.length} left — the apps are connected, these just need you.` : 'Everything is done. Nice.') : null,
        ...items.map((t) => {
          const m = mod(t.app);
          const check = h('button', { class: `check ${t.done ? 'on' : ''}`, role: 'checkbox', 'aria-checked': String(t.done), 'aria-label': `Mark "${t.title}" as done`,
            onClick: async () => { t.done = !t.done; await api(`/todos/${t.id}`, { method: 'POST', body: { done: t.done } }); box.dispatchEvent(new Event('redraw')); } }, t.done ? icon('check', 14) : null);
          return h('div', { class: `todo ${t.done ? 'done' : ''}` }, check,
            h('div', {}, h('div', { class: 't' }, t.title), h('div', { class: 'd' }, t.detail)),
            !t.done && m ? button(t.cta, { kind: 'secondary', cls: 'btn-sm', iconRight: m.basePath ? 'right' : 'external', onClick: () => (m.basePath ? go(`#/app/${m.id}`) : window.open(exposedUrl(m.exposedPort), '_blank', 'noopener')) }) : h('span'));
        }),
        !items.length ? h('div', { class: 'muted' }, 'Nothing to do — enjoy!') : null);
    };
    box.addEventListener('redraw', () => { items.forEach((t) => t); draw(); });
    draw();
  } catch (e) {
    fill(box, h('div', { class: 'error-text' }, e.message));
  }
}

// ───────────────────────────────────────────────────────────────────────────── apps ───
function appView(id) {
  const m = mod(id);
  if (!m || !S.statuses.has(id)) return h('div', { class: 'page' }, h('h2', {}, 'App not found'), h('p', { class: 'muted' }, 'That app is not enabled.'), button('Back to dashboard', { onClick: () => go('#/') }));

  const menu = () => document.getElementById('sidebar').classList.toggle('open');
  if (m.basePath) {
    return h('div', { class: 'frame-wrap solo' },
      h('iframe', { src: `${m.basePath}/`, title: m.name, allow: 'clipboard-write' }),
      h('button', { class: 'menu-fab menu-btn', 'aria-label': 'Menu', onClick: menu }, icon('menu', 20)));
  }

  const bar = h('div', { class: 'frame-bar' },
    h('button', { class: 'icon-btn menu-btn', 'aria-label': 'Menu', onClick: menu }, icon('menu', 20)),
    badge(m, 30), h('span', { class: 'name' }, m.name), h('span', { 'data-state': id, class: 'pill' }, STATE_TEXT[stateOf(id)] ?? ''), h('span', { class: 'grow' }),
    button('Restart', { kind: 'ghost', cls: 'btn-sm', icon: 'refresh', onClick: async () => { await api(`/modules/${id}/restart`, { method: 'POST' }); toast(`Restarting ${m.name}…`); } }),
    button('Log', { kind: 'ghost', cls: 'btn-sm', icon: 'logs', onClick: () => showLogs(m) }));
  const st = S.statuses.get(id);

  const url = m.headless ? null : exposedUrl(m.exposedPort);
  const crashed = st && !st.up && ['crashed', 'missing'].includes(st.state)
    ? h('div', { class: 'notice notice-err' }, icon('alert', 18), h('div', {}, h('b', {}, `${m.name} isn't running`), st.error ?? '', st.hint ? h('div', { class: 'mono small', style: { marginTop: '6px', wordBreak: 'break-all' } }, st.hint) : null,
      h('div', { class: 'hint' }, 'Press Log for details. Permission errors usually mean PUID/PGID should match the owner of your config and media folders.')))
    : null;
  if (m.headless) {
    // An app with no web page (FlareSolverr): nothing to open, so say what it does and how to use it.
    return h('div', { class: 'frame-wrap' }, bar,
      h('div', { class: 'page', style: { maxWidth: '720px' } }, crashed,
        h('div', { class: 'card stack' },
          h('h2', {}, `${m.name} works in the background`),
          h('p', { class: 'muted' }, m.blurb),
          h('p', { class: 'muted' }, `It has no page of its own. In Prowlarr, open an indexer that reports a Cloudflare problem and type "flaresolverr" into its Tags box. That indexer's searches then go through ${m.name}.`),
          S.statuses.has('prowlarr') ? h('div', { class: 'flex' }, button('Open Prowlarr', { kind: 'primary', iconRight: 'right', onClick: () => go('#/app/prowlarr') })) : null)));
  }
  return h('div', { class: 'frame-wrap' }, bar,
    h('div', { class: 'page', style: { maxWidth: '720px' } },
      crashed,
      h('div', { class: 'card stack' },
        h('h2', {}, `${m.name} has its own address`),
        h('p', { class: 'muted' }, m.id === 'profilarr'
          ? `${m.name} can't be shown inside Allarr, so it has its own sign-in and its own port. It manages your Sonarr and Radarr settings: keep this address to yourself.`
          : `${m.name} is meant for the people you share it with, so it has its own sign-in and its own port instead of living behind your admin login.`),
        h('div', { class: 'flex' }, h('code', { class: 'grow', style: { padding: '10px 12px' } }, url), button('Copy', { kind: 'secondary', icon: 'copy', onClick: () => copyText(url, 'Link copied') })),
        h('div', { class: 'flex' }, button(`Open ${m.name}`, { kind: 'primary', iconRight: 'external', onClick: () => window.open(url, '_blank', 'noopener') })),
        h('div', { class: 'hint' }, `Make sure port ${m.exposedPort} is published by your container, and put it behind your own domain/reverse proxy if you want to share it outside your home.`))));
}

async function showLogs(m) {
  const pre = h('pre', { class: 'log' }, 'Loading…');
  const load = async () => {
    try {
      const { lines } = await api(`/modules/${m.id}/logs`);
      pre.textContent = lines.length ? lines.join('\n') : 'No log output yet.';
      pre.scrollTop = pre.scrollHeight;
    } catch (e) { pre.textContent = e.message; }
  };
  modal({ title: `${m.name} log`, wide: true, body: pre, actions: [button('Refresh', { icon: 'refresh', onClick: load })] });
  load();
}

// ───────────────────────────────────────────────────────────────────────────── wiring ───
export function runWiring(title, request = () => api('/setup/run', { method: 'POST', body: {} })) {
  const box = h('div');
  const m = modal({ title, body: box, onClose: () => { S.onWiring = null; route(true); } });
  const paint = (w) => {
    if (!w) return fill(box, h('div', { class: 'flex muted' }, spinner(), 'Starting…'));
    fill(box, progressList(w), progressSummary(w, { onContinue: m.close, onRetry: () => request().then((x) => { S.wiring = x; paint(x); }) }));
  };
  S.onWiring = paint;
  paint(null);
  request().then((w) => { S.wiring = w; paint(w); }).catch((e) => { fill(box, h('div', { class: 'notice notice-err' }, icon('x', 18), e.message)); });
}

// ─────────────────────────────────────────────────────────────────────────── settings ───
function appearanceCard() {
  const box = h('div', { class: 'flex' }, spinner());
  api('/settings/theme').then(({ enabled }) => {
    const input = h('input', { type: 'checkbox', checked: enabled, 'aria-label': "Match the apps' look to Allarr", onChange: async (e) => {
      try {
        await api('/settings/theme', { method: 'POST', body: { enabled: e.target.checked } });
        toast(e.target.checked ? 'Apps now match Allarr. Reopen an app to see it.' : 'Apps use their own look again. Reopen an app to see it.', 'ok');
      } catch (x) { e.target.checked = !e.target.checked; toast(x.message, 'error'); }
    } });
    fill(box, h('div', { class: 'grow' }, h('div', { style: { fontWeight: 600 } }, "Match the apps' look to Allarr"),
      h('div', { class: 'small muted' }, 'Restyles the colours, fonts and corners of the embedded apps. Menus and features stay exactly as they are. Switch it off if something looks wrong.')),
      h('span', { class: 'switch' }, input, h('span', { class: 'track' })));
  }).catch(() => fill(box, h('span', { class: 'muted small' }, 'Unavailable')));
  return h('div', { class: 'card' }, h('div', { class: 'card-title' }, icon('sparkle', 20), h('h3', {}, 'Appearance')), box);
}

function subtitleSyncCard() {
  if (!S.statuses.has('bazarr')) return null;
  const box = h('div', { class: 'flex' }, spinner());
  api('/settings/subtitle-sync').then(({ mode }) => {
    const input = h('input', { type: 'checkbox', checked: mode === 'embedded', 'aria-label': "Sync new subtitles with the video's embedded subtitles", onChange: async (e) => {
      const want = e.target.checked;
      try {
        const r = await api('/settings/subtitle-sync', { method: 'POST', body: { mode: want ? 'embedded' : 'off' } });
        toast(r.message ? `Bazarr: ${r.message}` : want ? 'Saved' : 'Switched off', 'ok');
      } catch (x) { e.target.checked = !want; toast(x.message, 'error'); }
    } });
    fill(box, h('div', { class: 'grow' }, h('div', { style: { fontWeight: 600 } }, "Sync new subtitles with the video's embedded subtitles"),
      h('div', { class: 'small muted' }, "Bazarr's own automatic sync can only listen to the audio, which is often off. With this on, every subtitle Bazarr downloads is lined up with a subtitle track already inside the video (same language if there is one). Videos with no usable embedded subtitles are left alone. It also switches Bazarr's audio sync off.")),
      h('span', { class: 'switch' }, input, h('span', { class: 'track' })));
  }).catch(() => fill(box, h('span', { class: 'muted small' }, 'Unavailable')));
  return h('div', { class: 'card' }, h('div', { class: 'card-title' }, icon('captions', 20), h('h3', {}, 'Subtitle sync')), box);
}

function addressesCard() {
  const apps = S.catalog.modules.filter((m) => m.exposedPort != null);
  if (!apps.length || !apps.some((m) => S.statuses.has(m.id))) return null;
  const inputs = Object.fromEntries(apps.map((m) => [m.id, h('input', { class: 'input', placeholder: `${m.name} port or address`, value: String(m.exposedPort) })]));
  const err = h('div', { class: 'error-text', role: 'alert' });
  return h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('external', 20), h('h3', {}, 'Addresses for Seerr, Wizarr and Profilarr')),
    h('p', { class: 'small muted', style: { marginBottom: '14px' } },
      'Seerr, Wizarr and Profilarr are opened on their own port. If you published them under different ports (for example 12000:5055), enter the port you use on the left, or a full address if they sit behind your own domain.'),
    h('div', { class: 'row' }, apps.map((m) => h('div', { class: 'field' }, h('label', {}, `${m.name} (default ${({ seerr: 5055, wizarr: 5690, profilarr: 6868 })[m.id]})`), inputs[m.id]))),
    err,
    button('Save addresses', { kind: 'secondary', onClick: async () => {
      err.textContent = '';
      try {
        S.catalog = await api('/settings/addresses', { method: 'POST', body: Object.fromEntries(apps.map((m) => [m.id, inputs[m.id].value])) });
        toast('Addresses saved', 'ok');
      } catch (e) { err.textContent = e.message; }
    } }));
}

function settings() {
  const sel = new Set(S.answers.apps ?? []);
  const original = new Set(sel);
  const applyBtn = button('Apply changes', { kind: 'primary', icon: 'check', disabled: true, onClick: () => {
    runWiring('Applying your changes', () => api('/apps', { method: 'POST', body: { apps: [...sel] } }));
  } });
  const changed = () => (applyBtn.disabled = sel.size === original.size && [...sel].every((x) => original.has(x)));

  const connBox = h('div');
  const showConn = async () => {
    fill(connBox, h('div', { class: 'flex muted' }, spinner(), 'Loading…'));
    const list = await api('/connections');
    fill(connBox, 
      h('div', { class: 'hint', style: { marginBottom: '10px' } }, 'Use these inside other apps (for example Maintainerr or Cleanuparr). They only work from inside the container.'),
      h('div', { class: 'kv' }, list.flatMap((c) => {
        const secret = c.apiKey ?? (c.extra ? `${c.extra.username} / ${c.extra.password}` : null);
        return [
          h('span', { class: 'k' }, c.name), h('span', { class: 'v', title: c.url }, c.url),
          button('', { kind: 'ghost', cls: 'btn-sm', icon: 'copy', title: 'Copy address', onClick: () => copyText(c.url, 'Address copied') }),
          h('span', { class: 'k faint' }, secret ? (c.apiKey ? 'API key' : 'Login') : ''), h('span', { class: 'v' }, secret ? '••••••••••••' : '—'),
          secret ? button('', { kind: 'ghost', cls: 'btn-sm', icon: 'copy', title: 'Copy', onClick: () => copyText(c.apiKey ?? c.extra.password, 'Copied') }) : h('span'),
        ];
      })));
  };

  const pw = { current: h('input', { class: 'input', type: 'password', autocomplete: 'current-password' }), next: h('input', { class: 'input', type: 'password', autocomplete: 'new-password' }) };
  const pwErr = h('div', { class: 'error-text', role: 'alert' });
  const sBox = h('div', { class: 'stack' }, h('div', { class: 'skeleton' }));
  api('/storage').then((r) => fill(sBox, 
    h('div', { class: 'flex wrap' }, h('span', { class: 'pill mono' }, r.path),
      r.hardlinks ? h('span', { class: 'pill pill-ok' }, icon('check', 12), 'Hardlinks working') : h('span', { class: 'pill pill-warn' }, 'Hardlinks unavailable'),
      r.freeBytes != null ? h('span', { class: 'pill' }, `${formatBytes(r.freeBytes)} free`) : null),
    r.issues.map((i) => h('div', { class: 'notice notice-warn' }, icon('alert', 18), h('div', {}, i.message, h('div', { class: 'hint' }, i.fix))))));

  return h('div', { class: 'page', style: { maxWidth: '900px' } },
    h('div', { class: 'page-head' }, h('div', { class: 'flex' }, h('button', { class: 'icon-btn menu-btn', 'aria-label': 'Menu', onClick: () => document.getElementById('sidebar').classList.toggle('open') }, icon('menu', 20)), h('h1', {}, 'Settings'))),
    h('div', { class: 'card stack-lg' },
      h('div', { class: 'card-title' }, icon('bolt', 20), h('h3', {}, 'Apps'), applyBtn),
      appPicker(sel, changed)),
    h('div', { class: 'card' }, h('div', { class: 'card-title' }, icon('disk', 20), h('h3', {}, 'Storage')), sBox),
    appearanceCard(),
    subtitleSyncCard(),
    addressesCard(),
    h('div', { class: 'card' }, h('div', { class: 'card-title' }, icon('link', 20), h('h3', {}, 'Connection details'),
      button('Show', { kind: 'secondary', cls: 'btn-sm', onClick: (e) => { e.currentTarget.remove(); showConn().catch((x) => toast(x.message, 'error')); } })),
      connBox, h('div', { class: 'muted small' }, 'Addresses and API keys for the built-in apps, for connecting extras like Maintainerr or Cleanuparr.')),
    h('div', { class: 'card' }, h('div', { class: 'card-title' }, icon('lock', 20), h('h3', {}, 'Change password')),
      h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', {}, 'Current password'), pw.current), h('div', { class: 'field' }, h('label', {}, 'New password'), pw.next)),
      pwErr, button('Update password', { kind: 'secondary', onClick: async () => {
        pwErr.textContent = '';
        try { await api('/password', { method: 'POST', body: { current: pw.current.value, next: pw.next.value } }); pw.current.value = pw.next.value = ''; toast('Password updated', 'ok'); }
        catch (e) { pwErr.textContent = e.message; }
      } })),
    h('div', { class: 'card flex' }, h('div', { class: 'grow' }, h('h3', {}, 'Re-apply connections'), h('div', { class: 'muted small' }, 'Re-checks folders, download clients, indexers and links between apps. Safe to run any time.')),
      button('Run again', { kind: 'secondary', icon: 'refresh', onClick: () => runWiring('Re-applying connections') })));
}

// ───────────────────────────────────────────────────────────────────────────── updates ───
const updItems = () => S.updates?.items ?? [];
const updAvail = () => updItems().filter((i) => i.available);
const updOf = (id) => updItems().find((i) => i.id === id);

function paintUpdates() {
  const n = updAvail().length;
  for (const el of document.querySelectorAll('[data-update-count]')) {
    el.textContent = n;
    el.hidden = !n;
  }
  for (const el of document.querySelectorAll('[data-update]')) {
    const i = updOf(el.dataset.update);
    el.hidden = !i?.available;
    el.textContent = i?.available ? `Update ${i.latest}` : '';
  }
  const banner = document.querySelector('[data-update-banner]');
  if (banner) fill(banner, updateBanner());
}

function updateBanner() {
  const list = updAvail();
  if (!list.length) return null;
  return h('div', { class: 'notice notice-warn' }, icon('download', 18),
    h('div', { class: 'grow' }, h('b', {}, `${list.length} update${list.length > 1 ? 's' : ''} available`),
      list.map((i) => `${mod(i.id).name} ${i.latest}`).join(' · '), h('div', { class: 'hint' }, 'Nothing is installed until you confirm.')),
    button('Review', { kind: 'secondary', cls: 'btn-sm', onClick: () => go('#/updates') }));
}

/** Progress dialog for an in-place update; also reopens a job that is already running. */
function jobModal(m, j) {
  const body = h('div', { class: 'stack' });
  const mdl = modal({ title: `Updating ${m.name}`, body, onClose: () => { S.onUpdate = null; route(true); } });
  const paint = (job) => {
    if (!job || job.id !== m.id) return;
    fill(body,
      h('p', { class: 'muted' }, `${m.name} ${job.from} → ${job.to}`),
      progressList(job),
      job.running ? h('div', { class: 'hint' }, `${m.name} is unavailable for a short while. It's fine to close this window; the update carries on.`) : null,
      !job.running && job.status === 'ok' ? h('div', { class: 'notice notice-ok' }, icon('check', 18), h('div', {}, h('b', {}, 'Updated'), `${m.name} is now on ${job.to}. Your settings and library are unchanged.`)) : null,
      !job.running && job.status === 'error' ? h('div', { class: 'notice notice-err' }, icon('alert', 18), h('div', {}, h('b', {}, job.rolledBack ? 'Update failed, nothing was lost' : 'Update failed'), job.detail || 'Something went wrong.')) : null,
      !job.running ? h('div', { class: 'flex', style: { justifyContent: 'flex-end' } }, button('Done', { kind: 'primary', onClick: mdl.close })) : null);
  };
  S.onUpdate = paint;
  paint(j);
}

function confirmUpdate(i) {
  const m = mod(i.id);
  const body = h('div', { class: 'stack' });
  const mdl = modal({ title: `Update ${m.name} to ${i.latest}?`, body });
  const go1 = button(`Update ${m.name}`, { kind: 'primary', icon: 'download', onClick: async () => {
    go1.disabled = true;
    try {
      const job = await api('/updates/apply', { method: 'POST', body: { id: i.id, version: i.latest } });
      mdl.close();
      // Live events may already be ahead of this reply (e.g. a failure within milliseconds): use the freshest state.
      jobModal(m, S.job?.startedAt === job.startedAt ? S.job : job);
    } catch (e) {
      go1.disabled = false;
      toast(e.message, 'error');
    }
  } });
  fill(body,
    h('p', { class: 'muted' }, `You're on ${i.current}. This installs ${i.latest}${i.date ? `, released ${new Date(i.date).toLocaleDateString()}` : ''}.`),
    i.changes?.length ? h('div', {}, h('div', { class: 'small', style: { fontWeight: 600 } }, "What's new"), h('ul', { class: 'changes' }, i.changes.slice(0, 5).map((c) => h('li', {}, c)))) : null,
    h('div', { class: 'stack small' },
      [['download', "Allarr downloads it and checks the file's checksum."],
        ['disk', `${m.name} is stopped briefly (about a minute) and its database is backed up first.`],
        ['shield', `If the new version doesn't start, Allarr automatically goes back to ${i.current}.`]]
        .map(([ic, t]) => h('div', { class: 'flex', style: { alignItems: 'flex-start' } }, h('span', { class: 'ic ok' }, icon(ic, 14)), h('span', {}, t)))),
    i.notes ? h('a', { href: i.notes, target: '_blank', rel: 'noopener noreferrer', class: 'small' }, 'Full release notes') : null,
    h('div', { class: 'flex', style: { justifyContent: 'flex-end' } }, button('Cancel', { kind: 'ghost', onClick: mdl.close }), go1));
}

function updateRow(i) {
  const m = mod(i.id);
  let action;
  if (i.available && i.inPlace) action = button('Update…', { kind: 'primary', cls: 'btn-sm', onClick: () => confirmUpdate(i) });
  else if (i.available) action = h('span', { class: 'pill pill-warn' }, 'Needs a new image');
  else if (i.error) action = h('span', { class: 'pill pill-err' }, 'Check failed');
  else action = h('span', { class: 'pill pill-ok' }, icon('check', 12), 'Up to date');
  return h('div', { class: 'upd-row' }, badge(m, 40),
    h('div', { class: 'grow' },
      h('div', { style: { fontWeight: 650 } }, m.name, h('span', { class: 'faint', style: { fontWeight: 400 } }, `  ·  ${m.role}`)),
      h('div', { class: 'small muted' },
        i.error ? `Couldn't check: ${i.error}` : i.available ? `${i.current ?? 'unknown'} → ${i.latest}${i.date ? `  ·  ${new Date(i.date).toLocaleDateString()}` : ''}` : `Version ${i.current ?? 'unknown'}`),
      i.available && i.changes?.length ? h('ul', { class: 'changes' }, i.changes.slice(0, 3).map((c) => h('li', {}, c))) : null,
      i.available && !i.inPlace ? h('div', { class: 'hint', style: { marginTop: '6px' } }, `${m.name} is compiled into the image, so it updates when you redeploy the latest image.`) : null,
      i.available && i.notes ? h('a', { href: i.notes, target: '_blank', rel: 'noopener noreferrer', class: 'small' }, 'Release notes') : null),
    action);
}

function updatesPage() {
  const items = updItems();
  const avail = items.filter((i) => i.available);
  const rest = items.filter((i) => !i.available);
  const checkBtn = button('Check now', { kind: 'secondary', icon: 'refresh', onClick: async (e) => {
    e.currentTarget.disabled = true;
    try { S.updates = await api('/updates/check', { method: 'POST' }); } catch (x) { toast(x.message, 'error'); }
    route(false);
  } });
  const applying = S.updates?.applying && mod(S.updates.applying);
  return h('div', { class: 'page', style: { maxWidth: '900px' } },
    h('div', { class: 'page-head' },
      h('div', { class: 'flex', style: { alignItems: 'flex-start' } },
        h('button', { class: 'icon-btn menu-btn', 'aria-label': 'Menu', onClick: () => document.getElementById('sidebar').classList.toggle('open') }, icon('menu', 20)),
        h('div', {}, h('h1', {}, 'Updates'), h('p', { class: 'muted', style: { marginTop: '6px' } }, 'Allarr checks for new versions every few hours. Nothing is installed until you say so.'))),
      h('div', { class: 'flex' }, h('span', { class: 'faint small' }, S.updates?.checkedAt ? `Checked ${timeAgo(S.updates.checkedAt)}` : 'Not checked yet'), checkBtn)),
    applying ? h('div', { class: 'notice notice-warn' }, icon('refresh', 18), h('div', { class: 'grow' }, h('b', {}, `Updating ${applying.name}…`), 'An update is in progress.'),
      button('View progress', { kind: 'secondary', cls: 'btn-sm', onClick: () => jobModal(applying, S.job) })) : null,
    !items.length ? h('div', { class: 'card muted' }, 'No version information yet. Press "Check now".') : null,
    avail.length ? h('div', { class: 'card' }, h('div', { class: 'card-title' }, icon('download', 20), h('h3', {}, `${avail.length} update${avail.length > 1 ? 's' : ''} available`)), avail.map(updateRow))
      : items.length ? h('div', { class: 'notice notice-ok' }, icon('check', 18), h('div', {}, h('b', {}, 'Everything is up to date'), 'Nothing to do right now.')) : null,
    rest.length ? h('div', { class: 'card' }, h('div', { class: 'card-title' }, icon('check', 20), h('h3', {}, 'Up to date')), rest.map(updateRow)) : null,
    h('div', { class: 'card stack' }, h('div', { class: 'card-title' }, icon('info', 20), h('h3', {}, 'How updates work')),
      h('p', { class: 'small muted' }, 'Sonarr, Radarr, Lidarr and Prowlarr can be updated right here: Allarr downloads the new version, backs up the database and restarts the app, and rolls back by itself if the new version fails to start.'),
      h('p', { class: 'small muted' }, 'Everything else (Bazarr, SABnzbd, Seerr, Wizarr, Maintainerr, Cleanuparr, qBittorrent) is part of the container image. When one of them is listed above, redeploy your stack with the latest image: Dockge → Update, Portainer → "Pull and redeploy", or recreate the container. Your settings live in /config and are kept.')));
}

// ───────────────────────────────────────────────────────────────────────────── router ───
let booted = false;

async function route(force = false) {
  const [a, b] = location.hash.replace(/^#\/?/, '').split('/');
  if (!booted || force) await refreshMe();

  if (!S.me.hasAdmin) return a === 'setup' && b === 'welcome' ? renderWizard(root, 'welcome') : go('#/setup/welcome');
  if (!S.me.authenticated) return a === 'login' ? renderLogin(root) : go('#/login');

  if (!booted || force) {
    await loadCatalog();
    S.updates = await api('/updates').catch(() => null);
    if (!es) startEvents();
    booted = true;
  }
  if (a === 'login') return go('#/');
  if (!S.me.setupComplete && a !== 'setup') return go('#/setup/storage');
  if (a === 'setup') {
    if (S.me.setupComplete && b !== 'install') return go('#/');
    return renderWizard(root, b || 'storage');
  }

  if (a === 'app') {
    const id = b;
    shell(appView(id), id);
    return paintStatus();
  }
  if (a === 'settings') { shell(settings(), 'settings'); return paintStatus(); }
  if (a === 'updates') { shell(updatesPage(), 'updates'); return paintStatus(); }
  shell(dashboard(), 'home');
  paintStatus();
}

let es = null;
function startEvents() {
  es = connectEvents({
    status: (list) => {
      S.statuses = new Map(list.map((s) => [s.id, s]));
      paintStatus();
      // the set of enabled apps changed (e.g. after Settings → Apply): rebuild the sidebar
      const ids = [...document.querySelectorAll('.nav [data-dot]')].map((e) => e.dataset.dot).sort().join();
      if (document.getElementById('sidebar') && ids !== [...S.statuses.keys()].sort().join() && !document.querySelector('.overlay')) route(false);
    },
    wiring: (w) => { S.wiring = w; S.onWiring?.(w); },
    updates: (u) => {
      S.updates = u;
      paintUpdates();
      if (location.hash === '#/updates' && !document.querySelector('.overlay')) route(false);
    },
    update: (j) => { S.job = j; S.onUpdate?.(j); },
  });
}

setUnauthorizedHandler(() => { if (location.hash !== '#/login') { location.hash = '#/login'; location.reload(); } });
window.addEventListener('hashchange', () => route(false));
route(false).catch((e) => {
  fill(root, h('div', { class: 'center' }, h('div', { class: 'card auth-card stack' }, h('h2', {}, "Can't reach Allarr"), h('p', { class: 'muted' }, e.message), button('Retry', { kind: 'primary', onClick: () => location.reload() }))));
});
