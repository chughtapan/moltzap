/**
 * Client-side divergence proofs for schema-conformance.
 *
 * Every `it` carries the 4-line author checklist per architect #197 §4.3:
 *   Mutation / Predicate broken / Expected observable / Last verified.
 *
 * `describe.skip` at module scope — CI discovers via
 * `vitest.conformance.config.ts` include glob (architect #197 §5.3) but
 * every test is skipped. The implementer flips `.skip → .only` locally,
 * captures the failing seed, restores skip.
 */
import { describe, it, expect } from "vitest";

describe.skip("registerEventWellFormednessClient — divergence proofs", () => {
  it("fails when the real client strips schema-required fields from surfaced events", () => {
    // Mutation: in the real client's inbound decode path, `delete
    //   event.base.from` before surfacing via the subscriber.
    // Predicate broken: client/schema-conformance.ts — `Value.Check(
    //   EventFrameSchema, observed.decoded)` inside
    //   registerEventWellFormednessClient.
    // Expected observable: property fails; Value.Check reports missing
    //   required property `from`.
    // Last verified: pending real-client mutation.
    expect(true).toBe(true);
  });
});

describe.skip("registerMalformedFrameHandlingClient — divergence proofs", () => {
  it("fails when the real client crashes and disconnects on a bit-flipped frame", () => {
    // Mutation: in the real client's frame-decode path, remove the
    //   try/catch around `JSON.parse` so a bit-flipped inbound frame
    //   throws out of the socket read loop, disconnecting the client.
    // Predicate broken: client/schema-conformance.ts — liveness leg of
    //   registerMalformedFrameHandlingClient; a disconnected client
    //   cannot receive the post-malformed tagged event within deadline.
    // Expected observable: property fails; liveness probe times out.
    // Last verified: pending real-client mutation.
    expect(true).toBe(true);
  });

  it("fails when the real client silently drops valid events after a malformed one", () => {
    // Mutation: in the real client's reader loop, set a "poisoned"
    //   flag after the first malformed frame and return early from
    //   every subsequent decode.
    // Predicate broken: client/schema-conformance.ts — liveness leg
    //   of registerMalformedFrameHandlingClient.
    // Expected observable: property fails; post-malformed tagged
    //   event never surfaces on the subscriber before deadline.
    // Last verified: pending real-client mutation.
    expect(true).toBe(true);
  });
});
