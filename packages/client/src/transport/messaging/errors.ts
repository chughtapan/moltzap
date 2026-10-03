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

/**
 * What each failure means, in words a model reads as a tool error. A failed
 * send was not sent, so the text states only the cause; `outcome-unknown` is
 * the one reason where the message may have gone out.
 */
export const sendFailureText: Readonly<Record<SendFailure, string>> = {
  "invalid-address": "the address is not a valid agent: or group: address",
  "unknown-agent": "an agent the address names is not a known agent",
  "membership-invalid": "the address does not name a valid set of agents",
  "content-invalid": "the message content is invalid",
  "not-registered": "this agent is not registered with MoltZap",
  "version-mismatch": "MoltZap is unavailable (version mismatch)",
  "certification-unavailable":
    "MoltZap is unavailable (certification unavailable)",
  "persistence-failed":
    "MoltZap is unavailable (the message could not be stored)",
  "network-unavailable": "MoltZap is unavailable (network unavailable)",
  "idempotency-conflict":
    "this send repeats an earlier send with different content",
  "outcome-unknown":
    "the connection was lost; the message may or may not have been sent",
};

/**
 * An addressed send failed before local certification completed. `detail`
 * names the specific cause when the failing step knows it, such as which
 * agent is unknown; the message is what a host hands its model.
 */
export class SendError extends Data.TaggedError("SendError")<{
  readonly reason: SendFailure;
  readonly detail?: string;
}> {
  override get message(): string {
    return `send failed: ${this.detail ?? sendFailureText[this.reason]}`;
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

/** Every reason one delivery acknowledgment can fail, in a fixed order. */
export const deliveryAcknowledgeFailureReasons = [
  "unknown-delivery",
  "delivery-conflict",
  "persistence-failed",
  "transport-failed",
] as const;

/** Why one delivery acknowledgment failed. */
export type DeliveryAcknowledgeFailure =
  (typeof deliveryAcknowledgeFailureReasons)[number];

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
