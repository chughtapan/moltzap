# Root-owned assembly for the simulator controller and application overlay.
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS overlay

WORKDIR /build/overlay
COPY overlay-package.json ./package.json
COPY tarballs ./tarballs
RUN npm install --omit=dev --no-audit --no-fund \
  && node --input-type=module --eval \
    'await import("./node_modules/@moltzap/openclaw-channel/dist/plugin.js")' \
  && mkdir -p /application-overlay/openclaw-channel \
  && cp -a node_modules/@moltzap/openclaw-channel/. /application-overlay/openclaw-channel/ \
  && rm -rf node_modules/@moltzap/openclaw-channel \
  && cp -a node_modules /application-overlay/node_modules \
  && rm -rf /root/.npm

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ENV NODE_ENV=production
WORKDIR /srv/moltzap

COPY controller-package.json ./package.json
COPY tarballs ./tarballs
RUN npm install --omit=dev --no-audit --no-fund \
  && rm -rf tarballs /root/.npm \
  && mkdir -p /opt/moltzap \
  && ln -s /srv/moltzap/node_modules/@moltzap/simulator/dist /opt/moltzap/dist \
  && ln -s /srv/moltzap/node_modules /opt/moltzap/node_modules \
  && ln -s /srv/moltzap/node_modules /node_modules

COPY --from=overlay --chown=node:node /application-overlay /opt/moltzap/application-overlay
COPY --chown=node:node register-daemon.mjs /opt/moltzap/register-daemon.mjs
COPY --chown=node:node simulator-fault-program.mjs /opt/moltzap/qualification/simulator-fault-program.mjs
RUN node --input-type=module --eval \
  'await import("/opt/moltzap/qualification/simulator-fault-program.mjs")'

USER node
ENTRYPOINT ["node", "/opt/moltzap/dist/cluster/controller/main.js"]
