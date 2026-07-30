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

/** Re-exports the public API from `./runtime/runtime.js`. */
export {
  AgentRuntimeDefinitionError,
  RuntimeCompleted,
  RuntimeExited,
  RuntimeFailed,
  RuntimeSignaled,
  defineRuntime,
  type AgentRuntime,
  type AgentRuntimeDefinition,
  type AgentRuntimeInput,
  type RunningAgent,
  type RuntimeTermination,
} from "./runtime/runtime.js";
/** Re-exports the public API from `./runtime/roster.js`. */
export type {
  AgentRoster,
  AgentRosterAcquisitionError,
  AgentRosterRequirements,
  AgentsService,
  StartedAgentHandles,
} from "./runtime/roster.js";

/** Re-exports the public API from `./kernel/run.js`. */
export {
  type SimulatorRunFailure,
  type SimulatorRunOptions,
  type SimulatorRunResult,
} from "./kernel/run.js";

/** Re-exports the public API from `./layer.js`. */
export { simulatorLayer, type SimulatorLayerOptions } from "./layer.js";
/** Re-exports the public API from `./runtime/effect.js`. */
export {
  EffectRuntimeStartFailed,
  effectRuntime,
  type EffectMessageContext,
  type EffectMessageReply,
  type EffectRuntimeOptions,
} from "./runtime/effect.js";
/** Re-exports the public API from `./runtime/openclaw/runtime.js`. */
export {
  openClawRuntime,
  type OpenClawRuntimeAcquisitionError,
  type OpenClawRuntimeOptions,
} from "./runtime/openclaw/runtime.js";
/** Re-exports the public API from `./runtime/nanoclaw/runtime.js`. */
export {
  nanoclawRuntime,
  type NanoclawRuntimeAcquisitionError,
  type NanoclawRuntimeOptions,
} from "./runtime/nanoclaw/runtime.js";
/** Re-exports the public API from `./runtime/process.js`. */
export { RuntimeAcquisitionFailed } from "./runtime/process.js";
/** Re-exports the public API from `./runtime/packages.js`. */
export type { InstallMode } from "./runtime/packages.js";
