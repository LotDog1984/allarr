/**
 * Local dev runner (no Docker): the real Hub + mock apps, with throw-away config/media folders.
 *   npm run dev          (from the hub folder)       -> http://localhost:8088
 *   npm run dev -- --reset                          -> wipe .dev and start from the welcome screen
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dev = path.join(root, '.dev');
if (process.argv.includes('--reset')) fs.rmSync(dev, { recursive: true, force: true });
fs.mkdirSync(path.join(dev, 'config'), { recursive: true });
fs.mkdirSync(path.join(dev, 'media'), { recursive: true });

// versions "baked into the image", so the update page can show an image-only update (Bazarr) as well
fs.mkdirSync(path.join(dev, 'opt'), { recursive: true });
fs.writeFileSync(path.join(dev, 'opt', 'versions.json'), JSON.stringify({ bazarr: '1.0.0' }));

const env = {
  ...process.env,
  ALLARR_DEV: '1',
  ALLARR_SUPERVISE: '0',
  ALLARR_PORT: process.env.ALLARR_PORT || '8088',
  ALLARR_PORT_OFFSET: '20000',
  ALLARR_UPDATES_FAKE: '1', // pretend newer versions exist so the update UI can be tried without the network
  ALLARR_APPS_DIR: path.join(dev, 'opt'),
  ALLARR_CONFIG_DIR: path.join(dev, 'config'),
  ALLARR_MEDIA_DIR: path.join(dev, 'media'),
};

const kids = ['dev/mock-apps.js', 'src/server.js'].map((f) =>
  spawn(process.execPath, [path.join(root, f)], { env, stdio: 'inherit', cwd: root }),
);
const stop = () => kids.forEach((k) => k.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
kids.forEach((k) => k.on('exit', stop));
