# Allarr

**The whole \*arr stack in one container, with one friendly web UI.**

Sonarr, Radarr, Lidarr, Prowlarr, Bazarr, qBittorrent, SABnzbd, Seerr, Wizarr, Maintainerr and Cleanuparr run
inside a single Docker container. A small control app, the **Allarr Hub**, starts and supervises them, hides
them behind one login, and wires them to each other for you. No pasting API keys between twelve web UIs.

## Quick start

**Dockge / Portainer / any Docker host:** paste [docker-compose.yml](docker-compose.yml) as a new stack, set the two
volume folders (`/config` for settings, `/media` for everything else), and deploy. The image is built by GitHub
Actions and published to `ghcr.io/lotdog1984/allarr`.

**From a checkout:** `docker compose -f docker-compose.build.yml up -d --build`

Open **http://your-server:8080** and follow the setup wizard (about two minutes):

1. **Account**: one login for everything.
2. **Storage**: Allarr checks `/media`, creates the folders and *proves* hardlinks work.
3. **Apps**: pick what you want (presets included). Everything is optional.
4. **Downloads**: qBittorrent needs nothing; add a Usenet provider if you have one.
5. **Media server**: Plex, Jellyfin or Emby (only tailors the checklist).
6. **Set everything up**: live progress while it starts and connects the apps.

Afterwards the dashboard shows each app's status, your storage health, and a short **Finish setup** checklist for
the things only a human can do (adding indexers, signing in to your media server, choosing subtitle languages).

## Updates (always with your confirmation)

Allarr never updates anything by itself.

* **Badge + Updates page.** Every few hours the Hub asks upstream for the newest version of each app. New versions
  show up as a badge in the sidebar, a banner on the dashboard and a chip on the app's card.
* **Sonarr, Radarr, Lidarr and Prowlarr update in place.** Press *Update…*, read what will happen, confirm. The Hub
  downloads the release, verifies its checksum, stops the app, backs up its database (`/config/allarr/backups`),
  switches to the new files (`/config/allarr/apps`) and verifies that it starts. If it doesn't, the old version and
  database are restored automatically. No image rebuild or redeploy needed.
* **Everything else is part of the image** (Bazarr, SABnzbd, Seerr, Wizarr, Maintainerr, Cleanuparr, qBittorrent).
  The badge says so; update by redeploying with the latest image (Dockge: *Update*, Portainer: *Pull and redeploy*).
* **The image rebuilds itself.** GitHub Actions publishes a fresh image every Monday (picking up new
  Sonarr/Radarr/Lidarr/Prowlarr/Bazarr releases). The versions pinned in the Dockerfile are bumped by a weekly pull
  request ([bump-versions.yml](.github/workflows/bump-versions.yml)); merging it is your confirmation. Enable
  *Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"* once for that.
* When a rebuilt image is newer than an in-place update, the Hub notices at startup and drops its own copy.
* A failed image build never replaces `latest`. To roll back, pin `ghcr.io/lotdog1984/allarr:sha-<commit>`.

## One folder, hardlinks

```
/media
├─ downloads
│  ├─ torrents/{movies,tv,music}     qBittorrent
│  └─ usenet/{incomplete,complete/*} SABnzbd
├─ movies                            Radarr
├─ series                            Sonarr
└─ music                             Lidarr
```

Because downloads and libraries live on the same filesystem under a single mount, Sonarr/Radarr/Lidarr
**hardlink** finished files into the library: instant, no extra disk space, and torrents keep seeding.
The Hub verifies this with a real test on the Storage step and shows a clear warning when it can't work
(split mounts, exFAT/FAT32, some network shares).

## What the Hub does automatically

| Step | Details |
|---|---|
| Config seeding | Each app starts already bound to `127.0.0.1`, under its URL base (`/sonarr`, `/radarr`, ...), with a known API key and authentication delegated to the Hub. |
| Root folders | `/media/series`, `/media/movies`, `/media/music`, and "use hardlinks" switched on. |
| Download clients | qBittorrent and SABnzbd added to Sonarr, Radarr and Lidarr with the right categories. |
| Indexers | Prowlarr linked to Sonarr, Radarr and Lidarr with full sync. |
| Subtitles | Bazarr linked to Sonarr and Radarr. |
| Requests | Sonarr and Radarr pre-added to Seerr. |
| Usenet | Your provider added to SABnzbd (optional). |

