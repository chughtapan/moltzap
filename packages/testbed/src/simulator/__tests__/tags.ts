/**
 * @file Named forms of the contractual literals tests assert against
 * (exit tags, outcome tags, closed reason/termination vocabularies,
 * event kinds, error `_tag`s); assertions import these instead of
 * repeating string literals.
 */
export const EXIT = { success: "Success", failure: "Failure" } as const;

export const OUTCOME = {
  episode: "episode",
  infrastructure: "infrastructure-failure",
} as const;

export const TERMINATION = {
  completed: "completed",
  agentCrashed: "agent-crashed",
  timeout: "timeout",
  interrupted: "interrupted",
} as const;

export const REASON = {
  serverLaunchFailed: "server-launch-failed",
  agentLaunchFailed: "agent-launch-failed",
  loggingProxyFailed: "logging-proxy-failed",
  spanAcceptanceLost: "span-acceptance-lost",
  transcriptDrainFailed: "transcript-drain-failed",
  faultRevertFailed: "fault-revert-failed",
  driverCrashed: "driver-crashed",
} as const;

export const EVENT = {
  checkpoint: "checkpoint",
  spanAccepted: "span.accepted",
  agentExited: "agent.exited",
  taskInjected: "task.injected",
  predicateFired: "trigger.predicate-fired",
  episodeTerminated: "episode.terminated",
  faultApplied: "fault.applied",
  faultReverted: "fault.reverted",
  teardownCompleted: "teardown.completed",
  toolCall: "proxy.tool-call",
  toolResult: "proxy.tool-result",
  transcriptMessage: "transcript.message",
} as const;

export const FAULT_EFFECT = {
  applied: "applied",
  targetNotReady: "target-not-ready",
  reverted: "reverted",
  wasNotApplied: "was-not-applied",
} as const;

export const ERROR_TAG = {
  adapterConfigRejected: "AdapterConfigRejected",
  isolationViolation: "IsolationViolation",
  faultUnsupported: "FaultUnsupported",
  unknownDriver: "UnknownDriver",
  eventLogSealed: "EventLogSealed",
  alreadySealed: "AlreadySealed",
  recordingInvalid: "RecordingInvalid",
  recordingUnsealed: "RecordingUnsealed",
  runSpecInvalid: "RunSpecInvalid",
  runNotCompleted: "RunNotCompleted",
  conditionMismatch: "ConditionMismatch",
  recordingSchemaMismatch: "RecordingSchemaMismatch",
  serverLaunchFailed: "ServerLaunchFailed",
  traceCaptureFailed: "TraceCaptureFailed",
  transcriptDrainFailed: "TranscriptDrainFailed",
} as const;

export const SNAPSHOT = {
  queued: "queued",
  live: "live",
  finished: "finished",
  cancelled: "cancelled",
  sealed: "sealed",
  unsealed: "unsealed",
} as const;

export const CANCEL = {
  beforeStart: "CancelledBeforeStart",
  interruptDelivered: "InterruptDelivered",
  alreadyTerminal: "AlreadyTerminal",
} as const;

export const PROVENANCE = { user: "user", default: "default" } as const;
