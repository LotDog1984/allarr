# syntax=docker/dockerfile:1.7
#
# Allarr: the whole *arr stack in ONE container, supervised and wired together by the Allarr Hub.
#
#   docker build -t allarr .
#
# Pin or bump the apps here. The Servarr apps (Sonarr, Radarr, Lidarr, Prowlarr) and Bazarr
# are fetched as "latest" at build time; everything else is pinned for reproducible builds.
ARG SEERR_VERSION=3.5.2
ARG MAINTAINERR_VERSION=3.32.0
ARG WIZARR_VERSION=2026.10.1
ARG SABNZBD_VERSION=5.1.3
ARG CLEANUPARR_VERSION=2.11.1

# ---------------------------------------------------------------------------------------
# 1. Prebuilt binaries: Sonarr, Radarr, Lidarr, Prowlarr, Bazarr, Cleanuparr
# ---------------------------------------------------------------------------------------
FROM debian:bookworm-slim AS fetch
ARG TARGETARCH
ARG CLEANUPARR_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /out
RUN set -eux; case "$TARGETARCH" in amd64) echo x64 > /arch;; arm64) echo arm64 > /arch;; *) echo "unsupported arch $TARGETARCH" >&2; exit 1;; esac
RUN set -eux; mkdir sonarr && curl -fsSL "https://services.sonarr.tv/v1/download/main/latest?version=4&os=linux&arch=$(cat /arch)" | tar xz -C sonarr --strip-components=1
RUN set -eux; mkdir radarr && curl -fsSL "https://radarr.servarr.com/v1/update/master/updatefile?os=linux&runtime=netcore&arch=$(cat /arch)" | tar xz -C radarr --strip-components=1
RUN set -eux; mkdir lidarr && curl -fsSL "https://lidarr.servarr.com/v1/update/master/updatefile?os=linux&runtime=netcore&arch=$(cat /arch)" | tar xz -C lidarr --strip-components=1
RUN set -eux; mkdir prowlarr && curl -fsSL "https://prowlarr.servarr.com/v1/update/master/updatefile?os=linux&runtime=netcore&arch=$(cat /arch)" | tar xz -C prowlarr --strip-components=1
RUN set -eux; curl -fsSL -o bazarr.zip https://github.com/morpheus65535/bazarr/releases/latest/download/bazarr.zip && unzip -q bazarr.zip -d bazarr && rm bazarr.zip
RUN set -eux; curl -fsSL -o cu.zip "https://github.com/Cleanuparr/Cleanuparr/releases/download/v${CLEANUPARR_VERSION}/Cleanuparr-${CLEANUPARR_VERSION}-linux-${TARGETARCH}.zip" \
 && unzip -q cu.zip && mv "Cleanuparr-${CLEANUPARR_VERSION}-linux-${TARGETARCH}" cleanuparr && rm cu.zip \
 && chmod +x cleanuparr/Cleanuparr

# ---------------------------------------------------------------------------------------
# 2. Seerr (Node 22, pnpm). Same recipe as upstream's Dockerfile, on Debian instead of Alpine.
# ---------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS seerr-src
ARG SEERR_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
# sqlite3's prebuilt binary needs a newer glibc than bookworm has, so compile native modules here.
ENV npm_config_build_from_source=true
WORKDIR /app
RUN curl -fsSL "https://github.com/seerr-team/seerr/archive/refs/tags/v${SEERR_VERSION}.tar.gz" | tar xz --strip-components=1 \
 && corepack enable

FROM seerr-src AS seerr-deps
RUN CI=true pnpm install --prod --frozen-lockfile

FROM seerr-src AS seerr-build
ARG SEERR_VERSION
ENV COMMIT_TAG=v${SEERR_VERSION}
RUN CYPRESS_INSTALL_BINARY=0 pnpm install --frozen-lockfile && pnpm build \
 && rm -rf src server node_modules cache .git \
 && mkdir -p config && touch config/DOCKER

# ---------------------------------------------------------------------------------------
# 3. Maintainerr (needs Node >= 26, so it gets its own runtime; Seerr and the Hub use Node 22)
# ---------------------------------------------------------------------------------------
FROM node:26-bookworm-slim AS maintainerr-build
ARG MAINTAINERR_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates build-essential python3 pkg-config \
    libcairo2-dev libpango1.0-dev libpixman-1-dev libjpeg-dev libgif-dev librsvg2-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN curl -fsSL "https://github.com/Maintainerr/Maintainerr/archive/refs/tags/v${MAINTAINERR_VERSION}.tar.gz" | tar xz --strip-components=1
RUN npm install -g corepack@latest && corepack enable && corepack install
RUN yarn install --network-timeout 99999999
# The UI bundle carries a /__PATH_PREFIX__ placeholder that start.sh rewrites to BASE_PATH on boot.
RUN echo "VITE_BASE_PATH=/__PATH_PREFIX__" >> apps/ui/.env && yarn turbo build
RUN yarn workspaces focus --all --production \
 && mkdir -p packages/contracts/node_modules apps/server/node_modules \
 && mkdir -p /out/apps/server /out/packages/contracts \
 && cp -a node_modules /out/node_modules \
 && cp -a apps/server/dist apps/server/package.json apps/server/node_modules /out/apps/server/ \
 && cp -a apps/ui/dist /out/apps/server/dist/ui \
 && cp -a apps/server/assets /out/apps/server/dist/assets \
 && cp -a packages/contracts/dist packages/contracts/package.json packages/contracts/node_modules /out/packages/contracts/ \
 && cp docker/start.sh /out/start.sh && chmod 755 /out/start.sh

