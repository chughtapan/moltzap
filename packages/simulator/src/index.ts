/** @file Code-first simulator API. */

export {
  Simulator,
  SimulatorDefinitionError,
  type SimulatorDefinition,
  type SimulatorDefinitionId,
} from "./definition.js";

export {
  AgentProcessExited,
  AgentProcessSignaled,
  AgentRuntimeCompleted,
  AgentRuntimeFailed,
  AgentRuntimeReady,
  AgentRuntimeStartFailed,
  ConversationOpened,
  CoreEvents,
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
export {
  type CustomerEvents,
  type EventMetadata,
  type ReadableRunLedger,
} from "./kernel/event-services.js";

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
export type { LedgerFailure } from "./ledger/live.js";

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
export type {
  AgentRoster,
  AgentRosterAcquisitionError,
  AgentRosterRequirements,
  AgentsService,
  StartedAgentHandles,
} from "./runtime/roster.js";

export {
  type SimulatorRunFailure,
  type SimulatorRunOptions,
  type SimulatorRunResult,
} from "./kernel/run.js";

export { simulatorLayer, type SimulatorLayerOptions } from "./layer.js";
export {
  EffectRuntimeStartFailed,
  effectRuntime,
  type EffectMessageContext,
  type EffectMessageReply,
  type EffectRuntimeOptions,
} from "./runtime/effect.js";
export {
  openClawRuntime,
  type OpenClawRuntimeAcquisitionError,
  type OpenClawRuntimeOptions,
} from "./runtime/openclaw/runtime.js";
export {
  nanoclawRuntime,
  type NanoclawRuntimeAcquisitionError,
  type NanoclawRuntimeOptions,
} from "./runtime/nanoclaw/runtime.js";
export { RuntimeAcquisitionFailed } from "./runtime/process.js";
export type { InstallMode } from "./runtime/packages.js";
