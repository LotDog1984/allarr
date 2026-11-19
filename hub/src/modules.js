import path from 'node:path';
import { config } from './config.js';
import * as store from './state.js';

const app = (...p) => path.join(config.appsDir, ...p);
const cfg = (...p) => path.join(config.configDir, ...p);
/** Where an app's files live: the image's copy, or the copy installed by a confirmed in-place update. */
export const binDir = (id) => store.get().modules[id]?.override?.dir ?? path.join(config.appsDir, id);

export const GROUPS = [
  { id: 'library', title: 'Your libraries', blurb: 'Find, grab and organise your media' },
  { id: 'search', title: 'Search & subtitles', blurb: 'Indexers and subtitles for the library apps' },
  { id: 'download', title: 'Downloaders', blurb: 'Torrent and Usenet clients, built in' },
  { id: 'people', title: 'Requests & people', blurb: 'Let friends and family ask for things' },
  { id: 'cleanup', title: 'Housekeeping', blurb: 'Keep the library and the queues tidy' },
];

/**
 * The module catalog. Everything the Hub knows about an app lives here.
 *
 *  port       internal port (apps listen on 127.0.0.1 only, except `exposed` ones)
 *  basePath   URL prefix the Hub serves the app under (login-protected)
 *  stripBase  the app has no URL-base option, so the Hub strips the prefix itself
 *  entryParams  query added when its main page is opened (SABnzbd: skip the quick-start wizard)
 *  exposed    app has its own login and must be reachable on its own port (requests / invites)
 *  run()      how to launch it inside the container
 */
