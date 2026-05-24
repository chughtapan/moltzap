/**
 * @file Public barrel for network and presence protocol descriptors.
 */
export {
  Connect,
  NetworkPing,
  PresenceUpdate,
  PresenceSubscribe,
  PresenceChangedNotificationDefinition,
} from "./methods.js";

export type { HelloOk } from "./methods.js";

// Server-internal WebSocket connection id brand (#673 follow-up).
// Lives in the protocol layer so service signatures can be brand-typed
// across the server boundary without a server-internal import.
export { ConnectionId } from "./actor-model.js";
