/** @file Public barrel for the final endpoint runtime capability. */
// safer-arch-ignore no-folder-cycle: Importing package.json for the MCP implementation version places the package root in the endpoint's dependencies, while this facade re-exports from endpoint/harness-endpoint.
// safer-arch-ignore require-curated-public-facade: Each re-export names one domain's adapter-facing values; the root re-exports them from their owners instead of from a shared contract module.
// safer-arch-ignore no-large-public-surface: The root is the one adapter-facing boundary, and each operation and inbound item is a closed schema its adapters decode; splitting them behind narrower entrypoints would give adapters a second import path for one contract.

/** The endpoint capability a host acquires, and its connect and delivery types. */
export {
  ConnectError,
  type HarnessEndpoint,
  type InboundDelivery,
} from "./endpoint/harness-endpoint/index.js";
/** Acquire the structural endpoint for one loopback daemon endpoint. */
// safer-arch-ignore no-public-vendor-type-leak: URL is the platform-standard endpoint locator required by the public acquisition contract.
export { acquireHarnessEndpoint } from "./endpoint/harness-endpoint/index.js";
/** One line of the daemon's optional history export. */
export { HistoryExportRecord } from "./delivery/history-export.js";
/** Send input and the closed error of a refused collective send. */
export {
  CollectiveError,
  SendInput,
  type SendResult,
} from "./transport/collectives/forms.js";
/** The items an endpoint delivers to its host. */
export { InboundItem } from "./transport/collectives/inbound.js";
/** The text a host's model reads for each delivered message, question and result. */
export {
  groupMembers,
  renderCollectiveRequest,
  renderCollectiveResult,
  renderContent,
} from "./transport/collectives/render.js";
/** The operation a native host's message text states. */
export {
  MessageTextError,
  parseMessageText,
} from "./transport/collectives/message-text.js";
/** Explicit direct and group addresses. */
export {
  AgentAddress,
  GroupAddress,
  MessageAddressInput,
} from "./transport/messaging/address.js";
/** The closed errors of sending, listening, and acknowledging delivery. */
export {
  DeliveryAcknowledgeError,
  ListenError,
  SendError,
} from "./transport/messaging/errors.js";
/** Certified inbound messages, direct or to a fixed group. */
export {
  type DirectMessage,
  type GroupMessage,
  InboundMessage,
} from "./transport/messaging/message.js";
/** Post ids and the closed semantic content of a message. */
export {
  Content,
  ContentPart,
  JsonValue,
  PostId,
} from "./transport/wire/values.js";
