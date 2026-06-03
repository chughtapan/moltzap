/**
 * @file Public barrel for network and presence protocol descriptors.
 */
export {
  Connect,
  // Presence is server-derived from LeaseRegistry; clients cannot
  // manually set status, so there is no client-driven presence-update
  // descriptor.
  PresenceSubscribe,
  PresenceChangedNotificationDefinition,
  // Backs the `Connect` descriptor's `@error` JSDoc claim.
  ProtocolMismatchError,
} from "./methods.js";

export type { HelloOk, ProtocolMismatchReason } from "./methods.js";

// Server-internal WebSocket connection id brand. Lives in the protocol
// layer so service signatures can be brand-typed across the server
// boundary without a server-internal import.
export { ConnectionId } from "./actor-model.js";
