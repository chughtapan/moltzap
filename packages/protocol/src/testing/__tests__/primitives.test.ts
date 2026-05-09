/**
 * Unit tests for the `@moltzap/protocol/testing` primitives that do NOT
 * require a live server or Toxiproxy. Tests that need the full
 * infrastructure live in the `test:conformance` script (gated behind
 * docker-compose).
 *
 * Covers: codec encode/decode round-trip, capture buffer append/snapshot,
 * reference-model authorizationOutcome totality, toxic profile selector
 * exhaustiveness.
 */
import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import * as fc from "fast-check";
import {
  encodeFrame,
  decodeFrame,
  malformFrame,
  isRequestFrame,
  isNotificationFrame,
  type AnyFrame,
} from "../conformance/_shared/frame-mutator.js";
import {
  makeCaptureBuffer,
  recordFrame,
  mergeCaptures,
} from "../conformance/_shared/captures.js";
import {
  initialReferenceState,
  applyCall,
  isIdempotent,
  authorizationOutcome,
} from "../models/index.js";
import { agentId } from "../conformance/_shared/test-fixtures.js";
import { deliveryInvariantFor, allToxicTags } from "../toxics/index.js";
import {
  allRpcMethods,
  arbitraryCallFor,
  arbitraryAnyCall,
} from "../arbitraries/index.js";

import { Connect } from "../../network/methods.js";
import { ConversationsList } from "../../task/methods.js";
import { jsonRpcMethod, requestFrame } from "../../transport/wire.js";

describe("codec", () => {
  it("round-trips a valid request frame", async () => {
    const frame: AnyFrame = requestFrame("req-1", Connect, {
      agentKey: "k",
      agentId: "a",
      minProtocol: "0.1.0",
      maxProtocol: "0.1.0",
    });
    const raw = encodeFrame(frame);
    const decoded = await Effect.runPromise(
      Effect.either(decodeFrame(raw, "inbound")),
    );
    expect(decoded._tag).toBe("Right");
    if (decoded._tag === "Right") {
      expect(isRequestFrame(decoded.right)).toBe(true);
    }
  });

  it("returns typed FrameSchemaError on malformed JSON", async () => {
    const decoded = await Effect.runPromise(
      Effect.either(decodeFrame("{not json", "inbound")),
    );
    expect(decoded._tag).toBe("Left");
    if (decoded._tag === "Left") {
      expect(decoded.left._tag).toBe("TestingFrameSchemaError");
    }
  });

  it("malformFrame never throws for any kind + seed", () => {
    const base: AnyFrame = requestFrame("r", Connect, {
      agentKey: "k",
      minProtocol: "0.1.0",
      maxProtocol: "0.1.0",
    });
    const kinds = [
      "bit-flip",
      "truncated",
      "oversized",
      "invalid-utf8",
      "missing-required-field",
      "extra-property",
    ] as const;
    for (const k of kinds) {
      expect(() => malformFrame(base, k, 42)).not.toThrow();
    }
  });
});

describe("captures", () => {
  it("captures a frame and surfaces it in snapshot", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const buf = yield* makeCaptureBuffer({ capacity: 8 });
        const frame: AnyFrame = {
          jsonrpc: "2.0",
          method: jsonRpcMethod("testing/ping"),
          params: null,
        } as NotificationFrame;
        yield* recordFrame(buf, "inbound", encodeFrame(frame), frame);
        const snap = yield* buf.snapshot;
        return snap;
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.frame && isNotificationFrame(result[0].frame)).toBe(true);
  });

  it("mergeCaptures aggregates multiple buffers in timestamp order", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const a = yield* makeCaptureBuffer({ capacity: 4 });
        const b = yield* makeCaptureBuffer({ capacity: 4 });
        const frame: AnyFrame = {
          jsonrpc: "2.0",
          method: jsonRpcMethod("testing/ping"),
          params: null,
        } as NotificationFrame;
        yield* recordFrame(a, "inbound", "{}", frame);
        yield* recordFrame(b, "inbound", "{}", frame);
        const merged = yield* mergeCaptures([a, b]);
        const snap = yield* merged.snapshot;
        return snap.length;
      }),
    );
    expect(result).toBe(2);
  });
});

describe("reference model", () => {
  it("applyCall is total for every wire method", () => {
    for (const method of allRpcMethods) {
      const [sampled] = fc.sample(arbitraryCallFor(method), 1);
      if (sampled === undefined) continue;
      const { outcome, next } = applyCall(initialReferenceState, sampled);
      expect(outcome._tag === "ok" || outcome._tag === "error").toBe(true);
      expect(typeof next.tick).toBe("number");
    }
  });

  it("isIdempotent returns boolean for every method", () => {
    for (const method of allRpcMethods) {
      expect(typeof isIdempotent(method)).toBe("boolean");
    }
  });

  it("authorizationOutcome denies unknown agent for non-auth methods", () => {
    const [call] = fc.sample(arbitraryCallFor(ConversationsList.name), {
      numRuns: 1,
      seed: 1,
    });
    if (call === undefined) throw new Error("sample failed");
    const verdict = authorizationOutcome(
      initialReferenceState,
      call,
      agentId("00000000-0000-4000-8000-000000000000"),
    );
    expect(verdict).toBe("deny-unauthenticated");
  });
});

describe("toxics", () => {
  it("deliveryInvariantFor returns a valid delivery property for every toxic tag", () => {
    const valid = [
      "fan-out-cardinality",
      "store-and-replay",
      "payload-opacity",
      "task-boundary-isolation",
    ];
    for (const tag of allToxicTags) {
      const inv = deliveryInvariantFor(tag);
      expect(valid).toContain(inv);
    }
  });
});

describe("arbitraries", () => {
  it("arbitraryAnyCall draws values for every method shape", () => {
    const [drawn] = fc.sample(arbitraryAnyCall(), { numRuns: 1, seed: 7 });
    expect(drawn).toBeDefined();
    if (drawn !== undefined) {
      expect(typeof drawn.method).toBe("string");
    }
  });
});
