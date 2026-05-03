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
import { describe, it, expect } from "vitest";
import { Either } from "effect";
import { s2cRpcMethods } from "@moltzap/protocol";
import {
  describePartitionKey,
  extractPartitionKey,
  LIFECYCLE_CONVERSATION_SENTINEL,
  type PartitionableRequest,
} from "../s2c-partition-key.js";

import {
  AppsOnBeforeDispatch,
  AppsOnBeforeMessageDelivery,
  AppsOnClose,
  AppsOnJoin,
  AppsOnSessionActive,
} from "@moltzap/protocol";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const CONV_X = "conv-X";
const CONV_Y = "conv-Y";

function reqOnBeforeDispatch(
  overrides: Partial<{ sessionId: unknown; conversationId: unknown }> = {},
): PartitionableRequest {
  return {
    id: "rpc-1",
    method: AppsOnBeforeDispatch.name,
    params: {
      sessionId: SESSION_A,
      conversationId: CONV_X,
      ...overrides,
    },
  };
}

function reqOnBeforeMessageDelivery(): PartitionableRequest {
  return {
    id: "rpc-2",
    method: AppsOnBeforeMessageDelivery.name,
    params: { sessionId: SESSION_A, conversationId: CONV_X },
  };
}

function reqLifecycle(method: string): PartitionableRequest {
  return {
    id: "rpc-3",
    method,
    params: { sessionId: SESSION_A },
  };
}

describe("extractPartitionKey — happy paths", () => {
  it("apps/onBeforeDispatch with sessionId+conversationId yields a key", () => {
    const result = extractPartitionKey(reqOnBeforeDispatch());
    expect(Either.isRight(result)).toBe(true);
  });

  it("apps/onBeforeMessageDelivery yields a key disjoint from before_dispatch for same (session, conv)", () => {
    const a = extractPartitionKey(reqOnBeforeDispatch());
    const b = extractPartitionKey(reqOnBeforeMessageDelivery());
    expect(Either.isRight(a) && Either.isRight(b)).toBe(true);
    if (Either.isRight(a) && Either.isRight(b)) {
      // Different keys is the load-bearing invariant — same (S, C) but
      // different hookKind partitions onto independent fibers.
      expect(a.right).not.toBe(b.right);
    }
  });

  it("apps/onJoin yields key with LIFECYCLE_CONVERSATION_SENTINEL", () => {
    const result = extractPartitionKey(reqLifecycle(AppsOnJoin.name));
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      const parts = describePartitionKey(result.right);
      expect(parts.conversationId).toBe(LIFECYCLE_CONVERSATION_SENTINEL);
      expect(parts.method).toBe(AppsOnJoin.name);
    }
  });

  it("apps/onClose yields key with LIFECYCLE_CONVERSATION_SENTINEL", () => {
    const result = extractPartitionKey(reqLifecycle(AppsOnClose.name));
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      const parts = describePartitionKey(result.right);
      expect(parts.conversationId).toBe(LIFECYCLE_CONVERSATION_SENTINEL);
      expect(parts.method).toBe(AppsOnClose.name);
    }
  });

  it("apps/onSessionActive yields key with LIFECYCLE_CONVERSATION_SENTINEL", () => {
    const result = extractPartitionKey(reqLifecycle(AppsOnSessionActive.name));
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      const parts = describePartitionKey(result.right);
      expect(parts.conversationId).toBe(LIFECYCLE_CONVERSATION_SENTINEL);
      expect(parts.method).toBe(AppsOnSessionActive.name);
    }
  });

  it("distinct sessions yield distinct keys for the same method+conv", () => {
    const a = extractPartitionKey(reqOnBeforeDispatch());
    const b = extractPartitionKey({
      id: "rpc-99",
      method: AppsOnBeforeDispatch.name,
      params: { sessionId: SESSION_B, conversationId: CONV_X },
    });
    expect(Either.isRight(a) && Either.isRight(b)).toBe(true);
    if (Either.isRight(a) && Either.isRight(b)) {
      expect(a.right).not.toBe(b.right);
    }
  });

  it("distinct conversations yield distinct keys for the same method+session", () => {
    const a = extractPartitionKey(reqOnBeforeDispatch());
    const b = extractPartitionKey({
      id: "rpc-99",
      method: AppsOnBeforeDispatch.name,
      params: { sessionId: SESSION_A, conversationId: CONV_Y },
    });
    expect(Either.isRight(a) && Either.isRight(b)).toBe(true);
    if (Either.isRight(a) && Either.isRight(b)) {
      expect(a.right).not.toBe(b.right);
    }
  });
});

