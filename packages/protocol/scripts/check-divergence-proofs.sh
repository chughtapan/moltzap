#!/usr/bin/env bash
#
# Executable divergence-proof gate.
#
# Any registrar wired into the server or client conformance suites must
# have an executable proof unless it is explicitly listed in the legacy
# exemption table below. This prevents new conformance properties from
# landing with only happy-path coverage.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROTOCOL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROOFS_DIR="$PROTOCOL_DIR/src/testing/conformance/__divergence_proofs__"
# Phase 1A reorg: server-side registrars are enumerated via the per-layer
# `index.ts` barrels (each `register*` lives in its own file and is
# re-imported by the layer index). Pre-reorg this script grepped
# `conformance/suite.ts` for `register*(ctx);` calls; that file is gone.
SERVER_LAYER_DIR="$PROTOCOL_DIR/src/testing/conformance"
SERVER_LAYERS=(transport identity network task app)
CLIENT_SUITE="$PROTOCOL_DIR/src/testing/conformance/client/suite.ts"

if [ ! -d "$PROOFS_DIR" ]; then
  echo "ERROR: $PROOFS_DIR not found" >&2
  exit 2
fi
for layer in "${SERVER_LAYERS[@]}"; do
  if [ ! -f "$SERVER_LAYER_DIR/$layer/index.ts" ]; then
    echo "ERROR: server layer barrel $SERVER_LAYER_DIR/$layer/index.ts not found" >&2
    exit 2
  fi
done
if [ ! -f "$CLIENT_SUITE" ]; then
  echo "ERROR: $CLIENT_SUITE not found" >&2
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

# Existing properties that predate the executable-proof gate. Keep this
# list small and intentional: new suite registrars should normally get a
# proof, not a new exemption.
#
# Dispatch-admission addendum (#533 row 13 cutover): the 15 properties
# below ship with executable bodies that drive a real recipient ↔
# moderator round-trip via `DispatchTestDriver`. The architect plan
# §2/§6 directs deletion of the prior tombstone-shape proof file
# (`dispatch-admission-executable.proofs.test.ts`); known-bad-server
# divergence proofs — analogous to `server-executable.proofs.test.ts` —
# are tracked in chughtapan/moltzap#535. Remove these 15 entries when
# that issue lands.
legacy_exempt_registrars=(
  registerEventWellFormedness
  registerRoundTripIdentity
  registerMalformedFrameHandling
  registerS2cRequestRoundTripIdentity
  registerS2cResponseValidation
  registerS2cMalformedRequestHandling
  registerDualDirectionIdCollision
  registerFanOutCardinality
  registerStoreAndReplay
  registerPayloadOpacity
  registerTaskBoundaryIsolation
  registerHookGatedDelivery
  registerMultiAppFifoShortCircuit
  registerLatencyResilience
  registerBackpressure
  registerSlicerFraming
  registerResetPeerRecovery
  registerTimeoutSurface
  registerSlowCloseCleanup
  registerSpuriousAppCallbackFrameHandling
  registerCallerControlledAppCallbackTimeout
  registerSchemaExhaustiveFuzz
  registerAppDisconnectFailPolicy
  registerLatencyResilienceClient
  registerSlicerFramingClient
  registerResetPeerRecoveryClient
  registerTimeoutSurfaceClient
  registerSlowCloseCleanupClient
  # #533 row 13 cutover — see addendum above.
  registerDispatchRequestAckMintsLease
  registerDispatchRequestRecipientDisconnectAbandons
  registerDispatchAuthorizeVerdictResolves
  registerDispatchAuthorizeTimeoutSynthesizesDeny
  registerDispatchReleaseFiresAfterResolve
  registerDispatchReleaseSkippedOnAbandoned
  registerDispatchesConsumedFiresOnFirstSend
  registerDispatchesConsumedSuppressedOnSecondSend
  registerDispatchesExpiredFiresOnTtl
  registerDispatchesExpiredSuppressedOnConsumeBeforeTtl
  registerDispatchesGetModeratorSeesRecord
  registerDispatchesGetNonModeratorRejected
  registerSameConversationDispatchesConcurrent
  registerSlowFirstDoesNotDelaySecondAck
  registerReleaseForOneLeaseDoesNotWaitOnAnother
)

is_legacy_exempt() {
  local registrar="$1"
  local exempt
  for exempt in "${legacy_exempt_registrars[@]}"; do
    if [ "$registrar" = "$exempt" ]; then
      return 0
    fi
  done
  return 1
}

extract_client_suite_registrars() {
  # Pre-Phase-1A shape: client/suite.ts lists `registerXxxClient(ctx);`
  # call sites. Phase 1A leaves the client suite untouched.
  local suite_file="$1"
  grep -Eo 'register[A-Za-z0-9_]+\(ctx\);' "$suite_file" \
    | sed 's/(ctx);//' \
    | grep -Ev '^registerAll(Client)?Properties$' \
    | sort -u
}

extract_layer_registrars() {
  # Phase 1A shape: each `<layer>/index.ts` barrel imports every property
  # registrar by name (`import { registerXxx } from "./xxx.js";`). Grep
  # those import lines to enumerate the layer's registrars without
  # parsing the per-property files individually.
  local layer_index="$1"
  grep -Eo '^import \{ register[A-Za-z0-9_]+ \} from' "$layer_index" \
    | sed -E 's/^import \{ (register[A-Za-z0-9_]+) \} from$/\1/' \
    | sort -u
}

mapfile -t suite_registrars < <(
  {
    for layer in "${SERVER_LAYERS[@]}"; do
      extract_layer_registrars "$SERVER_LAYER_DIR/$layer/index.ts"
    done
    extract_client_suite_registrars "$CLIENT_SUITE"
  } | sort -u
)
if [ "${#suite_registrars[@]}" -eq 0 ]; then
  echo "Divergence-proof gate: FAIL — no suite registrars discovered (extractor regression)" >&2
  exit 1
fi

missing=()
for registrar in "${suite_registrars[@]}"; do
  if is_legacy_exempt "$registrar"; then
    continue
  fi
  if ! grep -R -q "$registrar" "${executable_proofs[@]}"; then
    missing+=("$registrar")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "Divergence-proof gate: FAIL — missing executable proofs for suite registrars:" >&2
  for registrar in "${missing[@]}"; do
    echo "  - $registrar" >&2
  done
  echo "Add a proof under $PROOFS_DIR or explicitly document a legacy exemption." >&2
  exit 1
fi

proved=0
for registrar in "${suite_registrars[@]}"; do
  if ! is_legacy_exempt "$registrar"; then
    proved=$((proved + 1))
  fi
done

echo "Divergence-proof gate: OK ($proved suite registrars proof-required, ${#legacy_exempt_registrars[@]} legacy exemptions, no skipped placeholders)"
