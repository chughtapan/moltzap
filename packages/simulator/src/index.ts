/** @file Code-first simulator API. */

/** Re-exports the public API from `./definition.js`. */
export {
  simulator,
  SimulatorDefinitionError,
  type SimulatorDefinition,
  type SimulatorDefinitionId,
} from "./definition.js";

/** Re-exports the public API from `./events/core.js`. */
export {
  AgentProcessExited,
  AgentProcessSignaled,
  AgentRuntimeCompleted,
  AgentRuntimeFailed,
  AgentRuntimeReady,
  AgentRuntimeStartFailed,
  ConversationOpened,
  coreEvents,
  EndpointMessageReceived,
  EndpointMessageSent,
  LinkDown,
  LinkUp,
  ProgramFailed,
  ProgramInterrupted,
  ProgramSucceeded,
  RouterMessageCommitted,
  RouterStartFailed,
  RouterStarted,
  RouterStopFailed,
  RunStarted,
} from "./events/core.js";
/** Re-exports the public API from `./kernel/event-services.js`. */
export {
  type CustomerEvents,
  type EventMetadata,
  type ReadableRunLedger,
} from "./kernel/event-services.js";

/** Re-exports the public API from `./events/catalog.js`. */
export {
  EventCatalog,
  EventCatalogDefinitionError,
  type EncodedEventOf,
  type EventCatalogDefinitionFailure,
  type EventClass,
  type EventClassOf,
  type EventOf,
  type VersionedEventTag,
} from "./events/catalog.js";
/** Re-exports the public API from `./ledger/live.js`. */
export type { LedgerFailure } from "./ledger/live.js";

/** Re-exports the public API from `./network.js`. */
export {
  AgentHandle,
  ConversationAddress,
  ConversationSocket,
  Endpoint,
  LinkController,
  Network,
  NetworkFailure,
  ParticipantHandle,
  type AgentConnection,
  type ConversationParticipants,
  type LinkControllerService,
  type MessageParts,
  type NetworkService,
  type ReceivedMessage,
} from "./network.js";

/** Re-exports the public API from `./kernel/run.js`. */
export {
  CompletedLedgerReceipt,
  IncompleteLedgerReceipt,
  LedgerReceipt,
  ProgramFinished,
  RunInfrastructureFailed,
  type SimulatorRunFailure,
  type SimulatorRunOutcome,
  type SimulatorRunOptions,
} from "./kernel/run.js";

/** Re-exports the public API from `./layer.js`. */
export { simulatorLayer, type SimulatorLayerOptions } from "./layer.js";
