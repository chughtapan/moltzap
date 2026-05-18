/**
 * @file Public barrel for network, presence, and endpoint-address protocol descriptors.
 */
export {
  Connect,
  NetworkPing,
  PresenceUpdate,
  PresenceSubscribe,
  PresenceChangedNotificationDefinition,
} from "./methods.js";

export type { HelloOk } from "./methods.js";

export {
  isEndpointAddress,
  endpointAddress,
  endpointAddressKind,
  makeEndpointAddress,
} from "./actor-model.js";

export type { EndpointAddress, EndpointAddressKind } from "./actor-model.js";