export const MODULES = [
  {
    id: 'sonarr', theme: 'servarr', name: 'Sonarr', role: 'TV series', group: 'library', color: '#35c5f4',
    blurb: 'Watches for new episodes and keeps your TV library organised.',
    port: 8989, basePath: '/sonarr', kind: 'servarr', api: 'v3', health: '/ping',
    category: 'tv', rootFolder: 'series', defaultOn: true,
    run: () => ({ cmd: path.join(binDir('sonarr'), 'Sonarr'), args: ['-nobrowser', `-data=${cfg('sonarr')}`] }),
  },
  {
    id: 'radarr', theme: 'servarr', name: 'Radarr', role: 'Movies', group: 'library', color: '#ffc230',
    blurb: 'Finds and organises your movie collection.',
    port: 7878, basePath: '/radarr', kind: 'servarr', api: 'v3', health: '/ping',
    category: 'movies', rootFolder: 'movies', defaultOn: true,
    run: () => ({ cmd: path.join(binDir('radarr'), 'Radarr'), args: ['-nobrowser', `-data=${cfg('radarr')}`] }),
  },
  {
    id: 'lidarr', theme: 'servarr', name: 'Lidarr', role: 'Music', group: 'library', color: '#00a65b',
    blurb: 'Builds and maintains your music library.',
    port: 8686, basePath: '/lidarr', kind: 'servarr', api: 'v1', health: '/ping',
    category: 'music', rootFolder: 'music', defaultOn: true,
    run: () => ({ cmd: path.join(binDir('lidarr'), 'Lidarr'), args: ['-nobrowser', `-data=${cfg('lidarr')}`] }),
  },
  {
    id: 'prowlarr', theme: 'servarr', name: 'Prowlarr', role: 'Indexers', group: 'search', color: '#e66000',
    blurb: 'One place to add search sources. Shares them with Sonarr, Radarr and Lidarr.',
    port: 9696, basePath: '/prowlarr', kind: 'servarr', api: 'v1', health: '/ping', defaultOn: true,
    run: () => ({ cmd: path.join(binDir('prowlarr'), 'Prowlarr'), args: ['-nobrowser', `-data=${cfg('prowlarr')}`] }),
  },
  {
    id: 'bazarr', theme: 'bazarr', name: 'Bazarr', role: 'Subtitles', group: 'search', color: '#a855f7',
    blurb: 'Downloads subtitles for everything Sonarr and Radarr manage.',
    port: 6767, basePath: '/bazarr', kind: 'bazarr', health: '/', defaultOn: true,
    run: (m) => ({
      cmd: app('venv-bazarr', 'bin', 'python'),
      args: [app('bazarr', 'bazarr.py'), '--config', cfg('bazarr'), '--port', String(m.listenPort), '--no-update'],
    }),
  },
  {
    id: 'qbittorrent', theme: 'qbittorrent', name: 'qBittorrent', role: 'Torrents', group: 'download', color: '#4f8df7',
    blurb: 'Built-in torrent client. Pre-configured, nothing to set up.',
    port: 8081, basePath: '/qbittorrent', stripBase: true, kind: 'qbittorrent', health: '/api/v2/app/version', defaultOn: true,
    run: (m) => ({
      cmd: 'qbittorrent-nox',
      args: [`--profile=${cfg('qbittorrent')}`, `--webui-port=${m.listenPort}`],
    }),
  },
  {
    id: 'sabnzbd', theme: 'sabnzbd', entryParams: { skip_wizard: '1' }, name: 'SABnzbd', role: 'Usenet', group: 'download', color: '#f4b400',
    blurb: 'Built-in Usenet client. Just add your provider.',
    port: 8085, basePath: '/sabnzbd', kind: 'sabnzbd', health: '/api?mode=version&output=json', defaultOn: true,
    run: (m) => ({
      cmd: app('venv-sabnzbd', 'bin', 'python'),
      args: [app('sabnzbd', 'SABnzbd.py'), '-f', cfg('sabnzbd', 'sabnzbd.ini'), '-s', `127.0.0.1:${m.listenPort}`, '-b', '0'],
    }),
  },
  {
    id: 'seerr', name: 'Seerr', role: 'Requests', group: 'people', color: '#6366f1',
    blurb: 'A friendly page where people request movies and shows.',
    port: 5055, exposed: true, kind: 'seerr', health: '/api/v1/status', defaultOn: true,
    run: (m) => ({
      cmd: 'node', args: ['dist/index.js'], cwd: app('seerr'),
      env: { NODE_ENV: 'production', PORT: String(m.listenPort), CONFIG_DIRECTORY: cfg('seerr') },
    }),
  },
  {
    id: 'wizarr', name: 'Wizarr', role: 'Invites', group: 'people', color: '#ec4899',
    blurb: 'Invite people to your media server with a simple link and guided signup.',
    port: 5690, exposed: true, kind: 'wizarr', health: '/health', defaultOn: true,
    run: (m) => ({
      cmd: 'sh', cwd: app('wizarr'),
      args: ['-c', 'FLASK_SKIP_SCHEDULER=true .venv/bin/flask db upgrade && exec .venv/bin/gunicorn --config gunicorn.conf.py --umask 007 run:app'],
      env: { HOST: '0.0.0.0', PORT: String(m.listenPort), FLASK_ENV: 'production' },
    }),
  },
  {
    id: 'maintainerr', theme: 'maintainerr', name: 'Maintainerr', role: 'Library cleanup', group: 'cleanup', color: '#14b8a6',
    blurb: 'Automatically removes media nobody watches anymore, with a grace period.',
    port: 6246, basePath: '/maintainerr', kind: 'maintainerr', health: '/', defaultOn: true,
    run: (m) => ({
      cmd: app('maintainerr', 'start.sh'), args: [], cwd: app('maintainerr'),
      env: {
        NODE_ENV: 'production', UI_PORT: String(m.listenPort), UI_HOSTNAME: '127.0.0.1',
        DATA_DIR: cfg('maintainerr'), BASE_PATH: '/maintainerr',
        PATH: `${app('node26', 'bin')}:${process.env.PATH}`, // Maintainerr requires Node 26+
      },
    }),
  },
  {
    id: 'cleanuparr', theme: 'cleanuparr', name: 'Cleanuparr', role: 'Queue cleanup', group: 'cleanup', color: '#f97316',
    blurb: 'Removes stalled, failed and unwanted downloads from your queues.',
    port: 11011, basePath: '/cleanuparr', kind: 'cleanuparr', health: '/', defaultOn: true,
    run: (m) => ({
      cmd: app('cleanuparr', 'Cleanuparr'), args: [], cwd: app('cleanuparr'),
      env: { HTTP_PORTS: String(m.listenPort), BASE_PATH: '/cleanuparr' },
    }),
  },
];

for (const m of MODULES) {
  m.listenPort = m.port + config.portOffset;
  m.listenHost = m.exposed ? '0.0.0.0' : '127.0.0.1';
}

export const byId = Object.fromEntries(MODULES.map((m) => [m.id, m]));
export const groupOf = (id) => GROUPS.find((g) => g.id === byId[id].group);

/** Base path the app itself serves under on 127.0.0.1 (the Hub strips it for stripBase apps). */
export const internalBase = (m) => (m.stripBase ? '' : m.basePath || '');
export const baseUrl = (m) => `http://127.0.0.1:${m.listenPort}${internalBase(m)}`;

/** What the browser needs to know. No commands, no paths. */
export const publicInfo = (m) => ({
  id: m.id, name: m.name, role: m.role, blurb: m.blurb, group: m.group, color: m.color,
  basePath: m.basePath || null, exposedPort: m.exposed ? m.port : null, defaultOn: !!m.defaultOn,
});
