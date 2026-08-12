# Root-owned assembly for the simulator controller and application overlay.
FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS overlay

WORKDIR /build/overlay
COPY overlay-package.json ./package.json
COPY tarballs ./tarballs
RUN npm install --omit=dev --no-audit --no-fund \
  && node --input-type=module --eval \
    'await import("./node_modules/@moltzap/openclaw-channel/dist/openclaw-entry.js")' \
  && mkdir -p /application-overlay/openclaw-channel \
  && cp -a node_modules/@moltzap/openclaw-channel/. /application-overlay/openclaw-channel/ \
  && rm -rf node_modules/@moltzap/openclaw-channel \
  && cp -a node_modules /application-overlay/node_modules \
  && rm -rf /root/.npm

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94

ENV NODE_ENV=production
WORKDIR /srv/moltzap

COPY controller-package.json ./package.json
COPY tarballs ./tarballs
RUN npm install --omit=dev --no-audit --no-fund \
  && test -f node_modules/@moltzap/evals/dist/peer-application.js \
  && test -x node_modules/.bin/moltzap-server \
  && rm -rf tarballs /root/.npm \
  && mkdir -p /opt/moltzap \
  && ln -s /srv/moltzap/node_modules/@moltzap/simulator/dist /opt/moltzap/dist \
  && ln -s /srv/moltzap/node_modules /opt/moltzap/node_modules \
  && ln -s /srv/moltzap/node_modules /node_modules

COPY --from=overlay --chown=node:node /application-overlay /opt/moltzap/application-overlay

USER node
ENTRYPOINT ["node", "/opt/moltzap/dist/cluster/controller/main.js"]
