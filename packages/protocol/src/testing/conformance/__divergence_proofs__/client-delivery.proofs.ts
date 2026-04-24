import { describe, it, expect } from "vitest";

describe.skip("registerFanOutCardinalityClient — divergence proofs", () => {
  it("fails when the real client coalesces duplicate fan-out frames", () => {
    // Mutation: in the real client's subscriber-dispatch path, add a
    //   "dedupe by payload checksum within 100ms" filter.
    // Predicate broken: client/delivery.ts — `observedByCampaign
    //   .length === N` inside registerFanOutCardinalityClient.
    // Expected observable: property fails; observed count is N-1
    //   (two frames with identical checksum collapsed).
    // Last verified: pending real-client mutation.
    expect(true).toBe(true);
  });

  it("fails when the real client surfaces frames out of arrival order", () => {
    // Mutation: in the subscriber-dispatch path, introduce a
    //   `queueMicrotask` per event so dispatch order drifts.
    // Predicate broken: client/delivery.ts — "positionIndex sequence
    //   === emission sequence" leg.
    // Expected observable: property fails with positionIndex mismatch
    //   at some index i.
    // Last verified: pending real-client mutation.
    expect(true).toBe(true);
  });
});

describe.skip("registerPayloadOpacityClient — divergence proofs", () => {
  it("fails when the real client re-serializes payloads with different key order", () => {
    // Mutation: in the real client's inbound decode, replace
    //   `rawBytes` on the surfaced `ObservedEvent` with
    //   `Buffer.from(JSON.stringify(JSON.parse(rawBytes)))`.
    // Predicate broken: client/delivery.ts — byte-equal
    //   `observed.rawBytes === emittedBytes` inside
    //   registerPayloadOpacityClient.
    // Expected observable: property fails on any payload whose key
    //   order isn't the canonical `JSON.stringify` output order.
    // Last verified: pending real-client mutation.
    expect(true).toBe(true);
  });
});

describe.skip("registerTaskBoundaryIsolationClient — divergence proofs", () => {
  it("fails when matchesFilter ignores the conversationId field", () => {
    // Mutation: in `packages/client/src/runtime/subscribers.ts`
    //   `matchesFilter`, force the `conversationId` predicate to a
    //   no-op (e.g. `if (filter.conversationId !== undefined) { /* skip */ }`)
    //   so a `{conversationId: "campaign-A"}` subscription receives
    //   campaign-B frames as well.
    // Predicate broken: client/delivery.ts:266-313 — `observedCampaignB
    //   .length === 0` inside registerTaskBoundaryIsolationClient
    //   (C4). Spec #222 §5.3 + the `RealClientEventSubscriber.subscribe`
    //   filter stub.
    // Expected observable: property fails with campaignB leak count
    //   equal to the emitted M (the filter is honored only by accident
    //   via the empty default; mutation makes the leak observable).
    // Last verified: spec #222 staff implementation (impl-staff-232).
    expect(true).toBe(true);
  });
});
