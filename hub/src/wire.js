import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as store from './state.js';
import * as storage from './storage.js';
import * as stack from './stack.js';
import * as seed from './seed.js';
import * as health from './health.js';
import * as sup from './supervisor.js';
import { byId, baseUrl, MODULES } from './modules.js';
import crypto from 'node:crypto';
import { arr, call, keyOf, upsertWithSchema, ApiError } from './arr.js';
import { canWrite, fixHint } from './perms.js';

/**
 * The wiring engine. This is what replaces "open 12 web UIs and paste API keys between them".
 * Every step is idempotent: running it again just re-asserts the same connections.
 */
export const events = new EventEmitter();
let run = null;

const snapshot = () => run && { ...run, steps: run.steps.map(({ fn, ...s }) => s) };
export const current = () => snapshot() ?? store.get().wiring;
const publish = () => events.emit('wiring', snapshot());

function friendly(e) {
  if (e?.name === 'TimeoutError') return 'took too long to answer';
  if (e?.cause?.code === 'ECONNREFUSED') return 'is not reachable yet';
  if (e instanceof ApiError && [401, 403].includes(e.status)) return 'rejected the API key';
  return e?.message ?? String(e);
}

/** Run fn for every item; one failure doesn't stop the others. */
async function each(items, label, fn) {
  const lines = [];
  let bad = 0;
  for (const item of items) {
    try {
      const note = await fn(item);
      lines.push(`✓ ${label(item)}${note ? ` — ${note}` : ''}`);
    } catch (e) {
      bad++;
      lines.push(`✗ ${label(item)} ${friendly(e)}`);
    }
  }
  const status = !bad ? 'ok' : bad === items.length ? 'error' : 'warn';
  return { status, detail: lines.join('\n') };
}

const name = (id) => byId[id].name;
/** The Prowlarr tag that routes an indexer through FlareSolverr. Also named in the checklist text. */
export const FLARE_TAG = 'flaresolverr';
/** The last couple of log lines, so a failed start says WHY right in the wizard. */
const lastLog = (id) => {
  const lines = sup.tail(id, 40).map((l) => l.trim()).filter(Boolean).slice(-2);
  return lines.length ? `\n    ↳ ${lines.map((l) => l.slice(0, 180)).join('\n    ↳ ')}` : '';
};
const mediaPath = (rel) => `${config.mediaDir.replace(/\\/g, '/')}/${rel}`;
const norm = (p) => p.replace(/[\\/]+$/, '');

