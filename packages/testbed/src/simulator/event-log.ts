/**
 * @file EventLog (contract 5, event half): the single ordered event
 * stream. One writer owns the log; scheduler, lifecycle, fault, span,
 * transcript, and proxy sources enqueue into one queue; the owner stamps
 * `logicalSequence` / `logicalTime` on drain. `logicalSequence` values
 * are unique and strictly increasing. At termination the queue is drained
 * and the log is sealed; enqueues after seal fail with `EventLogSealed`.
 * Checkpoints are drain boundaries.
 *
 * Field-presence rules (invariant 5) are encoded per event class:
 * `episodeId` present exactly on episode-scoped classes, `causationId`
 * required exactly on caused classes, `correlationId` required exactly on
 * multi-event-exchange classes.
 *
 * ```mermaid
 * flowchart LR
 *   SCH[scheduler] --> Q[one MPSC queue]
 *   LIF[lifecycle] --> Q
 *   FLT[fault executor] --> Q
 *   SPN[OTLP receiver] --> Q
 *   TRX[transcript drain] --> Q
 *   PXY[MCP logging proxy] --> Q
 *   Q --> W[single writer: stamp sequence + logicalTime]
 *   W --> S[EventSink append batch]
 *   W --> C[checkpoint at drain boundary]
 * ```
 */
