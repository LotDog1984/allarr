import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as store from './state.js';
import { chownPath, media } from './storage.js';

/**
 * "Seeding" = writing each app's config file BEFORE its first start, so it comes up already:
 *  - listening on localhost only,
 *  - under its URL base (e.g. /sonarr) so the Hub can proxy it,
 *  - with an API key the Hub knows,
 *  - with authentication delegated to the Hub (one login for everything),
 *  - pointed at the shared /media folders.
 * Existing config files are patched, never replaced, so upgrades keep the user's settings.
 */
const cfgDir = (id) => path.join(config.configDir, id);
const rand = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');

/** mkdir -p, handing every directory level we create to PUID (apps can't write into root-owned parents). */
function mkdirp(dir) {
  const missing = [];
  for (let cur = dir; !fs.existsSync(cur); cur = path.dirname(cur)) missing.unshift(cur);
  for (const d of missing) {
    fs.mkdirSync(d);
    chownPath(d);
  }
}

function ensureDir(dir) {
  mkdirp(dir);
  // If a previous install left root-owned files, hand them to PUID once.
  if (process.getuid?.() === 0 && config.puid !== undefined && fs.statSync(dir).uid !== config.puid) {
    const walk = (p) => {
      chownPath(p);
      if (fs.lstatSync(p).isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f));
    };
    walk(dir);
  }
}

function writeIfMissing(file, content) {
  if (fs.existsSync(file)) return false;
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, content);
  chownPath(file);
  return true;
}

// --- Servarr (Sonarr, Radarr, Lidarr, Prowlarr) ------------------------------------------
function setXml(xml, tag, value) {
  const re = new RegExp(`<${tag}\\s*/>|<${tag}>[\\s\\S]*?</${tag}>`);
  const line = `<${tag}>${value}</${tag}>`;
  return re.test(xml) ? xml.replace(re, line) : xml.replace('</Config>', `  ${line}\n</Config>`);
}

function seedServarr(mod) {
  const dir = cfgDir(mod.id);
  ensureDir(dir);
  const file = path.join(dir, 'config.xml');
  let xml = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '<Config>\n</Config>\n';
  const existingKey = xml.match(/<ApiKey>([^<]+)<\/ApiKey>/)?.[1];
  const apiKey = existingKey || rand();

  const wanted = {
    BindAddress: '127.0.0.1',
    Port: mod.listenPort,
    UrlBase: mod.basePath,
    EnableSsl: 'False',
    LaunchBrowser: 'False',
    ApiKey: apiKey,
    AuthenticationMethod: 'External', // the Hub already logged you in
    AuthenticationRequired: 'DisabledForLocalAddresses',
    UpdateMechanism: 'Docker',
    InstanceName: mod.name,
  };
  for (const [k, v] of Object.entries(wanted)) xml = setXml(xml, k, v);
  fs.writeFileSync(file, xml);
  chownPath(file);
  return { apiKey };
}

// --- qBittorrent ------------------------------------------------------------------------
function qbHash(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512');
  return `@ByteArray(${salt.toString('base64')}:${hash.toString('base64')})`;
}

function seedQbittorrent(mod) {
  const profile = cfgDir('qbittorrent');
  ensureDir(profile);
  const confDir = path.join(profile, 'qBittorrent', 'config');
  const creds = store.get().qbittorrent ?? { username: 'admin', password: rand(12) };

  const torrents = media('downloads', 'torrents');
  const wrote = writeIfMissing(
    path.join(confDir, 'qBittorrent.conf'),
    [
      '[LegalNotice]', 'Accepted=true', '',
      '[Preferences]',
      'General\\Locale=en',
      `Downloads\\SavePath=${torrents}/`,
      'Downloads\\TempPathEnabled=false',
      'WebUI\\Address=127.0.0.1',
      `WebUI\\Port=${mod.listenPort}`,
      'WebUI\\LocalHostAuth=false', // only the Hub and the *arr apps can reach it (127.0.0.1)
      'WebUI\\CSRFProtection=false',
      'WebUI\\HostHeaderValidation=false',
      'WebUI\\ClickjackingProtection=false',
      `WebUI\\Username=${creds.username}`,
      `WebUI\\Password_PBKDF2="${qbHash(creds.password)}"`,
      '', '[BitTorrent]',
      `Session\\DefaultSavePath=${torrents}`,
      'Session\\Port=6881',
      'Session\\DisableAutoTMMByDefault=false',
      'Session\\DisableAutoTMMTriggers\\CategorySavePathChanged=false',
      'Session\\DisableAutoTMMTriggers\\DefaultSavePathChanged=false',
      '',
    ].join('\n'),
  );
  writeIfMissing(
    path.join(confDir, 'categories.json'),
    JSON.stringify(
      Object.fromEntries(['movies', 'tv', 'music'].map((c) => [c, { save_path: `${torrents}/${c}` }])),
      null, 2,
    ),
  );
  if (wrote) store.update((s) => { s.qbittorrent = creds; });
  return {};
}

