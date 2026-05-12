#!/usr/bin/env bash
# List every wall-clock sleep / setTimeout site in test-classified code
# under the repo. Used by issue #591 to scope the WS-timing-race
# remediation: each site is either (a) replaced by an Effect-native
# cleanup signal helper, (b) replaced by an existing positive synch
# primitive (waitForNotification, awaitAgentReady), or (c) kept with
# a comment naming why (e.g., toxiproxy probe interval, jittered
# backoff test).
#
# Run from repo root: `bash scripts/audit-test-sleeps.sh`
#
# Output is grouped by file and prefixed with line:column; the
# implement-senior dispatched against this audit walks file-by-file
# and decides per call-site.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

PATTERNS=(
  'Effect\.sleep'
  'Effect\.delay'
  'setTimeout'
  'CLOSE_DRAIN_MS'
  'FRAME_SETTLE_MS'
  'SHUTDOWN_DRAIN_MS'
  'PGLITE_BOOT_DELAY_MS'
  'DRAIN_WINDOW_MS'
)

# Scope: any path containing __tests__, .test.ts, .proofs.test.ts,
# /testing/, /test-utils/, or /conformance/ in packages/.
SCOPE_GLOBS=(
  'packages/*/src/__tests__'
  'packages/*/src/**/*.test.ts'
  'packages/*/src/test-utils'
  'packages/protocol/src/testing'
)

PATTERN_RE="$(IFS='|'; echo "${PATTERNS[*]}")"

# Use git ls-files so we only audit tracked files.
mapfile -t FILES < <(
  git ls-files 'packages/*' \
    | grep -E '(/__tests__/|\.test\.ts$|/test-utils/|/testing/)' \
    | grep -E '\.ts$'
)

total=0
for f in "${FILES[@]}"; do
  hits=$(grep -nE "$PATTERN_RE" "$f" 2>/dev/null || true)
  if [[ -n "$hits" ]]; then
    echo "=== $f ==="
    echo "$hits"
    echo
    count=$(echo "$hits" | wc -l)
    total=$((total + count))
  fi
done

echo "audit-test-sleeps: $total call sites across $(printf '%s\n' "${FILES[@]}" | wc -l) test files"
