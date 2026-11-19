import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const here = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  version: '0.1.0',
  /** Port the Hub (the only port most people ever need) listens on. */
  port: Number(env.ALLARR_PORT || 8080),
  host: env.ALLARR_HOST || '0.0.0.0',
  /** Everything the apps persist: /config/sonarr, /config/radarr, ... */
  configDir: env.ALLARR_CONFIG_DIR || '/config',
  /** The ONE media mount. downloads, movies, series and music all live below it. */
  mediaDir: env.ALLARR_MEDIA_DIR || '/media',
  /** Where the app binaries are installed in the image. */
  appsDir: env.ALLARR_APPS_DIR || '/opt',
  puid: env.PUID ? Number(env.PUID) : undefined,
  pgid: env.PGID ? Number(env.PGID) : undefined,
  /** Set ALLARR_SUPERVISE=0 to only talk to already-running apps (dev / mock mode). */
  supervise: env.ALLARR_SUPERVISE !== '0',
  /** Added to every internal app port. Lets the dev setup avoid clashes on a desktop. */
  portOffset: Number(env.ALLARR_PORT_OFFSET || 0),
  tz: env.TZ || 'UTC',
  publicDir: path.join(here, '..', 'public'),
};

export const hubDir = path.join(config.configDir, 'allarr');
