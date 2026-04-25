#!/usr/bin/env bash
#
# Executable divergence-proof gate.
#
# The old gate accepted `describe.skip(...)` comment placeholders. That
# made CI report skipped tests instead of proving the properties reject
# bad implementations. This gate now requires real Vitest proof files and
# fails if any skipped divergence-proof placeholder comes back.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROTOCOL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROOFS_DIR="$PROTOCOL_DIR/src/testing/conformance/__divergence_proofs__"

if [ ! -d "$PROOFS_DIR" ]; then
  echo "ERROR: $PROOFS_DIR not found" >&2
  exit 2
fi

mapfile -t executable_proofs < <(find "$PROOFS_DIR" -maxdepth 1 -name '*-executable.proofs.test.ts' | sort)
if [ "${#executable_proofs[@]}" -eq 0 ]; then
  echo "Divergence-proof gate: FAIL — no executable proof tests found" >&2
  exit 1
fi

if grep -R --line-number -E 'describe\.skip|it\.skip|test\.skip' "$PROOFS_DIR"; then
  echo "Divergence-proof gate: FAIL — skipped divergence proofs are not allowed" >&2
  exit 1
fi

required_registrars=(
  registerEventWellFormednessClient
  registerMalformedFrameHandlingClient
  registerFanOutCardinalityClient
  registerPayloadOpacityClient
  registerTaskBoundaryIsolationClient
  registerSchemaExhaustiveFuzzClient
  registerModelEquivalenceClient
  registerRequestIdUniquenessClient
  registerRequestWellFormedness
  registerRpcMapCoverage
  registerAuthorityNegative
  registerAuthorityPositive
  registerModelEquivalence
  registerRequestIdUniqueness
  registerIdempotence
)

missing=()
for registrar in "${required_registrars[@]}"; do
  if ! grep -R -q "$registrar" "${executable_proofs[@]}"; then
    missing+=("$registrar")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "Divergence-proof gate: FAIL — missing executable proofs for:" >&2
  for registrar in "${missing[@]}"; do
    echo "  - $registrar" >&2
  done
  exit 1
fi

echo "Divergence-proof gate: OK (${#required_registrars[@]} executable proof cases, no skipped placeholders)"
