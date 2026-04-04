#!/bin/bash
set -euo pipefail

# Build the moltzap-eval-agent:local Docker image with the MoltZap channel plugin pre-installed.
# Prerequisites: Docker running, ghcr.io/openclaw/openclaw:latest pulled.
# Usage: build-eval-agent.sh [--label KEY=VALUE]

DOCKER_LABEL_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --label)
      DOCKER_LABEL_ARGS+=(--label "$2")
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

cd "$(dirname "$0")/../../.."

echo "Building protocol + channel plugin..."
pnpm --filter @moltzap/protocol build
pnpm --filter @moltzap/openclaw-channel build
pnpm --filter @moltzap/cli build

echo "Packing tarballs..."
(cd packages/protocol && pnpm pack && mv moltzap-protocol-*.tgz ../evals/)
(cd packages/openclaw-channel && pnpm pack && mv moltzap-openclaw-channel-*.tgz ../evals/)
(cd packages/cli && pnpm pack && mv moltzap-cli-*.tgz ../evals/)

echo "Building Docker image..."
docker build ${DOCKER_LABEL_ARGS[@]+"${DOCKER_LABEL_ARGS[@]}"} -f packages/evals/Dockerfile.eval-agent -t moltzap-eval-agent:local packages/evals/

echo "Cleaning up tarballs..."
rm -f packages/evals/moltzap-*.tgz

echo "Done: moltzap-eval-agent:local"
