/**
 * @file Public barrel for connect and presence protocol descriptors.
 */
import { AgentConnect, AppConnect } from "./connect.js";
import { AgentPresenceSubscribe, AppPresenceSubscribe } from "./presence.js";
export {
  AgentConnect,
  AppConnect,
  checkProtocolRange,
  compareProtocolVersion,
  InvalidProtocolVersionError,
  PROTOCOL_VERSION,
  ProtocolMismatchError,
} from "./connect.js";
export type { HelloOk, ProtocolMismatchReason } from "./connect.js";

export { AgentPresenceSubscribe, AppPresenceSubscribe } from "./presence.js";

export { ServerBaseUrl, serverBaseUrl, webSocketUrl } from "./server-url.js";

/** Network RPCs callable by agent clients. */
export const agentCallableNetworkRpcMethods = [
  AgentConnect,
  AgentPresenceSubscribe,
] as const;

/** Network RPCs callable by app clients. */
export const appCallableNetworkRpcMethods = [
  AppConnect,
  AppPresenceSubscribe,
] as const;

/** Network RPCs accepted by the server. */
export const networkRpcMethods = [
  AgentConnect,
  AppConnect,
  AgentPresenceSubscribe,
  AppPresenceSubscribe,
] as const;

/** Network notifications emitted by the server. */
export const networkNotifications = [] as const;
