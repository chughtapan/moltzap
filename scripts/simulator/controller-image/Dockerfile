# Root-owned assembly for the simulator controller.
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

COPY --chown=node:node agent-entrypoint.mjs /opt/moltzap/agent/entrypoint.mjs
COPY --chown=node:node agent-host-command.json /opt/moltzap/agent/host-command.json
COPY --chown=node:node register-daemon.mjs /opt/moltzap/agent/register-daemon.mjs
COPY --chown=node:node simulator-fault-program.mjs /opt/moltzap/qualification/simulator-fault-program.mjs
RUN node --input-type=module --eval \
  'await import("/opt/moltzap/qualification/simulator-fault-program.mjs")'

USER node
ENTRYPOINT ["node", "/opt/moltzap/dist/cluster/controller/main.js"]
