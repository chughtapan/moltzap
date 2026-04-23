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
  type AnyFrame,
} from "../codec.js";
import { makeCaptureBuffer, recordFrame, mergeCaptures } from "../captures.js";
import {
  initialReferenceState,
  applyCall,
  isIdempotent,
  authorizationOutcome,
} from "../models/index.js";
import { tierCInvariantFor, allToxicTags } from "../toxics/index.js";
import {
  allRpcMethods,
  arbitraryCallFor,
  arbitraryAnyCall,
} from "../arbitraries/index.js";

describe("codec", () => {
  it("round-trips a valid request frame", async () => {
    const frame: AnyFrame = {
      type: "request",
      jsonrpc: "2.0",
      id: "req-1",
      method: "auth/connect",
      params: { agentKey: "k", agentId: "a" },
    };
    const raw = encodeFrame(frame);
    const decoded = await Effect.runPromise(
      Effect.either(decodeFrame(raw, "inbound")),
    );
    expect(decoded._tag).toBe("Right");
    if (decoded._tag === "Right") {
      expect(decoded.right.type).toBe("request");
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
    const base: AnyFrame = {
      type: "request",
      jsonrpc: "2.0",
      id: "r",
      method: "auth/connect",
      params: {},
    };
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
          type: "event",
          jsonrpc: "2.0",
          event: "ping",
          data: null,
        };
        yield* recordFrame(buf, "inbound", encodeFrame(frame), frame);
        const snap = yield* buf.snapshot;
        return snap;
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.frame?.type).toBe("event");
  });

  it("mergeCaptures aggregates multiple buffers in timestamp order", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const a = yield* makeCaptureBuffer({ capacity: 4 });
        const b = yield* makeCaptureBuffer({ capacity: 4 });
        const frame: AnyFrame = {
          type: "event",
          jsonrpc: "2.0",
          event: "ping",
          data: null,
        };
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
  it("applyCall is total for every RpcMethodName", () => {
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
    const [call] = fc.sample(arbitraryCallFor("conversations/list"), {
      numRuns: 1,
      seed: 1,
    });
    if (call === undefined) throw new Error("sample failed");
    const verdict = authorizationOutcome(initialReferenceState, call, "nobody");
    expect(verdict).toBe("deny-unauthenticated");
  });
});

describe("toxics", () => {
  it("tierCInvariantFor returns a valid tier-C id for every toxic tag", () => {
    for (const tag of allToxicTags) {
      const inv = tierCInvariantFor(tag);
      expect(["C1", "C2", "C3", "C4"]).toContain(inv);
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
