import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { config } from './config.js';

/** The Hub runs as root (so it can fix ownership); the apps run as PUID:PGID. */
export const isRoot = () => process.getuid?.() === 0;
export const appsRunAsOtherUser = () => isRoot() && config.puid !== undefined;

/** Can the app user (PUID:PGID) really create files in `dir`? Tested as that user, not assumed. */
export function canWrite(dir) {
  if (!appsRunAsOtherUser()) {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
  const r = spawnSync('sh', ['-c', 't="$1/.allarr-w-$$" && : > "$t" && rm -f "$t"', 'sh', dir], {
    uid: config.puid,
    gid: config.pgid ?? config.puid,
    stdio: 'ignore',
  });
  return r.status === 0;
}

/**
 * Hand a path to the app user. When the filesystem refuses to change ownership (NFS root-squash,
 * SMB/CIFS, a dropped CAP_CHOWN...), open the permissions up instead so the apps can still write.
 */
export function giveToApps(p) {
  if (!appsRunAsOtherUser()) return;
  try {
    fs.chownSync(p, config.puid, config.pgid ?? config.puid);
    return;
  } catch { /* fall through */ }
  try {
    fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o777 : 0o666);
  } catch { /* best effort; storage.check() reports it if the apps still can't write */ }
}

export const fixHint = (dir) =>
  `Set PUID/PGID in your compose file to the user that owns the folder on the host (check with: ls -ln <host folder>), ` +
  `or run on the host: chown -R ${config.puid}:${config.pgid ?? config.puid} <host folder>. On NFS/SMB shares, also check ` +
  `that the share allows that user to write.`;
