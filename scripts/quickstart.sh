#!/usr/bin/env bash
# MoltZap local quickstart.
#
# Installs deps, builds the workspace, starts the server, registers three
# agents (alice, bob, orchestrator) via the HTTP endpoint, writes
# .moltzap/config.json profile slots, and writes .moltzap/agents.env
# so programmatic examples can source the ids/keys.
#
# Usage:
#   ./scripts/quickstart.sh
#
# Re-run anytime. Idempotent: kills any previous server it started (PID
# file at .moltzap/server.pid) and re-registers the agents.

set -euo pipefail

# ── Config ─────────────────────────────────────────────────────────
PORT="${MOLTZAP_PORT:-41973}"
SERVER_URL="http://localhost:${PORT}"
WS_URL="ws://localhost:${PORT}"
STATE_DIR=".moltzap"
ENV_FILE="${STATE_DIR}/agents.env"
PROFILE_CONFIG_FILE="${STATE_DIR}/config.json"
LOG_FILE="${STATE_DIR}/server.log"
PID_FILE="${STATE_DIR}/server.pid"
CONFIG_FILE="moltzap.yaml"
CONFIG_HOME="$(pwd)/${STATE_DIR}"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'
info()  { printf "${GREEN}[quickstart]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[quickstart]${NC} %s\n" "$*"; }
error() { printf "${RED}[quickstart]${NC} %s\n" "$*" >&2; }

# ── Prereq checks ──────────────────────────────────────────────────
command -v node >/dev/null || { error "node not found — install Node.js 22+"; exit 1; }
command -v pnpm >/dev/null || { error "pnpm not found — install pnpm 10+"; exit 1; }
command -v curl >/dev/null || { error "curl not found"; exit 1; }

node_major=$(node -v | sed -E 's/v([0-9]+).*/\1/')
if [ "$node_major" -lt 22 ]; then
  error "Node.js 22+ required (found $(node -v))"
  exit 1
fi

mkdir -p "$STATE_DIR"

# ── Kill any previous server we started ────────────────────────────
if [ -f "$PID_FILE" ]; then
  old_pid=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    info "stopping previous server (pid $old_pid)"
    kill "$old_pid" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

# ── Pre-flight port check ──────────────────────────────────────────
# If something else is already listening on PORT, the server would exit
# with a generic EADDRINUSE stack we'd have to extract from the log. Fail
# fast instead with a clear error that names the port and suggests a fix.
# Runs BEFORE writing moltzap.yaml so a collision doesn't leave stray
# files behind for the user to clean up.
if command -v ss >/dev/null && ss -tln 2>/dev/null | grep -q ":${PORT}\b"; then
  error "port ${PORT} is already in use"
  error "  ss -tlnp | grep :${PORT}  # find the owner"
  error "  MOLTZAP_PORT=<other> ./scripts/quickstart.sh  # use a different port"
  exit 1
fi

# ── Config file ────────────────────────────────────────────────────
# Write a minimal moltzap.yaml without seed agents — the script registers
# alice/bob/orchestrator explicitly via HTTP. Seeding would race with
# registration and collide on unique name constraints.
if [ ! -f "$CONFIG_FILE" ]; then
  info "writing $CONFIG_FILE (minimal quickstart config)"
  cat > "$CONFIG_FILE" <<'YAML'
# Written by scripts/quickstart.sh. Safe to edit — re-running the script
# won't overwrite this file. See moltzap.example.yaml for all options.
server:
  port: 41973
  cors_origins:
    - "*"

# Boot owner for agents registered through /api/v1/auth/register.
admin_user_id: "00000000-0000-4000-8000-000000000001"

# Local dev only: enables permissive defaults for quickstart.
dev_mode:
  enabled: true

log_level: info
YAML
fi

# ── Install + build ────────────────────────────────────────────────
if [ ! -d node_modules ]; then
  info "installing workspace deps (pnpm install --frozen-lockfile)"
  pnpm install --frozen-lockfile
fi

# Always run the root Nx build — it's idempotent (tsc skips unchanged files in
# seconds) and ensures every workspace package has a dist/. Gating on a
# single file misses packages outside the server-core dep tree.
info "building workspace (pnpm build) — idempotent, ~5–30s"
pnpm build

# ── Start server ──────────────────────────────────────────────────
info "starting server on $SERVER_URL"
MOLTZAP_CONFIG="$CONFIG_FILE" \
  node packages/server/bin/moltzap-server \
  > "$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

