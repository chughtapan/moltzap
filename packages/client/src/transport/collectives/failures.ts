/** @file How a collective send reports failure: a refused send, routed to its result or inbound, and an emitted item the service cannot keep. */

import { Effect } from "effect";
import type { SendError } from "../messaging/errors.js";
import type { EngineSentPost } from "../messaging/index.js";
import type { MessageAddressInput } from "../wire/values.js";
import type {
  CollectiveEmitError,
  CollectiveError,
  CollectiveId,
  FailureDelivery,
  SendResult,
} from "./forms.js";
import type { InboundItem } from "./inbound.js";

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
            Effect.catchTag("CollectiveEmitError", () =>
              Effect.fail(refused.error),
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
