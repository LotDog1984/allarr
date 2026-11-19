import http from 'node:http';
import net from 'node:net';
import { stripSessionCookie } from './auth.js';
import * as store from './state.js';
import * as sup from './supervisor.js';

/**
 * Reverse proxy: /sonarr -> 127.0.0.1:8989/sonarr, and so on. Only reachable after logging in
 * to the Hub (or with the app's own API key, so phone apps and scripts keep working).
 */
const upstreamPath = (mod, url) => (mod.stripBase ? url.slice(mod.basePath.length) || '/' : url);

function upstreamHeaders(req, mod) {
  const h = { ...req.headers };
  h.host = `127.0.0.1:${mod.listenPort}`;
  h['x-forwarded-for'] = req.socket.remoteAddress;
  h['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || 'http';
  h['x-forwarded-host'] = req.headers.host;
  const cookie = stripSessionCookie(req.headers.cookie);
  if (cookie) h.cookie = cookie;
  else delete h.cookie;
  return h;
}

function rewriteLocation(loc, mod) {
  const self = `http://127.0.0.1:${mod.listenPort}`;
  if (loc.startsWith(self)) loc = loc.slice(self.length) || '/';
  if (mod.stripBase && loc.startsWith('/') && !loc.startsWith(mod.basePath)) loc = mod.basePath + loc;
  return loc;
}

const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const PAGE_CSS = 'font:16px system-ui;background:#0f1115;color:#e8eaf0;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box';

const startingPage = (mod) => `<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=3>
<title>${mod.name} is starting</title>
<body style="${PAGE_CSS}">
<div style="text-align:center"><div style="font-size:40px">⏳</div><h2>${mod.name} is starting…</h2>
<p style="color:#9aa3b2">This page refreshes by itself. First start can take a minute.</p></div>`;

/** The app keeps crashing: say so, show why, and what usually fixes it. */
const crashedPage = (mod, info) => {
  const lines = sup.tail(mod.id, 12).map((l) => l.trim()).filter(Boolean).slice(-8);
  return `<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=8>
<title>${mod.name} isn't running</title>
<body style="${PAGE_CSS}"><div style="max-width:720px;width:100%">
<h2 style="margin:0 0 6px">${mod.name} isn't running</h2>
<p style="color:#9aa3b2;margin:0 0 16px">${esc(info.error ?? 'It stopped unexpectedly')}. Allarr keeps retrying, and this page refreshes by itself.</p>
<pre style="background:#0b0d11;border:1px solid #2a2f3b;border-radius:10px;padding:14px;white-space:pre-wrap;word-break:break-all;font:12.5px/1.55 ui-monospace,Consolas,monospace;color:#99a2b3;max-height:260px;overflow:auto">${esc(lines.join('\n') || 'No log output yet.')}</pre>
<p style="color:#9aa3b2;font-size:14px;margin-top:14px">Seeing <b>permission denied</b> or <b>cannot create directory</b>? Set <code>PUID</code>/<code>PGID</code> in your compose file to the user that owns your config and media folders.</p></div>`;
};

// ---- theming: make each app look like part of Allarr ---------------------------------------
/** A full page (top-level or iframe). XHR fragments live inside a page that already has the theme. */
const wantsHtml = (req) => {
  if (req.method !== 'GET') return false;
  const dest = req.headers['sec-fetch-dest'];
  return dest ? ['document', 'iframe'].includes(dest) : (req.headers.accept ?? '').includes('text/html');
};
const themeOn = (mod) => !!mod.theme && store.get().settings?.theme !== false;

function injectTheme(html, theme) {
  const tag = `<link rel="stylesheet" href="/themes/base.css"><link rel="stylesheet" href="/themes/${theme}.css">`;
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${tag}</head>`) : tag + html;
}

export function proxyHttp(req, res, mod) {
  const theming = themeOn(mod) && wantsHtml(req);
  const headers = upstreamHeaders(req, mod);
  if (theming) headers['accept-encoding'] = 'identity'; // we need to read (and edit) the HTML
  const upstream = http.request(
    { host: '127.0.0.1', port: mod.listenPort, method: req.method, path: upstreamPath(mod, req.url), headers },
    (ur) => {
      const h = { ...ur.headers };
      delete h['x-frame-options']; // the Hub shows apps inside its own frame
      if (h['content-security-policy']) {
        h['content-security-policy'] = h['content-security-policy'].replace(/frame-ancestors[^;]*;?/i, '');
      }
      if (h.location) h.location = rewriteLocation(h.location, mod);

      if (theming && ur.statusCode === 200 && /text\/html/i.test(h['content-type'] ?? '')) {
        const chunks = [];
        ur.on('data', (c) => chunks.push(c));
        ur.on('end', () => {
          const html = injectTheme(Buffer.concat(chunks).toString('utf8'), mod.theme);
          delete h['transfer-encoding'];
          delete h.etag;
          h['content-length'] = Buffer.byteLength(html);
          res.writeHead(200, ur.statusMessage, h);
          res.end(html);
        });
        return;
      }
      res.writeHead(ur.statusCode, ur.statusMessage, h);
      ur.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy();
    const info = sup.info(mod.id);
    const crashed = ['crashed', 'missing'].includes(info.state);
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
    res.end(crashed ? crashedPage(mod, info) : startingPage(mod));
  });
  req.pipe(upstream);
}

export function proxyUpgrade(req, socket, head, mod) {
  const upstream = net.connect(mod.listenPort, '127.0.0.1', () => {
    let raw = `${req.method} ${upstreamPath(mod, req.url)} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(upstreamHeaders(req, mod))) raw += `${k}: ${v}\r\n`;
    upstream.write(`${raw}\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}
