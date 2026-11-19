import http from 'node:http';
import net from 'node:net';
import { stripSessionCookie } from './auth.js';

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

const startingPage = (mod) => `<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=3>
<title>${mod.name} is starting</title>
<body style="font:16px system-ui;background:#0f1115;color:#e8eaf0;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><div style="font-size:40px">⏳</div><h2>${mod.name} is starting…</h2>
<p style="color:#9aa3b2">This page refreshes by itself. First start can take a minute.</p></div>`;

export function proxyHttp(req, res, mod) {
  const upstream = http.request(
    { host: '127.0.0.1', port: mod.listenPort, method: req.method, path: upstreamPath(mod, req.url), headers: upstreamHeaders(req, mod) },
    (ur) => {
      const h = { ...ur.headers };
      delete h['x-frame-options']; // the Hub shows apps inside its own frame
      if (h['content-security-policy']) {
        h['content-security-policy'] = h['content-security-policy'].replace(/frame-ancestors[^;]*;?/i, '');
      }
      if (h.location) h.location = rewriteLocation(h.location, mod);
      res.writeHead(ur.statusCode, ur.statusMessage, h);
      ur.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
    res.end(startingPage(mod));
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