// --- SABnzbd ----------------------------------------------------------------------------
function seedSabnzbd(mod) {
  const dir = cfgDir('sabnzbd');
  ensureDir(dir);
  const file = path.join(dir, 'sabnzbd.ini');
  let apiKey = store.get().modules.sabnzbd?.apiKey;
  if (fs.existsSync(file)) {
    apiKey = fs.readFileSync(file, 'utf8').match(/^api_key\s*=\s*(\S+)/m)?.[1] ?? apiKey;
    return { apiKey };
  }
  apiKey ??= rand();
  const usenet = media('downloads', 'usenet');
  const cats = ['movies', 'tv', 'music'];
  writeIfMissing(file, [
    '[misc]',
    `api_key = ${apiKey}`,
    `nzb_key = ${rand()}`,
    'host = 127.0.0.1',
    `port = ${mod.listenPort}`,
    `url_base = ${mod.basePath}`,
    `download_dir = ${usenet}/incomplete`,
    `complete_dir = ${usenet}/complete`,
    'host_whitelist = ',
    'username = ',
    'password = ',
    '[categories]',
    '[[*]]', 'name = *', 'order = 0', 'dir = ',
    ...cats.flatMap((c, i) => [`[[${c}]]`, `name = ${c}`, `order = ${i + 1}`, `dir = ${c}`]),
    '[servers]',
    '',
  ].join('\n'));
  return { apiKey };
}

// --- Bazarr -----------------------------------------------------------------------------
function seedBazarr(mod) {
  const dir = cfgDir('bazarr');
  ensureDir(dir);
  const file = path.join(dir, 'config', 'config.yaml');
  let apiKey = store.get().modules.bazarr?.apiKey;
  if (fs.existsSync(file)) {
    apiKey = fs.readFileSync(file, 'utf8').match(/^\s*apikey:\s*['"]?([0-9a-fA-F]+)/m)?.[1] ?? apiKey;
    return { apiKey };
  }
  apiKey ??= rand();
  writeIfMissing(file, [
    'general:', '  ip: 127.0.0.1', `  port: ${mod.listenPort}`, `  base_url: ${mod.basePath}`,
    'auth:', '  type: null', `  apikey: ${apiKey}`, '',
  ].join('\n'));
  return { apiKey };
}

// --- Wizarr: its data dir is /data/database, a symlink into /config/wizarr/database ------------
// The target must exist before Wizarr starts (mkdir on a dangling symlink fails).
function seedWizarr() {
  mkdirp(path.join(cfgDir('wizarr'), 'database'));
  return {};
}

// --- Apps that only need a data folder --------------------------------------------------
function seedPlain(mod) {
  ensureDir(cfgDir(mod.id));
  return {};
}

// --- Seerr ---------------------------------------------------------------------------------
/** True when settings.json is a complete file Seerr itself wrote (it always has a `main` section). */
export function isCompleteSeerrSettings(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return !!data && typeof data === 'object' && !!data.main && typeof data.main === 'object';
  } catch {
    return false;
  }
}

// Seerr crashes on start ("Cannot read properties of undefined (reading 'apiKey')") if settings.json exists but
// is partial or truncated. Earlier Allarr versions could leave such a file behind: move it aside so Seerr
// writes a fresh complete one (wiring re-adds Radarr/Sonarr to it).
function seedSeerr(mod) {
  ensureDir(cfgDir(mod.id));
  const file = path.join(cfgDir(mod.id), 'settings.json');
  if (fs.existsSync(file) && !isCompleteSeerrSettings(file)) {
    fs.renameSync(file, `${file}.broken`);
    chownPath(`${file}.broken`);
  }
  return {};
}

const SEEDERS = {
  seerr: seedSeerr,
  servarr: seedServarr,
  qbittorrent: seedQbittorrent,
  sabnzbd: seedSabnzbd,
  bazarr: seedBazarr,
  wizarr: seedWizarr,
};

/** Prepare one module's config and remember its API key. */
export function prepare(mod) {
  const out = (SEEDERS[mod.kind] ?? seedPlain)(mod);
  store.update((s) => {
    s.modules[mod.id] = { ...s.modules[mod.id], enabled: true, ...(out.apiKey ? { apiKey: out.apiKey } : {}) };
  });
  return out;
}
