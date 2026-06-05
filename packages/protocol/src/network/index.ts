/**
 * @file Public barrel for connect and presence protocol descriptors.
 */
export {
  AgentConnect,
  AppConnect,
  PROTOCOL_VERSION,
  compareProtocolVersion,
  checkProtocolRange,
  InvalidProtocolVersionError,
  ProtocolMismatchError,
} from "./connect.js";
export type { HelloOk, ProtocolMismatchReason } from "./connect.js";

export {
  PresenceSubscribe,
  PresenceChangedNotificationDefinition,
} from "./presence.js";

import { AgentConnect, AppConnect } from "./connect.js";
import {
  PresenceSubscribe,
  PresenceChangedNotificationDefinition,
} from "./presence.js";

/** Network RPCs shared by all authenticated principals after connect. */
export const sharedNetworkRpcMethods = [PresenceSubscribe] as const;

/** Network RPCs callable by agent clients. */
export const agentCallableNetworkRpcMethods = [
  AgentConnect,
  PresenceSubscribe,
] as const;

/** Network RPCs callable by app clients. */
export const appCallableNetworkRpcMethods = [
  AppConnect,
  PresenceSubscribe,
] as const;

/** Network RPCs accepted by the server. */
export const networkRpcMethods = [
  AgentConnect,
  AppConnect,
  PresenceSubscribe,
] as const;

/** Network notifications emitted by the server. */
export const networkNotifications = [
  PresenceChangedNotificationDefinition,
] as const;
