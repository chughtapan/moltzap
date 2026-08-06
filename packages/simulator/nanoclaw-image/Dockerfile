# The NanoClaw half of one evaluation cell: the pinned upstream checkout, the
# MoltZap channel that carries its social traffic, and the bootstrap entrypoint
# the simulator's container runtime executes. Every input is staged by
# scripts/build-nanoclaw-image.mjs, so the build context is content-addressed
# and this file never reaches the network for source.

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS nanoclaw

# better-sqlite3 falls back to compiling from source when no prebuild matches
# the image's Node ABI, and a NanoClaw that cannot open its database is a run
# that fails after the cohort is already admitted.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates g++ make python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY nanoclaw-source.tar.gz prepare.mjs ./
COPY assets ./assets
COPY tarballs ./tarballs
RUN mkdir -p /build/app \
  && tar -xzf nanoclaw-source.tar.gz -C /build/app --strip-components=1 \
  && rm nanoclaw-source.tar.gz \
  && node prepare.mjs /build/app /build/assets /build/tarballs

WORKDIR /build/app
# HUSKY=0 because upstream's `prepare` script installs git hooks, and the
# extracted tarball is not a repository.
ENV HUSKY=0
RUN npm install --no-audit --no-fund \
  && npm run build \
  && test -f dist/index.js \
  && test -f dist/moltzap-eval-provision.js \
  && node_modules/.bin/tsx scripts/upgrade-state.ts set "" moltzap-simulator \
  && npm prune --omit=dev \
  && rm -rf vendor /root/.npm

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94

# NanoClaw executes every agent turn in a container it spawns itself and refuses
# to start when no runtime answers, so the client ships here and the platform
# supplies the endpoint through DOCKER_HOST.
COPY --from=docker.io/library/docker:cli@sha256:27a51d5ab1cd38d9eeaba7b415b8c07bc10c31e1cf1ec8d78f6413fcfab3f44f \
  /usr/local/bin/docker /usr/local/bin/docker

ENV NODE_ENV=production
COPY --from=nanoclaw --chown=node:node /build/app /opt/moltzap/nanoclaw/app
COPY --chown=node:node entrypoint.mjs /opt/moltzap/nanoclaw/entrypoint.mjs
RUN mkdir -p /var/lib/moltzap/nanoclaw \
  && chown -R node:node /var/lib/moltzap/nanoclaw

USER node
WORKDIR /var/lib/moltzap/nanoclaw
ENTRYPOINT ["node", "/opt/moltzap/nanoclaw/entrypoint.mjs"]
