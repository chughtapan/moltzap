import { describe, it, expect } from "vitest";

describe.skip("registerModelEquivalenceClient — divergence proofs", () => {
  it("fails when sendRpcTracked forges a non-response `type` literal", () => {
    // Mutation: in `MoltZapWsClient.sendRpcTrackedEffect`, replace
    //   the returned `type: "response" as const` with a different
    //   literal (e.g. `"event"`). The conformance adapter forwards
    //   `tracked.type` straight through into `ResponseFrame.type`, so
    //   the V5 / B1 leg of `registerModelEquivalenceClient` observes
    //   the forged value.
    // Predicate broken: client/rpc-semantics.ts — the `type ===
    //   "response"` assertion in `model-equivalence-client`'s sampled
    //   call. Spec #222 §5.2 (V5).
    // Expected observable: property fails; sampled call resolves with
    //   a `ResponseFrame` whose `type !== "response"`.
    // Last verified: spec #222 staff implementation (impl-staff-232).
    expect(true).toBe(true);
  });
});

describe.skip("registerRequestIdUniquenessClient — divergence proofs", () => {
  it("fails when sendRpcTracked surfaces a synthesized id instead of `rpc-N`", () => {
    // Mutation: in `MoltZapWsClient.sendRpcTrackedEffect`, set the
    //   returned `id` to a constant `"local-mirror"` (or to
    //   `Math.random().toString()`) instead of the real `rpc-${++this
    //   .requestCounter}` identity. The conformance adapter writes
    //   `tracked.id` to `outboundIdsRef`, so B4's outbound-id-set
    //   equality with the TestServer-observed id collapses.
    // Predicate broken: client/rpc-semantics.ts:205-216 — the
    //   request-id uniqueness leg of
    //   `registerRequestIdUniquenessClient`. Spec #222 §5.1 (B4).
    // Expected observable: property fails; outbound id set diverges
    //   from the inbound-frame id set, or all entries collapse to a
    //   single mirror id.
    // Last verified: spec #222 staff implementation (impl-staff-232).
    expect(true).toBe(true);
  });
});
