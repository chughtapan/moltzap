/** @file How a collective send reports failure: a refused send, routed to its result or inbound, and an emitted item the service cannot keep. */

import { Effect } from "effect";
import type { SendError } from "../messaging/errors.js";
import type { EngineSentPost } from "../messaging/index.js";
import type { MessageAddressInput } from "../wire/values.js";
import type { InboundItem } from "./inbound.js";
import {
  CollectiveEmitError,
  type CollectiveError,
  type CollectiveId,
  type FailureDelivery,
  type SendResult,
} from "./forms.js";

/**
 * Keep a send's own outcome when an item its work emitted cannot be kept. The
 * send's posts may already exist, so the emit failure must not read as the
 * send's failure, which tells a host its posts were not sent; the emit port
 * has reported the storage failure itself, as the daemon's does by stopping.
 * @param effect Work whose emitted item may not be kept.
 * @returns The work, with an emit failure dropped.
 */
export function ignoreEmitFailure<E, R>(
  effect: Effect.Effect<void, E | CollectiveEmitError, R>,
): Effect.Effect<void, Exclude<E, CollectiveEmitError>, R> {
  return Effect.catchIf(
    effect,
    (error): error is CollectiveEmitError =>
      error instanceof CollectiveEmitError,
    () => Effect.void,
  );
}

/** One completed send: the posts certified by its return, and a collective id. */
export interface CollectiveSendOutcome extends SendResult {
  readonly postIds: ReadonlyArray<EngineSentPost["postId"]>;
}

/**
 * A refused collective send, with the address its failure item routes to.
 * The address is the operation's own, or the requester's for a response.
 */
export interface RefusedSend<E> {
  readonly id: CollectiveId;
  readonly to: MessageAddressInput;
  readonly error: E;
}

/**
 * Deliver a refused collective send's error where the host wants it. With
 * `inbound` the send completes, naming the operation, and the error arrives
 * as an `operationFailed` item carrying the same text. When that item cannot
 * be kept, the send fails with the refusal itself, the outcome it had.
 */
export function reportFailure(
  emit: (item: InboundItem) => Effect.Effect<void, CollectiveEmitError>,
  failureDelivery: FailureDelivery,
  send: Effect.Effect<
    CollectiveSendOutcome,
    RefusedSend<SendError | CollectiveError>
  >,
): Effect.Effect<CollectiveSendOutcome, SendError | CollectiveError> {
  return send.pipe(
    Effect.catchAll((refused) => {
      switch (failureDelivery) {
        case "result":
          return Effect.fail(refused.error);
        case "inbound":
          return emit({
            kind: "operationFailed",
            id: refused.id,
            to: refused.to,
            error: refused.error.message,
          }).pipe(
            Effect.as({ operationId: refused.id, postIds: [] }),
            Effect.catchIf(
              (error): error is CollectiveEmitError =>
                error instanceof CollectiveEmitError,
              () => Effect.fail(refused.error),
            ),
          );
        default: {
          const exhaustive: never = failureDelivery;
          return exhaustive;
        }
      }
    }),
  );
}

/**
 * Tag a send's error with the operation id and the address its failure item
 * routes to.
 */
export function refusedAs<E>(id: CollectiveId, to: MessageAddressInput) {
  return (error: E): RefusedSend<E> => ({ id, to, error });
}
