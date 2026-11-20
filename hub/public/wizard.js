import { api } from './api.js';
import { h, icon, button, spinner, formatBytes, fill, badge as badgeEl } from './ui.js';
import { S, mod, go, refreshMe, selectedApps, progressList, progressSummary } from './store.js';

const brand = () => h('div', { class: 'brand' }, h('img', { class: 'logo', src: '/favicon.svg', alt: '' }), 'Allarr');

// ------------------------------------------------------------------------------- login ---
export function renderLogin(root) {
  const err = h('div', { class: 'error-text', role: 'alert' });
  const user = h('input', { class: 'input', id: 'u', autocomplete: 'username', value: S.me?.username ?? '', autofocus: true });
  const pass = h('input', { class: 'input', id: 'p', type: 'password', autocomplete: 'current-password' });
  const submit = async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      await api('/login', { method: 'POST', body: { username: user.value.trim(), password: pass.value } });
      await refreshMe();
      go('#/');
      location.reload();
    } catch (ex) {
      err.textContent = ex.message;
      pass.select();
    }
  };
  fill(root, 
    h('div', { class: 'center' },
      h('form', { class: 'card auth-card stack-lg', onSubmit: submit },
        brand(),
        h('div', {}, h('h2', {}, 'Welcome back'), h('p', { class: 'muted' }, 'Sign in to manage your media stack.')),
        h('div', {},
          h('div', { class: 'field' }, h('label', { for: 'u' }, 'Username'), user),
          h('div', { class: 'field' }, h('label', { for: 'p' }, 'Password'), pass),
          err),
        h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Sign in'))),
  );
}

// ------------------------------------------------------------------------------ wizard ---
const ALL = [
  { id: 'welcome', label: 'Account' },
  { id: 'storage', label: 'Storage' },
  { id: 'apps', label: 'Apps' },
  { id: 'downloads', label: 'Downloads', when: (a) => a.includes('qbittorrent') || a.includes('sabnzbd') },
  { id: 'server', label: 'Media server', when: (a) => ['seerr', 'wizarr', 'maintainerr'].some((x) => a.includes(x)) },
  { id: 'review', label: 'Finish' },
];
// Before sign-in the catalog isn't loaded yet; show the full path so the stepper doesn't jump later.
const applicable = () => (S.catalog.modules.length ? ALL.filter((s) => !s.when || s.when(selectedApps())) : ALL);
const neighbour = (id, d) => applicable()[applicable().findIndex((s) => s.id === id) + d]?.id;
const next = (id) => go(`#/setup/${neighbour(id, 1) ?? 'review'}`);
const back = (id) => go(`#/setup/${neighbour(id, -1) ?? 'welcome'}`);

const saveAnswers = async (patch) => {
  S.answers = await api('/answers', { method: 'POST', body: patch });
};

const foot = (id, { nextLabel = 'Continue', onNext, nextDisabled, showBack = true } = {}) => {
  const nextBtn = button(nextLabel, { kind: 'primary', iconRight: 'right', disabled: nextDisabled, onClick: onNext ?? (() => next(id)) });
  return {
    nextBtn,
    el: h('div', { class: 'wiz-foot' },
      showBack ? button('Back', { kind: 'ghost', icon: 'left', onClick: () => back(id) }) : h('span'),
      nextBtn),
  };
};

export function renderWizard(root, stepId) {
  const steps = applicable();
  const idx = Math.max(0, steps.findIndex((s) => s.id === stepId));
  const builders = { welcome, storage, apps, downloads, server, review, install };
  const card = (builders[stepId] ?? storage)(stepId);

  fill(root, 
    h('div', { class: 'center' },
      h('div', { class: 'wizard' },
        brand(),
        stepId !== 'install'
          ? h('div', { class: 'stepper', role: 'list' }, steps.map((s, i) =>
              h('div', { class: `s ${i < idx ? 'done' : i === idx ? 'now' : ''}`, role: 'listitem' }, h('div', { class: 'bar' }), h('span', {}, s.label))))
          : null,
        h('div', { class: 'card' }, card))),
  );
}

// 1 ───────────────────────────────────────────────────────────────────── account ───
function welcome(id) {
  if (S.me.authenticated) {
    const f = foot(id, { showBack: false });
    return h('div', {}, h('h2', {}, 'Welcome back'), h('p', { class: 'lead' }, `You're signed in as ${S.me.username}. Let's finish setting up your stack.`), f.el);
  }
  const err = h('div', { class: 'error-text', role: 'alert' });
  const user = h('input', { class: 'input', id: 'u', value: 'admin', autocomplete: 'username' });
  const p1 = h('input', { class: 'input', id: 'p1', type: 'password', autocomplete: 'new-password' });
  const p2 = h('input', { class: 'input', id: 'p2', type: 'password', autocomplete: 'new-password' });
  const submit = async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (p1.value !== p2.value) return (err.textContent = "The two passwords don't match.");
    try {
      await api('/setup/admin', { method: 'POST', body: { username: user.value.trim(), password: p1.value } });
      await refreshMe();
      go('#/setup/storage');
    } catch (ex) {
      err.textContent = ex.message;
    }
  };
  return h('form', { onSubmit: submit },
    h('h2', {}, 'Welcome to Allarr 👋'),
    h('p', { class: 'lead' }, 'One app for your whole media stack. Setup takes about two minutes — first, create the account you will use to sign in.'),
    h('div', { class: 'field' }, h('label', { for: 'u' }, 'Username'), user),
    h('div', { class: 'row' },
      h('div', { class: 'field' }, h('label', { for: 'p1' }, 'Password'), p1, h('span', { class: 'hint' }, 'At least 8 characters')),
      h('div', { class: 'field' }, h('label', { for: 'p2' }, 'Confirm password'), p2)),
    err,
    h('div', { class: 'notice' }, icon('shield', 18),
      h('div', {}, h('b', {}, 'One login for everything'),
        'Sonarr, Radarr and the rest are hidden behind this login, so you never need to set up separate passwords for them.')),
    h('div', { class: 'wiz-foot' }, h('span'), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create account', icon('right', 16))));
}

// 2 ────────────────────────────────────────────────────────────────────── storage ───
function storage(id) {
  const body = h('div', { class: 'stack' }, h('div', { class: 'skeleton', style: { width: '60%' } }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton', style: { width: '80%' } }));
  const f = foot(id, { nextDisabled: true });
  const row = (state, title, text) =>
    h('div', { class: 'check-row' },
      h('span', { class: `ic ${state}` }, icon(state === 'ok' ? 'check' : state === 'warn' ? 'alert' : 'x', 14)),
      h('div', {}, h('div', { style: { fontWeight: 600 } }, title), h('div', { class: 'muted small' }, text)));

  const show = (r) => {
    const worst = r.issues.some((i) => i.level === 'error') ? 'err' : r.hardlinks && !r.issues.length ? 'ok' : 'warn';
    const pctUsed = r.totalBytes ? Math.round(((r.totalBytes - r.freeBytes) / r.totalBytes) * 100) : null;
    fill(body, 
      h('div', { class: `notice notice-${worst}` }, icon(worst === 'ok' ? 'check' : 'alert', 18),
        h('div', {}, h('b', {}, worst === 'ok' ? 'Your storage is ready' : worst === 'warn' ? 'Works, with one catch' : "There's a problem with your storage"),
          worst === 'ok'
            ? 'Downloads and libraries share one drive, so finished files are hardlinked instead of copied.'
            : r.issues.map((i) => i.message).join(' '))),
      h('div', {},
        row(r.writable ? 'ok' : 'err', 'Folder access', r.writable ? `Allarr can read and write in ${r.path}` : `Allarr can't write to ${r.path}`),
        row(r.sameFilesystem === false ? 'err' : 'ok', 'One drive for everything', r.sameFilesystem === false ? 'Downloads and library are on different drives.' : 'Downloads, movies, series and music are on the same drive.'),
        row(r.hardlinks ? 'ok' : 'warn', 'Hardlinks', r.hardlinks ? 'Tested: a file shows up in two places instantly, using no extra space.' : "Hardlinks don't work here, so files would be copied."),
        r.isMount === false ? row('warn', 'Mapped volume', 'Nothing is mapped to /media — files would disappear with the container.') : null,
        r.freeBytes != null ? row('ok', 'Free space', `${formatBytes(r.freeBytes)} free of ${formatBytes(r.totalBytes)}${pctUsed != null ? ` (${pctUsed}% used)` : ''}`) : null),
      r.issues.filter((i) => i.fix).map((i) => h('div', { class: 'hint', style: { marginTop: '-4px' } }, `How to fix: ${i.fix}`)),
      h('div', {},
        h('div', { class: 'small muted', style: { marginBottom: '8px' } }, 'Allarr created this layout inside your one media folder:'),
        h('div', { class: 'tree' },
          h('b', {}, r.path), h('br'),
          '├─ downloads', h('br'), '│  ├─ torrents  ', h('span', { class: 'c' }, 'qBittorrent'), h('br'),
          '│  └─ usenet    ', h('span', { class: 'c' }, 'SABnzbd'), h('br'),
          '├─ movies       ', h('span', { class: 'c' }, 'Radarr'), h('br'),
          '├─ series       ', h('span', { class: 'c' }, 'Sonarr'), h('br'),
          '└─ music        ', h('span', { class: 'c' }, 'Lidarr'))),
      h('details', {}, h('summary', { class: 'small muted', style: { cursor: 'pointer' } }, 'What are hardlinks, and why do they matter?'),
        h('p', { class: 'small muted', style: { marginTop: '8px' } },
          'Normally a finished download is copied into your library: slow, double the disk space, and torrents stop seeding. With hardlinks the same file simply appears in both places at once — instant, free, and seeding keeps working. It only works when everything is on the same drive, which is why Allarr uses a single media folder.')),
      button('Check again', { kind: 'ghost', icon: 'refresh', onClick: load }),
    );
    f.nextBtn.disabled = !r.ok;
  };
  async function load() {
    fill(body, h('div', { class: 'flex muted' }, spinner(), 'Checking your storage…'));
    try { show(await api('/storage')); } catch (e) { fill(body, h('div', { class: 'notice notice-err' }, icon('x', 18), e.message)); }
  }
  load();
  return h('div', {}, h('h2', {}, 'Where is your media?'),
    h('p', { class: 'lead' }, 'Everything lives in one folder — the one you mapped to /media when you started the container.'), body, f.el);
}

// 3 ───────────────────────────────────────────────────────────────────────── apps ───
const PRESETS = [
  { label: 'Everything', apps: () => S.catalog.modules.map((m) => m.id) },
  { label: 'Essentials', apps: () => ['sonarr', 'radarr', 'prowlarr', 'flaresolverr', 'qbittorrent'] },
  { label: 'Torrents + subtitles', apps: () => ['sonarr', 'radarr', 'prowlarr', 'flaresolverr', 'bazarr', 'qbittorrent', 'seerr'] },
];

export function appPicker(sel, onChange) {
  const hints = h('div', { class: 'stack' });
  const root = h('div', { class: 'stack-lg' });
  const paintHints = () => {
    const libs = ['sonarr', 'radarr', 'lidarr'].some((x) => sel.has(x));
    fill(hints, 
      libs && !sel.has('prowlarr')
        ? h('div', { class: 'notice notice-warn' }, icon('info', 18), h('div', {}, h('b', {}, 'Add Prowlarr?'), 'It is where you add search sources once and share them with every library app.',
            h('div', { style: { marginTop: '8px' } }, button('Add Prowlarr', { kind: 'secondary', size: 'sm', cls: 'btn-sm', onClick: () => toggle('prowlarr', true) }))))
        : null,
      libs && !sel.has('qbittorrent') && !sel.has('sabnzbd')
        ? h('div', { class: 'notice notice-warn' }, icon('info', 18), h('div', {}, h('b', {}, 'No downloader selected'), 'Sonarr, Radarr and Lidarr need qBittorrent (torrents) or SABnzbd (Usenet) to actually download things.'))
        : null,
    );
  };
  const boxes = new Map();
  function toggle(id, on) {
    on ? sel.add(id) : sel.delete(id);
    boxes.get(id).input.checked = on;
    boxes.get(id).label.classList.toggle('on', on);
    paintHints();
    onChange?.(sel);
  }
  const card = (m) => {
    const input = h('input', { type: 'checkbox', checked: sel.has(m.id), 'aria-label': `Install ${m.name}`, onChange: (e) => toggle(m.id, e.target.checked) });
    const label = h('label', { class: `app-pick ${sel.has(m.id) ? 'on' : ''}` },
      badgeEl(m),
      h('div', { class: 'grow' }, h('div', { class: 't' }, m.name, h('span', { class: 'faint', style: { fontWeight: 400 } }, `  ·  ${m.role}`)), h('div', { class: 'd' }, m.blurb)),
      h('span', { class: 'switch' }, input, h('span', { class: 'track' })));
    boxes.set(m.id, { input, label });
    return label;
  };
  fill(root, 
    h('div', { class: 'flex wrap' }, h('span', { class: 'muted small' }, 'Quick pick:'),
      PRESETS.map((p) => button(p.label, { kind: 'secondary', cls: 'btn-sm', onClick: () => {
        const want = new Set(p.apps());
        for (const m of S.catalog.modules) toggle(m.id, want.has(m.id));
      } }))),
    S.catalog.groups.map((g) => {
      const mods = S.catalog.modules.filter((m) => m.group === g.id);
      return h('div', {}, h('div', { class: 'group-title' }, h('h4', {}, g.title), h('span', {}, g.blurb)), h('div', { class: 'stack' }, mods.map(card)));
    }),
    hints,
  );
  paintHints();
  return root;
}

function apps(id) {
  const sel = new Set(selectedApps());
  const f = foot(id, {
    onNext: async () => {
      await saveAnswers({ apps: [...sel] });
      next(id);
    },
  });
  const sync = () => (f.nextBtn.disabled = sel.size === 0);
  return h('div', {}, h('h2', {}, 'What would you like to run?'),
    h('p', { class: 'lead' }, 'Everything is optional and can be changed later in Settings. Not sure? Keep the defaults.'),
    appPicker(sel, sync), f.el);
}

// 4 ──────────────────────────────────────────────────────────────────────── downloads ───
function downloads(id) {
  const a = selectedApps();
  const u = { enabled: false, name: '', host: '', port: 563, ssl: true, username: '', password: '', connections: 20, ...(S.answers.usenet ?? {}) };
  const err = h('div', { class: 'error-text', role: 'alert' });
  const field = (label, key, props = {}, hint) =>
    h('div', { class: 'field' }, h('label', {}, label),
      h('input', { class: 'input', value: u[key], ...props, onInput: (e) => { u[key] = props.type === 'number' ? Number(e.target.value) : e.target.value; } }),
      hint ? h('span', { class: 'hint' }, hint) : null);
  const usenetForm = h('div', { style: { marginTop: '16px', display: u.enabled ? 'block' : 'none' } },
    h('div', { class: 'row' }, field('Server address', 'host', { placeholder: 'news.yourprovider.com', autocomplete: 'off' }), field('Port', 'port', { type: 'number' })),
    h('div', { class: 'row' }, field('Username', 'username', { autocomplete: 'off' }), field('Password', 'password', { type: 'password', autocomplete: 'new-password' })),
    h('div', { class: 'row' }, field('Connections', 'connections', { type: 'number' }, "Check your provider's limit (often 20–50)"),
      h('div', { class: 'field' }, h('label', {}, 'Encryption'),
        h('label', { class: 'flex', style: { height: '44px' } }, h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: u.ssl, onChange: (e) => { u.ssl = e.target.checked; } }), h('span', { class: 'track' })), 'Use SSL (recommended)'))));
  const toggle = h('input', { type: 'checkbox', checked: u.enabled, onChange: (e) => { u.enabled = e.target.checked; usenetForm.style.display = u.enabled ? 'block' : 'none'; } });

  const f = foot(id, {
    onNext: async () => {
      err.textContent = '';
      if (a.includes('sabnzbd') && u.enabled && !u.host.trim()) return (err.textContent = 'Enter your provider\'s server address, or switch the option off to skip.');
      await saveAnswers({ usenet: a.includes('sabnzbd') ? u : { enabled: false } });
      next(id);
    },
  });

  return h('div', {}, h('h2', {}, 'Download clients'),
    h('p', { class: 'lead' }, 'Both clients are built in and already pointed at the right folders.'),
    h('div', { class: 'stack' },
      a.includes('qbittorrent') ? h('div', { class: 'card', style: { background: 'var(--panel2)' } },
        h('div', { class: 'flex' }, badgeEl(mod('qbittorrent')), h('div', { class: 'grow' }, h('b', {}, 'qBittorrent'), h('div', { class: 'muted small' }, 'Torrents are saved to /media/downloads/torrents and hardlinked into your library. Nothing to set up.')),
          h('span', { class: 'pill pill-ok' }, icon('check', 12), 'Ready'))) : null,
      a.includes('sabnzbd') ? h('div', { class: 'card', style: { background: 'var(--panel2)' } },
        h('div', { class: 'flex' }, badgeEl(mod('sabnzbd')), h('div', { class: 'grow' }, h('b', {}, 'SABnzbd'), h('div', { class: 'muted small' }, 'Usenet needs a paid provider account. Skip this if you only use torrents.')),
          h('span', { class: 'switch' }, toggle, h('span', { class: 'track' }))),
        usenetForm) : null,
      err),
    f.el);
}

// 5 ─────────────────────────────────────────────────────────────────── media server ───
function server(id) {
  let type = S.answers.mediaServer?.type ?? 'none';
  const choices = [
    ['plex', 'Plex', 'Sign in with your Plex account'], ['jellyfin', 'Jellyfin', 'Free and open source'],
    ['emby', 'Emby', 'Self-hosted media server'], ['none', 'Not yet', "I'll connect it later"],
  ];
  const nodes = choices.map(([k, name, sub]) => h('div', { class: `choice ${type === k ? 'on' : ''}`, role: 'radio', tabindex: 0, 'aria-checked': String(type === k),
    onClick: () => pick(k), onKeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick(k)) }, name, h('span', { class: 'sub' }, sub)));
  function pick(k) {
    type = k;
    nodes.forEach((n, i) => { n.classList.toggle('on', choices[i][0] === k); n.setAttribute('aria-checked', String(choices[i][0] === k)); });
  }
  const f = foot(id, { onNext: async () => { await saveAnswers({ mediaServer: { type } }); next(id); } });
  return h('div', {}, h('h2', {}, 'Which media server do you use?'),
    h('p', { class: 'lead' }, 'Requests, invites and library cleanup all talk to your media server. This only tailors the checklist we show you afterwards.'),
    h('div', { class: 'choice-grid', role: 'radiogroup', 'aria-label': 'Media server' }, nodes), f.el);
}