// ------------------------------------------------------------------------------ steps ---
const steps = {
  async storage() {
    const r = storage.check();
    if (!r.ok) return { status: 'error', detail: r.issues.map((i) => `✗ ${i.message}`).join('\n') };
    const lines = ['✓ Folders created: downloads, movies, series, music'];
    lines.push(r.hardlinks ? '✓ Hardlinks work — imports are instant and use no extra space' : '');
    for (const i of r.issues) lines.push(`! ${i.message}`);
    return { status: r.issues.length ? 'warn' : 'ok', detail: lines.filter(Boolean).join('\n') };
  },

  async start(ctx) {
    // Fail early and clearly if the apps (running as PUID:PGID) can't write to their own folders.
    const ids0 = ctx.ids.filter((id) => id !== 'seerr');
    for (const id of ids0) seed.prepare(byId[id]); // creates /config/<app> and hands it to the app user
    const blocked = ids0.map((id) => path.join(config.configDir, id)).filter((d) => fs.existsSync(d) && !canWrite(d));
    if (blocked.length) {
      throw new Error(`The apps run as ${config.puid}:${config.pgid ?? config.puid} but can't write to ${blocked.join(', ')}. ${fixHint(blocked[0])}`);
    }
    const ids = ctx.ids.filter((id) => id !== 'seerr'); // Seerr starts last, once it has something to talk to
    for (const id of ids) stack.startModule(id);
    return { status: 'ok', detail: ids.map((id) => `✓ ${name(id)}`).join('\n') };
  },

  async wait(ctx) {
    const ids = ctx.ids.filter((id) => id !== 'seerr');
    await Promise.all(
      ids.map(async (id) => {
        if (await health.waitUntilUp(byId[id])) ctx.up.add(id);
      }),
    );
    const down = ids.filter((id) => !ctx.up.has(id));
    const lines = ids.map((id) =>
      ctx.up.has(id)
        ? `✓ ${name(id)} is ready`
        : `✗ ${name(id)} didn't start${sup.info(id).error ? ` (${sup.info(id).error})` : ' — check its log in Settings'}${lastLog(id)}`,
    );
    return { status: !down.length ? 'ok' : down.length === ids.length ? 'error' : 'warn', detail: lines.join('\n') };
  },

  /**
   * Cleanuparr insists on its own account on first run. Allarr already signs you in, so: create that account
   * with a random password (kept under Settings -> Connection details), finish its setup, and switch on its
   * "disable authentication for local addresses" mode. Only the Hub can reach it (127.0.0.1), so this is safe.
   */
  async cleanuparr(ctx) {
    if (!ctx.up.has('cleanuparr')) return { status: 'warn', detail: '✗ Cleanuparr is not running.' };
    const api = (method, path, opts) => call('cleanuparr', method, path, opts);
    let status = await api('GET', '/api/auth/status');
    let creds = store.get().modules.cleanuparr?.login;

    if (!status.setupCompleted) {
      creds ??= { username: 'allarr', password: `${crypto.randomBytes(18).toString('base64url')}-Aa1` };
      store.update((s) => { s.modules.cleanuparr = { ...s.modules.cleanuparr, login: creds }; }); // keep it before using it
      await api('POST', '/api/auth/setup/account', { body: creds });
      await api('POST', '/api/auth/setup/complete', { body: {} });
      status = await api('GET', '/api/auth/status');
    }
    if (status.authBypassActive) return { status: 'ok', detail: '✓ Cleanuparr already trusts Allarr, so there is no second sign-in' };
    if (!creds) {
      return {
        status: 'warn',
        detail: "! Cleanuparr already has an account that Allarr doesn't know. In Cleanuparr: Settings → General → turn on \"Disable authentication for local addresses\" to skip its sign-in.",
      };
    }

    const login = await api('POST', '/api/auth/login', { body: creds });
    const token = login?.tokens?.accessToken;
    if (!token) throw new Error('Cleanuparr did not return a sign-in token');
    const headers = { Authorization: `Bearer ${token}` };
    const general = await api('GET', '/api/configuration/general', { headers });
    general.auth = { ...general.auth, disableAuthForLocalAddresses: true };
    await api('PUT', '/api/configuration/general', { headers, body: general });
    status = await api('GET', '/api/auth/status');
    if (!status.authBypassActive) throw new Error('Cleanuparr did not accept the setting');
    return { status: 'ok', detail: '✓ Cleanuparr set up and now trusts Allarr (no second sign-in)' };
  },

  async usenet(ctx) {
    const u = ctx.answers.usenet;
    if (!u?.enabled || !u.host) {
      return { status: 'skipped', detail: 'No provider entered. You can add one later from the checklist.' };
    }
    if (!ctx.up.has('sabnzbd')) return { status: 'warn', detail: '✗ SABnzbd is not running, provider not added.' };
    const label = u.name?.trim() || 'Usenet provider';
    const q = new URLSearchParams({
      mode: 'set_config', section: 'servers', name: label, displayname: label,
      host: u.host.trim(), port: String(u.port || 563), ssl: u.ssl === false ? '0' : '1',
      username: u.username ?? '', password: u.password ?? '', connections: String(u.connections || 20),
      enable: '1', apikey: keyOf('sabnzbd') ?? '', output: 'json',
    });
    const res = await call('sabnzbd', 'GET', `/api?${q}`);
    if (res?.status === false) throw new Error(res.error || 'SABnzbd refused the provider');
    return { status: 'ok', detail: `✓ ${label} added to SABnzbd` };
  },

  async libraries(ctx) {
    const libs = ctx.libs.filter((id) => ctx.up.has(id));
    return each(libs, (id) => name(id), async (id) => {
      const m = byId[id];
      const want = mediaPath(m.rootFolder);
      const roots = await arr(id, 'GET', '/rootfolder');
      if (!roots.some((r) => norm(r.path) === want)) {
        const body = { path: want };
        if (id === 'lidarr') {
          const [q, md] = await Promise.all([arr(id, 'GET', '/qualityprofile'), arr(id, 'GET', '/metadataprofile')]);
          Object.assign(body, {
            name: 'Music', defaultQualityProfileId: q[0]?.id ?? 1, defaultMetadataProfileId: md[0]?.id ?? 1,
            defaultMonitorOption: 'all', defaultNewItemMonitorOption: 'all', defaultTags: [],
          });
        }
        await arr(id, 'POST', '/rootfolder', { body });
      }
      const mm = await arr(id, 'GET', '/config/mediamanagement');
      if (!mm.copyUsingHardlinks) {
        await arr(id, 'PUT', `/config/mediamanagement/${mm.id}`, { body: { ...mm, copyUsingHardlinks: true } });
      }
      return `${want}, hardlinks on`;
    });
  },

  async downloaders(ctx) {
    // Prowlarr gets the clients too (for grabbing a release straight from its own search page), in its own category.
    const libs = [...ctx.libs, ...(ctx.ids.includes('prowlarr') ? ['prowlarr'] : [])].filter((id) => ctx.up.has(id));
    const clients = [];
    if (ctx.up.has('qbittorrent')) clients.push('qbittorrent');
    if (ctx.up.has('sabnzbd')) clients.push('sabnzbd');
    const pairs = libs.flatMap((lib) => clients.map((c) => [lib, c]));
    return each(pairs, ([lib, c]) => `${name(lib)} ⇄ ${name(c)}`, async ([lib, c]) => {
      const category = byId[lib].category ?? 'prowlarr';
      const cats = { tvCategory: category, movieCategory: category, musicCategory: category, category };
      if (c === 'qbittorrent') {
        const creds = store.get().qbittorrent ?? { username: 'admin', password: '' };
        return upsertWithSchema(lib, 'downloadclient', 'QBittorrent', 'qBittorrent', {
          host: '127.0.0.1', port: byId.qbittorrent.listenPort, useSsl: false, urlBase: '',
          username: creds.username, password: creds.password, ...cats,
        }, { enable: true, priority: 1 });
      }
      return upsertWithSchema(lib, 'downloadclient', 'Sabnzbd', 'SABnzbd', {
        host: '127.0.0.1', port: byId.sabnzbd.listenPort, useSsl: false, urlBase: byId.sabnzbd.basePath,
        apiKey: keyOf('sabnzbd'), username: '', password: '', ...cats,
      }, { enable: true, priority: 1 });
    });
  },

  async indexers(ctx) {
    const libs = ctx.libs.filter((id) => ctx.up.has(id));
    return each(libs, (id) => `Prowlarr → ${name(id)}`, (id) =>
      upsertWithSchema('prowlarr', 'applications', name(id), name(id), {
        prowlarrUrl: baseUrl(byId.prowlarr), baseUrl: baseUrl(byId[id]), apiKey: keyOf(id),
      }, { syncLevel: 'fullSync' }),
    );
  },

  /**
   * Prowlarr talks to FlareSolverr through an "indexer proxy", and only for indexers that carry the proxy's tag.
   * So: make the tag, make the proxy, and the user ticks the tag on any indexer that Prowlarr says is
   * Cloudflare-protected (the checklist explains it). Tagging everything would slow every search down.
   */
  async flaresolverr(ctx) {
    if (!ctx.up.has('prowlarr')) return { status: 'warn', detail: '✗ Prowlarr is not running, so FlareSolverr was not added.' };
    if (!ctx.up.has('flaresolverr')) {
      return { status: 'warn', detail: `✗ FlareSolverr didn't start${sup.info('flaresolverr').error ? ` (${sup.info('flaresolverr').error})` : ''}${lastLog('flaresolverr')}` };
    }
    const label = FLARE_TAG;
    const tags = await arr('prowlarr', 'GET', '/tag');
    const tag = tags.find((t) => t.label === label) ?? (await arr('prowlarr', 'POST', '/tag', { body: { label } }));
    const how = await upsertWithSchema('prowlarr', 'indexerProxy', 'FlareSolverr', 'FlareSolverr', {
      host: `http://127.0.0.1:${byId.flaresolverr.listenPort}/`, requestTimeout: 60,
    }, { tags: [tag.id] });
    return { status: 'ok', detail: `✓ FlareSolverr ${how} in Prowlarr. Give an indexer the "${label}" tag to send it through FlareSolverr` };
  },

  async subtitles(ctx) {
    const form = {};
    const linked = [];
    for (const id of ['sonarr', 'radarr']) {
      if (!ctx.up.has(id)) continue;
      const m = byId[id];
      Object.assign(form, {
        [`settings-general-use_${id}`]: 'true',
        [`settings-${id}-ip`]: '127.0.0.1',
        [`settings-${id}-port`]: String(m.listenPort),
        [`settings-${id}-base_url`]: m.basePath,
        [`settings-${id}-ssl`]: 'false',
        [`settings-${id}-apikey`]: keyOf(id),
      });
      linked.push(name(id));
    }
    if (!linked.length) return { status: 'skipped', detail: 'Neither Sonarr nor Radarr is running.' };
    // (header names are case-insensitive: call() already sends the key as X-Api-Key)
    await call('bazarr', 'POST', '/api/system/settings', { form });
    return { status: 'ok', detail: `✓ Bazarr ⇄ ${linked.join(' and ')}` };
  },

  async requests(ctx) {
    const file = path.join(config.configDir, 'seerr', 'settings.json');
    // Seerr must write its own complete default settings.json first (a partial file crashes it).
    if (config.supervise && !seed.isCompleteSeerrSettings(file)) {
      stack.startModule('seerr'); // also moves a partial leftover file aside
      await health.waitUntilUp(byId.seerr, { timeout: 150_000 });
      for (let i = 0; i < 20 && !seed.isCompleteSeerrSettings(file); i++) await new Promise((r) => setTimeout(r, 1000));
    }
    if (config.supervise) await sup.stop('seerr'); // Seerr rewrites this file while it runs
    let settings = {};
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* dev/mock: no real Seerr wrote one */ }
    if (config.supervise && !settings.main) {
      // Never write a file without Seerr's own defaults: it would crash on the next start.
      stack.startModule('seerr');
      return { status: 'warn', detail: '✗ Seerr did not finish creating its settings in time, so Radarr/Sonarr were not added. Run setup again in a minute.' };
    }

    const lines = [];
    for (const id of ['radarr', 'sonarr']) {
      if (!ctx.up.has(id)) continue;
      try {
        const m = byId[id];
        const profile = (await arr(id, 'GET', '/qualityprofile'))[0];
        const entry = {
          name: `Allarr ${m.name}`, hostname: '127.0.0.1', port: m.listenPort, apiKey: keyOf(id), useSsl: false,
          baseUrl: m.basePath, activeProfileId: profile?.id ?? 1, activeProfileName: profile?.name ?? 'Any',
          activeDirectory: mediaPath(m.rootFolder), is4k: false, isDefault: true, externalUrl: '',
          syncEnabled: false, preventSearch: false,
          ...(id === 'radarr' ? { minimumAvailability: 'released' } : { enableSeasonFolders: true }),
        };
        const others = (settings[id] ?? []).filter((x) => x.name !== entry.name);
        settings[id] = [...others, entry].map((x, i) => ({ ...x, id: i }));
        lines.push(`✓ ${m.name} added to Seerr`);
      } catch (e) {
        lines.push(`✗ ${name(id)} ${friendly(e)}`);
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));
    storage.chownPath(path.dirname(file));
    storage.chownPath(file);

    stack.startModule('seerr');
    const up = await health.waitUntilUp(byId.seerr, { timeout: 150_000 });
    ctx.up.add('seerr');
    lines.push(up ? '✓ Seerr is ready' : '✗ Seerr is still starting — give it a minute');
    return { status: lines.some((l) => l.startsWith('✗')) ? 'warn' : 'ok', detail: lines.join('\n') };
  },

  async finish() {
    store.update((s) => { s.setup.complete = true; });
    return { status: 'ok', detail: '✓ Everything is connected' };
  },
};

