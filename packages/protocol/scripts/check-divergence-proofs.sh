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
SERVER_SUITE="$PROTOCOL_DIR/src/testing/conformance/suite.ts"
CLIENT_SUITE="$PROTOCOL_DIR/src/testing/conformance/client/suite.ts"

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

extract_suite_registrars() {
  local suite_file="$1"
  grep -Eo 'register[A-Za-z0-9_]+\(ctx\);' "$suite_file" \
    | sed 's/(ctx);//' \
    | grep -Ev '^registerAll(Client)?Properties$' \
    | sort -u
}

mapfile -t suite_registrars < <(
  {
    extract_suite_registrars "$SERVER_SUITE"
    extract_suite_registrars "$CLIENT_SUITE"
  } | sort -u
)

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
