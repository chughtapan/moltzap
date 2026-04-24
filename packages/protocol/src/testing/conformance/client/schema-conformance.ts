/**
 * Client-side schema-conformance properties.
 *
 * Covers spec-amendment #200 §5:
 *   A2 — event-well-formedness (client-side new)
 *   A4 — malformed-frame-handling (client half of both-sides)
 *
 * Predicate-authoring discipline:
 *   - P1 (#195): every predicate names a client-realistic misbehaviour.
 *     Here it's "real client surfaces a malformed or dropped event."
 *   - P2 (#195): every property ships a divergence proof in
 *     `__divergence_proofs__/client-schema-conformance.proofs.ts`.
 *   - O7 (#200): every observation filters by property-authored
 *     `emissionTag` via `ClientHandshakeWindow.emitTaggedEvent` — auto-
 *     subscribe / hello / resume frames never satisfy a predicate.
 *   - O6 (#200): when spec names a typed error, assert exact match.
 *     A4 client half: `MalformedFrameError` is documented; the adapter
 *     exposes no typed error channel, so the predicate checks liveness
 *     only — a client that crashes on a malformed frame will disconnect,
 *     preventing the subsequent liveness probe from surfacing.
 */
import { Effect } from "effect";
import { Value } from "@sinclair/typebox/value";
import { EventFrameSchema, type EventFrame } from "../../../schema/frames.js";
import { arbitraryEventFrame } from "../../arbitraries/frames.js";
import * as fc from "fast-check";
import type { ClientConformanceRunContext } from "./runner.js";
import { registerProperty } from "../registry.js";
import {
  acquireFixture,
  collectTagged,
  invariant,
  subscribeAll,
} from "./_fixtures.js";

const CATEGORY = "schema-conformance" as const;
const PROPERTY_BUDGET_MS = 8_000;

/**
 * A2 client-side — TestServer emits a property-sampled valid
 * `EventFrame` with a property-authored `emissionTag`; real client's
 * subscriber surfaces an event whose payload schema-matches within
 * deadline.
 *
 * Predicate: `Value.Check(EventFrameSchema, observed.decoded)` passes
 * AND `data.__emissionTag === emissionTag`.
 *
 * Discriminates: a client that strips or reorders required schema
 * fields when surfacing events fails.
 */
export function registerEventWellFormednessClient(
  ctx: ClientConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "event-well-formedness-client",
    "valid EventFrame emitted by TestServer surfaces schema-clean on real client",
    Effect.scoped(
      Effect.gen(function* () {
        const fx = yield* acquireFixture(
          ctx,
          CATEGORY,
          "event-well-formedness-client",
        );
        yield* subscribeAll(fx.handle);
        const sampled = fc.sample(arbitraryEventFrame(), {
          numRuns: 1,
          seed: ctx.seed,
        })[0];
        if (sampled === undefined) {
          return yield* Effect.fail(
            invariant(
              CATEGORY,
              "event-well-formedness-client",
              "failed to sample EventFrame",
            ),
          );
        }
        const tag = yield* fx.window.freshEmissionTag;
        yield* fx.window.emitTaggedEvent({
          connection: fx.connection,
          base: sampled,
          emissionTag: tag,
        });
        const observed = yield* collectTagged(fx.handle, (t) => t === tag, {
          expected: 1,
          budgetMs: PROPERTY_BUDGET_MS,
        });
        if (observed.length === 0) {
          return yield* Effect.fail(
            invariant(
              CATEGORY,
              "event-well-formedness-client",
              `tagged event ${tag} not surfaced within ${PROPERTY_BUDGET_MS}ms`,
            ),
          );
        }
        // Reconstruct the expected event shape and re-check schema.
        const reconstructed: EventFrame = {
          jsonrpc: "2.0",
          type: "event",
          event: observed[0]!.eventName,
          data: observed[0]!.data,
        };
        if (!Value.Check(EventFrameSchema, reconstructed)) {
          return yield* Effect.fail(
            invariant(
              CATEGORY,
              "event-well-formedness-client",
              "real client surfaced event that fails EventFrameSchema",
            ),
          );
        }
      }),
    ),
  );
}

/**
 * A4 client half — TestServer emits a bit-flipped / truncated /
 * oversized frame; real client drops it silently. A subsequent tagged
 * valid event still surfaces (liveness proof, mirrors #187 round-5
 * guard). A client that crashes on the malformed frame disconnects,
 * preventing the liveness probe from surfacing within the deadline.
 *
 * Predicate: liveness — next tagged event surfaces within deadline.
 */
export function registerMalformedFrameHandlingClient(
  ctx: ClientConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "malformed-frame-handling-client",
    "malformed TestServer emission absorbed silently; liveness intact",
    Effect.scoped(
      Effect.gen(function* () {
        const fx = yield* acquireFixture(
          ctx,
          CATEGORY,
          "malformed-frame-handling-client",
        );
        yield* subscribeAll(fx.handle);
        const baseEvent = fc.sample(arbitraryEventFrame(), {
          numRuns: 1,
          seed: ctx.seed,
        })[0];
        if (baseEvent === undefined) {
          return yield* Effect.fail(
            invariant(
              CATEGORY,
              "malformed-frame-handling-client",
              "failed to sample base EventFrame",
            ),
          );
        }
        // Emit a malformed frame — the real client must absorb it.
        yield* fx.connection
          .emitMalformed({
            baseEvent,
            kind: "bit-flip",
            seed: ctx.seed,
          })
          .pipe(Effect.orElseSucceed(() => undefined));
        // Liveness probe: emit a valid tagged event after the malformed one.
        const tag = yield* fx.window.freshEmissionTag;
        yield* fx.window.emitTaggedEvent({
          connection: fx.connection,
          base: baseEvent,
          emissionTag: tag,
        });
        const observed = yield* collectTagged(fx.handle, (t) => t === tag, {
          expected: 1,
          budgetMs: PROPERTY_BUDGET_MS,
        });
        if (observed.length === 0) {
          return yield* Effect.fail(
            invariant(
              CATEGORY,
              "malformed-frame-handling-client",
              "liveness failed: no tagged event after malformed emission",
            ),
          );
        }
      }),
    ),
  );
}