describe("extractPartitionKey — failure modes (each `_tag`)", () => {
  it("missing params.sessionId → MalformedPartitionKeyError reason=missing-session-id", () => {
    const result = extractPartitionKey(
      reqOnBeforeDispatch({ sessionId: undefined }),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("MalformedPartitionKeyError");
      expect(result.left.reason).toBe("missing-session-id");
    }
  });

  it("missing params.conversationId on hook method → reason=missing-conversation-id", () => {
    const result = extractPartitionKey(
      reqOnBeforeDispatch({ conversationId: undefined }),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.reason).toBe("missing-conversation-id");
    }
  });

  it("unknown method name → reason=unknown-method", () => {
    const result = extractPartitionKey({
      id: "rpc-x",
      method: "apps/notARealMethod",
      params: { sessionId: SESSION_A },
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.reason).toBe("unknown-method");
    }
  });

  it("non-object params → reason=params-shape", () => {
    const result = extractPartitionKey({
      id: "rpc-y",
      method: AppsOnBeforeDispatch.name,
      params: "not-an-object",
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.reason).toBe("params-shape");
    }
  });

  it("array params → reason=params-shape", () => {
    const result = extractPartitionKey({
      id: "rpc-z",
      method: AppsOnBeforeDispatch.name,
      params: [SESSION_A, CONV_X],
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.reason).toBe("params-shape");
    }
  });

  it("empty-string sessionId → reason=missing-session-id", () => {
    const result = extractPartitionKey(reqOnBeforeDispatch({ sessionId: "" }));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.reason).toBe("missing-session-id");
    }
  });
});

describe("extractPartitionKey — schema drift guard against `@moltzap/protocol`", () => {
  // Architect plan §3.2 documented the "literal Set, not derived from
  // s2cRpcMethods" choice as a deliberate cycle-avoidance trade. This
  // test is the counter-measure: every wire method the protocol
  // declares must be partitionable. Adding a new entry to
  // `s2cRpcMethods` without updating `LIFECYCLE_METHODS` or
  // `CONVERSATION_BEARING_METHODS` in `s2c-partition-key.ts` compiles
  // cleanly today; this test fails until the routing layer catches up.
  it("every method in s2cRpcMethods is recognised by extractPartitionKey", () => {
    const synthesise = (method: string): PartitionableRequest => ({
      id: "rpc-drift",
      method,
      // Provide both routing fields so the only failure mode under
      // test is `unknown-method`, not missing-session-id /
      // missing-conversation-id / params-shape.
      params: { sessionId: SESSION_A, conversationId: CONV_X },
    });
    const offenders: Array<{ method: string; reason: string }> = [];
    for (const def of s2cRpcMethods) {
      const result = extractPartitionKey(synthesise(def.name));
      if (Either.isLeft(result)) {
        offenders.push({ method: def.name, reason: result.left.reason });
      }
    }
    if (offenders.length > 0) {
      expect.fail(
        `s2c partition extractor rejects ${offenders.length} method(s) declared in @moltzap/protocol's s2cRpcMethods:\n` +
          offenders
            .map((o) => `  - ${o.method} (reason=${o.reason})`)
            .join("\n") +
          `\nUpdate LIFECYCLE_METHODS or CONVERSATION_BEARING_METHODS in ` +
          `packages/client/src/internal/s2c-partition-key.ts so the ` +
          `union covers every entry of s2cRpcMethods.`,
      );
    }
  });
});

describe("describePartitionKey — round-trip", () => {
  it("describePartitionKey(extractPartitionKey(req)) preserves sessionId+conversationId+method", () => {
    const req = reqOnBeforeDispatch();
    const key = extractPartitionKey(req);
    expect(Either.isRight(key)).toBe(true);
    if (Either.isRight(key)) {
      const parts = describePartitionKey(key.right);
      expect(parts.sessionId).toBe(SESSION_A);
      expect(parts.conversationId).toBe(CONV_X);
      expect(parts.method).toBe(AppsOnBeforeDispatch.name);
    }
  });

  it("preserves the lifecycle sentinel for lifecycle methods", () => {
    const req = reqLifecycle(AppsOnSessionActive.name);
    const key = extractPartitionKey(req);
    expect(Either.isRight(key)).toBe(true);
    if (Either.isRight(key)) {
      const parts = describePartitionKey(key.right);
      expect(parts.sessionId).toBe(SESSION_A);
      expect(parts.conversationId).toBe(LIFECYCLE_CONVERSATION_SENTINEL);
      expect(parts.method).toBe(AppsOnSessionActive.name);
    }
  });
});
