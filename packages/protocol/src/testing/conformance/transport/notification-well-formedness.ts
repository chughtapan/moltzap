/**
 * Valid notification frame round-trips the codec cleanly.
 *
 * `@pure-codec` — does NOT drive a real server or real client. Spec A2's
 * "accepted by a real client" assertion requires a TestServer + real
 * client driver; that property lives in the consumer package (e.g.,
 * `packages/client` or `moltzap-arena`) and is tracked under #186.
 *
 * Tightened per architect §4.4: predicate demands `Right` AND schema
 * check of the specific notification variant — the previous `Right || Left`
 * shape was a tautology over the union.
 */
import * as fc from "fast-check";
import { Effect, Either } from "effect";
import { Value } from "@sinclair/typebox/value";
import { arbitraryNotificationFrame } from "../../arbitraries/frames.js";
import {
  decodeFrame,
  encodeFrame,
  isNotificationFrame,
} from "../_shared/frame-mutator.js";
import { NotificationFrameSchema } from "../../../transport/wire.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { assertProperty, registerProperty } from "../_shared/registry.js";

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
    assertProperty(CATEGORY, "notification-well-formedness", () =>
      Promise.resolve(
        fc.assert(
          fc.property(arbitraryNotificationFrame(), (frame) => {
            const raw = encodeFrame(frame);
            const decoded = Effect.runSync(
              Effect.either(decodeFrame(raw, "inbound")),
            );
            return Either.match(decoded, {
              onLeft: () => false,
              onRight: (frame) =>
                isNotificationFrame(frame) &&
                Value.Check(NotificationFrameSchema, frame),
            });
          }),
          {
            seed: ctx.seed,
            numRuns: ctx.opts.numRuns ?? DEFAULT_NOTIFICATION_SCHEMA_RUNS,
          },
        ),
      ),
    ),
  );
}
