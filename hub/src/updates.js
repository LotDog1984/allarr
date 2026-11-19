import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config, hubDir } from './config.js';
import * as store from './state.js';
import * as health from './health.js';
import * as stack from './stack.js';
import * as sup from './supervisor.js';
import { byId } from './modules.js';

/**
 * Update checks + user-confirmed updates.
 *
 *  - Every few hours the Hub asks upstream what the newest version of each enabled app is and shows a badge.
 *  - NOTHING is ever installed automatically. Sonarr, Radarr, Lidarr and Prowlarr can be updated in place
 *    from the GUI after the user confirms: download -> checksum -> stop -> back up the database -> switch ->
 *    start -> verify. If the new version doesn't come up, the old one is restored automatically.
 *  - Everything else (Bazarr, SABnzbd, Seerr, Wizarr, Maintainerr, Cleanuparr) needs a compiled build, so for
 *    those the badge just says a newer image is needed; the user redeploys the stack.
 */
export const events = new EventEmitter();

/** Apps that can be swapped to a newer download without rebuilding the image. */
export const IN_PLACE = ['sonarr', 'radarr', 'lidarr', 'prowlarr'];
const BIN = { sonarr: 'Sonarr', radarr: 'Radarr', lidarr: 'Lidarr', prowlarr: 'Prowlarr' };
const SERVARR = { radarr: ['radarr.servarr.com', 'Radarr/Radarr'], lidarr: ['lidarr.servarr.com', 'Lidarr/Lidarr'], prowlarr: ['prowlarr.servarr.com', 'Prowlarr/Prowlarr'] };
const GITHUB = {
  bazarr: 'morpheus65535/bazarr', sabnzbd: 'sabnzbd/sabnzbd', seerr: 'seerr-team/seerr',
  maintainerr: 'Maintainerr/Maintainerr', wizarr: 'wizarrrr/wizarr', cleanuparr: 'Cleanuparr/Cleanuparr',
};
export const hasSource = (id) => id === 'sonarr' || id in SERVARR || id in GITHUB;

const UA = { 'user-agent': 'allarr-hub' }; // generic; nothing about the user is sent upstream
const arch = () => (process.arch === 'arm64' ? 'arm64' : 'x64');

// -------------------------------------------------------------------------- versions ---
export function cmp(a, b) {
  const seg = (v) => String(v).replace(/^v/, '').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const [x, y] = [seg(a), seg(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Versions baked into the image at build time (see the Dockerfile). */
function manifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.appsDir, 'versions.json'), 'utf8'));
  } catch {
    return {};
  }
}

function currentOf(id) {
  const live = health.statuses().find((s) => s.id === id)?.version;
  return live ? String(live).replace(/^v/, '') : (manifest()[id] ?? null);
}

async function getJson(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    const host = new URL(url).host;
    if (host === 'api.github.com' && [403, 429].includes(res.status)) throw new Error("GitHub is limiting requests from this network right now. It will try again later.");
    throw new Error(`${host} answered ${res.status}`);
  }
  return res.json();
}

/** Newest stable version of an app, with a download (when we can install it in place). */
export async function latestOf(id) {
  if (process.env.ALLARR_UPDATES_FAKE === '1') {
    const cur = currentOf(id) ?? '1.0.0';
    const bump = ['sonarr', 'radarr', 'bazarr'].includes(id);
    const v = String(cur).replace(/\.mock$/, '').split('.').map((n) => parseInt(n, 10) || 0);
    v[v.length - 1] += bump ? 1 : 0;
    return { version: v.join('.'), date: new Date().toISOString(), notes: 'https://example.com/changelog', changes: ['Fixed a bug where something rare happened', 'Improved performance of the library scan'], url: 'http://127.0.0.1:9/fake.tar.gz' };
  }
  if (id === 'sonarr') {
    const r = (await getJson('https://services.sonarr.tv/v1/releases'))['v4-stable'];
    const a = r.linux?.[arch()]?.archive;
    return {
      version: r.version, date: r.releaseDate, url: a?.url, hash: a?.hash,
      notes: `https://github.com/Sonarr/Sonarr/releases/tag/v${r.version}`,
      changes: [...(r.changes?.new ?? []), ...(r.changes?.fixed ?? [])],
    };
  }
  if (SERVARR[id]) {
    const [host, repo] = SERVARR[id];
    const r = (await getJson(`https://${host}/v1/update/master/changes?os=linux&runtime=netcore&arch=${arch()}`))[0];
    return {
      version: r.version, date: r.releaseDate, url: r.url, hash: r.hash,
      notes: `https://github.com/${repo}/releases`,
      changes: [...(r.changes?.new ?? []), ...(r.changes?.fixed ?? [])],
    };
  }
  const r = await getJson(`https://api.github.com/repos/${GITHUB[id]}/releases/latest`);
  return { version: r.tag_name.replace(/^v/, ''), date: r.published_at, notes: r.html_url, changes: [] };
}

