import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { canWrite, fixHint, giveToApps } from './perms.js';

/**
 * One mount, one filesystem. Everything lives under /media so the *arr apps can HARDLINK
 * finished downloads into the library instead of copying them (instant, zero extra space,
 * and torrents keep seeding).
 */
export const LAYOUT = [
  'downloads/torrents/movies',
  'downloads/torrents/tv',
  'downloads/torrents/music',
  'downloads/usenet/incomplete',
  'downloads/usenet/complete/movies',
  'downloads/usenet/complete/tv',
  'downloads/usenet/complete/music',
  'movies',
  'series',
  'music',
];

export const media = (...p) => path.join(config.mediaDir, ...p);

/** Give a path to the app user, or open its permissions if the filesystem won't let us chown. */
export const chownPath = giveToApps;

export function ensureLayout() {
  fs.mkdirSync(config.mediaDir, { recursive: true });
  for (const rel of LAYOUT) {
    // chown every new directory level so the apps (running as PUID) can write
    let cur = config.mediaDir;
    for (const part of rel.split('/')) {
      cur = path.join(cur, part);
      if (!fs.existsSync(cur)) {
        fs.mkdirSync(cur);
        chownPath(cur);
      }
    }
  }
}

function hardlinkTest() {
  const id = crypto.randomBytes(4).toString('hex');
  const a = media('downloads', `.allarr-test-${id}`);
  const b = media('movies', `.allarr-link-${id}`);
  try {
    fs.writeFileSync(a, 'allarr');
    fs.linkSync(a, b);
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return { ok: sa.ino === sb.ino && sa.nlink >= 2, code: null };
  } catch (e) {
    return { ok: false, code: e.code || 'UNKNOWN' };
  } finally {
    for (const f of [a, b]) {
      try { fs.unlinkSync(f); } catch { /* already gone */ }
    }
  }
}

/** Everything the "Storage" step and the dashboard storage card need. */
export function check() {
  const issues = [];
  const result = {
    path: config.mediaDir,
    exists: false, writable: false, isMount: null, sameFilesystem: null, hardlinks: false,
    freeBytes: null, totalBytes: null, issues,
  };

  try {
    ensureLayout();
    result.exists = true;
  } catch (e) {
    issues.push({
      level: 'error', code: 'NO_ACCESS',
      message: `Allarr can't create folders in ${config.mediaDir} (${e.code || e.message}).`,
      fix: 'Check that the folder is mapped into the container and that PUID/PGID can write to it.',
    });
    return { ...result, ok: false };
  }

  try {
    const t = media(`.allarr-write-${Date.now()}`);
    fs.writeFileSync(t, '');
    fs.unlinkSync(t);
    result.writable = true;
  } catch {
    issues.push({
      level: 'error', code: 'READ_ONLY',
      message: `${config.mediaDir} is read-only for Allarr.`,
      fix: 'Remove ":ro" from the volume, or fix folder permissions for your PUID/PGID.',
    });
  }

  try {
    const s = fs.statfsSync(config.mediaDir);
    result.freeBytes = Number(s.bavail) * Number(s.bsize);
    result.totalBytes = Number(s.blocks) * Number(s.bsize);
  } catch { /* not supported everywhere */ }

  // Same drive for downloads and library? Subfolders mounted separately would break hardlinks.
  try {
    const devs = ['downloads', 'movies', 'series', 'music'].map((d) => fs.statSync(media(d)).dev);
    result.sameFilesystem = devs.every((d) => d === devs[0]);
    if (!result.sameFilesystem) {
      issues.push({
        level: 'error', code: 'SPLIT_MOUNTS',
        message: 'Downloads and your library are on different drives.',
        fix: 'Map ONE folder to /media and let Allarr create the subfolders inside it. Do not mount /media/downloads or /media/movies separately.',
      });
    }
  } catch { /* ignore */ }

  // Is /media a real mapped volume, or just the container's own disposable layer?
  if (process.platform !== 'win32' && !process.env.ALLARR_DEV) {
    try {
      result.isMount = fs.statSync(config.mediaDir).dev !== fs.statSync('/').dev;
      if (!result.isMount) {
        issues.push({
          level: 'warn', code: 'NOT_A_MOUNT',
          message: 'Nothing is mapped to /media. Files would be lost when the container is removed.',
          fix: 'Add a volume such as  -v /your/storage:/media  to your Docker run command or compose file.',
        });
      }
    } catch { /* ignore */ }
  }

  // The Hub is root, so the test above proves nothing about the apps (they run as PUID:PGID). Test as them.
  for (const dir of [media('downloads'), media('movies'), media('series'), media('music')]) {
    if (fs.existsSync(dir) && !canWrite(dir)) {
      issues.push({
        level: 'error', code: 'APPS_CANNOT_WRITE',
        message: `The apps run as user ${config.puid ?? 'the container user'}:${config.pgid ?? config.puid ?? ''} but cannot write to ${dir}.`,
        fix: fixHint(dir),
      });
      break;
    }
  }

  if (result.writable) {
    const t = hardlinkTest();
    result.hardlinks = t.ok;
    if (!t.ok && result.sameFilesystem !== false) {
      const why = {
        EXDEV: 'The two folders are on different filesystems.',
        EPERM: 'This filesystem does not allow hardlinks (common on exFAT, FAT32 and some network shares).',
        ENOTSUP: 'This filesystem does not support hardlinks.',
        EOPNOTSUPP: 'This filesystem does not support hardlinks.',
      }[t.code] || `The test failed (${t.code}).`;
      issues.push({
        level: 'warn', code: 'NO_HARDLINKS',
        message: `Hardlinks don't work here. ${why}`,
        fix: 'Allarr will still work, but imports will copy files (slower, uses double the space, and torrents stop seeding). Use ext4, XFS, btrfs, ZFS or NTFS on a local disk.',
      });
    }
  }

  return { ...result, ok: !issues.some((i) => i.level === 'error') };
}
