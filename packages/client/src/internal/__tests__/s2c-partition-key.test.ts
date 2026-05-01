/**
 * Unit tests for the partition-key extractor.
 *
 * Spec: moltzap#356 §8 (test plan, file 1).
 *
 * The extractor is pure (`Either`-returning, no Effect). Tests pass
 * synthetic `PartitionableRequest` records and assert the branded key
 * value or the typed `MalformedPartitionKeyError._tag`.
 *
 * Mutation surface: every `_tag` branch + the lifecycle sentinel +
 * cross-conversation key disjointness are independently asserted so a
 * collapsing mutation flips at least one test.
 */
import { describe, it } from "vitest";

describe("extractPartitionKey — happy paths", () => {
  it.todo("apps/onBeforeDispatch with sessionId+conversationId yields a key");
  it.todo("apps/onBeforeMessageDelivery yields a key disjoint from before_dispatch for same (session, conv)");
  it.todo("apps/onJoin yields key with LIFECYCLE_CONVERSATION_SENTINEL");
  it.todo("apps/onClose yields key with LIFECYCLE_CONVERSATION_SENTINEL");
  it.todo("apps/onSessionActive yields key with LIFECYCLE_CONVERSATION_SENTINEL");
});

describe("extractPartitionKey — failure modes (each `_tag`)", () => {
  it.todo("missing params.sessionId → MalformedPartitionKeyError reason=missing-session-id");
  it.todo("missing params.conversationId on hook method → reason=missing-conversation-id");
  it.todo("unknown method name → reason=unknown-method");
  it.todo("non-object params → reason=params-shape");
});

describe("describePartitionKey — round-trip", () => {
  it.todo("describePartitionKey(extractPartitionKey(req)) preserves sessionId+conversationId+method");
});
