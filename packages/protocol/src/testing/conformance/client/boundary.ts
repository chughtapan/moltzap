/**
 * Client-side boundary properties.
 *
 * Covers spec-amendment #200 §5:
 *   E2 — schema-exhaustive-fuzz (client half of both-sides)
 *
 * E1 (webhook-graceful-shutdown) is N/A on the client side per spec —
 * no client-observable surface.
 */
import { Effect } from "effect";
import * as fc from "fast-check";
import { arbitraryEventFrame } from "../../arbitraries/frames.js";
import type { ClientConformanceRunContext } from "./runner.js";
import { registerProperty } from "../registry.js";
import {
  acquireFixture,
  collectTagged,
  invariant,
  subscribeAll,
} from "./_fixtures.js";

const CATEGORY = "boundary" as const;
const PROPERTY_BUDGET_MS = 12_000;

/**
 * E2 client half — TestServer emits arbitrary `EventFrame`s across
 * many shapes to a real client. Properties interleave with a tagged
 * liveness probe and a task-boundary assertion.
 *
 * Predicate (all three must hold):
 *   1. No crash — real client stays `ready`; no spurious closeSignal.
 *   2. Liveness probe — a valid tagged event emitted post-fuzz surfaces.
 *   3. Task-boundary cleanliness — no cross-wiring on the tagged
 *      observation surface.
 */
export function registerSchemaExhaustiveFuzzClient(
  ctx: ClientConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "schema-exhaustive-fuzz-client",
    "real client absorbs arbitrary EventFrames; liveness and boundary hold",
    Effect.scoped(
      Effect.gen(function* () {
        const fx = yield* acquireFixture(
          ctx,
          CATEGORY,
          "schema-exhaustive-fuzz-client",
        );
        yield* subscribeAll(fx.handle);
        // Fuzz burst: 10 arbitrary EventFrames seeded by ctx.seed.
        const burst = fc.sample(arbitraryEventFrame(), {
          numRuns: 10,
          seed: ctx.seed,
        });
        for (const frame of burst) {
          yield* fx.connection
            .emitEvent(frame)
            .pipe(Effect.orElseSucceed(() => undefined));
        }
        // (1) Real client still alive — closeSignal not fired.
        const closeRace = yield* Effect.race(
          fx.handle.closeSignal.pipe(Effect.as("closed" as const)),
          Effect.sleep("100 millis").pipe(Effect.as("alive" as const)),
        );
        if (closeRace === "closed") {
          return yield* Effect.fail(
            invariant(
              CATEGORY,
              "schema-exhaustive-fuzz-client",
              "real client closed during fuzz burst",
            ),
          );
        }
        // (2) Liveness probe.
        const tag = yield* fx.window.freshEmissionTag;
        yield* fx.window.emitTaggedEvent({
          connection: fx.connection,
          base: {
            jsonrpc: "2.0",
            type: "event",
            event: "messages.delivered",
            data: {},
          },
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
              "schema-exhaustive-fuzz-client",
              "liveness probe never surfaced after fuzz burst",
            ),
          );
        }
        // (3) Task-boundary cleanliness: the liveness probe's surfaced
        // tag must be exactly the emitted one — no cross-wiring.
        if (observed[0]!.tag !== tag) {
          return yield* Effect.fail(
            invariant(
              CATEGORY,
              "schema-exhaustive-fuzz-client",
              `cross-wired: expected tag ${tag}, got ${observed[0]!.tag}`,
            ),
          );
        }
      }),
    ),
  );
}
