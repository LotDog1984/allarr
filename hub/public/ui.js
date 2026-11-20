// Tiny UI toolkit: element builder, icons, toasts, formatting. No framework, no build step.

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (['value', 'checked', 'disabled', 'selected'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}

/** Replace an element's children. Unlike replaceChildren(), it flattens arrays and skips null/false. */
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false).map((k) => (k.nodeType ? k : document.createTextNode(String(k)))));
  return el;
}

// --- icons (24x24, stroke) -----------------------------------------------------------------
const PATHS = {
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  right: 'M5 12h14M12 5l7 7-7 7',
  left: 'M19 12H5M12 19l-7-7 7-7',
  external: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  settings: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  folder: 'M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  disk: 'M3 14h18M5 14l2-9h10l2 9M5 14v5h14v-5M17 17h.01',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  terminal: 'M4 17l6-6-6-6M12 19h8',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  sparkle: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  tv: 'M3 7h18v12H3zM8 3l4 4 4-4',
  film: 'M4 4h16v16H4zM4 9h16M4 15h16M9 4v16M15 4v16',
  music: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  captions: 'M4 5h16v14H4zM8 11h3M8 15h3M14 11h2M14 15h2',
  download: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  users: 'M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM21 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
  logs: 'M14 3H6v18h12V7zM14 3v4h4M9 12h6M9 16h6',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
};

export function icon(name, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', PATHS[name] ?? PATHS.info);
  svg.append(path);
  return svg;
}

export const APP_ICON = {
  sonarr: 'tv', radarr: 'film', lidarr: 'music', prowlarr: 'search', bazarr: 'captions',
  qbittorrent: 'download', sabnzbd: 'download', seerr: 'sparkle', wizarr: 'users',
  maintainerr: 'trash', cleanuparr: 'trash', profilarr: 'settings',
};

/** Coloured square with the app's initial. (We use monograms, not trademarked logos.) */
export function badge(mod, size = 40) {
  return h('span', {
    class: 'badge',
    style: { width: `${size}px`, height: `${size}px`, '--c': mod.color, fontSize: `${Math.round(size * 0.42)}px` },
    'aria-hidden': 'true',
  }, icon(APP_ICON[mod.id] ?? 'info', Math.round(size * 0.5)));
}

export const spinner = () => h('span', { class: 'spinner', role: 'status', 'aria-label': 'Working' });

// --- buttons -------------------------------------------------------------------------------
export function button(label, { kind = 'secondary', icon: ic, iconRight, onClick, disabled, title, type = 'button', cls = '' } = {}) {
  return h(
    'button',
    { class: `btn btn-${kind} ${cls}`.trim(), type, onClick, disabled, title },
    ic && icon(ic, 16),
    label && h('span', {}, label),
    iconRight && icon(iconRight, 16),
  );
}

// --- toasts --------------------------------------------------------------------------------
export function toast(message, kind = 'info') {
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast toast-${kind}` }, icon(kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'info', 16), h('span', {}, message));
  box.append(el);
  setTimeout(() => el.classList.add('out'), 3800);
  setTimeout(() => el.remove(), 4300);
}

export async function copyText(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} to clipboard`, 'ok');
  } catch {
    // clipboard API needs https/localhost; fall back to a selectable prompt
    window.prompt('Copy this:', text);
  }
}

// --- misc ----------------------------------------------------------------------------------
export function formatBytes(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

export function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  return hr < 48 ? `${hr} h ago` : `${Math.round(hr / 24)} days ago`;
}

export const greeting = () => {
  const hr = new Date().getHours();
  return hr < 5 ? 'Still up' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
};

/** Where do the apps that live on their own port (Seerr, Wizarr) live from this browser's point of view? */
export const exposedUrl = (addr) => (/^https?:\/\//.test(String(addr)) ? String(addr) : `${location.protocol}//${location.hostname}:${addr}`);

export function modal({ title, body, actions = [], wide = false, onClose }) {
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const overlay = h(
    'div',
    { class: 'overlay', onClick: (e) => e.target === overlay && close() },
    h('div', { class: `modal ${wide ? 'modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onClick: close }, icon('x', 18))),
      h('div', { class: 'modal-body' }, body),
      actions.length ? h('div', { class: 'modal-foot' }, actions) : null,
    ),
  );
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  return { close, overlay };
}
