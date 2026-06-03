/**
 * Client-side schema-conformance properties:
 *   notification-well-formedness
 *   malformed-frame-handling (client half of the both-sides property)
 *
 * Predicate-authoring discipline:
 *   - Every predicate names a client-realistic misbehaviour. Here it's
 *     "real client surfaces a malformed or dropped notification."
 *   - Executable divergence proofs live under
 *     `__divergence_proofs__/*-executable.proofs.test.ts`.
 *   - Every observation filters by property-authored `emissionTag` via
 *     `ClientHandshakeWindow.emitTaggedNotification` — auto-subscribe /
 *     hello / resume frames never satisfy a predicate.
 *   - When the spec names a typed error, assert exact match. For the
 *     malformed-frame-handling client half, `MalformedFrameError` is
 *     documented; the adapter exposes no typed error channel, so the
 *     predicate checks liveness only — a client that crashes on a
 *     malformed frame disconnects, preventing the subsequent liveness
 *     probe from surfacing.
 */
import { Effect } from "effect";
import { decodesStrictly } from "../../../schema-primitives.js";
import type { NotificationFrame } from "../../../transport/index.js";
import {
  notificationFrameSchema,
  validateNotificationFrame,
} from "../../index.js";
import { arbitraryNotificationFrame } from "../../arbitraries/frames.js";
import * as fc from "fast-check";
import type { ClientConformanceRunContext } from "./runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  acquireFixture,
  collectTagged,
  invariant,
  subscribeAll,
  type ClientFixture,
  type TaggedObservation,
} from "./_fixtures.js";

const CATEGORY = "schema-conformance" as const;
const PROPERTY_NOTIFICATION_WELL_FORMEDNESS_CLIENT =
  "notification-well-formedness-client";
const PROPERTY_MALFORMED_FRAME_HANDLING_CLIENT =
  "malformed-frame-handling-client";
const PROPERTY_BUDGET_MS = 8_000;
const NotificationFrameSchema = notificationFrameSchema();

/**
 * Client-side `notification-well-formedness` — TestServer emits a
 * property-sampled valid `NotificationFrame` with a property-authored
 * `emissionTag`; real client's subscriber surfaces a notification whose
 * payload schema-matches within deadline.
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
    runNotificationWellFormedness(ctx).pipe(
      Effect.withSpan("registerNotificationWellFormednessClient"),
    ),
  );
}

/**
 * Client half of `malformed-frame-handling` — TestServer emits a
 * bit-flipped / truncated / oversized frame; real client drops it
 * silently. A subsequent tagged valid notification still surfaces
 * (liveness proof). A client that crashes on the malformed frame
 * disconnects, preventing the liveness probe from surfacing within the
 * deadline.
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
    runMalformedFrameHandling(ctx).pipe(
      Effect.withSpan("registerMalformedFrameHandlingClient"),
    ),
  );
}

function runNotificationWellFormedness(ctx: ClientConformanceRunContext) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fx = yield* acquireSubscribedFixture(
        ctx,
        PROPERTY_NOTIFICATION_WELL_FORMEDNESS_CLIENT,
      );
      const sampled = yield* sampleNotification(
        ctx.seed,
        PROPERTY_NOTIFICATION_WELL_FORMEDNESS_CLIENT,
        "failed to sample NotificationFrame",
      );
      const observed = yield* emitAndCollectTagged(
        fx,
        sampled,
        PROPERTY_NOTIFICATION_WELL_FORMEDNESS_CLIENT,
      );
      yield* assertNotificationSchemaClean(observed);
    }),
  );
}

function runMalformedFrameHandling(ctx: ClientConformanceRunContext) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fx = yield* acquireSubscribedFixture(
        ctx,
        PROPERTY_MALFORMED_FRAME_HANDLING_CLIENT,
      );
      const baseNotification = yield* sampleNotification(
        ctx.seed,
        PROPERTY_MALFORMED_FRAME_HANDLING_CLIENT,
        "failed to sample base NotificationFrame",
      );
      yield* fx.connection
        .emitMalformed({
          baseNotification,
          kind: "bit-flip",
          seed: ctx.seed,
        })
        .pipe(Effect.orElseSucceed(() => undefined));
      yield* emitAndCollectTagged(
        fx,
        baseNotification,
        PROPERTY_MALFORMED_FRAME_HANDLING_CLIENT,
      );
    }),
  );
}

function acquireSubscribedFixture(
  ctx: ClientConformanceRunContext,
  propertyName: string,
) {
  return Effect.gen(function* () {
    const fx = yield* acquireFixture(ctx, CATEGORY, propertyName);
    yield* subscribeAll(fx.handle);
    return fx;
  });
}

function sampleNotification(
  seed: number,
  propertyName: string,
  reason: string,
) {
  const sampled = fc.sample(arbitraryNotificationFrame(), {
    numRuns: 1,
    seed,
  })[0];
  return sampled === undefined
    ? Effect.fail(invariant(CATEGORY, propertyName, reason))
    : Effect.succeed(sampled);
}

function emitAndCollectTagged(
  fx: ClientFixture,
  base: NotificationFrame,
  propertyName: string,
) {
  return Effect.gen(function* () {
    const tag = yield* fx.window.freshEmissionTag;
    yield* fx.window.emitTaggedNotification({
      connection: fx.connection,
      base,
      emissionTag: tag,
    });
    const observed = yield* collectTagged(fx.handle, (t) => t === tag, {
      expected: 1,
      budgetMs: PROPERTY_BUDGET_MS,
    });
    if (observed.length === 0) {
      return yield* Effect.fail(
        invariant(CATEGORY, propertyName, livenessFailure(propertyName, tag)),
      );
    }
    return observed[0]!;
  });
}

function livenessFailure(propertyName: string, tag: string): string {
  return propertyName === PROPERTY_NOTIFICATION_WELL_FORMEDNESS_CLIENT
    ? `tagged notification ${tag} not surfaced within ${PROPERTY_BUDGET_MS}ms`
    : "liveness failed: no tagged notification after malformed emission";
}

function assertNotificationSchemaClean(observed: TaggedObservation) {
  return validateNotificationFrame(observed.decoded) &&
    decodesStrictly(NotificationFrameSchema, observed.decoded)
    ? Effect.void
    : Effect.fail(
        invariant(
          CATEGORY,
          PROPERTY_NOTIFICATION_WELL_FORMEDNESS_CLIENT,
          "real client surfaced notification that fails NotificationFrameSchema",
        ),
      );
}
