/** @file Public barrel for the final endpoint runtime capability. */
// safer-arch-ignore no-folder-cycle: The root owns the public and loopback contracts consumed by endpoint internals while its server subpath composes daemon and endpoint capabilities into the one Client process boundary.
export {
  AgentAddress,
  ConnectError,
  Content,
  ContentPart,
  DeliveryAcknowledgeError,
  type DirectMessage,
  GroupAddress,
  type GroupMessage,
  type HarnessEndpoint,
  HistoryExportRecord,
  type InboundDelivery,
  InboundMessage,
  JsonValue,
  ListenError,
  MessageAddressInput,
  PostId,
  SendError,
  SendInput,
} from "./contract.js";
/** Acquire the structural endpoint for one loopback daemon endpoint. */
// safer-arch-ignore no-public-vendor-type-leak: URL is the platform-standard endpoint locator required by the public acquisition contract.
export { acquireHarnessEndpoint } from "./client-runtime.js";