function plan(ids) {
  const has = (...x) => x.some((id) => ids.includes(id));
  const libs = ids.filter((id) => byId[id].rootFolder);
  const p = [{ id: 'storage', label: 'Preparing your media folders' }];
  p.push({ id: 'start', label: 'Starting your apps' }, { id: 'wait', label: 'Waiting for the apps to wake up' });
  if (has('cleanuparr')) p.push({ id: 'cleanuparr', label: 'Skipping Cleanuparr\'s separate sign-in' });
  if (has('sabnzbd')) p.push({ id: 'usenet', label: 'Setting up Usenet' });
  if (libs.length) p.push({ id: 'libraries', label: 'Pointing libraries at /media' });
  if ((libs.length || has('prowlarr')) && has('qbittorrent', 'sabnzbd')) p.push({ id: 'downloaders', label: 'Connecting the download clients' });
  if (has('prowlarr') && libs.length) p.push({ id: 'indexers', label: 'Sharing Prowlarr indexers' });
  if (has('prowlarr') && has('flaresolverr')) p.push({ id: 'flaresolverr', label: 'Connecting FlareSolverr to Prowlarr' });
  if (has('bazarr') && has('sonarr', 'radarr')) p.push({ id: 'subtitles', label: 'Connecting Bazarr' });
  if (has('seerr')) p.push({ id: 'requests', label: 'Setting up requests in Seerr' });
  p.push({ id: 'finish', label: 'Finishing up' });
  return p;
}

