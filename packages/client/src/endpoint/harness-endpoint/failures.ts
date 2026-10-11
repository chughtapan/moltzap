/** @file One closed error projection for the private native MCP client edge. */

import { ProtocolError } from "@modelcontextprotocol/client";
import {
  type DeliveryAcknowledgeError,
  deliveryAcknowledgeFailureReasons,
  ListenError,
} from "../../transport/messaging/errors.js";

interface ReasonPayload {
  readonly reason: unknown;
}

const hasReasonPayload = (value: unknown): value is ReasonPayload =>
  typeof value === "object" && value !== null && "reason" in value;
const operationReason = (cause: unknown): unknown => {
  if (hasReasonPayload(cause)) {
    return cause.reason;
  }
  const data: unknown = ProtocolError.isInstance(cause)
    ? cause.data
    : undefined;
  return hasReasonPayload(data) ? data.reason : undefined;
};

/** Runtime classification never trusts an upstream reason outside the closed union. */
export const isReason = <Reason>(
  value: unknown,
  allowed: readonly Reason[],
): value is Reason => allowed.some((candidate) => candidate === value);

/** Receipts preserve lifecycle refusals without leaking SDK or transport diagnostics. */
export const acknowledgeReason = (
  cause: unknown,
): DeliveryAcknowledgeError["reason"] => {
  const reason = operationReason(cause);
  return isReason(reason, deliveryAcknowledgeFailureReasons)
    ? reason
    : "transport-failed";
};

/** Both polling and unread recovery use the same lifecycle failure interpretation. */
export const listenFailure = (cause: unknown): ListenError => {
  const reason = operationReason(cause);
  switch (reason) {
    case "already-listening":
    case "consumer-revoked":
    case "incompatible-daemon":
    case "decode-failed":
    case "transport-failed":
      return new ListenError({ reason });
    default:
      return new ListenError({ reason: "transport-failed" });
  }
};
