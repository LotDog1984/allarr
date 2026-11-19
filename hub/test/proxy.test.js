import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'allarr-proxy-'));
Object.assign(process.env, {
  ALLARR_CONFIG_DIR: path.join(tmp, 'config'), ALLARR_MEDIA_DIR: path.join(tmp, 'media'),
  ALLARR_SUPERVISE: '0', ALLARR_PORT_OFFSET: '33000',
});

const store = await import('../src/state.js');
const { byId } = await import('../src/modules.js');
const { proxyHttp } = await import('../src/proxy.js');

const radarr = byId.radarr;
let seen; // what the "app" received
const app = http.createServer((req, res) => {
  seen = req.headers;
  if (req.url === '/radarr/api') {
    res.setHeader('content-type', 'application/json');
    return res.end('{"ok":true}');
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-security-policy', "default-src 'self'; frame-ancestors 'none'");
  res.end('<!doctype html><html><head><title>Radarr</title></head><body>hello</body></html>');
});
const proxy = http.createServer((req, res) => proxyHttp(req, res, radarr));
const listen = (srv, port) => new Promise((r) => srv.listen(port, '127.0.0.1', r));

let base;
test.before(async () => {
  await listen(app, radarr.listenPort);
  await listen(proxy, 0);
  base = `http://127.0.0.1:${proxy.address().port}`;
});
test.after(() => {
  app.closeAllConnections?.(); proxy.closeAllConnections?.();
  app.close(); proxy.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const page = (headers = {}) => fetch(`${base}/radarr/`, { headers });

test('a full page gets the shared palette and the app theme, inside <head>', async () => {
  const res = await page({ 'sec-fetch-dest': 'iframe', 'accept-encoding': 'gzip' });
  const html = await res.text();
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /\/themes\/base\.css/);
  assert.match(head, /\/themes\/servarr\.css/);
  assert.ok(head.indexOf('base.css') < head.indexOf('servarr.css'), 'palette first, app theme after');
  assert.equal(Number(res.headers.get('content-length')), Buffer.byteLength(html), 'length matches the edited body');
  assert.equal(seen['accept-encoding'], 'identity', 'the app is asked not to compress so the HTML can be edited');
});

test('framing headers are relaxed so the Hub can embed the app', async () => {
  const res = await page({ 'sec-fetch-dest': 'iframe' });
  assert.equal(res.headers.get('x-frame-options'), null);
  assert.doesNotMatch(res.headers.get('content-security-policy') ?? '', /frame-ancestors/);
});

test('XHR fragments and JSON are left alone', async () => {
  const xhr = await (await page({ 'sec-fetch-dest': 'empty', accept: 'text/html' })).text();
  assert.doesNotMatch(xhr, /themes\//);
  const json = await fetch(`${base}/radarr/api`, { headers: { 'sec-fetch-dest': 'empty' } });
  assert.equal(await json.text(), '{"ok":true}');
});

test('the Appearance switch turns theming off', async () => {
  store.update((s) => { s.settings = { ...s.settings, theme: false }; });
  const html = await (await page({ 'sec-fetch-dest': 'iframe' })).text();
  assert.doesNotMatch(html, /themes\//);
  store.update((s) => { s.settings = { ...s.settings, theme: true }; });
  assert.match(await (await page({ 'sec-fetch-dest': 'iframe' })).text(), /themes\/servarr\.css/);
});

test('every theme file that a module names exists', () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'public', 'themes');
  assert.ok(fs.existsSync(path.join(dir, 'base.css')));
  for (const m of Object.values(byId)) {
    if (m.theme) assert.ok(fs.existsSync(path.join(dir, `${m.theme}.css`)), `${m.id} -> ${m.theme}.css`);
  }
});