// ------------------------------------------------------------------------------- runner ---
export async function start() {
  if (run?.running) return snapshot();

  const answers = store.get().setup.answers ?? {};
  const wanted = (answers.apps?.length ? answers.apps : MODULES.filter((m) => m.defaultOn).map((m) => m.id)).filter(
    (id) => byId[id],
  );
  // Anything that was on before but isn't wanted any more gets stopped.
  for (const id of store.enabledIds()) if (!wanted.includes(id)) await stack.stopModule(id);

  const ctx = { ids: wanted, libs: wanted.filter((id) => byId[id].rootFolder), up: new Set(), answers };
  run = {
    running: true, startedAt: Date.now(), finishedAt: null, status: 'running',
    steps: plan(wanted).map((s) => ({ ...s, status: 'pending', detail: '' })),
  };
  publish();

  (async () => {
    for (const step of run.steps) {
      step.status = 'running';
      publish();
      try {
        const res = await steps[step.id](ctx);
        Object.assign(step, res);
      } catch (e) {
        Object.assign(step, { status: 'error', detail: `✗ ${friendly(e)}` });
      }
      publish();
    }
    run.running = false;
    run.finishedAt = Date.now();
    run.status = run.steps.some((s) => s.status === 'error') ? 'error' : run.steps.some((s) => s.status === 'warn') ? 'warn' : 'ok';
    store.update((s) => { s.wiring = snapshot(); });
    publish();
  })();

  return snapshot();
}