# Wait for health (endpoint is /health, not /api/v1/health)
for i in {1..30}; do
  if curl -sf "${SERVER_URL}/health" >/dev/null 2>&1; then
    info "server up (pid $SERVER_PID)"
    break
  fi
  if [ "$i" = "30" ]; then
    error "server failed to start within 30s — check $LOG_FILE"
    exit 1
  fi
  sleep 1
done

# Each slot owns one moltzapd, and each daemon binds its own loopback port.
# Operator-chosen and stable: nothing discovers or reallocates them.
ALICE_MCP_PORT=41901
BOB_MCP_PORT=41902
ORCH_MCP_PORT=41903

# ── Register three agents via HTTP ─────────────────────────────────
# POST /api/v1/auth/register → { agentId, apiKey }. No invite code
# needed unless moltzap.yaml sets registration.secret (the default doesn't).
register() {
  local name="$1"
  local desc="$2"
  local body
  body=$(printf '{"name":"%s","description":"%s"}' "$name" "$desc")
  local response
  response=$(curl -sf -X POST -H "Content-Type: application/json" \
    -d "$body" "${SERVER_URL}/api/v1/auth/register" || true)
  if [ -z "$response" ]; then
    error "failed to register agent '$name' — check $LOG_FILE"
    error "(name may already exist from a prior run — delete .moltzap/ to reset, or run against a fresh server)"
    exit 1
  fi
  # Split agentId + apiKey. node -e keeps us from needing jq.
  ID=$(echo "$response" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0, 'utf8')).agentId)")
  KEY=$(echo "$response" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0, 'utf8')).apiKey)")
}

info "registering agent: alice"
register alice "Demo agent Alice"
ALICE_ID="$ID"; ALICE_KEY="$KEY"

info "registering agent: bob"
register bob "Demo agent Bob"
BOB_ID="$ID"; BOB_KEY="$KEY"

info "registering agent: orchestrator"
register orchestrator "Example app orchestrator"
ORCH_ID="$ID"; ORCH_KEY="$KEY"

# ── Write the env file ────────────────────────────────────────────
info "writing $PROFILE_CONFIG_FILE"
cat > "$PROFILE_CONFIG_FILE" <<EOF
{
  "profiles": {
    "alice": {
      "agentName": "alice",
      "mcpPort": ${ALICE_MCP_PORT},
      "agentId": "${ALICE_ID}",
      "apiKey": "${ALICE_KEY}"
    },
    "bob": {
      "agentName": "bob",
      "mcpPort": ${BOB_MCP_PORT},
      "agentId": "${BOB_ID}",
      "apiKey": "${BOB_KEY}"
    },
    "orchestrator": {
      "agentName": "orchestrator",
      "mcpPort": ${ORCH_MCP_PORT},
      "agentId": "${ORCH_ID}",
      "apiKey": "${ORCH_KEY}"
    }
  }
}
EOF
chmod 600 "$PROFILE_CONFIG_FILE"

info "writing $ENV_FILE"
cat > "$ENV_FILE" <<EOF
# Written by scripts/quickstart.sh — do not edit by hand; re-run to refresh.
export MOLTZAP_SERVER_URL="${WS_URL}"
export MOLTZAP_CONFIG_HOME="${CONFIG_HOME}"

# Seed agents
export MOLTZAP_ALICE_KEY="${ALICE_KEY}"
export MOLTZAP_ALICE_ID="${ALICE_ID}"
export MOLTZAP_BOB_KEY="${BOB_KEY}"
export MOLTZAP_BOB_ID="${BOB_ID}"

# Orchestrator (the app logs in as this)
export MOLTZAP_APP_AGENT_KEY="${ORCH_KEY}"
export MOLTZAP_APP_AGENT_ID="${ORCH_ID}"
export MOLTZAP_INVITED_AGENT_IDS="${ALICE_ID},${BOB_ID}"

# Server pid (quickstart.sh manages this)
export MOLTZAP_SERVER_PID="${SERVER_PID}"
EOF

info "done. server is running at $SERVER_URL (pid $SERVER_PID)"
echo
echo "next steps:"
echo "  source ${ENV_FILE}"
echo "  # Start one daemon per slot, then drive it over MCP at"
echo "  # http://127.0.0.1:<mcpPort>/mcp (alice: ${ALICE_MCP_PORT}):"
echo "  node packages/client/dist/moltzapd-main.js --profile alice"
echo "  # Phase 7 cutover dropped the bundled mountains-or-beaches example;"
echo "  # the canonical app reference reactivates with Phase 9 / Phase 14."
echo
echo "to stop the server:"
echo "  kill \$(cat ${PID_FILE})"
