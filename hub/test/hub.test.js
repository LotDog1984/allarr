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
  for (const m of MODULES) assert.ok(m.exposed || m.basePath || m.headless, `${m.id} must be proxied, exposed or headless`);
});

test('FlareSolverr is a headless app that listens on localhost only and is seeded with its crash folder', () => {
  const m = byId.flaresolverr;
  assert.ok(m.headless && !m.basePath && !m.exposed);
  assert.equal(m.listenHost, '127.0.0.1');
  const run = m.run(m);
  assert.equal(run.env.HOST, '127.0.0.1');
  assert.equal(run.env.PORT, String(m.listenPort));
  seed.prepare(m);
  assert.ok(fs.statSync(path.join(process.env.ALLARR_CONFIG_DIR, 'flaresolverr', '.config', 'chromium', 'Crash Reports', 'pending')).isDirectory());
});

test('Profilarr connections are added once, then refreshed, with the sync priority rows', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { ready, upsertInstances } = await import('../src/profilarr.js');
  const file = path.join(tmp, 'profilarr.db');
  assert.equal(await ready(file), false); // no database yet
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE arr_instances (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, type TEXT NOT NULL, url TEXT NOT NULL, api_key TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE database_instances (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
    CREATE TABLE arr_sync_database_priority (instance_id INTEGER, database_id INTEGER, priority INTEGER);
    INSERT INTO database_instances (name) VALUES ('Dictionarry');`);
  db.close();
  assert.equal(await ready(file), true);
  const entries = [{ name: 'Radarr', type: 'radarr', url: 'http://127.0.0.1:7878/radarr', apiKey: 'a' }, { name: 'Sonarr', type: 'sonarr', url: 'http://127.0.0.1:8989/sonarr', apiKey: 'b' }];
  assert.deepEqual((await upsertInstances(file, entries)).map((d) => d.how), ['added', 'added']);
  assert.deepEqual((await upsertInstances(file, entries.map((e) => ({ ...e, apiKey: e.apiKey + '2' })))).map((d) => d.how), ['updated', 'updated']);
  const check = new DatabaseSync(file);
  assert.deepEqual(check.prepare('SELECT name, api_key FROM arr_instances ORDER BY id').all().map((r) => [r.name, r.api_key]), [['Radarr', 'a2'], ['Sonarr', 'b2']]);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM arr_sync_database_priority').get().n, 2); // one per new instance, not per refresh
  check.close();
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
  assert.deepEqual(Object.keys(cats).sort(), ['movies', 'music', 'prowlarr', 'tv']);
});

test('SABnzbd is seeded with a key, URL base and category folders', () => {
  const { apiKey } = seed.prepare(byId.sabnzbd);
  const ini = fs.readFileSync(path.join(process.env.ALLARR_CONFIG_DIR, 'sabnzbd', 'sabnzbd.ini'), 'utf8');
  assert.match(ini, new RegExp(`api_key = ${apiKey}`));
  assert.match(ini, /url_base = \/sabnzbd/);
  assert.match(ini, /\[\[tv\]\]/);
  assert.equal(seed.prepare(byId.sabnzbd).apiKey, apiKey); // re-seeding adopts the existing key
});
