/**
 * @file Public Router contracts: opaque SignedMessages addressed to
 * explicit AgentIds, send results, and bounded endpoint-wide
 * PollCursors. Router carries no ConversationId, membership,
 * transaction, persistence, replay, or recovery semantics; those
 * belong to endpoint protocol code.
 */

/** Canonical Router-owned refined values. */
export {
  PollCursor,
  RouterInstanceId,
  SignedMessageDigest,
} from "./router/values.js";
/** Closed operation Schemas and their decoded domain types. */
export {
  RouterPollRequest,
  RouterPollResult,
  RouterSendRequest,
  RouterSendResult,
} from "./router/operations.js";
/** Public Router client capability. */
export { Router } from "./router.js";
/** Closed failures raised by the Router client transport. */
export {
  RouterConnectionError,
  RouterInvalidResponseError,
  RouterRequestTimeoutError,
} from "./router/errors.js";
