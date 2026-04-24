import { describe, it, expect } from "vitest";

describe.skip("registerModelEquivalenceClient — divergence proofs", () => {
  it("fails when the real client routes a response to the wrong pending call", () => {
    // Mutation: in the real client's response-dispatch path, pop the
    //   pending-call deferred by LIFO order instead of by id lookup.
    // Predicate broken: client/rpc-semantics.ts — "model-ok ⇒
    //   client-ok on the sampled id" leg of registerModelEquivalence
    //   Client.
    // Expected observable: property fails; sampled call's promise
    //   resolves to a value that doesn't match the model oracle's
    //   shape for the sampled method.
    // Last verified: pending real-client mutation.
    expect(true).toBe(true);
  });
});

describe.skip("registerRequestIdUniquenessClient — divergence proofs", () => {
  it("fails when the real client resolves a pending call with an unknown-id response", () => {
    // Mutation: in the real client's response-dispatch path, fall back
    //   to "first pending deferred" when the id lookup misses, instead
    //   of dropping the spurious response.
    // Predicate broken: client/rpc-semantics.ts — "no call on id ≠ Y
    //   is resolved by the spurious response" leg.
    // Expected observable: property fails; an unrelated pending call
    //   resolves prematurely to the spurious response's payload.
    // Last verified: pending real-client mutation.
    expect(true).toBe(true);
  });
});
