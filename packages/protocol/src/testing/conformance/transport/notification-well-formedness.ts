/**
 * Valid notification frame round-trips the codec cleanly.
 *
 * `@pure-codec` — does NOT drive a real server or real client. The
 * "accepted by a real client" assertion requires a TestServer + real
 * client driver; that property lives in the consumer package (e.g.,
 * `packages/client` or `moltzap-arena`).
 *
 * The predicate demands `Right` AND a schema check of the specific
 * notification variant. A `Right || Left` shape would be a tautology
 * over the union and assert nothing.
 */
import * as fc from "fast-check";
import { Effect, Either } from "effect";
import { decodesStrictly } from "../../../schema-primitives.js";
import { arbitraryNotificationFrame } from "../../arbitraries/frames.js";
import {
  decodeFrame,
  encodeFrame,
  isNotificationFrame,
  type AnyFrame,
} from "../_shared/frame-mutator.js";
import {
  NotificationFrameSchema,
  type NotificationFrame,
} from "@moltzap/protocol/transport";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  assertProperty,
  type PropertyAssertionFailure,
  registerProperty,
} from "../_shared/registry.js";

const CATEGORY = "schema-conformance" as const;
const DEFAULT_NOTIFICATION_SCHEMA_RUNS = 20;

export function registerNotificationWellFormedness(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "notification-well-formedness",
    "valid notification frame decodes cleanly and re-encodes to match",
    assertProperty(CATEGORY, "notification-well-formedness", (onFailure) =>
      assertNotificationWellFormedness(ctx, onFailure),
    ).pipe(Effect.withSpan("registerNotificationWellFormedness")),
  );
}

function assertNotificationWellFormedness(
  ctx: ConformanceRunContext,
  onFailure: (cause: unknown) => PropertyAssertionFailure,
): Effect.Effect<void, PropertyAssertionFailure> {
  return Effect.tryPromise({
    try: () =>
      Promise.resolve(
        fc.assert(
          fc.property(
            arbitraryNotificationFrame(),
            notificationFrameDecodesCleanly,
          ),
          {
            seed: ctx.seed,
            numRuns: ctx.opts.numRuns ?? DEFAULT_NOTIFICATION_SCHEMA_RUNS,
          },
        ),
      ),
    catch: onFailure,
  });
}

function notificationFrameDecodesCleanly(frame: NotificationFrame): boolean {
  const raw = encodeFrame(frame);
  const decoded = Effect.runSync(Effect.either(decodeFrame(raw, "inbound")));
  return Either.match(decoded, {
    onLeft: () => false,
    onRight: isWellFormedNotificationFrame,
  });
}

function isWellFormedNotificationFrame(frame: AnyFrame): boolean {
  return (
    isNotificationFrame(frame) &&
    decodesStrictly(NotificationFrameSchema(), frame)
  );
}
