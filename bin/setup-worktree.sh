#!/usr/bin/env bash
# bin/setup-worktree.sh — bootstrap a fresh `git worktree add` checkout
#
# Why this exists:
#   `git worktree add` produces a clean filesystem checkout with no installed
#   dependencies or built package outputs. Workspace packages resolve one
#   another through those outputs, so a fresh checkout needs one consistent
#   bootstrap path.
#
# What it does (idempotent — safe to re-run):
#   1. `pnpm install`
#        Populates per-package `node_modules/` from the shared pnpm store.
#   2. `pnpm -r build`
#        Builds every workspace package's `dist/` so package export maps and
#        dependent workspace builds resolve consistently.
#
# Usage:
#   git worktree add ../moltzap-feature -b feature origin/main
#   cd ../moltzap-feature
#   bin/setup-worktree.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> pnpm install (root: $ROOT)"
pnpm install

echo "==> pnpm -r build"
pnpm -r build

echo
echo "Worktree ready. node_modules populated and dist/ built."
