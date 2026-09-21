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

# Claude Code's managed settings apply to every session whatever setting
# sources or permission mode OpenClaw passes. They deny AskUserQuestion, which
# waits for a person: in an agent pod nobody answers, and the session stays
# blocked until the run tears it down.
COPY claude-code-managed-settings.json /etc/claude-code/managed-settings.json

# patch-openclaw.mjs is scripts/agent-images/openclaw/patch-openclaw.mjs: a
# turn that a bot sender opens gets an optional-reply delivery hint and skips
# OpenClaw's stranded-reply recovery. It runs before the plugin installs
# against the dist and fails the build unless every anchor matches the base
# exactly once; the marker records what it applied.
COPY patch-openclaw.mjs /opt/moltzap/agent/
RUN node /opt/moltzap/agent/patch-openclaw.mjs /app/dist \
    --base-image "${OPENCLAW_BASE_IMAGE}" \
    --marker /opt/moltzap/agent/openclaw-patch.json

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
# finalize-host.mjs is scripts/agent-images/openclaw/finalize-host.mjs. When a
# run asks for model usage, the entrypoint runs it as the host user once the
# host has stopped and keeps the summary it prints outside the host's reach.
COPY entrypoint.mjs register-daemon.mjs host.sh host-command.json finalize-host.mjs /opt/moltzap/agent/

ENV NODE_ENV=production
WORKDIR /app
ENTRYPOINT ["node", "/opt/moltzap/agent/entrypoint.mjs"]
