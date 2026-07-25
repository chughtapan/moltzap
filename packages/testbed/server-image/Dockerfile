# The simulator's per-run server image: the `@moltzap/server-core` bin
# `moltzap-server` plus the config that pins the image contract
# `launcher-live.ts` launches against. Built by
# `scripts/build-server-image.mjs`, which stages the workspace tarballs
# next to this file; the image is never pushed, so runs pin it by the
# local image id (`sha256:...`, the `ServerSpec.imageDigest` form).
#
# `packages/server/Dockerfile` is the deployment image of the same
# binary and stays the reference for operators. This one exists beside
# it because a run's identity is the image digest: it is built from the
# workspace's already-built output, so it changes exactly when that tree
# changes, and it bakes the launcher's contract (port, `/data`, open
# registration, no encryption secret) rather than reading an operator's
# mounted config.
FROM node:22-slim

ENV NODE_ENV=production \
    MOLTZAP_CONFIG=/etc/moltzap/moltzap.yaml

WORKDIR /srv/moltzap

COPY package.json ./
COPY tarballs ./tarballs
RUN npm install --omit=dev --no-audit --no-fund \
  && npm cache clean --force \
  && rm -rf tarballs

COPY moltzap.yaml /etc/moltzap/moltzap.yaml

# The data directory the config pins; the launcher bind-mounts the run's
# storage directory here and the transcript drain reads it post-stop.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

ENTRYPOINT ["node", "/srv/moltzap/node_modules/@moltzap/server-core/bin/moltzap-server"]
