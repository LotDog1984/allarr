import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'allarr-upd-'));
Object.assign(process.env, {
  ALLARR_CONFIG_DIR: path.join(tmp, 'config'), ALLARR_MEDIA_DIR: path.join(tmp, 'media'),
  ALLARR_APPS_DIR: path.join(tmp, 'opt'), ALLARR_SUPERVISE: '0', ALLARR_PORT_OFFSET: '31000',
});

const store = await import('../src/state.js');
const updates = await import('../src/updates.js');
const { byId, binDir } = await import('../src/modules.js');

const realFetch = globalThis.fetch;
const RADARR_OLD = '7.0.0.1000';
const RADARR_NEW = '7.0.3.2000';

// a tiny "Radarr" release tarball: Radarr/Radarr
const pkg = path.join(tmp, 'pkg');
fs.mkdirSync(path.join(pkg, 'Radarr'), { recursive: true });
fs.writeFileSync(path.join(pkg, 'Radarr', 'Radarr'), '#!/bin/sh\necho hi\n');
execFileSync('tar', ['czf', '../radarr.tgz', 'Radarr'], { cwd: pkg });
const tarball = fs.readFileSync(path.join(tmp, 'radarr.tgz'));
const goodHash = crypto.createHash('sha256').update(tarball).digest('hex');
let feedHash = goodHash;

// Upstream is mocked; localhost (the health probe) goes to the real fetch.
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (u.includes('services.sonarr.tv')) {
    return Response.json({ 'v4-stable': { version: '4.0.9.9', releaseDate: 'x', linux: { x64: { archive: { url: 'https://dl/sonarr.tgz', hash: 'h' } }, arm64: { archive: { url: 'https://dl/sonarr.tgz', hash: 'h' } } }, changes: { new: ['n1'], fixed: ['f1'] } } });
  }
  if (u.includes('radarr.servarr.com/v1/update')) {
    return Response.json([{ version: RADARR_NEW, releaseDate: '2026-11-16', url: 'https://dl/radarr.tgz', hash: feedHash, changes: { new: [], fixed: ['fix a'] } }]);
  }
  if (u === 'https://dl/radarr.tgz') return new Response(tarball);
  if (u.includes('api.github.com/repos/morpheus65535/bazarr')) return Response.json({ tag_name: 'v1.9.0', html_url: 'https://gh/bazarr', published_at: 'y' });
  throw new Error(`unexpected fetch ${u}`);
};

// A fake Radarr that answers /ping and reports a version we can change.
let reported = RADARR_NEW;
let fake;
const startFake = () => new Promise((r) => {
  fake = http.createServer((req, res) => {
    if (req.url.endsWith('/ping')) return res.end('{"status":"OK"}');
    if (req.url.includes('/system/status')) return res.end(JSON.stringify({ version: reported }));
    res.statusCode = 404;
    res.end();
  }).listen(byId.radarr.listenPort, '127.0.0.1', r);
});
const stopFake = () => new Promise((r) => fake.close(r));

const dbFile = path.join(process.env.ALLARR_CONFIG_DIR, 'radarr', 'radarr.db');

test.before(() => {
  fs.mkdirSync(process.env.ALLARR_APPS_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.ALLARR_APPS_DIR, 'versions.json'), JSON.stringify({ radarr: RADARR_OLD, sonarr: '4.0.1.1', bazarr: '1.5.0' }));
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  fs.writeFileSync(dbFile, 'ORIGINAL-DB');
  store.update((s) => { for (const id of ['radarr', 'sonarr', 'bazarr']) s.modules[id] = { enabled: true, apiKey: 'k' }; });
});
test.after(() => { fake?.closeAllConnections?.(); fake?.close(); globalThis.fetch = realFetch; fs.rmSync(tmp, { recursive: true, force: true }); });