# ---------------------------------------------------------------------------------------
# 4. The runtime image
# ---------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ARG SABNZBD_VERSION
ARG WIZARR_VERSION
ENV DEBIAN_FRONTEND=noninteractive

# .NET runtime libs, Python, the torrent client, Usenet extraction tools, and Maintainerr's image libs.
RUN sed -i 's/^Components: main$/Components: main non-free/' /etc/apt/sources.list.d/debian.sources \
 && grep -q "non-free" /etc/apt/sources.list.d/debian.sources \
 && apt-get update && apt-get install -y --no-install-recommends \
    tini ca-certificates curl tzdata unzip ffmpeg libatomic1 \
    libicu72 libssl3 libsqlite3-0 \
    python3 python3-venv \
    qbittorrent-nox \
    par2 p7zip-full unrar \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libpixman-1-0 libjpeg62-turbo libgif7 librsvg2-2 \
 && rm -rf /var/lib/apt/lists/*

# Servarr apps, Bazarr, Cleanuparr
COPY --from=fetch /out/sonarr     /opt/sonarr
COPY --from=fetch /out/radarr     /opt/radarr
COPY --from=fetch /out/lidarr     /opt/lidarr
COPY --from=fetch /out/prowlarr   /opt/prowlarr
COPY --from=fetch /out/bazarr     /opt/bazarr
COPY --from=fetch /out/cleanuparr /opt/cleanuparr
# Cleanuparr hardcodes <app dir>/config; keep its state in /config/cleanuparr like every other app.
RUN rm -rf /opt/cleanuparr/config && ln -s /config/cleanuparr /opt/cleanuparr/config  && mkdir -p /opt/bazarr/bin && chmod -R a+rwX /opt/bazarr/bin

# Bazarr and SABnzbd each get their own virtualenv so their pinned requirements can never conflict.
RUN python3 -m venv /opt/venv-bazarr \
 && /opt/venv-bazarr/bin/pip install --no-cache-dir -r /opt/bazarr/requirements.txt
RUN curl -fsSL "https://github.com/sabnzbd/sabnzbd/releases/download/${SABNZBD_VERSION}/SABnzbd-${SABNZBD_VERSION}-src.tar.gz" | tar xz -C /opt \
 && mv "/opt/SABnzbd-${SABNZBD_VERSION}" /opt/sabnzbd \
 && python3 -m venv /opt/venv-sabnzbd \
 && /opt/venv-sabnzbd/bin/pip install --no-cache-dir -r /opt/sabnzbd/requirements.txt

# Seerr
COPY --from=seerr-build /app               /opt/seerr
COPY --from=seerr-deps  /app/node_modules  /opt/seerr/node_modules

# Maintainerr + its own Node 26. Upstream's start.sh hardcodes /opt/app.
COPY --from=maintainerr-build /out /opt/maintainerr
COPY --from=node:26-bookworm-slim /usr/local/bin/node /opt/node26/bin/node
RUN ln -s /opt/maintainerr /opt/app

# Wizarr (Flask, managed with uv). Its data dir is hardcoded to /data/database -> keep it in /config.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
ENV UV_PYTHON=3.13 UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 UV_CACHE_DIR=/tmp/uv-cache
RUN mkdir -p /opt/wizarr \
 && curl -fsSL "https://github.com/wizarrrr/wizarr/archive/refs/tags/v${WIZARR_VERSION}.tar.gz" | tar xz -C /opt/wizarr --strip-components=1 \
 && cd /opt/wizarr \
 && uv sync --frozen --no-dev \
 && .venv/bin/pybabel compile --use-fuzzy -d app/translations \
 && mkdir -p app/static/js app/static/css \
 && npm --prefix app/static ci --cache /tmp/npm-cache \
 && DOCKER_BUILD=true npm --prefix app/static run build \
 && rm -rf app/static/node_modules /tmp/npm-cache /tmp/uv-cache \
 && cp -r wizard_steps /opt/default_wizard_steps && chmod -R a+rwX /opt/default_wizard_steps \
 && mkdir -p /data && ln -s /config/wizarr/database /data/database

# The Hub: supervisor, wiring engine, login and GUI. No npm dependencies.
COPY hub/package.json /opt/hub/package.json
COPY hub/src          /opt/hub/src
COPY hub/public       /opt/hub/public

ENV PUID=1000 PGID=1000 TZ=Etc/UTC \
    ALLARR_CONFIG_DIR=/config ALLARR_MEDIA_DIR=/media ALLARR_APPS_DIR=/opt \
    ALLARR_PORT=8080

# 8080 Hub (everything for you) | 5055 Seerr (requests) | 5690 Wizarr (invites) | 6881 torrent peers
EXPOSE 8080 5055 5690 6881/tcp 6881/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/state >/dev/null || exit 1

WORKDIR /opt/hub
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
