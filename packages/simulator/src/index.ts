/** @file Code-first simulator API. */
// safer-arch-ignore no-folder-cycle: The package root is the explicit public composition facade over mutually typed event, ledger, and runtime capabilities.
// safer-arch-ignore no-package-mesh: The simulator is a capability-composition package whose named facades expose the intentional cross-domain contracts used by one run kernel.

/** Re-exports the public API from `./definition.js`. */
export {
  type ClusterServices,
  Run,
  RunSpec,
  SimulatorDefinitionError,
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
  coreEvents,
  LinkDown,
  LinkPolicyCleared,
  LinkPolicySet,
  LinkUp,
  ProgramFailed,
  ProgramInterrupted,
  ProgramSucceeded,
  RouterStarted,
  RouterStartFailed,
  RouterStopFailed,
  RunStarted,
} from "./events/core.js";
/** Re-exports the public API from `./run/events.js`. */
export {
  type CustomerEvents,
  type EventMetadata,
  type ReadableRunLedger,
} from "./run/events.js";

/** Re-exports the public API from `./events/catalog.js`. */
export {
  type EncodedEventOf,
  EventCatalog,
  EventCatalogDefinitionError,
  type EventCatalogDefinitionFailure,
  type EventClass,
  type EventClassOf,
  type EventOf,
  type VersionedEventTag,
} from "./events/catalog.js";
/** Re-exports the public ledger failure contract from its owning domain. */
export type { LedgerFailure } from "./ledger/index.js";

/** Re-exports the compatible experiment-facing network API. */
export {
  type AgentConnection,
  AgentHandle,
  Endpoint,
  LinkController,
  type LinkControllerService,
  type LinkDelivery,
  linkPolicy,
  type LinkPolicy,
  linkVerdict,
  type LinkVerdict,
  Network,
  NetworkError,
  type NetworkService,
  ParticipantHandle,
} from "./network/index.js";

/** Re-exports the public API from `./run/execute.js`. */
export {
  ClusterLost,
  CompletedLedgerReceipt,
  IncompleteLedgerReceipt,
  LedgerReceipt,
  ProgramFinished,
  type SimulatorRunFailure,
  type SimulatorRunOutcome,
} from "./run/execute.js";

/** Re-exports the mechanism-neutral cluster error. */
export { ClusterError } from "./cluster/cluster.js";

/** Re-exports the final line printed by `moltzap-sim run`. */
export { ProfileRunResult } from "./cluster/profiles/result.js";

/** Re-exports the direct-invocation check every shipped entrypoint needs. */
export { isEntryModule } from "./cluster/entry.js";
