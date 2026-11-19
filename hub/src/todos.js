import * as store from './state.js';

const SERVERS = { plex: 'Plex', jellyfin: 'Jellyfin', emby: 'Emby' };

/** The "Finish setup" checklist: things only a human can do (accounts, indexers, languages). */
export function list() {
  const s = store.get();
  const on = new Set(store.enabledIds());
  const a = s.setup.answers ?? {};
  const server = SERVERS[a.mediaServer?.type];
  const t = [];

  if (on.has('prowlarr')) {
    t.push({
      id: 'indexers', app: 'prowlarr', path: '/prowlarr/#/indexers', cta: 'Add indexers',
      title: 'Add your indexers',
      detail: 'Prowlarr needs at least one torrent or Usenet indexer. Add them once here; they sync to Sonarr, Radarr and Lidarr automatically.',
    });
  }
  if (on.has('sabnzbd') && !a.usenet?.enabled) {
    t.push({
      id: 'usenet', app: 'sabnzbd', path: '/sabnzbd/config/servers/', cta: 'Add provider',
      title: 'Add a Usenet provider',
      detail: 'Skip this if you only use torrents. Otherwise SABnzbd needs your Usenet provider details to download anything.',
    });
  }
  if (on.has('bazarr')) {
    t.push({
      id: 'subtitles', app: 'bazarr', path: '/bazarr/settings/languages', cta: 'Choose languages',
      title: 'Pick subtitle languages',
      detail: 'Choose the languages you want and a couple of subtitle providers. Bazarr is already linked to Sonarr and Radarr.',
    });
  }
  if (on.has('seerr')) {
    t.push({
      id: 'seerr', app: 'seerr', cta: 'Open Seerr',
      title: `Sign in to Seerr${server ? ` with ${server}` : ''}`,
      detail: `Seerr's first-run screen asks you to sign in to your media server${server ? ` (${server})` : ''} and pick libraries. Sonarr and Radarr are already added for you.`,
    });
  }
  if (on.has('wizarr')) {
    t.push({
      id: 'wizarr', app: 'wizarr', cta: 'Open Wizarr',
      title: 'Connect Wizarr to your media server',
      detail: `Create your admin account, then add your ${server ?? 'media server'} so invites can create accounts on it.`,
    });
  }
  if (on.has('maintainerr')) {
    t.push({
      id: 'maintainerr', app: 'maintainerr', path: '/maintainerr/', cta: 'Open Maintainerr',
      title: 'Connect Maintainerr',
      detail: `Add your ${server ?? 'media server'}, then Sonarr, Radarr and Seerr. Copy their addresses and keys from Settings → Connection details.`,
    });
  }
  if (on.has('cleanuparr')) {
    t.push({
      id: 'cleanuparr', app: 'cleanuparr', path: '/cleanuparr/', cta: 'Open Cleanuparr',
      title: 'Connect Cleanuparr',
      detail: 'Add your Sonarr, Radarr and download clients, then choose what counts as stalled. No sign-in needed: Allarr already took care of that. Connection details are in Settings.',
    });
  }
  return t.map((x) => ({ ...x, done: !!s.todos[x.id] }));
}
