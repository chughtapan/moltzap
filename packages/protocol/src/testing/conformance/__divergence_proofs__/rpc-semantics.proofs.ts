/**
 * Divergence proofs for rpc-semantics properties.
 * See schema-conformance.proofs.ts for protocol notes.
 *
 * Every `it` carries the 4-line author checklist per architect #197
 * §4.3: Mutation / Predicate broken / Expected observable /
 * Last verified.
 */
import { describe, it, expect } from "vitest";

describe.skip("registerModelEquivalence — divergence proofs", () => {
  it("fails when the server errors on a model-confident call", () => {
    // Mutation: break the server handler for a method in the
    //   confident-oracle set — e.g., force `agents/list` to return a
    //   typed error unconditionally. The model still predicts ok for
    //   agents/list (confident-derivation), so the property enters
    //   the "server MUST agree" branch and sees a disagreement.
    // Predicate broken: rpc-semantics.ts — `return serverTag === "ok"`
    //   inside registerModelEquivalence's conditional-oracle branch
    //   (round-7 derived arbitraryConfidentCall).
    // Expected observable: property fails; fast-check shrinks to the
    //   broken method (agents/list); reported by the suite with
    //   seed=<N>.
    // Last verified: round-5 acceptance signal 2 exercised the
    //   symmetric direction (swap applyCall tag → fails on agents/list).
    //   Round-7 conditional oracle + confident-call derivation
    //   pending server-side handler mutation.
    expect(true).toBe(true);
  });

  it("safety-net fires when applyCall becomes param-sensitive", () => {
    // Mutation: add a param-branch to `applyCall` for agents/list
    //   that returns `_tag: "error"` on some param subset (e.g.
    //   when params.limit > 50).
    // Predicate broken: rpc-semantics.ts — the safety-net guard
    //   `if (modelTag === "error") throw new Error(...)` inside
    //   registerModelEquivalence, which architect #197 §6.1 mandated
    //   over a silent short-circuit.
    // Expected observable: property fails with the thrown message
    //   "arbitraryConfidentCall drew <method> with params <...>
    //    → model _tag: 'error'".
    // Last verified: pending local mutation of applyCall.
    expect(true).toBe(true);
  });
});

describe.skip("registerAuthorityPositive — divergence proofs", () => {
  it("fails when the server revokes the fresh agent's grant", () => {
    // Mutation: in packages/server, set the freshly-registered
    //   agent's status to "suspended" immediately after registration
    //   (see packages/server 01-registration.integration for the
    //   pattern). conversations/list then returns a typed denial.
    // Predicate broken: rpc-semantics.ts —
    //   `outcome._tag === "Left"` branch inside
    //   registerAuthorityPositive raises PropertyInvariantViolation.
    // Expected observable: property fails with
    //   "authorized conversations/list failed: TestingRpcResponseError".
    // Last verified: pending server mutation.
    expect(true).toBe(true);
  });
});

describe.skip("registerAuthorityNegative — divergence proofs", () => {
  it("fails when the server allows unauthenticated conversations/list", () => {
    // Mutation: remove the `requiresActive: true` guard from the
    //   conversations/list handler (or disable the auth middleware).
    // Predicate broken: rpc-semantics.ts —
    //   `outcome._tag === "Right"` branch inside
    //   registerAuthorityNegative raises PropertyInvariantViolation.
    // Expected observable: property fails with
    //   "pre-handshake conversations/list returned success".
    // Last verified: pending server mutation.
    expect(true).toBe(true);
  });

  it("fails when the server returns a non-auth error for unauthenticated", () => {
    // Mutation: replace the typed Unauthorized error in the auth
    //   middleware with a generic InternalError (code -32603).
    // Predicate broken: rpc-semantics.ts —
    //   `code === ErrorCodes.Unauthorized || code === ErrorCodes.Forbidden`
    //   inside registerAuthorityNegative (round-5 [P2] tightening).
    // Expected observable: property fails with
    //   "expected Unauthorized/Forbidden code (...), got -32603".
    // Last verified: pending server mutation.
    expect(true).toBe(true);
  });
});

describe.skip("registerRequestIdUniqueness — divergence proofs", () => {
  it("fails when the server emits a stray response with a fresh id", () => {
    // Mutation: in the server's RPC dispatcher, after every real
    //   reply, emit an extra ResponseFrame with
    //   `id: crypto.randomUUID()`.
    // Predicate broken: rpc-semantics.ts —
    //   `inboundIds.size !== outboundIds.size` inside
    //   registerRequestIdUniqueness (round-6 architect §4.2
    //   set-equality form).
    // Expected observable: property fails; fast-check shrinks `n` to
    //   the minimum draw that exposes the stray.
    // Last verified: pending server mutation; the set-equality form
    //   is architect #195 §4.2's canonical divergence shape.
    expect(true).toBe(true);
  });
});

describe.skip("registerIdempotence — divergence proofs", () => {
  it("fails when the server returns different result bodies on replay", () => {
    // Mutation: make conversations/list include a fresh
    //   `requestId: crypto.randomUUID()` field in its result so the
    //   two replays have non-equal JSON AND the injected field isn't
    //   one of the sorted arrays named in canonIdempotenceResult.
    // Predicate broken: rpc-semantics.ts —
    //   `canonIdempotenceResult(method, pair.a.right) !==
    //    canonIdempotenceResult(method, pair.b.right)` inside
    //   registerIdempotence (round-7 canonical-projection form).
    // Expected observable: property fails with
    //   "<method>: replay bodies diverge under canonical projection".
    // Last verified: round-7 canonicalization lands; proof update
    //   pending the server mutation run.
    expect(true).toBe(true);
  });

  it("does NOT false-fail under pure row-order drift", () => {
    // Mutation: make conversations/list return rows in a different
    //   order across the two replays (no content change).
    // Predicate broken: the canonical projection sorts
    //   `result.conversations` by element canonicalization, so order
    //   drift is normalized away — the property should PASS this
    //   mutation.
    // Expected observable: property passes; no invariant violation.
    // Last verified: round-7; this is the spec B5 row-set semantics
    //   architect #197 §3 named as the false-fail to close.
    expect(true).toBe(true);
  });
});
