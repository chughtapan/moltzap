/**
 * @file Public barrel for connect protocol descriptors.
 */
export {
  agentConnect,
  PROTOCOL_VERSION,
  compareProtocolVersion,
  checkProtocolRange,
  InvalidProtocolVersionError,
  ProtocolMismatchError,
} from "./connect.js";
/** Re-exports the public API from `./connect.js`. */
export type { HelloOk, ProtocolMismatchReason } from "./connect.js";

/** Re-exports the public API from `./server-url.js`. */
export {
  type ServerBaseUrl,
  serverBaseUrlSchema,
  httpBaseUrl,
  serverBaseUrl,
  webSocketUrl,
} from "./server-url.js";

import { agentConnect } from "./connect.js";

/** Network RPCs callable by agent clients. */
export const agentCallableNetworkRpcMethods = [agentConnect] as const;

/** Network RPCs accepted by the server. */
export const networkRpcMethods = [agentConnect] as const;

/** Network notifications emitted by the server. */
export const networkNotifications = [] as const;
