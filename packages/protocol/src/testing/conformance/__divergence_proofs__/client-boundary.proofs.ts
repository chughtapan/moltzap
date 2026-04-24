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

  it("fails when the real client leaks a fuzzed task-B event into task-A subscriber", () => {
    // Mutation: in the subscription filter, replace the per-task
    //   predicate with `() => true` specifically for fuzzed payloads
    //   (e.g. when `source === "fuzz"`).
    // Predicate broken: client/boundary.ts — C4-shape post-fuzz
    //   assertion leg of registerSchemaExhaustiveFuzzClient.
    // Expected observable: property fails; task-A subscriber
    //   observes tagged task-B events.
    // Last verified: pending real-client mutation.
    expect(true).toBe(true);
  });
});
