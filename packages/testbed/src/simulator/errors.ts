/**
 * @file Tagged errors for the simulator surface. Stable `_tag`s are the
 * contract: `--json` output and CLI exit codes key on them, and every
 * message states problem, cause, and fix. Grouped by owning contract;
 * the union types at the bottom are the per-operation error channels.
 */
import { Schema } from "effect";

// ---------------------------------------------------------------------------
// RunSpec / materialization (contract 1, config time)
// ---------------------------------------------------------------------------

/** The spec fails schema decode; `issues` carries path-precise failures. */
export class RunSpecInvalid extends Schema.TaggedError<RunSpecInvalid>()(
  "RunSpecInvalid",
  {
    issues: Schema.Array(
      Schema.Struct({
        path: Schema.Array(Schema.String),
        message: Schema.String,
      }),
    ),
    message: Schema.String,
  },
) {}

/** An adapter rejected a field of its canonical config at config time (fail-fast, invariant 17). */
export class AdapterConfigRejected extends Schema.TaggedError<AdapterConfigRejected>()(
  "AdapterConfigRejected",
  {
    slot: Schema.String,
    runtimeKind: Schema.String,
    field: Schema.String,
    message: Schema.String,
  },
) {}

/** An adversarial role is assigned to a slot without container isolation (invariant 18). */
export class IsolationViolation extends Schema.TaggedError<IsolationViolation>()(
  "IsolationViolation",
  {
    slot: Schema.String,
    message: Schema.String,
  },
) {}

/** A `DriverRef.name` does not resolve against the registered-driver set at config time. */
export class UnknownDriver extends Schema.TaggedError<UnknownDriver>()(
  "UnknownDriver",
  {
    name: Schema.String,
    message: Schema.String,
  },
) {}

