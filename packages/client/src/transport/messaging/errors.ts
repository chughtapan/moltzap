/** @file The closed errors of sending, listening and acknowledging delivery. */

import { Data } from "effect";

/** Every reason one addressed send can fail, in a fixed order. */
export const sendFailureReasons = [
  "invalid-address",
  "unknown-agent",
  "membership-invalid",
  "content-invalid",
  "not-registered",
  "version-mismatch",
  "certification-unavailable",
  "persistence-failed",
  "network-unavailable",
  "idempotency-conflict",
  "outcome-unknown",
] as const;

/** Why one addressed send failed. */
export type SendFailure = (typeof sendFailureReasons)[number];

/** An addressed send failed before local certification completed. */
export class SendError extends Data.TaggedError("SendError")<{
  readonly reason: SendFailure;
}> {
  override get message(): string {
    return `send failed: ${this.reason}`;
  }
}

type ListenFailure =
  | "already-listening"
  | "incompatible-daemon"
  | "transport-failed"
  | "decode-failed";

/** The endpoint's sole inbound subscription failed. */
export class ListenError extends Data.TaggedError("ListenError")<{
  readonly reason: ListenFailure;
}> {
  override get message(): string {
    return `listen failed: ${this.reason}`;
  }
}

type DeliveryAcknowledgeFailure =
  | "unknown-delivery"
  | "delivery-conflict"
  | "persistence-failed"
  | "transport-failed";

/** Transport acknowledgment could not complete for one delivery. */
export class DeliveryAcknowledgeError extends Data.TaggedError(
  "DeliveryAcknowledgeError",
)<{
  readonly reason: DeliveryAcknowledgeFailure;
}> {
  override get message(): string {
    return `delivery acknowledgment failed: ${this.reason}`;
  }
}
