/** @file Public barrel for the final endpoint runtime capability. */
// safer-arch-ignore no-large-public-surface: The root is the one adapter-facing boundary, and each operation and inbound item is a closed schema its adapters decode; splitting them behind narrower entrypoints would give adapters a second import path for one contract.
// safer-arch-ignore no-folder-cycle: The root owns the public and loopback contracts consumed by endpoint internals while its server subpath composes daemon and endpoint capabilities into the one Client process boundary.
export {
  AgentAddress,
  CollectiveError,
  CollectiveOperation,
  CollectiveResponse,
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
  InboundItem,
  InboundMessage,
  JsonValue,
  ListenError,
  MessageAddressInput,
  PostId,
  SendError,
  SendInput,
  type SendResult,
} from "./contract.js";
/** Acquire the structural endpoint for one loopback daemon endpoint. */
// safer-arch-ignore no-public-vendor-type-leak: URL is the platform-standard endpoint locator required by the public acquisition contract.
export { acquireHarnessEndpoint } from "./client-runtime/index.js";
