#!/usr/bin/env bash
#
# Divergence-proof gate — asserts every `export function register<Name>`
# in packages/protocol/src/testing/conformance/*.ts has a matching
# `describe.skip("register<Name>"` in
# packages/protocol/src/testing/conformance/__divergence_proofs__/
# <category>.proofs.ts.
#
# Usage: run from repo root. Exit 1 with a list of missing registrars.
# Wired into the consumer's `test:conformance` npm script as a
# pre-step so CI fails loudly if a new property ships without a proof.
#
# Per architect #195 §5.3: ~30 LOC of grep + comm. No dep.

set -euo pipefail

# Resolve paths relative to the script itself so the gate works from
# any CWD (repo root, packages/server, packages/protocol, CI runner).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROTOCOL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFORMANCE_DIR="$PROTOCOL_DIR/src/testing/conformance"
PROOFS_DIR="$CONFORMANCE_DIR/__divergence_proofs__"

if [ ! -d "$CONFORMANCE_DIR" ]; then
  echo "ERROR: $CONFORMANCE_DIR not found — run from repo root" >&2
  exit 2
fi

if [ ! -d "$PROOFS_DIR" ]; then
  echo "ERROR: $PROOFS_DIR not found — create it before adding properties" >&2
  exit 2
fi

missing=()
tombstones=()

# Iterate each conformance module (except the registry/runner/suite/index
# scaffolding).
for category_file in \
  "$CONFORMANCE_DIR/schema-conformance.ts" \
  "$CONFORMANCE_DIR/rpc-semantics.ts" \
  "$CONFORMANCE_DIR/delivery.ts" \
  "$CONFORMANCE_DIR/adversity.ts" \
  "$CONFORMANCE_DIR/boundary.ts"; do

  if [ ! -f "$category_file" ]; then
    echo "ERROR: expected conformance file $category_file missing" >&2
    exit 2
  fi

  category=$(basename "$category_file" .ts)
  proof_file="$PROOFS_DIR/${category}.proofs.ts"

  if [ ! -f "$proof_file" ]; then
    echo "ERROR: missing proof file for $category: $proof_file" >&2
    exit 1
  fi

  # Extract registrar names: `export function register<Name>(`.
  registrars=$(grep -oE 'export function (register[A-Za-z0-9_]+)\b' "$category_file" | awk '{print $3}')

  for registrar in $registrars; do
    # Backpressure tombstone is architect-approved as deferred (→ #186);
    # no proof required.
    if [ "$registrar" = "registerBackpressure" ]; then
      tombstones+=("$registrar")
      continue
    fi
    if ! grep -qE "describe\.skip\(['\"]${registrar}\b" "$proof_file"; then
      missing+=("${category}.ts::${registrar} (expected describe.skip(\"${registrar}\") in ${category}.proofs.ts)")
    fi
  done
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "Divergence-proof gate: FAIL — missing proofs for:" >&2
  for m in "${missing[@]}"; do
    echo "  - $m" >&2
  done
  echo "" >&2
  echo "Each property in conformance/*.ts must have a matching" >&2
  echo "describe.skip(\"<registrar>\") in __divergence_proofs__/<category>.proofs.ts." >&2
  echo "See architect #195 §5 for the proof shape." >&2
  exit 1
fi

echo "Divergence-proof gate: OK (${#tombstones[@]} tombstoned, all live registrars have proofs)"
