ARG OPENCLAW_BASE_IMAGE
FROM ${OPENCLAW_BASE_IMAGE}

USER root
ARG OPENCLAW_BASE_IMAGE
LABEL dev.moltzap.openclaw-base-image="${OPENCLAW_BASE_IMAGE}"

WORKDIR /opt/moltzap
COPY package.json ./package.json
COPY tarballs ./tarballs
RUN npm install --omit=dev --no-audit --no-fund \
  && rm -rf node_modules/openclaw \
  && ln -s /app node_modules/openclaw \
  && node --input-type=module --eval \
    'await import("@moltzap/openclaw-channel")' \
  && rm -rf tarballs /root/.npm

COPY entrypoint.mjs register-daemon.mjs host-command.json /opt/moltzap/agent/

ENV NODE_ENV=production
WORKDIR /app
ENTRYPOINT ["node", "/opt/moltzap/agent/entrypoint.mjs"]