// 6 ──────────────────────────────────────────────────────────────────────── review ───
function review(id) {
  const sel = selectedApps().map(mod).filter(Boolean);
  const err = h('div', { class: 'error-text', role: 'alert' });
  const go1 = button('Set everything up', { kind: 'primary', cls: 'btn-lg', iconRight: 'bolt', onClick: async () => {
    go1.disabled = true;
    try {
      S.wiring = await api('/setup/run', { method: 'POST', body: {} });
      go('#/setup/install');
    } catch (e) { err.textContent = e.message; go1.disabled = false; }
  } });
  return h('div', {}, h('h2', {}, 'Ready to go'),
    h('p', { class: 'lead' }, "Here's what Allarr is about to do. You can change any of it later."),
    h('div', { class: 'flex wrap', style: { marginBottom: '18px' } }, sel.map((m) => h('span', { class: 'pill', style: { height: '32px', paddingLeft: '6px' } }, badgeEl(m, 20), m.name))),
    h('div', { class: 'stack' },
      [
        ['folder', 'Start your apps inside this one container and hide them behind your Allarr login.'],
        ['link', 'Connect them to each other: download clients in Sonarr/Radarr/Lidarr, indexers from Prowlarr, subtitles from Bazarr, requests in Seerr.'],
        ['disk', 'Point every library at /media so finished downloads are hardlinked instead of copied.'],
      ].map(([ic, t]) => h('div', { class: 'flex', style: { alignItems: 'flex-start' } }, h('span', { class: 'ic ok' }, icon(ic, 14)), h('span', {}, t)))),
    err,
    h('div', { class: 'wiz-foot' }, button('Back', { kind: 'ghost', icon: 'left', onClick: () => back(id) }), go1));
}

// 7 ─────────────────────────────────────────────────────────────────────── install ───
function install() {
  const box = h('div');
  const paint = (w) => {
    if (!w) {
      fill(box, h('div', { class: 'flex muted' }, spinner(), 'Waiting for setup to start…'));
      return;
    }
    fill(box, 
      h('h2', {}, w.running ? 'Setting things up…' : w.status === 'ok' ? 'You are all set' : 'Setup finished'),
      h('p', { class: 'lead' }, w.running ? 'This can take a minute or two the first time — the apps create their databases on first start.' : 'Here is what happened:'),
      progressList(w),
      progressSummary(w, {
        onContinue: async () => { S.onWiring = null; await refreshMe(); go('#/'); },
        onRetry: async () => { S.wiring = await api('/setup/run', { method: 'POST', body: {} }); paint(S.wiring); },
      }),
    );
  };
  S.onWiring = paint;
  paint(S.wiring);
  api('/wiring').then((w) => { if (w && !S.wiring) { S.wiring = w; paint(w); } }).catch(() => {});
  return box;
}
