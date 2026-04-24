import { describe, it, expect } from "vitest";

describe.skip("registerSchemaExhaustiveFuzzClient — divergence proofs", () => {
  it("fails when the real client crashes on an arbitrary event-type payload", () => {
    // Mutation: in a specific event-type handler (e.g. `presence/
    //   changed`), cast params through `JSON.parse(... as string)`
    //   with no try/catch so an arbitrary-shape payload throws.
    // Predicate broken: client/boundary.ts — "no crash" leg of
    //   registerSchemaExhaustiveFuzzClient (observable via
    //   `closeSignal` firing unexpectedly during the fuzz burst).
    // Expected observable: property fails; closeSignal resolves mid-
    //   burst; post-fuzz liveness probe never surfaces.
    // Last verified: pending real-client mutation.
    expect(true).toBe(true);
  });

  it("fails when the real client drops all events after a fuzz burst", () => {
    // Mutation: in the real client's inbound handler, after receiving any
    //   frame with an arbitrary-shape payload, set a "fuzz-poisoned" flag
    //   and silently drop all subsequent frames including the liveness probe.
    // Predicate broken: client/boundary.ts — liveness probe leg of
    //   registerSchemaExhaustiveFuzzClient (observed.length === 0 check).
    // Expected observable: property fails; post-fuzz tagged event never
    //   surfaces on the subscriber before the budget expires.
    // Last verified: pending real-client mutation.
    expect(true).toBe(true);
  });
});
