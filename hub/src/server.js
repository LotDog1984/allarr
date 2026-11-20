import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as store from './state.js';
import * as auth from './auth.js';
import * as storage from './storage.js';
import * as stack from './stack.js';
import * as health from './health.js';
import * as sup from './supervisor.js';
import * as wiring from './wire.js';
import * as todos from './todos.js';
import * as updates from './updates.js';
import { proxyHttp, proxyUpgrade } from './proxy.js';
import { GROUPS, MODULES, byId, publicInfo, baseUrl } from './modules.js';
import { keyOf } from './arr.js';

store.load();

// ------------------------------------------------------------------------- helpers ---
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};
const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src 'self' http: https:; connect-src 'self'; frame-ancestors 'self'",
};

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { ...SECURITY, ...headers });
  res.end(body);
};
const json = (res, code, obj, headers = {}) =>
  send(res, code, JSON.stringify(obj), { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
const fail = (res, code, message) => json(res, code, { error: message });

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error('Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https';
const enabledMods = () => store.enabledIds().map((id) => byId[id]).filter(Boolean);

// ------------------------------------------------------------------ live updates (SSE) ---
const clients = new Set();
const broadcast = (event, data) => {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
};
wiring.events.on('wiring', (w) => broadcast('wiring', w));
updates.events.on('updates', (u) => broadcast('updates', u));
updates.events.on('job', (j) => broadcast('update', j));

function statusPayload() {
  return health.statuses();
}

function serveEvents(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(`event: status\ndata: ${JSON.stringify(statusPayload())}\n\n`);
  res.write(`event: wiring\ndata: ${JSON.stringify(wiring.current() ?? null)}\n\n`);
  clients.add(res);
  const beat = setInterval(() => res.write(': ♥\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(beat);
    clients.delete(res);
  });
}

/** Port (or full URL) a browser should use to reach an app that lives on its own port. */
const publicAddress = (m) =>
  store.get().settings?.addresses?.[m.id] ?? process.env[`PUBLIC_PORT_${m.id.toUpperCase()}`] ?? m.port;
const catalog = () => ({
  groups: GROUPS,
  modules: MODULES.map((m) => ({ ...publicInfo(m), exposedPort: m.exposed ? publicAddress(m) : null })),
});

// -------------------------------------------------------------------------- API routes ---
const NAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

const open = {
  'GET /api/state': (req, res) => {
    const s = store.get();
    json(res, 200, {
      version: config.version,
      hasAdmin: !!s.admin,
      authenticated: !!auth.currentUser(req),
      setupComplete: s.setup.complete,
      username: auth.currentUser(req),
    });
  },

  'POST /api/setup/admin': async (req, res) => {
    if (store.get().admin) return fail(res, 409, 'An account already exists.');
    const { username, password } = await readJson(req);
    if (!NAME_RE.test(username ?? '')) return fail(res, 400, 'Username must be 3–32 letters, numbers, dots, dashes or underscores.');
    if ((password ?? '').length < 8) return fail(res, 400, 'Choose a password with at least 8 characters.');
    store.update((s) => { s.admin = { username, hash: auth.hashPassword(password) }; });
    json(res, 200, { ok: true }, { 'set-cookie': auth.sessionCookie(username, isHttps(req)) });
  },

  'POST /api/login': async (req, res) => {
    if (!auth.throttle(req.socket.remoteAddress)) return fail(res, 429, 'Too many attempts. Wait a minute and try again.');
    const { username, password } = await readJson(req);
    const admin = store.get().admin;
    if (!admin || username !== admin.username || !auth.verifyPassword(password ?? '', admin.hash)) {
      return fail(res, 401, 'Wrong username or password.');
    }
    json(res, 200, { ok: true }, { 'set-cookie': auth.sessionCookie(username, isHttps(req)) });
  },

  'POST /api/logout': (req, res) => json(res, 200, { ok: true }, { 'set-cookie': auth.clearCookie() }),
};

const secured = {
  'GET /api/catalog': (req, res) => json(res, 200, catalog()),

  'POST /api/settings/theme': async (req, res) => {
    const { enabled } = await readJson(req);
    store.update((s) => { s.settings = { ...s.settings, theme: !!enabled }; });
    json(res, 200, { enabled: !!enabled });
  },
  'GET /api/settings/theme': (req, res) => json(res, 200, { enabled: store.get().settings?.theme !== false }),

  // Seerr/Wizarr keep their own port. The container can't know which HOST port was published, so let the user say.
  'POST /api/settings/addresses': async (req, res) => {
    const body = await readJson(req);
    const next = {};
    for (const m of MODULES.filter((x) => x.exposed)) {
      const v = String(body[m.id] ?? '').trim();
      if (!v) continue;
      const okPort = /^\d+$/.test(v) && +v >= 1 && +v <= 65535;
      const okUrl = /^https?:\/\/[^\s/]+(\/\S*)?$/.test(v);
      if (!okPort && !okUrl) return fail(res, 400, `${m.name}: enter a port number (like 12000) or a full address (like https://requests.example.com).`);
      next[m.id] = v.replace(/\/$/, '');
    }
    store.update((s) => { s.settings = { ...s.settings, addresses: next }; });
    json(res, 200, catalog());
  },

  // "Sync new subtitles with the embedded ones" (Bazarr's own auto-sync can only use the audio).
  'GET /api/settings/subtitle-sync': (req, res) => json(res, 200, { mode: wiring.subtitleSyncMode(), bazarr: enabledMods().some((m) => m.id === 'bazarr') }),
  'POST /api/settings/subtitle-sync': async (req, res) => {
    const { mode } = await readJson(req);
    if (!['off', 'embedded'].includes(mode)) return fail(res, 400, 'Choose "off" or "embedded".');
    store.update((s) => { s.settings = { ...s.settings, subtitleSync: mode }; });
    let message = null;
    if (enabledMods().some((m) => m.id === 'bazarr')) {
      try {
        message = await wiring.applySubtitleSync();
      } catch (e) {
        if (e.conflict) {
          store.update((s) => { s.settings = { ...s.settings, subtitleSync: 'off' }; }); // don't claim it's on when it isn't
          return fail(res, 409, e.message);
        }
        message = 'Saved. Bazarr is not reachable right now, so it will be applied the next time you press Re-apply connections.';
      }
    }
    json(res, 200, { mode, message });
  },

  'GET /api/answers': (req, res) => json(res, 200, store.get().setup.answers ?? {}),

  'POST /api/answers': async (req, res) => {
    const body = await readJson(req);
    if (body.apps) body.apps = body.apps.filter((id) => byId[id]);
    store.update((s) => { s.setup.answers = { ...s.setup.answers, ...body }; });
    json(res, 200, store.get().setup.answers);
  },

  'GET /api/storage': (req, res) => json(res, 200, storage.check()),

  'POST /api/setup/run': async (req, res) => json(res, 202, await wiring.start()),

  'GET /api/wiring': (req, res) => json(res, 200, wiring.current() ?? null),

  'GET /api/status': (req, res) => json(res, 200, { modules: statusPayload(), setupComplete: store.get().setup.complete }),

  'GET /api/events': serveEvents,

  // Updates: checking is automatic, installing only ever happens after the user confirms the exact version.
  'GET /api/updates': (req, res) => json(res, 200, updates.summary()),
  'POST /api/updates/check': async (req, res) => json(res, 200, await updates.check()),
  'GET /api/updates/job': (req, res) => json(res, 200, updates.currentJob()),
  'POST /api/updates/apply': async (req, res) => {
    const { id, version } = await readJson(req);
    try {
      json(res, 202, await updates.apply(id, version));
    } catch (e) {
      fail(res, 409, e.message);
    }
  },

  'GET /api/todos': (req, res) => json(res, 200, todos.list()),

  'GET /api/connections': (req, res) =>
    json(res, 200, enabledMods().map((m) => ({
      id: m.id, name: m.name, url: baseUrl(m), apiKey: keyOf(m.id) ?? null,
      extra: m.id === 'qbittorrent' ? store.get().qbittorrent : m.id === 'cleanuparr' ? (store.get().modules.cleanuparr?.login ?? null) : null,
    }))),

  'POST /api/password': async (req, res) => {
    const { current, next } = await readJson(req);
    const admin = store.get().admin;
    if (!auth.verifyPassword(current ?? '', admin.hash)) return fail(res, 403, 'Current password is wrong.');
    if ((next ?? '').length < 8) return fail(res, 400, 'Choose a password with at least 8 characters.');
    store.update((s) => { s.admin.hash = auth.hashPassword(next); });
    json(res, 200, { ok: true });
  },

  // Turn apps on/off after setup. Everything gets (re)wired afterwards.
  'POST /api/apps': async (req, res) => {
    const { apps } = await readJson(req);
    if (!Array.isArray(apps)) return fail(res, 400, 'Expected a list of apps.');
    store.update((s) => { s.setup.answers = { ...s.setup.answers, apps: apps.filter((id) => byId[id]) }; });
    json(res, 202, await wiring.start());
  },
};

// /api/todos/:id, /api/modules/:id/{restart,logs}
async function dynamic(req, res, url) {
  let m;
  if (req.method === 'POST' && (m = url.match(/^\/api\/todos\/([\w-]+)$/))) {
    const { done } = await readJson(req);
    store.update((s) => { s.todos[m[1]] = !!done; });
    return json(res, 200, { ok: true });
  }
  if ((m = url.match(/^\/api\/modules\/(\w+)\/(restart|logs)$/))) {
    const mod = byId[m[1]];
    if (!mod || !store.get().modules[mod.id]?.enabled) return fail(res, 404, 'Unknown app.');
    if (m[2] === 'logs' && req.method === 'GET') return json(res, 200, { lines: sup.tail(mod.id, 300) });
    if (m[2] === 'restart' && req.method === 'POST') {
      stack.restartModule(mod.id);
      return json(res, 202, { ok: true });
    }
  }
  return false;
}

// --------------------------------------------------------------------- static files ---
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  let file = path.normalize(path.join(config.publicDir, rel));
  if (!file.startsWith(config.publicDir)) return fail(res, 403, 'Forbidden');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (path.extname(rel)) return fail(res, 404, 'Not found');
    file = path.join(config.publicDir, 'index.html');
  }
  const ext = path.extname(file);
  send(res, 200, fs.readFileSync(file), {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    // Assets aren't fingerprinted, so make browsers revalidate instead of serving stale UI after an upgrade.
    'cache-control': 'no-cache',
  });
}

// ---------------------------------------------------------------------------- server ---
function proxyTarget(pathname) {
  return enabledMods().find((m) => m.basePath && (pathname === m.basePath || pathname.startsWith(`${m.basePath}/`)));
}

/** Phone apps and scripts present the app's own API key; let those through. */
function hasValidApiKey(req, mod, url) {
  const key = keyOf(mod.id);
  if (!key) return false;
  const given = req.headers['x-api-key'] ?? new URL(url, 'http://x').searchParams.get('apikey');
  return given === key && url.startsWith(`${mod.basePath}/api`);
}

const server = http.createServer(async (req, res) => {
  const url = req.url;
  const pathname = url.split('?')[0];
  try {
    const mod = proxyTarget(pathname);
    if (mod) {
      if (pathname === mod.basePath) return send(res, 302, '', { location: `${mod.basePath}/` });
      if (!auth.currentUser(req) && !hasValidApiKey(req, mod, url)) {
        return req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')
          ? send(res, 302, '', { location: '/#/login' })
          : fail(res, 401, 'Log in to Allarr first.');
      }
      return proxyHttp(req, res, mod);
    }

    if (pathname.startsWith('/api/')) {
      const key = `${req.method} ${pathname}`;
      if (open[key]) return await open[key](req, res);
      if (!auth.currentUser(req)) return fail(res, 401, 'Please log in.');
      if (secured[key]) return await secured[key](req, res);
      if ((await dynamic(req, res, pathname)) !== false) return;
      return fail(res, 404, 'Not found');
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed');
    serveStatic(req, res, pathname);
  } catch (e) {
    console.error('[hub]', req.method, url, e);
    if (!res.headersSent) fail(res, 500, e.message || 'Something went wrong');
  }
});

server.on('upgrade', (req, socket, head) => {
  const mod = proxyTarget(req.url.split('?')[0]);
  if (!mod || (!auth.currentUser(req) && !hasValidApiKey(req, mod, req.url))) return socket.destroy();
  proxyUpgrade(req, socket, head, mod);
});

// --------------------------------------------------------------------------- startup ---
server.listen(config.port, config.host, () => {
  console.log(`Allarr Hub ${config.version} listening on http://${config.host}:${config.port}`);
  console.log(`  config: ${config.configDir}   media: ${config.mediaDir}   supervise: ${config.supervise}`);
  if (store.get().setup.complete) {
    updates.reconcile(); // drop in-place copies that a newer image has overtaken
    console.log('  starting your apps…');
    stack.startAll();
  }
});
health.startPoller((s) => broadcast('status', s));
updates.schedule();

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.log(`\n${sig}: stopping apps…`);
    await sup.stopAll();
    process.exit(0);
  });
}
