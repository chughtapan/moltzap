#!/usr/bin/env bash
# check-no-upward-imports.sh — guard rail for Phase 3 (#544).
#
# Forbids cross-LAYER upward relative imports inside src/ trees, on the rule
# that workspace-name imports are the canonical cross-LAYER path. Cross-LAYER
# means a path crossing one of the protocol layers (transport, identity,
# network, task, app). Same-folder siblings (`./foo.js`), within-folder upward
# (`../foo.js` where the parent is the same logical group, e.g.
# `packages/X/src/cli/commands/x.ts -> ../config.js` while still inside
# `cli/`), and **same-package kernel imports** (`../db/X.js`, `../crypto/X.js`,
# etc.) are out of scope per parent epic #538 §Phase 3, #544 plan v2 §5, and
# #542 plan-approved §3 ("Kernels do not get subpath exports; they're imported
# relatively.").
#
# This script is INFORMATIONAL — it prints offending sites and exits non-zero
# when any are found. Phase 4 (#545) lands the eslint hard-fail rule
# (no-restricted-imports patterns targeting cross-LAYER `../*`) once Phase 3
# has zeroed the count. Until then this script is the budget receipt.
#
# Scope: every package's src/ tree minus same-package sibling imports we
# explicitly retain (kernels + within-subtree upward). The retained sites are
# listed in `IGNORE_PATTERNS` below and shrink toward zero over Phase 3's
# commits.
#
# Usage:
#   bash scripts/check-no-upward-imports.sh                # all packages
#   bash scripts/check-no-upward-imports.sh packages/server # one package
#
# Exits 0 when no cross-LAYER upward imports outside the ignore list.
# Exits 1 when violations remain.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TARGETS=("${@:-packages/protocol/src packages/client/src packages/server/src \
  packages/claude-code-channel/src packages/openclaw-channel/src \
  packages/nanoclaw-channel/src packages/runtimes/src}")

# Imports that are upward but stay inside the same logical group, OR are
# same-package kernel imports per #542 plan-approved §3. Phase 3 §5
# NOT-in-scope. Phase 4 (#545) eslint rule will exempt the same set.
#
# Format: extended grep regex matching the FULL `from "..."` literal, anchored
# inside the string. Matched imports are subtracted from the violation list.
IGNORE_PATTERNS=(
  # ── #542 §3: kernels stay relative within the package ─────────────────
  # `from "../db/X.js"`, `from "../../db/X.js"`, etc.
  '"(\.\./)+db/'
  '"(\.\./)+crypto/'
  '"(\.\./)+runtime/'
  '"(\.\./)+runtime-surface/'
  '"(\.\./)+adapters/'
  '"(\.\./)+config/'
  '"(\.\./)+test-utils/'
  '"(\.\./)+test-utils\.js"'
  '"(\.\./)+logger\.js"'
  '"(\.\./)+logger/'
  # ── client/cli/ within-subtree (cli/ is one group; commands/ is child) ─
  '"\.\./socket-client\.js"'
  '"\.\./transport\.js"'
)

ALL_VIOLATIONS=$(grep -rEn 'from "\.\./' $TARGETS --include="*.ts" 2>/dev/null || true)

if [[ -z "$ALL_VIOLATIONS" ]]; then
  echo "PASS: 0 upward relative imports across $TARGETS"
  exit 0
fi

# Filter out ignore-list matches.
FILTERED="$ALL_VIOLATIONS"
for pat in "${IGNORE_PATTERNS[@]}"; do
  FILTERED=$(echo "$FILTERED" | grep -vE "$pat" || true)
done

if [[ -z "$FILTERED" ]]; then
  echo "PASS: $(echo "$ALL_VIOLATIONS" | wc -l) upward imports — all ignored per IGNORE_PATTERNS"
  exit 0
fi

COUNT=$(echo "$FILTERED" | wc -l)
echo "FAIL: $COUNT cross-LAYER upward relative imports remain (Phase 3 #544 budget)"
echo ""
echo "Per-package counts:"
for pkg in protocol client server claude-code-channel openclaw-channel nanoclaw-channel runtimes; do
  c=$(echo "$FILTERED" | grep -c "^packages/$pkg/" || true)
  printf "  %-25s %s\n" "$pkg" "$c"
done
echo ""
echo "First 30 offenders:"
echo "$FILTERED" | head -30
echo ""
echo "Use workspace-name imports (e.g. @moltzap/protocol/transport) for cross-LAYER imports."
echo "Same-folder siblings (./foo.js) stay relative."
echo "Same-package kernel imports (../db/X.js etc.) stay relative per #542 §3."
exit 1