// ----------------------------------------------------------------------------- check ---
let checking = null;

export function check() {
  checking ??= (async () => {
    const items = {};
    await Promise.all(store.enabledIds().filter(hasSource).map(async (id) => {
      const current = currentOf(id);
      const base = { id, current, inPlace: IN_PLACE.includes(id) };
      try {
        const l = await latestOf(id);
        items[id] = {
          ...base, latest: l.version, available: !!current && cmp(l.version, current) > 0,
          date: l.date, notes: l.notes, changes: (l.changes ?? []).slice(0, 8),
          asset: l.url ? { url: l.url, hash: l.hash ?? null } : null,
        };
      } catch (e) {
        items[id] = { ...base, error: e.message };
      }
    }));
    store.update((s) => { s.updates = { checkedAt: Date.now(), items }; });
    events.emit('updates', summary());
    return summary();
  })().finally(() => { checking = null; });
  return checking;
}

/** What the browser sees (no download URLs). */
export function summary() {
  const u = store.get().updates;
  const ids = new Set(store.enabledIds());
  const items = Object.values(u?.items ?? {}).filter((i) => ids.has(i.id)).map(({ asset, ...i }) => i);
  return { checkedAt: u?.checkedAt ?? null, items, count: items.filter((i) => i.available).length, applying: job?.running ? job.id : null };
}

// ------------------------------------------------------------------------------ apply ---
let job = null;
export const currentJob = () => job && { ...job, steps: job.steps.map((s) => ({ ...s })) };
const publish = () => events.emit('job', currentJob());

const LABELS = {
  download: 'Downloading the new version',
  extract: 'Unpacking and checking it',
  stop: 'Stopping the app',
  backup: 'Backing up its database',
  switch: 'Starting the new version',
  verify: 'Checking that it works',
};

function step(id, status, detail = '') {
  const s = job.steps.find((x) => x.id === id);
  Object.assign(s, { status, detail });
  publish();
}

const run = (cmd, args, cwd) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed: ${err.trim().slice(-200)}`))));
  });

const appsRoot = (id) => path.join(hubDir, 'apps', id);

function backupDb(id, version) {
  const src = path.join(config.configDir, id);
  const dest = path.join(hubDir, 'backups', `${id}-${version}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    if (/\.db(-wal|-shm)?$/.test(f) || f === 'config.xml') fs.copyFileSync(path.join(src, f), path.join(dest, f));
  }
  return dest;
}

function restoreDb(id, backup) {
  const dest = path.join(config.configDir, id);
  for (const f of fs.readdirSync(dest)) if (/\.db(-wal|-shm)?$/.test(f)) fs.rmSync(path.join(dest, f), { force: true });
  for (const f of fs.readdirSync(backup)) fs.copyFileSync(path.join(backup, f), path.join(dest, f));
}

/**
 * Update one app in place. Only ever called from a user's confirmation (POST /api/updates/apply),
 * which must name the exact version they were shown.
 */
