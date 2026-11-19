import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hubDir } from './config.js';

const file = path.join(hubDir, 'state.json');
let state = null;

const defaults = () => ({
  secret: crypto.randomBytes(32).toString('hex'),
  admin: null, // { username, hash }
  setup: { complete: false, answers: {} },
  modules: {}, // id -> { enabled, apiKey }
  qbittorrent: null, // { username, password }
  todos: {}, // id -> true when ticked off
  wiring: null, // last wiring run
  updates: null, // last upstream version check
  settings: {}, // { addresses: { seerr, wizarr } } what the user types into Settings
});

export function load() {
  fs.mkdirSync(hubDir, { recursive: true });
  try {
    state = { ...defaults(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    state = defaults();
    save();
  }
  return state;
}

export const get = () => state ?? load();

export function save() {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function update(fn) {
  fn(get());
  save();
}

export const enabledIds = () =>
  Object.entries(get().modules)
    .filter(([, v]) => v.enabled)
    .map(([id]) => id);
