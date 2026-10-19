/** @file The structural capability one scoped endpoint connection gives its host. */

import { Data, type Effect, type Redacted, type Stream } from "effect";
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
  /** Stable immutable reference for native custody and duplicate-wakeup handling. */
  readonly eventId: string;
  readonly item: InboundItem;
  /** Valid only during this consumer's lifetime, even if its remote release fails. */
  readonly acknowledge: Effect.Effect<void, DeliveryAcknowledgeError>;
}

/** Explicit remote authentication and native receive mode, without SDK or management authority. */
export interface HarnessEndpointOptions {
  readonly credential?: Redacted.Redacted;
  /** Defaults to polling with a credential, or native push for a trusted-local host. */
  readonly delivery?:
    | "push"
    | "poll"
    | Readonly<{
        mode: "poll";
        /** Host-local signal after the stream acquires its consumer lease and starts renewal, even with no unread items. */
        onReady?: Effect.Effect<void>;
      }>
    | Readonly<{
        mode: "webhook";
        /** Public HTTPS callback routed to the scoped loopback receiver. */
        url: string;
        /** Deployment's private callback port; no management endpoint is served here. */
        port: number;
        /** Host-local signal after the stream binds and its authenticated subscription is accepted, not after a delivery. */
        onReady?: Effect.Effect<void>;
      }>;
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
