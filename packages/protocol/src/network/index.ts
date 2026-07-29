/**
 * @file Public barrel for connect and presence protocol descriptors.
 */
export {
  agentConnect,
  appConnect,
  PROTOCOL_VERSION,
  compareProtocolVersion,
  checkProtocolRange,
  InvalidProtocolVersionError,
  ProtocolMismatchError,
} from "./connect.js";
/** Re-exports the public API from `./connect.js`. */
export type { HelloOk, ProtocolMismatchReason } from "./connect.js";

/** Re-exports the public API from `./presence.js`. */
export { agentPresenceSubscribe, appPresenceSubscribe } from "./presence.js";

/** Re-exports the public API from `./server-url.js`. */
export {
  type ServerBaseUrl,
  serverBaseUrlSchema,
  serverBaseUrl,
  webSocketUrl,
} from "./server-url.js";

import { agentConnect, appConnect } from "./connect.js";
import { agentPresenceSubscribe, appPresenceSubscribe } from "./presence.js";

/** Network RPCs callable by agent clients. */
export const agentCallableNetworkRpcMethods = [
  agentConnect,
  agentPresenceSubscribe,
] as const;

/** Network RPCs callable by app clients. */
export const appCallableNetworkRpcMethods = [
  appConnect,
  appPresenceSubscribe,
] as const;

/** Network RPCs accepted by the server. */
export const networkRpcMethods = [
  agentConnect,
  appConnect,
  agentPresenceSubscribe,
  appPresenceSubscribe,
] as const;

/** Network notifications emitted by the server. */
export const networkNotifications = [] as const;