const waitJob = async () => {
  for (let i = 0; i < 100; i++) {
    if (!updates.currentJob()?.running) return updates.currentJob();
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('job did not finish');
};

test('version comparison', () => {
  assert.equal(updates.cmp('7.0.3.10918', '7.0.3.10918'), 0);
  assert.equal(updates.cmp('7.0.3.10918', '7.0.2.99999'), 1);
  assert.equal(updates.cmp('v4.0.9', '4.0.10'), -1);
  assert.equal(updates.cmp('2026.10.1', '2026.9.4'), 1);
});

test('check() reports what is newer, per source', async () => {
  const sum = await updates.check();
  const by = Object.fromEntries(sum.items.map((i) => [i.id, i]));
  assert.equal(by.radarr.available, true);
  assert.equal(by.radarr.latest, RADARR_NEW);
  assert.equal(by.radarr.inPlace, true);
  assert.deepEqual(by.radarr.changes, ['fix a']);
  assert.equal(by.sonarr.latest, '4.0.9.9');
  assert.equal(by.bazarr.available, true);
  assert.equal(by.bazarr.inPlace, false);
  assert.equal(sum.count, 3);
  assert.ok(!('asset' in by.radarr), 'download URLs are not sent to the browser');
});

test('nothing is applied for apps that need a new image, or for a version the user was not shown', async () => {
  await assert.rejects(updates.apply('bazarr', '1.9.0'), /can't be updated in place/);
  await assert.rejects(updates.apply('radarr', '9.9.9.9'), /no longer current/);
  assert.equal(store.get().modules.radarr.override, undefined);
});

test('a bad checksum is rejected and nothing changes', async () => {
  feedHash = 'f'.repeat(64);
  await updates.check();
  await updates.apply('radarr', RADARR_NEW);
  const job = await waitJob();
  assert.equal(job.status, 'error');
  assert.match(job.steps.find((s) => s.id === 'download').detail, /checksum/i);
  assert.equal(store.get().modules.radarr.override, undefined);
  assert.equal(fs.readFileSync(dbFile, 'utf8'), 'ORIGINAL-DB');
  feedHash = goodHash;
});

test('if the new version does not start, the old one is restored automatically', async () => {
  await updates.check();
  await updates.apply('radarr', RADARR_NEW, { healthTimeout: 1500 }); // no fake server running = "won't start"
  const job = await waitJob();
  assert.equal(job.status, 'error');
  assert.ok(job.rolledBack);
  assert.match(job.detail, new RegExp(`restored to ${RADARR_OLD}`));
  assert.equal(store.get().modules.radarr.override, undefined);
  assert.equal(binDir('radarr'), path.join(process.env.ALLARR_APPS_DIR, 'radarr'));
  assert.equal(fs.readFileSync(dbFile, 'utf8'), 'ORIGINAL-DB');
  assert.equal(fs.existsSync(path.join(tmp, 'config', 'allarr', 'apps', 'radarr', RADARR_NEW)), false);
});

test('a confirmed update downloads, verifies, backs up, switches and checks the new version', async () => {
  await startFake();
  await updates.check();
  const started = await updates.apply('radarr', RADARR_NEW);
  assert.equal(started.running, true);
  const job = await waitJob();
  assert.equal(job.status, 'ok', JSON.stringify(job.steps));
  assert.ok(job.steps.every((s) => s.status === 'ok'));

  const ov = store.get().modules.radarr.override;
  assert.equal(ov.version, RADARR_NEW);
  assert.equal(ov.previous, RADARR_OLD);
  assert.equal(binDir('radarr'), ov.dir);
  assert.ok(fs.existsSync(path.join(ov.dir, 'Radarr')), 'new files are in place');
  assert.equal(fs.readFileSync(path.join(ov.backup, 'radarr.db'), 'utf8'), 'ORIGINAL-DB', 'database was backed up');
  assert.equal(byId.radarr.run(byId.radarr).cmd, path.join(ov.dir, 'Radarr'), 'the supervisor launches the new files');
  await stopFake();
});

test('after the image itself is updated, an older in-place copy is dropped', () => {
  const ov = store.get().modules.radarr.override;
  fs.writeFileSync(path.join(process.env.ALLARR_APPS_DIR, 'versions.json'), JSON.stringify({ radarr: '7.0.9.0' }));
  updates.reconcile();
  assert.equal(store.get().modules.radarr.override, undefined);
  assert.equal(fs.existsSync(ov.dir), false);
});
