/** @file A scripted Router transmit over an endpoint store's durable outbox. */

import { SignedMessage } from "@moltzap/identity";
import { type Duration, Effect, Queue } from "effect";
import type { EndpointStore } from "../store/index.js";
import { decodeCanonical } from "../transport/wire/index.js";

/**
 * Transmit one outbox row the way the Router worker does: begin it, complete
 * it, and hand its envelope to the Router. A row another transmit already
 * began is inactive and forwards nothing.
 * @param store Store that owns the outbox row.
 * @param outbound Receives each envelope the Router accepts.
 * @param outboundId Outbox row to transmit.
 * @param transit Time the envelope spends between beginning and completing.
 * @returns Completion once the row is handled.
 */
export function forwardStoredOutbound(
  store: EndpointStore,
  outbound: Queue.Queue<SignedMessage>,
  outboundId: string,
  transit?: Duration.DurationInput,
): Effect.Effect<void> {
  return store.beginOutbound(outboundId).pipe(
    Effect.flatMap((attempt) => {
      switch (attempt.kind) {
        case "inactive":
          return Effect.void;
        case "pending":
          return decodeCanonical(
            SignedMessage,
            attempt.outbound.canonicalSignedMessage,
          ).pipe(
            Effect.tap(() =>
              transit === undefined ? Effect.void : Effect.sleep(transit),
            ),
            Effect.flatMap((message) =>
              store
                .completeOutbound(attempt.outbound)
                .pipe(Effect.zipRight(Queue.offer(outbound, message))),
            ),
            Effect.asVoid,
          );
        default: {
          const exhaustive: never = attempt;
          return exhaustive;
        }
      }
    }),
    Effect.orDie,
  );
}
