import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the Hub at throw-away folders BEFORE importing it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'allarr-test-'));
process.env.ALLARR_CONFIG_DIR = path.join(tmp, 'config');
process.env.ALLARR_MEDIA_DIR = path.join(tmp, 'media');
process.env.ALLARR_SUPERVISE = '0';
process.env.ALLARR_DEV = '1';

const { hashPassword, verifyPassword } = await import('../src/auth.js');
const seed = await import('../src/seed.js');
const storage = await import('../src/storage.js');
const store = await import('../src/state.js');
const { byId, MODULES } = await import('../src/modules.js');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('passwords are hashed with a random salt and verify correctly', () => {
  const a = hashPassword('correct horse');
  const b = hashPassword('correct horse');
  assert.notEqual(a, b);
  assert.ok(verifyPassword('correct horse', a));
  assert.ok(!verifyPassword('wrong', a));
  assert.ok(!verifyPassword('x', 'garbage'));
});

test('module catalog has unique ports and base paths', () => {
  const ports = MODULES.map((m) => m.port);
  assert.equal(new Set(ports).size, ports.length);
  const bases = MODULES.filter((m) => m.basePath).map((m) => m.basePath);
  assert.equal(new Set(bases).size, bases.length);
  for (const m of MODULES) assert.ok(m.exposed || m.basePath, `${m.id} must be proxied or exposed`);
});

test('storage layout is created and hardlinks are proven', () => {
  const r = storage.check();
  assert.ok(r.ok, JSON.stringify(r.issues));
  assert.ok(r.writable && r.sameFilesystem && r.hardlinks);
  for (const d of ['downloads/torrents/tv', 'downloads/usenet/complete/movies', 'movies', 'series', 'music']) {
    assert.ok(fs.statSync(path.join(process.env.ALLARR_MEDIA_DIR, d)).isDirectory(), d);
  }
  // the test files must not be left behind
  assert.deepEqual(fs.readdirSync(path.join(process.env.ALLARR_MEDIA_DIR, 'movies')), []);
});

test('Servarr seeding is idempotent and keeps the API key', () => {
  const a = seed.prepare(byId.sonarr);
  const b = seed.prepare(byId.sonarr);
  assert.match(a.apiKey, /^[0-9a-f]{32}$/);
  assert.equal(a.apiKey, b.apiKey);
  const xml = fs.readFileSync(path.join(process.env.ALLARR_CONFIG_DIR, 'sonarr', 'config.xml'), 'utf8');
  assert.match(xml, /<BindAddress>127\.0\.0\.1<\/BindAddress>/);
  assert.match(xml, /<UrlBase>\/sonarr<\/UrlBase>/);
  assert.match(xml, /<AuthenticationMethod>External<\/AuthenticationMethod>/);
  assert.equal((xml.match(/<ApiKey>/g) || []).length, 1);
  assert.equal(store.get().modules.sonarr.apiKey, a.apiKey);
});

test("seeding patches an existing config.xml and keeps the user's settings", () => {
  const dir = path.join(process.env.ALLARR_CONFIG_DIR, 'radarr');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.xml'),
    '<Config>\n  <Port>1234</Port>\n  <ApiKey>deadbeefdeadbeefdeadbeefdeadbeef</ApiKey>\n  <LogLevel>debug</LogLevel>\n</Config>\n');
  const out = seed.prepare(byId.radarr);
  assert.equal(out.apiKey, 'deadbeefdeadbeefdeadbeefdeadbeef'); // adopted, not replaced
  const xml = fs.readFileSync(path.join(dir, 'config.xml'), 'utf8');
  assert.match(xml, /<LogLevel>debug<\/LogLevel>/); // user setting survives
  assert.match(xml, new RegExp(`<Port>${byId.radarr.listenPort}</Port>`)); // contract enforced
  assert.match(xml, /<UrlBase>\/radarr<\/UrlBase>/);
});

test('qBittorrent is seeded with a hashed password, categories and shared save paths', () => {
  seed.prepare(byId.qbittorrent);
  const conf = fs.readFileSync(path.join(process.env.ALLARR_CONFIG_DIR, 'qbittorrent', 'qBittorrent', 'config', 'qBittorrent.conf'), 'utf8');
  const { password } = store.get().qbittorrent;
  assert.match(conf, /WebUI\\Password_PBKDF2="@ByteArray\([^:]+:[^)]+\)"/);
  assert.ok(!conf.includes(password), 'plain password must not be written to the config');
  assert.match(conf, /WebUI\\Address=127\.0\.0\.1/);
  const cats = JSON.parse(fs.readFileSync(path.join(process.env.ALLARR_CONFIG_DIR, 'qbittorrent', 'qBittorrent', 'config', 'categories.json'), 'utf8'));
  assert.deepEqual(Object.keys(cats).sort(), ['movies', 'music', 'tv']);
});

test('SABnzbd is seeded with a key, URL base and category folders', () => {
  const { apiKey } = seed.prepare(byId.sabnzbd);
  const ini = fs.readFileSync(path.join(process.env.ALLARR_CONFIG_DIR, 'sabnzbd', 'sabnzbd.ini'), 'utf8');
  assert.match(ini, new RegExp(`api_key = ${apiKey}`));
  assert.match(ini, /url_base = \/sabnzbd/);
  assert.match(ini, /\[\[tv\]\]/);
  assert.equal(seed.prepare(byId.sabnzbd).apiKey, apiKey); // re-seeding adopts the existing key
});
