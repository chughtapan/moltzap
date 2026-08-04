/** @file Code-first simulator API. */
// safer-arch-ignore no-folder-cycle: The package root is the explicit public composition facade over mutually typed event, ledger, network, and runtime capabilities.
// safer-arch-ignore no-package-mesh: The simulator is a capability-composition package whose named facades expose the intentional cross-domain contracts used by one run kernel.

/** Re-exports the public API from `./definition.js`. */
export {
  Run,
  RunSpec,
  SimulatorDefinitionError,
  type RunInfrastructureServices,
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

/** Re-exports the mechanism-neutral infrastructure failure. */
export { SimulatorInfrastructureFailure } from "./platform/failure.js";
