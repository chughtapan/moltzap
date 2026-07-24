/**
 * @file Public facade of the simulator surface, exported as
 * `@moltzap/testbed/simulator`: the five public contracts (RunConfig /
 * agent-runner, EnvironmentMount, WorldDriver, Episode lifecycle,
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
  AgentSlotName,
  PrincipalName,
  SpecHash,
  ImageDigest,
  LogicalTime,
  IsolationPosture,
  SlotRole,
  SimulatorRuntimeKind,
  FaultKind,
  OpenClawSlotConfig,
  NanoclawSlotConfig,
  StubSlotConfig,
  RuntimeAssignment,
  McpServerMountSpec,
  AgentSlotSpec,
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
  canonicalJson,
  computeSpecHash,
} from "./run-spec.js";

export {
  type RuntimeExit,
  type SimulatorRuntime,
  type ServerContainerHandle,
  type LaunchedAgent,
  type TeardownReport,
  type LaunchedWorld,
  type LaunchDeps,
  type AgentRunner,
  makeAgentRunner,
} from "./run-config.js";

export {
  type MountPlan,
  type MountHandle,
  type EnvironmentMount,
  makeEnvironmentMount,
} from "./environment-mount.js";

export {
  type AppliedFault,
  type WorldDriver,
  makeWorldDriver,
} from "./world-driver.js";

export {
  type GenerativeSchedule,
  deriveGenerativeSchedule,
  type TaskDelivery,
  type PrincipalDriver,
  type EpisodeDeps,
  type EpisodeController,
  makeEpisodeController,
  type ExecuteRunOptions,
  type SealedAttempt,
  executeRun,
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
  type EventLogHandle,
  makeEventLog,
  type OtlpReceiverHandle,
  makeOtlpReceiver,
  type TranscriptDrain,
  makeTranscriptDrain,
} from "./event-log.js";

export {
  RECORDING_SCHEMA_VERSION,
  RecordingIdentity,
  SlotProvenance,
  ManifestJson,
  EpisodeTermination,
  InfraFailureReason,
  EpisodeOutcome,
  InfraFailureOutcome,
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
  recordingPathFor,
  type SecretRegistry,
  makeSecretRegistry,
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
  type ExperimentQueue,
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
  SpanAcceptanceLost,
  TranscriptDrainFailed,
  ManifestPersistFailed,
  RecordingStoreFailed,
  SealFailed,
  RecordingInvalid,
  RecordingSchemaMismatch,
  UnknownAttempt,
  AttemptNotRetryable,
  type ConfigTimeError,
  type InfraError,
} from "./errors.js";

export {
  StubStep,
  StubRuntimeScript,
  type StubRuntimeOptions,
  createStubRuntime,
} from "./stub-runtime.js";
