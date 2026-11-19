import { config } from './config.js';
import { byId } from './modules.js';
import * as seed from './seed.js';
import * as sup from './supervisor.js';
import * as store from './state.js';

/** Seed an app's config, then (inside the container) launch it under the supervisor. */
export function startModule(id) {
  const mod = byId[id];
  seed.prepare(mod);
  if (config.supervise) sup.start(id, mod.run(mod));
}

export async function stopModule(id) {
  if (config.supervise) await sup.stop(id);
  store.update((s) => {
    if (s.modules[id]) s.modules[id].enabled = false;
  });
}

export const restartModule = async (id) => {
  if (config.supervise) await sup.stop(id);
  startModule(id);
};

export function startAll() {
  for (const id of store.enabledIds()) if (byId[id]) startModule(id);
}
