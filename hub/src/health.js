import { config } from './config.js';
import * as store from './state.js';
import * as sup from './supervisor.js';
import { byId, baseUrl, internalBase } from './modules.js';

/** Is the app answering HTTP yet? Anything below 500 counts (login redirects, 401, ...). */
export async function probe(mod) {
  const url = `http://127.0.0.1:${mod.listenPort}${internalBase(mod)}${mod.health || '/'}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
    res.body?.cancel();
    return res.status < 500;
  } catch {
    return false;
  }
}

async function readVersion(mod) {
  const key = store.get().modules[mod.id]?.apiKey;
  try {
    const get = async (p, headers = {}) =>
      fetch(`${baseUrl(mod)}${p}`, { headers, signal: AbortSignal.timeout(3000) }).then((r) => r.text());
    if (mod.kind === 'servarr') {
      return JSON.parse(await get(`/api/${mod.api}/system/status`, { 'X-Api-Key': key })).version;
    }
    if (mod.kind === 'qbittorrent') return (await get('/api/v2/app/version')).replace(/^v/, '');
    if (mod.kind === 'sabnzbd') return JSON.parse(await get('/api?mode=version&output=json')).version;
    if (mod.kind === 'seerr') return JSON.parse(await get('/api/v1/status')).version;
  } catch { /* version is a nice-to-have */ }
  return null;
}

const snapshot = new Map();
export const bus = sup.bus; // 'change' events double as status triggers

export function resolveState(mod, up) {
  if (up) return 'running';
  if (!config.supervise) return 'stopped';
  const s = sup.info(mod.id);
  return s.state === 'running' ? 'starting' : s.state;
}

export async function refresh() {
  const ids = store.enabledIds().filter((id) => byId[id]);
  let changed = false;

  await Promise.all(
    ids.map(async (id) => {
      const mod = byId[id];
      const up = await probe(mod);
      const prev = snapshot.get(id);
      const s = sup.info(id);
      const next = {
        id,
        state: resolveState(mod, up),
        up,
        restarts: s.restarts,
        error: up ? null : s.error,
        version: up ? (prev?.version ?? (await readVersion(mod))) : null,
      };
      if (!prev || JSON.stringify(prev) !== JSON.stringify(next)) changed = true;
      snapshot.set(id, next);
    }),
  );

  for (const id of [...snapshot.keys()]) {
    if (!ids.includes(id)) {
      snapshot.delete(id);
      changed = true;
    }
  }
  return changed;
}

export const statuses = () => [...snapshot.values()];

export function startPoller(onChange) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      if (await refresh()) onChange(statuses());
    } catch (e) {
      console.error('[health]', e.message);
    } finally {
      busy = false;
    }
  };
  tick();
  const timer = setInterval(tick, 3000);
  sup.bus.on('change', () => tick());
  return () => clearInterval(timer);
}

export async function waitUntilUp(mod, { timeout = 240_000, interval = 2000 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await probe(mod)) return true;
    if (config.supervise && sup.info(mod.id).state === 'missing') return false;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}
