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
import { MessageDeliveredNotificationDefinition } from "../../../schema/notifications.js";
import { brandNotificationFrame } from "../../../schema/internal-frames.js";
import { arbitraryNotificationFrame } from "../../arbitraries/frames.js";
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
const DEFAULT_FUZZ_BURST_RUNS = 10;
const PROPERTY_SCHEMA_EXHAUSTIVE_FUZZ_CLIENT = "schema-exhaustive-fuzz-client";

/**
 * E2 client half — TestServer emits arbitrary `NotificationFrame`s across
 * many shapes to a real client. Properties interleave with a tagged
 * liveness probe and a task-boundary assertion.
 *
 * Predicate (both must hold):
 *   1. No crash — real client stays `ready`; no spurious closeSignal.
 *   2. Liveness probe — a valid tagged notification emitted post-fuzz surfaces.
 */
export function registerSchemaExhaustiveFuzzClient(
  ctx: ClientConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY_SCHEMA_EXHAUSTIVE_FUZZ_CLIENT,
    "real client absorbs arbitrary NotificationFrames; liveness and boundary hold",
    Effect.scoped(
      Effect.gen(function* () {
        const fx = yield* acquireFixture(
          ctx,
          CATEGORY,
          PROPERTY_SCHEMA_EXHAUSTIVE_FUZZ_CLIENT,
        );
        yield* subscribeAll(fx.handle);
        // Fuzz burst: default 10 frames; stress mode scales with
        // CONFORMANCE_NUM_RUNS through ctx.opts.numRuns.
        const fuzzRuns = ctx.opts.numRuns ?? DEFAULT_FUZZ_BURST_RUNS;
        const burst = fc.sample(arbitraryNotificationFrame(), {
          numRuns: fuzzRuns,
          seed: ctx.seed,
        });
        for (const frame of burst) {
          yield* fx.connection
            .emitNotification(frame)
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
              PROPERTY_SCHEMA_EXHAUSTIVE_FUZZ_CLIENT,
              "real client closed during fuzz burst",
            ),
          );
        }
        // (2) Liveness probe.
        const tag = yield* fx.window.freshEmissionTag;
        yield* fx.window.emitTaggedNotification({
          connection: fx.connection,
          base: brandNotificationFrame({
            jsonrpc: "2.0",
            method: MessageDeliveredNotificationDefinition.name,
            params: {},
          }),
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
              PROPERTY_SCHEMA_EXHAUSTIVE_FUZZ_CLIENT,
              "liveness probe never surfaced after fuzz burst",
            ),
          );
        }
      }),
    ),
  );
}
