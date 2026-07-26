/**
 * @file Public facade of the simulator surface, exported as
 * `@moltzap/testbed/simulator`: the five public contracts (RunConfig /
 * agent-runner, Environment, World, Episode lifecycle,
 * EventLog / recording), the recording schema, and their seams. The
 * package root keeps the pre-simulator testbed surface unchanged.
 */
// safer-arch-ignore no-large-public-surface: the five contracts + recording schema are a spec-defined public surface (chughtapan/moltzap#810); each schema class is contract, not incidental export.
// safer-arch-ignore no-inventory-barrel: every sibling is a contract module of the same spec-defined surface; the facade is the curated contract, not an inventory.
// safer-arch-ignore require-curated-public-facade: the export list is the five-contract surface named by the contract doc; each symbol is spec-traced in the design doc's Interfaces section.

export {
  RunId,
  AttemptId,
  EpisodeId,
  LogicalSequence,
  CorrelationId,
  WallTimeMs,
} from "./ids.js";

export {
  type JsonValue,
  JsonObject,
  Seed,
  AgentName,
  PrincipalName,
  SpecHash,
  ImageDigest,
  LogicalTime,
  RunsIn,
  AgentRole,
  RuntimeKind,
  FaultKind,
  OpenClawConfig,
  NanoclawConfig,
  StubConfig,
  RuntimeAssignment,
  McpServer,
  Agent,
  FaultSpec,
  FaultScheduleEntry,
  WorldSpec,
  DriverRef,
  TaskInjectionSpec,
  OnAgentCrash,
  TerminationPolicySpec,
  EpisodeSpec,
  ConditionDesignation,
  TimeoutsSpec,
  ServerSpec,
  RecordingSpec,
  RunSpec,
  type MaterializedRunSpec,
  type AgentFacingRunSpec,
  type FieldProvenance,
  type MaterializationReport,
  materializeRunSpec,
  type CanonicalJson,
  toCanonicalJson,
  canonicalJson,
  computeSpecHash,
} from "./run-spec.js";

export {
  type RuntimeExit,
  type SimulatorRuntime,
  type ServerHandle,
  type LaunchedAgent,
  type TeardownReport,
  type Society,
  type LaunchDeps,
  type Launcher,
  makeLauncher,
  resolveServerImagePin,
} from "./run-config.js";

export {
  type MountPlan,
  type MountHandle,
  type Environment,
  makeEnvironment,
} from "./environment.js";

export { type AppliedFault, type World, makeWorld } from "./world.js";

export {
  type Schedule,
  makeSchedule,
  type TaskDelivery,
  type Principal,
  type EpisodeDeps,
  type Episode,
  makeEpisode,
  type RunOptions,
  type SealedAttempt,
  run,
} from "./episode.js";

export {
  EventSource,
  RunStarted,
  ServerStarted,
  AgentLaunched,
  AgentReady,
  AgentExited,
  Checkpoint,
  RunTerminated,
  TeardownCompleted,
  EpisodeStarted,
  TaskInjected,
  TriggerGenerativeFired,
  TriggerPredicateFired,
  EpisodeTerminated,
  FaultApplied,
  FaultReverted,
  SpanAccepted,
  TranscriptMessage,
  ToolCallRequested,
  ToolCallCompleted,
  type SimulatorEvent,
  decodeEventLine,
  type PendingEvent,
  type LogicalClock,
  type EventSink,
  type SealSummary,
  type EventLog,
  makeEventLog,
  type Receiver,
  makeReceiver,
  type ServerStorageAccess,
  type TranscriptDrain,
  makeTranscriptDrain,
} from "./event-log.js";

export {
  RECORDING_SCHEMA_VERSION,
  RecordingIdentity,
  AgentProvenance,
  ManifestJson,
  EpisodeTermination,
  FailureReason,
  EpisodeOutcome,
  FailureOutcome,
  type RunOutcome,
  ResultJson,
  CapturedSpan,
  TracesJson,
  Sha256,
  SealMarker,
  type RecordingRef,
  type SealedRecordingRef,
  type RecordingSnapshot,
  type AllocatedAttempt,
  type RecordingStore,
  recordingPath,
  type Secrets,
  makeSecrets,
} from "./recording.js";

export {
  LiveAttemptState,
  TerminalAttemptState,
  QueuedAttempt,
  LiveAttempt,
  FinishedAttempt,
  CancelledAttempt,
  type AttemptSnapshot,
  type CancelOutcome,
  type RunQueue,
  type Runner,
} from "./attempts.js";

export {
  RunSpecInvalid,
  AdapterConfigRejected,
  IsolationViolation,
  UnknownDriver,
  DriverConfigRejected,
  ServerLaunchFailed,
  AgentLaunchFailed,
  ProvisioningFailed,
  MountFailed,
  LoggingProxyFailed,
  FaultUnsupported,
  FaultApplyFailed,
  FaultRevertFailed,
  TaskInjectionFailed,
  DriverCrashed,
  EventLogSealed,
  TraceCaptureFailed,
  TranscriptDrainFailed,
  ManifestPersistFailed,
  RecordingStoreFailed,
  SealFailed,
  AlreadySealed,
  RecordingInvalid,
  RecordingSchemaMismatch,
  UnknownAttempt,
  AttemptNotRetryable,
  type ConfigTimeError,
  type InfraError,
} from "./errors.js";

export {
  StubStep,
  StubScript,
  type StubOptions,
  makeStubRuntime,
} from "./stub-runtime.js";