/** A registered driver rejected its `DriverRef.config` at config time (fail-fast). */
export class DriverConfigRejected extends Schema.TaggedError<DriverConfigRejected>()(
  "DriverConfigRejected",
  {
    name: Schema.String,
    field: Schema.String,
    message: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// Launch (contract 1, run time)
// ---------------------------------------------------------------------------

/** The server container did not reach ready; the run fails with reason `server-launch-failed`. */
export class ServerLaunchFailed extends Schema.TaggedError<ServerLaunchFailed>()(
  "ServerLaunchFailed",
  {
    imageDigest: Schema.String,
    detail: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * An agent slot failed to launch or reach ready. Partial multi-agent
 * launch tears down already-started agents in reverse order and surfaces
 * this error; the run seals with reason `agent-launch-failed`.
 */
export class AgentLaunchFailed extends Schema.TaggedError<AgentLaunchFailed>()(
  "AgentLaunchFailed",
  {
    slot: Schema.String,
    cause: Schema.Literal(
      "spawn-failed",
      "exited-before-ready",
      "ready-timeout",
    ),
    detail: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * Per-run identity provisioning failed: agent registration or the
 * observer credential could not be minted against the fresh server; the
 * run seals with reason `provisioning-failed`.
 */
export class ProvisioningFailed extends Schema.TaggedError<ProvisioningFailed>()(
  "ProvisioningFailed",
  {
    subject: Schema.String,
    message: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// EnvironmentMount (contract 2)
// ---------------------------------------------------------------------------

/** Mount material could not be prepared or wired into the runtime at spawn time. */
export class MountFailed extends Schema.TaggedError<MountFailed>()(
  "MountFailed",
  {
    slot: Schema.String,
    mount: Schema.String,
    message: Schema.String,
  },
) {}

/** The MCP logging proxy failed to start or broke transparency mid-run. */
export class LoggingProxyFailed extends Schema.TaggedError<LoggingProxyFailed>()(
  "LoggingProxyFailed",
  {
    slot: Schema.String,
    mount: Schema.String,
    message: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// WorldDriver (contract 3)
// ---------------------------------------------------------------------------

/** The fault kind is expressible in the vocabulary but not honored by this implementation (v0: delay, throttle). */
export class FaultUnsupported extends Schema.TaggedError<FaultUnsupported>()(
  "FaultUnsupported",
  {
    faultKind: Schema.String,
    message: Schema.String,
  },
) {}

/** A scheduled fault apply failed against a live target. */
export class FaultApplyFailed extends Schema.TaggedError<FaultApplyFailed>()(
  "FaultApplyFailed",
  {
    faultKind: Schema.String,
    target: Schema.String,
    message: Schema.String,
  },
) {}

/** A scheduled fault revert (heal) failed; the run seals with reason `fault-revert-failed`. */
export class FaultRevertFailed extends Schema.TaggedError<FaultRevertFailed>()(
  "FaultRevertFailed",
  {
    faultKind: Schema.String,
    target: Schema.String,
    message: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// Episode lifecycle (contract 4)
// ---------------------------------------------------------------------------

/** The seed task could not be delivered as principal speech. */
export class TaskInjectionFailed extends Schema.TaggedError<TaskInjectionFailed>()(
  "TaskInjectionFailed",
  {
    principal: Schema.String,
    to: Schema.String,
    message: Schema.String,
  },
) {}

/** A principal or world driver process crashed after readiness; the run seals with reason `driver-crashed`. */
export class DriverCrashed extends Schema.TaggedError<DriverCrashed>()(
  "DriverCrashed",
  {
    driver: Schema.String,
    message: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// EventLog / recording (contract 5)
// ---------------------------------------------------------------------------

/** An enqueue arrived after seal; the event is rejected, never silently dropped. */
export class EventLogSealed extends Schema.TaggedError<EventLogSealed>()(
  "EventLogSealed",
  {
    source: Schema.String,
    kind: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * The OTLP receiver could not accept spans within the configured bound
 * (`timeouts.otlpReceiverFailMs`) or failed to bind at bring-up; the run
 * seals with reason `span-acceptance-lost`.
 */
export class SpanAcceptanceLost extends Schema.TaggedError<SpanAcceptanceLost>()(
  "SpanAcceptanceLost",
  {
    boundMs: Schema.Number,
    phase: Schema.Literal("bind", "stall"),
    message: Schema.String,
  },
) {}

/** The transcript drain could not complete; the run seals with reason `transcript-drain-failed`. */
export class TranscriptDrainFailed extends Schema.TaggedError<TranscriptDrainFailed>()(
  "TranscriptDrainFailed",
  {
    detail: Schema.String,
    message: Schema.String,
  },
) {}

/** The recording store failed before the manifest persisted; the run fails with no recording. */
export class ManifestPersistFailed extends Schema.TaggedError<ManifestPersistFailed>()(
  "ManifestPersistFailed",
  {
    storeRoot: Schema.String,
    message: Schema.String,
  },
) {}

/** A non-seal recording-store write failed after the manifest persisted; sealing is still attempted. */
export class RecordingStoreFailed extends Schema.TaggedError<RecordingStoreFailed>()(
  "RecordingStoreFailed",
  {
    file: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * The seal path itself failed (lock, fsync, result write, or marker
 * publish); the recording necessarily stays unsealed. Surfaced to the
 * invoker; the unsealed recording remains readable for diagnosis.
 */
export class SealFailed extends Schema.TaggedError<SealFailed>()("SealFailed", {
  recordingPath: Schema.String,
  step: Schema.Literal(
    "acquire-lock",
    "fsync-data",
    "write-result",
    "write-marker",
  ),
  message: Schema.String,
}) {}

/**
 * This sealer lost the at-most-once race. `observed` fixes the typed
 * behavior: `marker-present` — the attempt is sealed; the caller reads
 * the winner's single outcome via `read`. `lock-held` — a lock exists
 * with no marker, so no sealed outcome is guaranteed yet: an active
 * winner may be mid-seal, or the lock is a crash tombstone. The caller
 * never writes; classification defers to marker presence on the next
 * observation plus the queue's worker-loss detection — a lock with no
 * marker and no live sealer reads as unsealed (the lock is a tombstone,
 * never a seal). Not a recording failure in either case.
 */
export class SealRaceLost extends Schema.TaggedError<SealRaceLost>()(
  "SealRaceLost",
  {
    recordingPath: Schema.String,
    observed: Schema.Literal("marker-present", "lock-held"),
    message: Schema.String,
  },
) {}

/** A recording file failed schema decode (graders, `recording inspect | validate | events`). */
export class RecordingInvalid extends Schema.TaggedError<RecordingInvalid>()(
  "RecordingInvalid",
  {
    file: Schema.String,
    issues: Schema.Array(
      Schema.Struct({
        path: Schema.Array(Schema.String),
        message: Schema.String,
      }),
    ),
    message: Schema.String,
  },
) {}

/** The recording's schema version does not match this reader; graders hard-fail here. */
export class RecordingSchemaMismatch extends Schema.TaggedError<RecordingSchemaMismatch>()(
  "RecordingSchemaMismatch",
  {
    expected: Schema.Int,
    actual: Schema.Int,
    message: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// Attempts / queue (contract 5 seams)
// ---------------------------------------------------------------------------

/** The attempt id does not exist in the queue's store. */
export class UnknownAttempt extends Schema.TaggedError<UnknownAttempt>()(
  "UnknownAttempt",
  {
    attemptId: Schema.String,
    message: Schema.String,
  },
) {}

/** `retry` was requested on an attempt that is not in a terminal state. */
export class AttemptNotRetryable extends Schema.TaggedError<AttemptNotRetryable>()(
  "AttemptNotRetryable",
  {
    attemptId: Schema.String,
    state: Schema.String,
    message: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// Per-phase error channels
// ---------------------------------------------------------------------------

/** Config-time failures: no run begins, no recording exists. */
export type ConfigTimeError =
  | RunSpecInvalid
  | AdapterConfigRejected
  | IsolationViolation
  | FaultUnsupported
  | UnknownDriver
  | DriverConfigRejected;

/**
 * Infrastructure failures observed after the manifest persists. Each maps
 * to exactly one `InfraFailureReason` in `result.json` (the seal site
 * discriminates exhaustively; an unmapped member is a compile error);
 * sealing is attempted for every member except where the seal path itself
 * is the failure (`SealFailed`).
 */
export type InfraError =
  | ServerLaunchFailed
  | AgentLaunchFailed
  | ProvisioningFailed
  | MountFailed
  | LoggingProxyFailed
  | FaultApplyFailed
  | FaultRevertFailed
  | TaskInjectionFailed
  | DriverCrashed
  | SpanAcceptanceLost
  | TranscriptDrainFailed
  | RecordingStoreFailed;
