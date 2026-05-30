/**
 * @file Validity guard for the wire-decode benchmark fixtures.
 *
 * The benchmark (`wire-decode.bench.ts`) is only meaningful if BOTH engines
 * ACCEPT all three representative frames — timing a rejection path would
 * measure the wrong thing. This test runs in the normal suite and fails
 * loudly if a production schema drifts out from under a fixture (e.g. a new
 * required param on `messages/send`), forcing the bench fixtures back into
 * sync before the canary's numbers are trusted.
 */
import { describe, it, expect } from "vitest";
import { Effect, Either, Exit } from "effect";
import type { RequestFrame } from "../wire.js";
import { serverRpcMethods } from "../../rpc-registry.js";
import {
  smallFrame,
  typicalFrame,
  nestedFrame,
  decodeAjvFull,
} from "./frames.js";
import {
  decodeWireRequest,
  PROTOTYPE_UNION_ARM_COUNT,
} from "./effect-schema-prototype.js";

const FRAMES = [
  ["small · agents/list", smallFrame],
  ["typical · messages/send", typicalFrame],
  ["nested · task/conversation/create", nestedFrame],
] as const;

describe("wire-decode bench fixtures", () => {
  for (const [name, frame] of FRAMES) {
    it(`AJV (shipping path) accepts the ${name} frame`, () => {
      const exit = Effect.runSyncExit(decodeAjvFull(frame as RequestFrame));
      expect(Exit.isSuccess(exit)).toBe(true);
    });

    it(`Effect Schema prototype accepts the ${name} frame`, () => {
      const accepted = Either.match(decodeWireRequest(frame), {
        onLeft: () => false,
        onRight: () => true,
      });
      expect(accepted).toBe(true);
    });
  }

  it("Schema prototype union has the same arm count as serverRpcMethods", () => {
    // Method-selection is only a fair A/B if both engines weigh the same
    // catalog. If the wire gains/loses a method, this fails and the prototype
    // filler list must be re-synced before the bench numbers are trusted.
    expect(PROTOTYPE_UNION_ARM_COUNT).toBe(serverRpcMethods.length);
  });
});
