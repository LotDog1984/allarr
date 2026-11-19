import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { config, hubDir } from './config.js';

/**
 * A tiny process supervisor. The Hub is PID-1-ish inside the container: it starts every
 * enabled app, restarts crashes with back-off, keeps a log tail, and stops them cleanly.
 */
const LOG_DIR = path.join(hubDir, 'logs');
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const procs = new Map();

export const bus = new EventEmitter();

export function info(id) {
  const p = procs.get(id);
  if (!p) return { state: 'stopped', restarts: 0, error: null };
  return { state: p.state, restarts: p.restarts, error: p.error, since: p.since, pid: p.child?.pid };
}

export function start(id, spec) {
  let p = procs.get(id);
  if (p?.wanted && p.child) return; // already running
  p ??= { restarts: 0, lines: [], backoff: 1000, state: 'stopped' };
  procs.set(id, p);
  p.wanted = true;
  p.spec = spec;
  launch(id, p);
}

function launch(id, p) {
  clearTimeout(p.timer);
  const { cmd, args = [], env = {}, cwd } = p.spec;

  const notInstalled = (path.isAbsolute(cmd) && !fs.existsSync(cmd)) || (cwd && !fs.existsSync(cwd));
  if (notInstalled) {
    p.state = 'missing';
    p.error = `${path.basename(cwd && !path.isAbsolute(cmd) ? cwd : cmd)} is not installed in this image`;
    bus.emit('change', id);
    return;
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, `${id}.log`);
  try {
    if (fs.statSync(logFile).size > MAX_LOG_BYTES) fs.renameSync(logFile, `${logFile}.old`);
  } catch { /* no log yet */ }
  const log = fs.createWriteStream(logFile, { flags: 'a' });

  // HOME inside the app's own config folder: .NET and Python tools want a writable home
  const home = path.join(config.configDir, id);
  const opts = { cwd, env: { ...process.env, HOME: home, ...env }, stdio: ['ignore', 'pipe', 'pipe'] };
  if (process.getuid?.() === 0 && config.puid !== undefined) {
    opts.uid = config.puid;
    opts.gid = config.pgid ?? config.puid;
  }

  const child = spawn(cmd, args, opts);
  p.child = child;
  p.state = 'running';
  p.since = Date.now();
  p.error = null;

  const onData = (d) => {
    log.write(d);
    for (const line of d.toString().split(/\r?\n/)) {
      if (!line) continue;
      p.lines.push(line);
      if (p.lines.length > 500) p.lines.shift();
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('error', (err) => {
    p.child = null;
    p.state = 'missing';
    p.error = err.code === 'ENOENT' ? `"${cmd}" is not installed in this image` : err.message;
    log.end();
    bus.emit('change', id);
  });

  child.on('exit', (code, signal) => {
    log.end();
    if (p.child !== child) return; // already handled by the 'error' branch
    p.child = null;
    if (!p.wanted) {
      p.state = 'stopped';
      bus.emit('change', id);
      return;
    }
    p.state = 'crashed';
    p.error = `exited (${signal || `code ${code}`})`;
    p.restarts += 1;
    if (Date.now() - p.since > 60_000) p.backoff = 1000;
    const wait = p.backoff;
    p.backoff = Math.min(p.backoff * 2, 30_000);
    p.timer = setTimeout(() => launch(id, p), wait);
    bus.emit('change', id);
  });

  bus.emit('change', id);
}

export function stop(id) {
  const p = procs.get(id);
  if (!p) return Promise.resolve();
  p.wanted = false;
  clearTimeout(p.timer);
  if (!p.child) {
    p.state = 'stopped';
    bus.emit('change', id);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const child = p.child;
    const killer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.once('exit', () => {
      clearTimeout(killer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

export const stopAll = () => Promise.all([...procs.keys()].map(stop));

export function tail(id, n = 200) {
  const p = procs.get(id);
  if (p?.lines.length) return p.lines.slice(-n);
  try {
    return fs.readFileSync(path.join(LOG_DIR, `${id}.log`), 'utf8').split(/\r?\n/).filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}
