#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -eq 0 ]]; then
  echo "usage: scripts/with-tempdir.sh <command> [args...]" >&2
  exit 64
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="${MOLTZAP_TMP_ROOT:-$ROOT_DIR/.tmp}"
TMP_SCOPE="${MOLTZAP_TMP_SCOPE:-command}"
SAFE_SCOPE="$(printf '%s' "$TMP_SCOPE" | tr -c 'A-Za-z0-9_.-' '-')"

mkdir -p "$TMP_ROOT"
RUN_TMPDIR="$(mktemp -d "$TMP_ROOT/${SAFE_SCOPE}.XXXXXX")"

cleanup() {
  rm -rf "$RUN_TMPDIR"
  rmdir "$TMP_ROOT" 2>/dev/null || true
}

on_signal() {
  cleanup
  exit 130
}

trap cleanup EXIT
trap on_signal INT TERM

export TMPDIR="$RUN_TMPDIR"
"$@"
