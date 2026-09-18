ARG OPENCLAW_BASE_IMAGE
FROM ${OPENCLAW_BASE_IMAGE}

USER root
ARG OPENCLAW_BASE_IMAGE
ARG TARGETARCH
ARG CLAUDE_CODE_VERSION
ARG CLAUDE_CODE_SHA256_AMD64
ARG CLAUDE_CODE_SHA256_ARM64
LABEL dev.moltzap.openclaw-base-image="${OPENCLAW_BASE_IMAGE}"
LABEL dev.moltzap.claude-code-version="${CLAUDE_CODE_VERSION}"

# The claude-cli agent runtime drives the unmodified Claude Code binary, which
# the base image does not ship, and that binary is handed the owner's
# subscription token. The npm package is only a launcher and Anthropic's
# install.sh runs whatever release is latest, so the pinned release binary is
# fetched directly and nothing runs until it matches the digest the build
# script commits. The verified binary then installs itself under the host
# user's ~/.local/bin, which the base image already keeps on PATH, and the
# installed copy is checked against the same digest. The version probe runs
# under a foreign HOME because the agent host's HOME is the bootstrap state
# directory, not /home/node.
USER node
RUN case "${TARGETARCH}" in \
    amd64) platform=linux-x64; digest="${CLAUDE_CODE_SHA256_AMD64}" ;; \
    arm64) platform=linux-arm64; digest="${CLAUDE_CODE_SHA256_ARM64}" ;; \
    *) echo "no pinned Claude Code binary for ${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && curl -fsSL "https://downloads.claude.ai/claude-code-releases/${CLAUDE_CODE_VERSION}/${platform}/claude" -o /tmp/claude \
  && echo "${digest}  /tmp/claude" | sha256sum -c - \
  && chmod +x /tmp/claude \
  && /tmp/claude install "${CLAUDE_CODE_VERSION}" \
  && rm -f /tmp/claude \
  && echo "${digest}  $(readlink -f /home/node/.local/bin/claude)" | sha256sum -c - \
  && HOME=/tmp/claude-version-probe /home/node/.local/bin/claude --version \
  && rm -rf /tmp/claude-version-probe
USER root

WORKDIR /opt/moltzap
COPY package.json ./package.json
COPY tarballs ./tarballs
RUN npm install --omit=dev --no-audit --no-fund \
  && rm -rf node_modules/openclaw \
  && ln -s /app node_modules/openclaw \
  && node --input-type=module --eval \
    'await import("@moltzap/openclaw-channel")' \
  && rm -rf tarballs /root/.npm

# host.sh is scripts/agent-images/openclaw/host.sh: it binds the run's
# Claude Code token profile, then becomes the gateway.
COPY entrypoint.mjs register-daemon.mjs host.sh host-command.json /opt/moltzap/agent/

ENV NODE_ENV=production
WORKDIR /app
ENTRYPOINT ["node", "/opt/moltzap/agent/entrypoint.mjs"]