export async function apply(id, version, { healthTimeout = 180_000 } = {}) {
  if (!IN_PLACE.includes(id)) throw new Error(`${byId[id]?.name ?? id} can't be updated in place. Redeploy the latest image instead.`);
  if (job?.running) throw new Error('Another update is already running.');
  const item = store.get().updates?.items?.[id];
  if (!item?.available || item.latest !== version) throw new Error('That update is no longer current. Check for updates again.');
  if (!item.asset?.url) throw new Error('No download is available for this platform.');

  const mod = byId[id];
  const previous = item.current;
  job = {
    id, name: mod.name, from: previous, to: version, running: true, status: 'running', startedAt: Date.now(),
    steps: Object.entries(LABELS).map(([sid, label]) => ({ id: sid, label, status: 'pending', detail: '' })),
  };
  publish();

  (async () => {
    let stopped = false, switched = false, backup = null;
    const dest = path.join(appsRoot(id), version);
    try {
      // 1. download (+ checksum)
      step('download', 'running');
      fs.mkdirSync(path.join(hubDir, 'tmp'), { recursive: true });
      const file = path.join(hubDir, 'tmp', `${id}-${version}.tar.gz`);
      // Abort if nothing arrives for 60 s (a stalled connection must not hang the update for minutes).
      const ac = new AbortController();
      let stall = setTimeout(() => ac.abort(), 60_000);
      const poke = () => { clearTimeout(stall); stall = setTimeout(() => ac.abort(), 60_000); };
      const sha = crypto.createHash('sha256');
      try {
        const res = await fetch(item.asset.url, { headers: UA, redirect: 'follow', signal: ac.signal });
        if (!res.ok) throw new Error(`the server answered ${res.status}`);
        await pipeline(Readable.fromWeb(res.body), new Transform({ transform(c, _e, cb) { poke(); sha.update(c); cb(null, c); } }), fs.createWriteStream(file));
      } catch (e) {
        throw new Error(`Couldn't download the update (${ac.signal.aborted ? 'the connection stalled' : (e.cause?.code ?? e.message)}). Nothing was changed.`);
      } finally {
        clearTimeout(stall);
      }
      const got = sha.digest('hex');
      const want = item.asset.hash;
      if (want && /^[0-9a-f]{64}$/i.test(want) && got !== want.toLowerCase()) throw new Error('The download is corrupt (checksum mismatch). Nothing was changed.');
      step('download', 'ok', want && /^[0-9a-f]{64}$/i.test(want) ? 'Checksum verified' : '');

      // 2. unpack beside the old version
      step('extract', 'running');
      const part = `${dest}.partial`;
      fs.rmSync(part, { recursive: true, force: true });
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(part, { recursive: true });
      // relative paths from the download folder: GNU tar treats "C:\..." as a remote host on Windows dev machines
      await run('tar', ['xzf', path.basename(file), '-C', path.relative(path.dirname(file), part).split(path.sep).join('/'), '--strip-components=1'], path.dirname(file));
      if (!fs.existsSync(path.join(part, BIN[id]))) throw new Error(`The download doesn't contain ${BIN[id]}.`);
      fs.renameSync(part, dest);
      fs.rmSync(file, { force: true });
      step('extract', 'ok');

      // 3. stop, 4. back up (the app must be stopped for a consistent database copy)
      step('stop', 'running');
      if (config.supervise) await sup.stop(id);
      stopped = true;
      step('stop', 'ok');
      step('backup', 'running');
      backup = backupDb(id, previous);
      step('backup', 'ok', backup);

      // 5. switch to the new files and start
      step('switch', 'running');
      store.update((s) => { s.modules[id].override = { version, dir: dest, previous, backup, at: Date.now() }; });
      switched = true;
      health.forgetVersion(id);
      stack.startModule(id);
      step('switch', 'ok');

      // 6. prove it works
      step('verify', 'running');
      if (!(await health.waitUntilUp(mod, { timeout: healthTimeout }))) throw new Error(`${mod.name} did not start with the new version.`);
      const reported = await health.readVersion(mod);
      step('verify', 'ok', reported ? `${mod.name} ${reported} is running` : 'Running');

      // tidy: older installed versions are no longer needed
      for (const d of fs.existsSync(appsRoot(id)) ? fs.readdirSync(appsRoot(id)) : []) {
        if (d !== version) fs.rmSync(path.join(appsRoot(id), d), { recursive: true, force: true });
      }
      job.running = false;
      job.status = 'ok';
      publish();
      check();
    } catch (e) {
      // Put everything back the way it was.
      const failed = job.steps.find((s) => s.status === 'running');
      if (failed) step(failed.id, 'error', e.message);
      try {
        if (stopped || switched) {
          if (config.supervise) await sup.stop(id);
          store.update((s) => { delete s.modules[id].override; });
          if (switched && backup) restoreDb(id, backup);
          health.forgetVersion(id);
          stack.startModule(id);
        }
        fs.rmSync(dest, { recursive: true, force: true });
        fs.rmSync(`${dest}.partial`, { recursive: true, force: true });
        job.rolledBack = true;
        job.detail = `${mod.name} was restored to ${previous}. ${e.message}`;
      } catch (r) {
        job.detail = `${e.message} (automatic restore also failed: ${r.message}; your backup is in ${backup ?? 'n/a'})`;
      }
      job.running = false;
      job.status = 'error';
      publish();
    }
  })();

  return currentJob();
}

// ---------------------------------------------------------------------------- startup ---
/** After the image itself was updated, drop in-place copies that are now older than the image's own. */
export function reconcile() {
  const bundled = manifest();
  for (const [id, m] of Object.entries(store.get().modules)) {
    const ov = m.override;
    if (!ov) continue;
    const missing = !fs.existsSync(path.join(ov.dir, BIN[id] ?? ''));
    const caughtUp = bundled[id] && cmp(bundled[id], ov.version) >= 0;
    if (missing || caughtUp) {
      console.log(`[updates] dropping in-place ${id} ${ov.version} (${missing ? 'files missing' : `image has ${bundled[id]}`})`);
      store.update((s) => { delete s.modules[id].override; });
      fs.rmSync(ov.dir, { recursive: true, force: true });
    }
  }
}

export function schedule() {
  if (process.env.ALLARR_UPDATE_CHECK === '0') return;
  setTimeout(() => check().catch(() => {}), 30_000).unref();
  setInterval(() => check().catch(() => {}), 6 * 3600_000).unref();
}
