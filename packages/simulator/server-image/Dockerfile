# The simulator's per-run production router image contains the
# `@moltzap/server-core` binary and its run-specific configuration. The image
# builder stages version-matched package tarballs beside this file and returns
# the local content-addressed image id used by the run ledger.
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
