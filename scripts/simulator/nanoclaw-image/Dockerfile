# MoltZap's application container retains NanoClaw's official agent image as
# its runtime base; the host and simulator bootstrap are layered around it.
ARG NANOCLAW_AGENT_IMAGE=nanoclaw-agent:unconfigured
FROM ${NANOCLAW_AGENT_IMAGE} AS builder

USER root
RUN apt-get update \
  && apt-get install --yes --no-install-recommends g++ make python3 \
  && rm -rf /var/lib/apt/lists/*

COPY source /opt/moltzap/nanoclaw/app
COPY tarballs /opt/moltzap/nanoclaw/tarballs
COPY channel/moltzap.ts /opt/moltzap/nanoclaw/channel/moltzap.ts
COPY nanoclaw-v2.3.0.patch /opt/moltzap/nanoclaw/nanoclaw-v2.3.0.patch
COPY prepare.mjs /opt/moltzap/nanoclaw/prepare.mjs

WORKDIR /opt/moltzap/nanoclaw/app
RUN git apply --check /opt/moltzap/nanoclaw/nanoclaw-v2.3.0.patch \
  && git apply /opt/moltzap/nanoclaw/nanoclaw-v2.3.0.patch \
  && node /opt/moltzap/nanoclaw/prepare.mjs \
    /opt/moltzap/nanoclaw/app \
    /opt/moltzap/nanoclaw/channel/moltzap.ts \
    /opt/moltzap/nanoclaw/tarballs/client.tgz \
    /opt/moltzap/nanoclaw/tarballs/identity.tgz \
    /opt/moltzap/nanoclaw/tarballs/router.tgz \
  && HUSKY=0 pnpm install --no-frozen-lockfile \
  && pnpm run build \
  && mkdir -p /app/node_modules/@moltzap \
  && ln -s /opt/moltzap/nanoclaw/app/node_modules/@moltzap/client /app/node_modules/@moltzap/client \
  && ln -s /opt/moltzap/nanoclaw/app/node_modules/effect /app/node_modules/effect \
  && ln -s /app/node_modules container/agent-runner/node_modules \
  && /app/node_modules/.bin/tsc --noEmit -p container/agent-runner/tsconfig.json \
  && pnpm prune --prod \
  && node --input-type=module --eval \
    'const { default: Database } = await import("better-sqlite3"); const database = new Database(":memory:"); database.close()' \
  && rm -rf /root/.cache /root/.local/share/pnpm/store /opt/moltzap/nanoclaw/tarballs

FROM ${NANOCLAW_AGENT_IMAGE}

USER root
ARG NANOCLAW_SOURCE_REVISION
ARG NANOCLAW_SOURCE_ARCHIVE_SHA256
LABEL dev.moltzap.nanoclaw-source-revision="${NANOCLAW_SOURCE_REVISION}"
LABEL dev.moltzap.nanoclaw-source-archive-sha256="${NANOCLAW_SOURCE_ARCHIVE_SHA256}"

COPY --from=builder /opt/moltzap/nanoclaw/app /opt/moltzap/nanoclaw/app
COPY bootstrap.mjs entrypoint.mjs preload.mjs process-driver.mjs provision.mjs /opt/moltzap/nanoclaw/

# Bun resolves the mounted runner from /app, while Node resolves the host from
# its extracted tree. The links give both processes the same patched packages.
RUN mkdir -p /var/lib/moltzap/nanoclaw \
  && mkdir -p /app/node_modules/@moltzap \
  && ln -s /opt/moltzap/nanoclaw/app/node_modules/@moltzap/client /app/node_modules/@moltzap/client \
  && ln -s /opt/moltzap/nanoclaw/app/node_modules/effect /app/node_modules/effect \
  && ln -s /opt/moltzap/nanoclaw/app/container/agent-runner/src /app/src \
  && ln -s /opt/moltzap/nanoclaw/app/container/skills /app/skills \
  && ln -s /opt/moltzap/nanoclaw/app/container/CLAUDE.md /app/CLAUDE.md \
  && ln -s /var/lib/moltzap/nanoclaw/current-session-context /app/.nanoclaw-session.json \
  && rmdir /workspace/group /workspace/extra /workspace \
  && ln -s /var/lib/moltzap/nanoclaw/current-workspace /workspace \
  && chown -R node:node /var/lib/moltzap/nanoclaw \
  && test ! -e /var/run/docker.sock \
  && ! command -v docker

ENV NODE_ENV=production
USER node
WORKDIR /var/lib/moltzap/nanoclaw
ENTRYPOINT ["node", "/opt/moltzap/nanoclaw/entrypoint.mjs"]