Every step is idempotent. **Settings → Re-apply connections** can be run at any time, and turning apps on/off in
Settings re-wires everything.

## How it fits together

```
 browser ──► :8080  Allarr Hub ── login, GUI, reverse proxy ──► 127.0.0.1:8989 /sonarr
                │                                              127.0.0.1:7878 /radarr
                │  supervises (spawn, restart, logs)            ... prowlarr, bazarr, qbittorrent,
                ▼                                                    sabnzbd, maintainerr, cleanuparr
        configures each app over its own HTTP API
 browser ──► :5055  Seerr   (own sign-in, for the people you share it with)
 browser ──► :5690  Wizarr  (own sign-in / invite links)
```

* The Hub is the container's main process (under `tini`). It starts each enabled app as a child, restarts crashes
  with back-off, keeps a log tail (viewable in the UI), and stops everything cleanly.
* Apps listen on localhost only. Admin apps are only reachable through the Hub, after logging in. Phone apps and
  scripts can still reach `/sonarr/api/...` by sending the app's own API key.
* Seerr and Wizarr don't support running under a URL prefix and are meant for other people, so they keep their
  own ports and their own sign-in.

## Local development (no Docker)

```bash
cd hub
npm run dev            # real Hub + mock apps on http://localhost:8088
npm run dev -- --reset # wipe the throw-away .dev folder and start from the welcome screen
```

`hub/dev/mock-apps.js` stands in for every app. It speaks just enough of the real HTTP APIs and checks every request
against the API key the Hub seeded, so the wiring logic can be developed and tested without the real apps.

## Status and honest caveats

Verified (Docker, amd64, fresh volumes, full wizard flow through the API):

* All 11 apps start and stay up, come back by themselves after `docker restart`, and run as `PUID:PGID`, not root.
* The wiring was checked against the **real** apps, not just the mocks: Sonarr's own "test all download clients"
  passes for both qBittorrent and SABnzbd, root folders and hardlinks are set, Prowlarr lists all three library
  apps with full sync, the Usenet provider is stored in SABnzbd, Bazarr stores the Sonarr/Radarr connection, and
  Seerr keeps the pre-added Sonarr/Radarr after its restart.
* Every admin app is reachable only through the Hub login (401 without it), and the real Sonarr UI renders
  inside the Hub frame.
* 14 unit tests (`cd hub && npm test`), including the whole in-place update flow with mocked upstreams, plus a
  mock-app dev setup for working on the GUI without Docker.

Not verified yet:

* **arm64** builds (the Dockerfile has the plumbing but it hasn't been built or run).
* Using the apps day to day: indexer sync results, real downloads end to end, subtitle providers.
* Maintainerr, Cleanuparr and Wizarr are started and reachable, but they are linked through the checklist rather
  than auto-configured. Cleanuparr's `BASE_PATH` support is only confirmed by it answering under `/cleanuparr/`.
* Live WebSocket traffic through the proxy (the apps' real-time updates) beyond the page loading.

Design notes and limits:

* **Cleanuparr** hardcodes its state folder, so the image symlinks it into `/config/cleanuparr`. **Wizarr**
  likewise uses `/data/database`, symlinked to `/config/wizarr/database`.
* **Maintainerr** requires Node 26+ while Seerr v3.5.2 needs Node 22, so the image carries two Node runtimes.
* Seerr's `sqlite3` is compiled from source during the build because its prebuilt binary needs a newer glibc than
  Debian bookworm provides.
* **Readarr** is intentionally not included (retired upstream) and **Huntarr** isn't either: its original
  repository was removed and a public security review documents an unauthenticated authentication bypass in it.
* The Hub runs as root so it can fix ownership; every app runs as `PUID:PGID`.
* The image is about 6 GB (three language runtimes plus ffmpeg). Rebuild it to pick up upstream releases.
* Use this for media you have the right to download and manage.
