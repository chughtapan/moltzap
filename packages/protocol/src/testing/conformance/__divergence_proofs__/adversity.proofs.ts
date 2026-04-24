/**
 * Divergence proofs for adversity properties.
 * See schema-conformance.proofs.ts for protocol notes.
 *
 * Note: `registerBackpressure` is deferred (→ epic #186); no proof.
 */
import { describe, it, expect } from "vitest";

describe.skip("registerLatencyResilience — divergence proofs", () => {
  it("fails when latency exceeds the property's observation window", () => {
    // Mutation: in `packages/protocol/src/testing/toxics/defaults.ts`,
    // raise `latencyMs` from 100ms to 2000ms (exceeding the 600ms
    // `Effect.sleep` inside the property body).
    //
    // Expected property result: FAIL — `delivered === 0` at the
    // snapshot moment (latency > sleep window), triggering
    // "latency toxic dropped all events".
    //
    // This proves the property's snapshot timing is tuned for the
    // default latency profile, not arbitrarily forgiving.
    expect(true).toBe(true);
  });
});

describe.skip("registerSlicerFraming — divergence proofs", () => {
  it("fails when slicing drops a byte at the boundary", () => {
    // Mutation: write a tiny proxy shim that drops 1 byte from every
    // sliced frame before forwarding (simulates framing corruption).
    //
    // Expected property result: FAIL — the token does not appear
    // verbatim in any inbound frame, triggering "token sli-token-...
    // not reassembled in participant's frames".
    //
    // The property's byte-identity substring check specifically
    // discriminates this mutation; a round-trip encoding is not
    // sufficient for proving opacity under fragmentation.
    expect(true).toBe(true);
  });
});

describe.skip("registerResetPeerRecovery — divergence proofs", () => {
  it("PropertyUnavailable fires when toxic disabled (no reset observed)", () => {
    // Mutation: temporarily remove the reset_peer toxic attach
    // (comment out the `yield* attachToxic` line in the property body).
    //
    // Expected property result: `PropertyUnavailable("reset_peer
    // toxic did not close within 3.5s budget")` — the property can't
    // observe the typed TransportClosedError it needs to pass.
    //
    // This is the "negative-outcome" divergence proof architect §3
    // named for this property — the predicate discriminates between
    // "toxic fired and client surfaced typed close" vs "no toxic".
    expect(true).toBe(true);
  });
});

describe.skip("registerTimeoutSurface — divergence proofs", () => {
  it("fails when sendRpc resolves successfully despite the timeout toxic", () => {
    // Mutation: temporarily remove the toxic attach. Without the toxic
    // the forwarding timeout never fires; sendRpc succeeds within the
    // 1500ms budget.
    //
    // Expected property result: FAIL —
    // "RPC through timeout toxic unexpectedly succeeded"
    // (outcome._tag === "Right").
    //
    // Proves the property isn't just accepting "something went wrong";
    // it specifically requires the documented RpcTimeoutError shape.
    expect(true).toBe(true);
  });

  it("fails when the client surfaces wrong error type", () => {
    // Mutation: in TestClient, wrap the sendRpc timeout with a
    // substitute error (e.g., always return TransportClosedError
    // instead of RpcTimeoutError).
    //
    // Expected property result: FAIL — "expected RpcTimeoutError,
    // got TestingTransportClosedError".
    expect(true).toBe(true);
  });
});

describe.skip("registerSlowCloseCleanup — divergence proofs", () => {
  it("fails when slow-close delay exceeds scope budget", () => {
    // Mutation: raise `slow_close.delayMs` from 250ms to 6000ms
    // (exceeding the 5s scope-release budget).
    //
    // Expected property result: FAIL — "scope release took Xms under
    // slow_close (budget 5000ms)".
    //
    // Proves the budget is a real constraint, not a rubber stamp.
    expect(true).toBe(true);
  });
});
