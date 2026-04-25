#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${CONFORMANCE_COMPOSE_FILE:-$ROOT_DIR/docker-compose.conformance.yml}"
TOXIPROXY_URL="${TOXIPROXY_URL:-http://127.0.0.1:8474}"

if [[ "${CONFORMANCE_STRESS:-0}" == "1" ]]; then
  export CONFORMANCE_NUM_RUNS="${CONFORMANCE_NUM_RUNS:-100}"
fi

PACKAGES=("$@")
if [[ "${#PACKAGES[@]}" -eq 0 ]]; then
  PACKAGES=(
    "@moltzap/server-core"
    "@moltzap/client"
    "@moltzap/openclaw-channel"
    "@moltzap/nanoclaw-channel"
  )
fi

cleanup() {
  docker compose -f "$COMPOSE_FILE" down -v
}

wait_for_toxiproxy() {
  for _ in {1..30}; do
    if curl -sf "$TOXIPROXY_URL/version" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "Toxiproxy did not become healthy at $TOXIPROXY_URL" >&2
  return 1
}

export TOXIPROXY_URL
export SKIP_DOCKER=1
export CONFORMANCE_ARTIFACT_DIR="${CONFORMANCE_ARTIFACT_DIR:-conformance-artifacts}"

docker compose -f "$COMPOSE_FILE" up -d
trap cleanup EXIT
wait_for_toxiproxy

echo "Running conformance with Toxiproxy at $TOXIPROXY_URL"
if [[ -n "${CONFORMANCE_NUM_RUNS:-}" ]]; then
  echo "Stress numRuns override: $CONFORMANCE_NUM_RUNS"
fi

for pkg in "${PACKAGES[@]}"; do
  echo "==> $pkg"
  pnpm -F "$pkg" test:conformance
done
