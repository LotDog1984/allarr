/**
 * Stand-ins for Sonarr, Radarr, Lidarr, Prowlarr, Bazarr, qBittorrent, SABnzbd, Seerr ...
 * They speak just enough of the real HTTP APIs for the Hub's wiring to be developed and
 * tested without Docker. Every request is checked against the API key the Hub seeded into
 * the app's config file, so a mismatch between seeding and wiring shows up here.
 *
 * Inspect what the Hub configured:  GET http://127.0.0.1:<port>/__mock/state
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { MODULES, internalBase } from '../src/modules.js';

const db = Object.fromEntries(MODULES.map((m) => [m.id, {
  rootfolder: [], downloadclient: [], applications: [], settings: null, servers: [],
  mediamanagement: { id: 1, copyUsingHardlinks: false, importExtraFiles: false },
}]));

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
function expectedKey(m) {
  const dir = path.join(config.configDir, m.id);
  if (m.kind === 'servarr') return read(path.join(dir, 'config.xml')).match(/<ApiKey>([^<]+)</)?.[1];
  if (m.kind === 'sabnzbd') return read(path.join(dir, 'sabnzbd.ini')).match(/^api_key\s*=\s*(\S+)/m)?.[1];
  if (m.kind === 'bazarr') return read(path.join(dir, 'config', 'config.yaml')).match(/apikey:\s*(\S+)/)?.[1];
  return null;
}

const field = (name, value = '') => ({ name, value });
const catField = (m) => ({ sonarr: 'tvCategory', radarr: 'movieCategory', lidarr: 'musicCategory', prowlarr: 'category' }[m.id]);
function clientSchema(m) {
  const common = [field('host', 'localhost'), field('port', 8080), field('useSsl', false), field('urlBase'), field('username'), field('password')];
  return [
    { implementation: 'QBittorrent', implementationName: 'qBittorrent', protocol: 'torrent', configContract: 'QBittorrentSettings', fields: [...common, field(catField(m), 'x'), field('initialState', 0)] },
    { implementation: 'Sabnzbd', implementationName: 'SABnzbd', protocol: 'usenet', configContract: 'SabnzbdSettings', fields: [...common, field('apiKey'), field(catField(m), 'x')] },
  ];
}
const appSchema = () => ['Sonarr', 'Radarr', 'Lidarr'].map((n) => ({
  implementation: n, implementationName: n, configContract: `${n}Settings`,
  fields: [field('prowlarrUrl'), field('baseUrl'), field('apiKey'), field('syncCategories', [])],
}));

const proxySchema = () => [{
  implementation: 'FlareSolverr', implementationName: 'FlareSolverr', configContract: 'FlareSolverrSettings',
  fields: [field('host', 'http://localhost:8191/'), field('requestTimeout', 60)],
}];

const page = (m) => `<!doctype html><meta charset=utf-8><title>${m.name} (mock)</title>
<body style="font:15px system-ui;padding:32px;background:#1b1e26;color:#dfe3ec">
<h1>${m.name} <small style="font-weight:400;opacity:.6">— mock UI</small></h1>
<p>This is a stand-in for the real ${m.name} web UI so the Hub's menu, proxy and iframe can be tested without Docker.</p>
<p>Request path as seen by the app: <code>${m.basePath ?? '/'}</code></p>`;

const body = (req) => new Promise((resolve) => {
  const c = [];
  req.on('data', (d) => c.push(d));
  req.on('end', () => resolve(Buffer.concat(c).toString()));
});

function handler(m) {
  const state = db[m.id];
  return async (req, res) => {
    const reply = (code, data, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type });
      res.end(typeof data === 'string' ? data : JSON.stringify(data));
    };
    const u = new URL(req.url, 'http://x');
    let p = u.pathname;
    const base = internalBase(m);
    if (base && p.startsWith(base)) p = p.slice(base.length) || '/';
    const raw = await body(req);
    const log = (extra = '') => console.log(`[mock ${m.id}] ${req.method} ${p}${extra}`);

    if (p === '/__mock/state') return reply(200, state);
    if (p === '/ping' || p === '/health') return reply(200, { status: 'OK' });

    if (m.kind === 'servarr' && p.startsWith(`/api/${m.api}/`)) {
      const key = req.headers['x-api-key'];
      const want = expectedKey(m);
      if (!want || key !== want) { log(' → 401 (bad key)'); return reply(401, { error: 'Unauthorized' }); }
      const r = p.slice(`/api/${m.api}`.length);
      const json = raw ? JSON.parse(raw) : null;
      log(raw ? ` ${raw.slice(0, 140)}` : '');
      if (r === '/system/status') return reply(200, { version: '4.0.0.mock', appName: m.name });
      if (r === '/qualityprofile') return reply(200, [{ id: 1, name: 'Any' }, { id: 2, name: 'HD-1080p' }]);
      if (r === '/metadataprofile') return reply(200, [{ id: 1, name: 'Standard' }]);
      if (r === '/config/mediamanagement') return reply(200, state.mediamanagement);
      if (r.startsWith('/config/mediamanagement/') && req.method === 'PUT') { state.mediamanagement = json; return reply(200, json); }
      const coll = r.match(/^\/(rootfolder|downloadclient|applications|tag|indexerProxy)(?:\/(schema|\d+))?$/);
      if (coll) {
        const list = (state[coll[1]] ??= []);
        if (coll[2] === 'schema') return reply(200, coll[1] === 'downloadclient' ? clientSchema(m) : coll[1] === 'indexerProxy' ? proxySchema() : appSchema());
        if (req.method === 'GET') return reply(200, list);
        if (req.method === 'POST') { const item = { ...json, id: list.length + 1 }; list.push(item); return reply(201, item); }
        if (req.method === 'PUT') { const i = list.findIndex((x) => x.id === json.id); list[i] = json; return reply(200, json); }
      }
      return reply(404, { error: 'mock: not implemented' });
    }

    if (m.kind === 'sabnzbd' && p === '/api') {
      const q = u.searchParams;
      if (q.get('mode') === 'version') return reply(200, { version: '5.1.3-mock' });
      if (q.get('mode') === 'get_cats') return reply(200, { categories: ['*', ...(state.cats ??= ['movies', 'tv', 'music'])] });
      if (q.get('mode') === 'set_config' && q.get('section') === 'categories') {
        if (q.get('apikey') !== expectedKey(m)) return reply(200, { status: false, error: 'API Key Incorrect' });
        (state.cats ??= ['movies', 'tv', 'music']).push(q.get('name'));
        return reply(200, { status: true });
      }
      if (q.get('mode') === 'set_config') {
        if (q.get('apikey') !== expectedKey(m)) return reply(200, { status: false, error: 'API Key Incorrect' });
        log(` ${q.get('section')} ${q.get('name')} ${q.get('host')}`);
        state.servers.push(Object.fromEntries([...q].filter(([k]) => k !== 'password' && k !== 'apikey')));
        return reply(200, { status: true });
      }
    }
    if (m.kind === 'qbittorrent' && p === '/api/v2/app/version') return reply(200, 'v5.0.0-mock', 'text/plain');
    if (m.kind === 'flaresolverr' && p === '/') return reply(200, { msg: 'FlareSolverr is ready!', version: '3.5.2-mock', userAgent: 'mock' });
    if (m.kind === 'seerr' && p === '/api/v1/status') return reply(200, { version: '3.5.2-mock' });
    if (m.kind === 'bazarr' && p === '/api/system/settings' && req.method === 'POST') {
      if (req.headers['x-api-key'] !== expectedKey(m)) return reply(401, { error: 'bad key' });
      state.settings = Object.fromEntries(new URLSearchParams(raw));
      log(` ${Object.keys(state.settings).length} settings`);
      return reply(204, '');
    }
    return reply(200, page(m), 'text/html; charset=utf-8');
  };
}

for (const m of MODULES) {
  http.createServer(handler(m)).listen(m.listenPort, m.listenHost === '0.0.0.0' ? '127.0.0.1' : m.listenHost, () =>
    console.log(`[mock] ${m.name.padEnd(12)} on :${m.listenPort}${m.basePath ?? ''}`));
}
