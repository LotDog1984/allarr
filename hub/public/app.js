import { api, setUnauthorizedHandler, connectEvents } from './api.js';
import { h, icon, button, badge, toast, copyText, modal, formatBytes, greeting, exposedUrl, spinner, fill } from './ui.js';
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
  for (const el of document.querySelectorAll('[data-version]')) {
    const v = S.statuses.get(el.dataset.version)?.version;
    el.textContent = v ? `v${String(v).replace(/^v/, '').replace(/\.mock$/, '')}` : '';
  }
  const sum = document.querySelector('[data-summary]');
  if (sum) fill(sum, ...summaryNodes());
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
  const direct = !m.basePath;
  return h('a', { href: direct ? '#/app/' + m.id : `#/app/${m.id}`, class: on ? 'active' : '', 'aria-current': on ? 'page' : null },
    badge(m, 22), m.name, h('span', { 'data-dot': m.id, class: `dot ${stateOf(m.id)}` }));
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
    h('div', { class: 'actions' },
      button('Open', { kind: 'primary', iconRight: m.basePath ? 'right' : 'external', cls: 'btn-sm', onClick: () => openApp(m) }),
      button('', { kind: 'secondary', icon: 'logs', cls: 'btn-sm', title: 'View log', onClick: () => showLogs(m) })),
    h('div', { class: 'faint small', 'data-version': m.id }));
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

  const bar = h('div', { class: 'frame-bar' },
    h('button', { class: 'icon-btn menu-btn', 'aria-label': 'Menu', onClick: () => document.getElementById('sidebar').classList.toggle('open') }, icon('menu', 20)),
    badge(m, 30), h('span', { class: 'name' }, m.name), h('span', { 'data-state': id, class: 'pill' }, STATE_TEXT[stateOf(id)] ?? ''), h('span', { class: 'grow' }),
    button('Restart', { kind: 'ghost', cls: 'btn-sm', icon: 'refresh', onClick: async () => { await api(`/modules/${id}/restart`, { method: 'POST' }); toast(`Restarting ${m.name}…`); } }),
    button('Log', { kind: 'ghost', cls: 'btn-sm', icon: 'logs', onClick: () => showLogs(m) }),
    m.basePath ? button('New tab', { kind: 'secondary', cls: 'btn-sm', icon: 'external', onClick: () => window.open(`${m.basePath}/`, '_blank') }) : null);

  if (m.basePath) return h('div', { class: 'frame-wrap' }, bar, h('iframe', { src: `${m.basePath}/`, title: m.name, allow: 'clipboard-write' }));

  const url = exposedUrl(m.exposedPort);
  return h('div', { class: 'frame-wrap' }, bar,
    h('div', { class: 'page', style: { maxWidth: '720px' } },
      h('div', { class: 'card stack' },
        h('h2', {}, `${m.name} has its own address`),
        h('p', { class: 'muted' }, `${m.name} is meant for the people you share it with, so it has its own sign-in and its own port instead of living behind your admin login.`),
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

// ───────────────────────────────────────────────────────────────────────────── router ───
let booted = false;

async function route(force = false) {
  const [a, b] = location.hash.replace(/^#\/?/, '').split('/');
  if (!booted || force) await refreshMe();

  if (!S.me.hasAdmin) return a === 'setup' && b === 'welcome' ? renderWizard(root, 'welcome') : go('#/setup/welcome');
  if (!S.me.authenticated) return a === 'login' ? renderLogin(root) : go('#/login');

  if (!booted || force) {
    await loadCatalog();
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
  });
}

setUnauthorizedHandler(() => { if (location.hash !== '#/login') { location.hash = '#/login'; location.reload(); } });
window.addEventListener('hashchange', () => route(false));
route(false).catch((e) => {
  fill(root, h('div', { class: 'center' }, h('div', { class: 'card auth-card stack' }, h('h2', {}, "Can't reach Allarr"), h('p', { class: 'muted' }, e.message), button('Retry', { kind: 'primary', onClick: () => location.reload() }))));
});
