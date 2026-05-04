#!/usr/bin/env bash
# bin/setup-worktree.sh — bootstrap a fresh `git worktree add` checkout
#
# Why this exists:
#   `git worktree add` produces a clean filesystem checkout with no
#   `node_modules/` and no built `dist/`. Every dispatched teammate working in
#   a fresh worktree needs the same three steps before any `pnpm` command
#   resolves: install, build, native postinstall. Per-dispatch handling
#   recurred ~5x during epic #415; this script collapses it to one line.
#
# What it does (idempotent — safe to re-run):
#   1. `pnpm install`
#        Populates per-package `node_modules/` from the shared pnpm store.
#        With root `package.json` -> `pnpm.onlyBuiltDependencies`, this also
#        runs `@anthropic-ai/claude-code`'s postinstall (`install.cjs`),
#        which downloads the platform-native `bin/claude.exe` (~245MB) used
#        by `packages/runtimes` integration tests.
#   2. `pnpm -r build`
#        Builds every workspace package's `dist/`. Required because:
#          - `@moltzap/protocol`'s `exports` map points at `./dist/...` —
#            consumers cannot resolve subpaths (`/schemas`, `/testing`,
#            `/schemas/primitives`) until the dist tree exists.
#          - `@moltzap/client`'s `bin` entry points at
#            `dist/cli/index.js` — pnpm warns at install time when this is
#            missing.
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
echo "Worktree ready. node_modules populated, dist/ built, claude-code binary resolved."