import { Schema, type Effect, type Scope } from "effect";
import {
  CorrelationId,
  EpisodeId,
  LogicalSequence,
  RunId,
  WallTimeMs,
} from "./ids.js";
import {
  AgentSlotName,
  LogicalTime,
  PrincipalName,
  Seed,
  SpecHash,
} from "./run-spec.js";
import type {
  EventLogSealed,
  RecordingInvalid,
  RecordingStoreFailed,
  SpanAcceptanceLost,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Event envelope building blocks
// ---------------------------------------------------------------------------

/** The closed set of event sources; one queue, many producers, one writer. */
export const EventSource = Schema.Literal(
  "scheduler",
  "lifecycle",
  "fault",
  "span",
  "transcript",
  "proxy",
).annotations({ description: "Producer that enqueued the event" });
export type EventSource = typeof EventSource.Type;

/** Fields every event carries (invariant 5). */
const envelopeFields = {
  runId: RunId,
  logicalSequence: LogicalSequence,
  logicalTime: LogicalTime.annotations({
    description: "Logical-clock time stamped by the writer at drain",
  }),
  wallTime: WallTimeMs.annotations({
    description: "Wall-clock time observed by the producing source",
  }),
} as const;

// ---------------------------------------------------------------------------
// Lifecycle events (run-scoped unless noted)
// ---------------------------------------------------------------------------

/** Root event of every log: the attempt began; the manifest is already persisted. */
export class RunStarted extends Schema.TaggedClass<RunStarted>()(
  "run.started",
  {
    ...envelopeFields,
    source: Schema.Literal("lifecycle"),
    specHash: SpecHash,
    seed: Seed,
  },
) {}

/** The server container reached ready. */
export class ServerStarted extends Schema.TaggedClass<ServerStarted>()(
  "server.started",
  {
    ...envelopeFields,
    source: Schema.Literal("lifecycle"),
    serverUrl: Schema.String.annotations({
      description: "Base server URL agents connect through",
    }),
  },
) {}

/** An agent slot's runtime process was spawned. */
export class AgentLaunched extends Schema.TaggedClass<AgentLaunched>()(
  "agent.launched",
  {
    ...envelopeFields,
    source: Schema.Literal("lifecycle"),
    slot: AgentSlotName,
  },
) {}

/** An agent authenticated against the server (readiness). */
export class AgentReady extends Schema.TaggedClass<AgentReady>()(
  "agent.ready",
  {
    ...envelopeFields,
    source: Schema.Literal("lifecycle"),
    slot: AgentSlotName,
  },
) {}

/** An agent's OS process exited; episode-scoped when it happens mid-episode. */
export class AgentExited extends Schema.TaggedClass<AgentExited>()(
  "agent.exited",
  {
    ...envelopeFields,
    source: Schema.Literal("lifecycle"),
    slot: AgentSlotName,
    exitCode: Schema.NullOr(Schema.Int).annotations({
      description: "Exit code; null when the process died from a signal",
    }),
    episodeId: Schema.optional(EpisodeId),
  },
) {}

/** Drain-boundary checkpoint marker; later rewind builds on these. */
export class Checkpoint extends Schema.TaggedClass<Checkpoint>()("checkpoint", {
  ...envelopeFields,
  source: Schema.Literal("lifecycle"),
}) {}

/** Terminal lifecycle event: the run ended; the seal follows the final drain. */
export class RunTerminated extends Schema.TaggedClass<RunTerminated>()(
  "run.terminated",
  {
    ...envelopeFields,
    source: Schema.Literal("lifecycle"),
    causationId: Schema.optional(
      LogicalSequence.annotations({
        description: "The recorded event that ended the run, when one exists",
      }),
    ),
  },
) {}

/** Reverse teardown finished; `complete` is false when teardown could not fully reverse. */
export class TeardownCompleted extends Schema.TaggedClass<TeardownCompleted>()(
  "teardown.completed",
  {
    ...envelopeFields,
    source: Schema.Literal("lifecycle"),
    complete: Schema.Boolean,
    failures: Schema.Array(Schema.String).annotations({
      description: "Human-readable descriptions of teardown steps that failed",
    }),
  },
) {}

// ---------------------------------------------------------------------------
// Scheduler events (episode-scoped)
// ---------------------------------------------------------------------------

/** The run's episode began (v0: exactly one per run). */
export class EpisodeStarted extends Schema.TaggedClass<EpisodeStarted>()(
  "episode.started",
  {
    ...envelopeFields,
    source: Schema.Literal("scheduler"),
    episodeId: EpisodeId,
  },
) {}

/** Seed task delivered as principal speech (generative; root). */
export class TaskInjected extends Schema.TaggedClass<TaskInjected>()(
  "task.injected",
  {
    ...envelopeFields,
    source: Schema.Literal("scheduler"),
    episodeId: EpisodeId,
    principal: PrincipalName,
    to: AgentSlotName,
    content: Schema.String.annotations({
      description: "Task content, redaction policy applied",
    }),
  },
) {}

/** A seed-derived trigger fired (generative half of the event split; root). */
export class TriggerGenerativeFired extends Schema.TaggedClass<TriggerGenerativeFired>()(
  "trigger.generative-fired",
  {
    ...envelopeFields,
    source: Schema.Literal("scheduler"),
    episodeId: EpisodeId,
    scheduledAtMs: LogicalTime.annotations({
      description: "Seed-derived scheduled logical time",
    }),
  },
) {}

/** A predicate trigger fired on an observed event (never seed-derived; each firing recorded). */
export class TriggerPredicateFired extends Schema.TaggedClass<TriggerPredicateFired>()(
  "trigger.predicate-fired",
  {
    ...envelopeFields,
    source: Schema.Literal("scheduler"),
    episodeId: EpisodeId,
    predicate: Schema.String.annotations({
      description: "Registered predicate driver name",
    }),
    causationId: LogicalSequence.annotations({
      description: "The earlier recorded event the predicate matched",
    }),
  },
) {}

/** The episode ended; termination taxonomy is closed in `recording.ts`. */
export class EpisodeTerminated extends Schema.TaggedClass<EpisodeTerminated>()(
  "episode.terminated",
  {
    ...envelopeFields,
    source: Schema.Literal("scheduler"),
    episodeId: EpisodeId,
    termination: Schema.Literal(
      "completed",
      "agent-crashed",
      "timeout",
      "interrupted",
    ),
    causationId: Schema.optional(
      LogicalSequence.annotations({
        description:
          "The recorded event that terminated the episode, when one exists",
      }),
    ),
  },
) {}

// ---------------------------------------------------------------------------
// Fault events (episode-scoped when mid-episode; correlated as pairs)
// ---------------------------------------------------------------------------

/**
 * A scheduled fault apply executed. A fault whose apply time precedes the
 * target's readiness is neither a crash nor a silent skip: the event
 * records the scheduled apply with effect `target-not-ready`.
 */
export class FaultApplied extends Schema.TaggedClass<FaultApplied>()(
  "fault.applied",
  {
    ...envelopeFields,
    source: Schema.Literal("fault"),
    correlationId: CorrelationId,
    faultKind: Schema.String.annotations({
      description: "Fault vocabulary kind (sever | delay | throttle)",
    }),
    target: AgentSlotName,
    scheduledAtMs: LogicalTime,
    effect: Schema.Literal("applied", "target-not-ready"),
    episodeId: Schema.optional(EpisodeId),
  },
) {}

/** The paired revert (heal) executed; correlates with its apply. */
export class FaultReverted extends Schema.TaggedClass<FaultReverted>()(
  "fault.reverted",
  {
    ...envelopeFields,
    source: Schema.Literal("fault"),
    correlationId: CorrelationId,
    faultKind: Schema.String,
    target: AgentSlotName,
    scheduledAtMs: LogicalTime,
    effect: Schema.Literal("reverted", "was-not-applied"),
    episodeId: Schema.optional(EpisodeId),
  },
) {}

// ---------------------------------------------------------------------------
// Span, transcript, proxy events
// ---------------------------------------------------------------------------

/**
 * A span accepted by the simulator's OTLP receiver. `raw` preserves the
 * exported span verbatim; unknown span kinds are recorded raw, never
 * dropped. The full span body also lands in `traces.json`.
 */
export class SpanAccepted extends Schema.TaggedClass<SpanAccepted>()(
  "span.accepted",
  {
    ...envelopeFields,
    source: Schema.Literal("span"),
    spanName: Schema.String.annotations({
      description: "Span name as exported; unrecognized names pass through",
    }),
    raw: Schema.Unknown.annotations({ description: "Verbatim OTLP span JSON" }),
    episodeId: Schema.optional(EpisodeId),
  },
) {}

/**
 * A society message drained from the server under the observer
 * credential, attributed to its original sender. Observer traffic itself
 * never appears as a society event. `conversationSeq` carries the
 * server's per-conversation delivery order so graders can reconstruct
 * exact conversation order independently of drain timing.
 */
export class TranscriptMessage extends Schema.TaggedClass<TranscriptMessage>()(
  "transcript.message",
  {
    ...envelopeFields,
    source: Schema.Literal("transcript"),
    conversationId: Schema.String.annotations({
      description: "Server conversation identity",
    }),
    conversationSeq: Schema.Int.annotations({
      description: "Server-assigned per-conversation delivery order",
    }),
    senderId: Schema.String.annotations({
      description: "Original sender's agent id",
    }),
    content: Schema.String.annotations({
      description: "Full message content under the redaction policy",
    }),
    deliveredAtWallTime: WallTimeMs.annotations({
      description: "Wall time the server delivered the message",
    }),
    episodeId: Schema.optional(EpisodeId),
  },
) {}

/** A tool call captured at the MCP logging proxy (calls never traverse moltzap). */
export class ToolCallRequested extends Schema.TaggedClass<ToolCallRequested>()(
  "proxy.tool-call",
  {
    ...envelopeFields,
    source: Schema.Literal("proxy"),
    correlationId: CorrelationId,
    slot: AgentSlotName,
    mount: Schema.String.annotations({ description: "MCP server mount name" }),
    tool: Schema.String.annotations({ description: "Tool name invoked" }),
    args: Schema.Unknown.annotations({
      description: "Tool arguments under the redaction policy",
    }),
    episodeId: Schema.optional(EpisodeId),
  },
) {}

/** The paired tool result; byte-identical to what the runtime received (proxy transparency). */
export class ToolCallCompleted extends Schema.TaggedClass<ToolCallCompleted>()(
  "proxy.tool-result",
  {
    ...envelopeFields,
    source: Schema.Literal("proxy"),
    correlationId: CorrelationId,
    slot: AgentSlotName,
    mount: Schema.String,
    tool: Schema.String,
    result: Schema.Unknown.annotations({
      description: "Tool result under the redaction policy",
    }),
    isError: Schema.Boolean.annotations({
      description: "Whether the MCP server returned an error result",
    }),
    episodeId: Schema.optional(EpisodeId),
  },
) {}

// ---------------------------------------------------------------------------
// The event union
// ---------------------------------------------------------------------------

/** Every line of `events.ndjson` decodes against this union. */
const SimulatorEvent = Schema.Union(
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
);
export type SimulatorEvent = typeof SimulatorEvent.Type;

/** An event as a source enqueues it: the writer stamps `runId`, `logicalSequence`, `logicalTime` on drain. */
export type PendingEvent = SimulatorEvent extends infer E
  ? E extends SimulatorEvent
    ? Omit<E, "runId" | "logicalSequence" | "logicalTime">
    : never
  : never;

/** Boundary decoder for one `events.ndjson` line (graders, `recording validate | events`). */
export function decodeEventLine(
  _line: string,
): Effect.Effect<SimulatorEvent, RecordingInvalid, never> {
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- interface stub; the signature is the contract, the body is downstream
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// EventLog contract
// ---------------------------------------------------------------------------

/** Logical clock read by the writer at drain; the episode scheduler owns advancement. */
export interface LogicalClock {
  now(): LogicalTime;
}

/** Byte-level sink the writer appends drained batches to (satisfied by `RecordingStore`). */
export interface EventSink {
  appendEvents(
    lines: ReadonlyArray<string>,
  ): Effect.Effect<void, RecordingStoreFailed, never>;
}

export type SealSummary = {
  readonly finalLogicalSequence: LogicalSequence;
  readonly eventCount: number;
};

/**
 * Handle every source enqueues through. `seal` closes the queue, drains
 * the remainder, appends the final checkpoint, and returns the final
 * sequence; the recording marker write follows in `RecordingStore.seal`.
 */
export interface EventLogHandle {
  enqueue(event: PendingEvent): Effect.Effect<void, EventLogSealed, never>;
  seal(): Effect.Effect<SealSummary, RecordingStoreFailed, never>;
}

/** Create the single-writer event log for one run. */
export function makeEventLog(_deps: {
  readonly runId: RunId;
  readonly clock: LogicalClock;
  readonly sink: EventSink;
}): Effect.Effect<EventLogHandle, never, Scope.Scope> {
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- interface stub; the signature is the contract, the body is downstream
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// OTLP receiver (trace-capture fold)
// ---------------------------------------------------------------------------

export type OtlpReceiverHandle = {
  /** OTLP/HTTP endpoint the server container exports spans to. */
  readonly endpoint: string;
};

/**
 * Bring up the per-run OTLP receiver. A span is accepted when the
 * receiver acknowledges the export request carrying it; accepted spans
 * reach the recording before seal. Bind failure or an acknowledgment
 * stall longer than `failBoundMs` fails the run with
 * `SpanAcceptanceLost`.
 */
export function makeOtlpReceiver(_deps: {
  readonly log: EventLogHandle;
  readonly failBoundMs: number;
}): Effect.Effect<OtlpReceiverHandle, SpanAcceptanceLost, Scope.Scope> {
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- interface stub; the signature is the contract, the body is downstream
  throw new Error("not implemented");
}
