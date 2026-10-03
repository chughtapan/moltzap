/** @file The structural capability one scoped endpoint connection gives its host. */

import { Data, type Effect, type Stream } from "effect";
import type {
  CollectiveError,
  FailureDelivery,
  SendInput,
  SendResult,
} from "../../transport/collectives/forms.js";
import type { InboundItem } from "../../transport/collectives/inbound.js";
import type {
  DeliveryAcknowledgeError,
  ListenError,
  SendError,
} from "../../transport/messaging/errors.js";

type ConnectFailure =
  | "transport-failed"
  | "decode-failed"
  | "incompatible-daemon";

/** Acquiring the endpoint connection failed. */
export class ConnectError extends Data.TaggedError("ConnectError")<{
  readonly reason: ConnectFailure;
}> {
  override get message(): string {
    return `connect failed: ${this.reason}`;
  }
}

/** One inbound item plus its transport-only acknowledgment. */
export interface InboundDelivery {
  readonly item: InboundItem;
  readonly acknowledge: Effect.Effect<void, DeliveryAcknowledgeError>;
}

/**
 * Structural runtime capability owned by one scoped endpoint connection.
 * Every send is one operation or one collective response; the stream yields
 * inbound items.
 *
 * A host whose tool returns before the send completes passes
 * `failureDelivery: "inbound"`: a refused gather, all_gather or response
 * then completes and its error arrives as an `operationFailed` item on the
 * stream. A multicast has no operation id, so its failure is always returned.
 */
export interface HarnessEndpoint {
  readonly send: (
    input: SendInput,
    options?: Readonly<{
      failureDelivery?: FailureDelivery;
      idempotencyKey?: string;
    }>,
  ) => Effect.Effect<SendResult, SendError | CollectiveError>;
  readonly messages: Stream.Stream<InboundDelivery, ListenError>;
}
