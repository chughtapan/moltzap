/**
 * Client-side schema-conformance properties.
 *
 * Covers spec-amendment #200 §5:
 *   A2 — notification-well-formedness (client-side new)
 *   A4 — malformed-frame-handling (client half of both-sides)
 *
 * Predicate-authoring discipline:
 *   - P1 (#195): every predicate names a client-realistic misbehaviour.
 *     Here it's "real client surfaces a malformed or dropped notification."
 *   - P2 (#195): executable divergence proofs live under
 *     `__divergence_proofs__/*-executable.proofs.test.ts`.
 *   - O7 (#200): every observation filters by property-authored
 *     `emissionTag` via `ClientHandshakeWindow.emitTaggedNotification` — auto-
 *     subscribe / hello / resume frames never satisfy a predicate.
 *   - O6 (#200): when spec names a typed error, assert exact match.
 *     A4 client half: `MalformedFrameError` is documented; the adapter
 *     exposes no typed error channel, so the predicate checks liveness
 *     only — a client that crashes on a malformed frame will disconnect,
 *     preventing the subsequent liveness probe from surfacing.
 */
import { Effect } from "effect";
import { Value } from "@sinclair/typebox/value";
import { NotificationFrameSchema } from "../../../transport/wire.js";
import { arbitraryNotificationFrame } from "../../arbitraries/frames.js";
import * as fc from "fast-check";
import type { ClientConformanceRunContext } from "./runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  acquireFixture,
  collectTagged,
  invariant,
  subscribeAll,
} from "./_fixtures.js";

const CATEGORY = "schema-conformance" as const;
const PROPERTY_NOTIFICATION_WELL_FORMEDNESS_CLIENT =
  "notification-well-formedness-client";
const PROPERTY_MALFORMED_FRAME_HANDLING_CLIENT =
  "malformed-frame-handling-client";
const PROPERTY_BUDGET_MS = 8_000;

/**
 * A2 client-side — TestServer emits a property-sampled valid
 * `NotificationFrame` with a property-authored `emissionTag`; real client's
 * subscriber surfaces a notification whose payload schema-matches within
 * deadline.
 *
 * Predicate: `Value.Check(NotificationFrameSchema, observed.decoded)` passes
 * AND `params.__emissionTag === emissionTag`.
 *
 * Discriminates: a client that strips or reorders required schema
 * fields when surfacing notifications fails.
 */
export function registerNotificationWellFormednessClient(
  ctx: ClientConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY_NOTIFICATION_WELL_FORMEDNESS_CLIENT,
    "valid NotificationFrame emitted by TestServer surfaces schema-clean on real client",
    Effect.scoped(
      Effect.gen(function* () {
        const fx = yield* acquireFixture(
          ctx,
          CATEGORY,
          PROPERTY_NOTIFICATION_WELL_FORMEDNESS_CLIENT,
        );
        yield* subscribeAll(fx.handle);
        const sampled = fc.sample(arbitraryNotificationFrame(), {
          numRuns: 1,
          seed: ctx.seed,
        })[0];
        if (sampled === undefined) {
          return yield* Effect.fail(
            invariant(
              CATEGORY,
              PROPERTY_NOTIFICATION_WELL_FORMEDNESS_CLIENT,
              "failed to sample NotificationFrame",
            ),
          );
        }
        const tag = yield* fx.window.freshEmissionTag;
        yield* fx.window.emitTaggedNotification({
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
              PROPERTY_NOTIFICATION_WELL_FORMEDNESS_CLIENT,
              `tagged notification ${tag} not surfaced within ${PROPERTY_BUDGET_MS}ms`,
            ),
          );
        }
        const reconstructed = {
          jsonrpc: "2.0",
          method: observed[0]!.notificationName,
          ...(observed[0]!.params !== undefined
            ? { params: observed[0]!.params }
            : {}),
        };
        if (!Value.Check(NotificationFrameSchema, reconstructed)) {
          return yield* Effect.fail(
            invariant(
              CATEGORY,
              PROPERTY_NOTIFICATION_WELL_FORMEDNESS_CLIENT,
              "real client surfaced notification that fails NotificationFrameSchema",
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
 * valid notification still surfaces (liveness proof, mirrors #187 round-5
 * guard). A client that crashes on the malformed frame disconnects,
 * preventing the liveness probe from surfacing within the deadline.
 *
 * Predicate: liveness — next tagged notification surfaces within deadline.
 */
export function registerMalformedFrameHandlingClient(
  ctx: ClientConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY_MALFORMED_FRAME_HANDLING_CLIENT,
    "malformed TestServer emission absorbed silently; liveness intact",
    Effect.scoped(
      Effect.gen(function* () {
        const fx = yield* acquireFixture(
          ctx,
          CATEGORY,
          PROPERTY_MALFORMED_FRAME_HANDLING_CLIENT,
        );
        yield* subscribeAll(fx.handle);
        const baseNotification = fc.sample(arbitraryNotificationFrame(), {
          numRuns: 1,
          seed: ctx.seed,
        })[0];
        if (baseNotification === undefined) {
          return yield* Effect.fail(
            invariant(
              CATEGORY,
              PROPERTY_MALFORMED_FRAME_HANDLING_CLIENT,
              "failed to sample base NotificationFrame",
            ),
          );
        }
        // Emit a malformed frame — the real client must absorb it.
        yield* fx.connection
          .emitMalformed({
            baseNotification,
            kind: "bit-flip",
            seed: ctx.seed,
          })
          .pipe(Effect.orElseSucceed(() => undefined));
        // Liveness probe: emit a valid tagged notification after the malformed one.
        const tag = yield* fx.window.freshEmissionTag;
        yield* fx.window.emitTaggedNotification({
          connection: fx.connection,
          base: baseNotification,
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
              PROPERTY_MALFORMED_FRAME_HANDLING_CLIENT,
              "liveness failed: no tagged notification after malformed emission",
            ),
          );
        }
      }),
    ),
  );
}
