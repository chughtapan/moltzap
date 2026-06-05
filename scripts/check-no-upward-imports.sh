#!/usr/bin/env bash
# check-no-upward-imports.sh — guard rail for Phase 3 (#544).
#
# Forbids cross-LAYER upward relative imports inside src/ trees, on the rule
# that workspace-name imports are the canonical cross-LAYER path. Cross-LAYER
# means a path crossing one of the protocol layers (transport, identity,
# network, task, app). Same-folder siblings (`./foo.js`), within-folder upward
# (`../foo.js` where the parent is the same logical group, e.g.
# `packages/X/src/cli/commands/x.ts -> ../config.js` while still inside
# `cli/`), and **same-package kernel imports** (`../db/X.js`,
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

if [[ $# -gt 0 ]]; then
  TARGETS=("$@")
else
  TARGETS=(
    packages/protocol/src
    packages/client/src
    packages/server/src
    packages/claude-code-channel/src
    packages/openclaw-channel/src
    packages/nanoclaw-channel/src
    packages/runtimes/src
  )
fi

# Imports that are upward but stay inside the same logical group, OR are
# same-package kernel imports per #542 plan-approved §3. Phase 3 §5
# NOT-in-scope. Phase 4 (#545) eslint rule will exempt the same set.
#
# Format: extended grep regex matching the FULL `from "..."` literal, anchored
# inside the string. Matched imports are subtracted from the violation list.
IGNORE_PATTERNS=(
  # #542 §3 — kernels stay relative within the package.
  # `from "../db/X.js"`, `from "../../db/X.js"`, etc.
  '"(\.\./)+db/'
  '"(\.\./)+crypto/'
  # `runtime/`, `runtime-surface/`, and `config/` directories were
  # deleted by #680 (runtime helpers folded into call sites; config
  # consolidated to `packages/server/src/config.ts`). Patterns retained
  # as a historical guard in case the directories return; remove once
  # the post-#680 layout has stabilized for several releases.
  '"(\.\./)+runtime/'
  '"(\.\./)+runtime-surface/'
  '"(\.\./)+adapters/'
  '"(\.\./)+config/'
  '"(\.\./)+test-utils/'
  '"(\.\./)+test-utils\.js"'
  '"(\.\./)+logger\.js"'
  '"(\.\./)+logger/'

  # Protocol same-package top-level files (NOT layers — siblings of
  # src/index.ts). Plan v2 §5 #1 keeps same-folder siblings relative.
  '"(\.\./)+schema-primitives\.js"'
  '"(\.\./)+rpc-registry\.js"'
  '"(\.\./)+version\.js"'
  '"(\.\./)+index\.js"'

  # Client same-package top-level files (auth, service, ws-client, etc.).
  # cli/ and test-utils/ already covered by other patterns.
  '"\.\./auth\.js"'
  '"\.\./service\.js"'
  '"\.\./ws-client\.js"'
  '"\.\./http-client\.js"'
  '"\.\./profile\.js"'
  '"\.\./channel-core\.js"'
  '"\.\./config\.js"'

  # client/cli/ within-subtree (cli/ is one group, commands/ its action layer).
  '"\.\./socket-client\.js"'
  '"\.\./transport\.js"'

  # Channel packages: __tests__/ to package siblings (one logical group
  # per plan §5 #3). Same for nanoclaw channels/ subtree.
  '"\.\./entry\.js"'
  '"\.\./types\.js"'
  '"\.\./server\.js"'
  '"\.\./routing\.js"'
  '"\.\./errors\.js"'

  # Protocol testing trees retained per §5 (within-subtree). The only
  # migrated testing tree is testing/conformance/<layer>/.
  '"(\.\./)+_shared/'
  '"(\.\./)+arbitraries/'
  '"(\.\./)+models/'
  '"(\.\./)+toxics/'
  '"(\.\./)+conformance/'
  '"(\.\./)+errors\.js"'
  '"(\.\./)+captures\.js"'
  '"(\.\./)+frame-mutator\.js"'
  '"(\.\./)+testing\.js"'
  '"(\.\./)+test-fixtures\.js"'
  '"(\.\./)+test-support\.js"'
  '"(\.\./)+client/'

  # openclaw-channel: __tests__/ to test-utils/ within same package.
  '"\.\./test-utils/'

  # Protocol source-side same-package cross-LAYER: Phase 3 retains these
  # as relative due to tsx self-reference resolution failure when
  # packages/protocol/scripts/generate-docs.ts loads source transitively (file path
  # `packages/protocol/src/<other-layer>/X.ts` importing `../<layer>/Y.js`).
  # Phase 4 (#545) eslint rule will exempt same-package cross-LAYER or land
  # a tsx workaround re-enabling source-side migration. Cross-PACKAGE
  # cross-LAYER consumers use workspace-name; that path is still enforced.
  '"\.\./(transport|identity|network|task|app)/(method|wire-errors|methods|agents|rpc-registry)\.js"'

  # Protocol-internal helpers explicitly NOT re-exported from the transport
  # barrel (per transport/index.ts JSDoc): rpc-groups decode helpers, wire.js
  # frame builders, json-rpc-server. Testing reaches them via relative path
  # by design.
  '"(\.\./)+transport/rpc-groups\.js"'
  '"(\.\./)+transport/wire\.js"'
  '"(\.\./)+transport/json-rpc-server\.js"'
)

ALL_VIOLATIONS=$(grep -rEn 'from "\.\./' "${TARGETS[@]}" --include="*.ts" 2>/dev/null || true)

if [[ -z "$ALL_VIOLATIONS" ]]; then
  echo "PASS: 0 upward relative imports across ${TARGETS[*]}"
  exit 0
fi

# Source-path filters — files in these trees are explicitly retained-relative
# per plan §5 (within-subtree, one logical group).
SOURCE_PATH_IGNORES=(
  # Protocol testing trees that stay relative (everything EXCEPT the per-
  # layer conformance subdirs, which Phase 3 already migrated).
  '^packages/protocol/src/testing/arbitraries/'
  '^packages/protocol/src/testing/toxics/'
  '^packages/protocol/src/testing/__tests__/'
  '^packages/protocol/src/testing/index\.ts:'
  '^packages/protocol/src/testing/conformance/_shared/'
  '^packages/protocol/src/testing/conformance/__divergence_proofs__/'
  '^packages/protocol/src/testing/conformance/client/'
  # Protocol source same-package layer crossings — kept relative due to
  # tsx self-reference bug. Already documented in IGNORE_PATTERNS but
  # double-cover here via source path so e.g. `*.test.ts` files in the
  # layer dir are also exempt.
  '^packages/protocol/src/(transport|identity|network|task|app)/[^/]+\.test\.ts:'
)

# Filter out source-path ignored lines first.
FILTERED="$ALL_VIOLATIONS"
for pat in "${SOURCE_PATH_IGNORES[@]}"; do
  FILTERED=$(echo "$FILTERED" | grep -vE "$pat" || true)
done

# Then filter out import-pattern matches.
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
