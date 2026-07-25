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
import { NodeHttpServer } from "@effect/platform-node";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import {
  Chunk,
  Deferred,
  Duration,
  Effect,
  Option,
  PubSub,
  Queue,
  Schema,
  Stream,
  type Scope,
} from "effect";
import {
  CorrelationId,
  EpisodeId,
  LogicalSequence,
  RunId,
  WallTimeMs,
  wallTimeNow,
} from "./ids.js";
import {
  AgentName,
  FaultKind,
  JsonValue,
  LogicalTime,
  PrincipalName,
  Seed,
  SpecHash,
  isJsonRecord,
  serializeJsonCanonical,
} from "./run-spec.js";
import {
  CapturedSpan,
  RECORDING_SCHEMA_VERSION,
  TracesJson,
  type Secrets,
} from "./recording.js";
import {
  EventLogSealed,
  RecordingInvalid,
  TraceCaptureFailed,
  TranscriptDrainFailed,
  type RecordingStoreFailed,
} from "./errors.js";
import { makeNodeServer } from "./node-http.js";
import { readSocietyMessages, type StoredMessageRow } from "./node-pglite.js";

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
    agent: AgentName,
    agentId: Schema.String.annotations({
      description:
        "Server-registered agent identity provisioned for the slot; relates lifecycle events to transcript senders",
    }),
  },
) {}

/** An agent authenticated against the server (readiness). */
export class AgentReady extends Schema.TaggedClass<AgentReady>()(
  "agent.ready",
  {
    ...envelopeFields,
    source: Schema.Literal("lifecycle"),
    agent: AgentName,
    agentId: Schema.String.annotations({
      description:
        "Server-registered agent identity provisioned for the slot; relates lifecycle events to transcript senders",
    }),
  },
) {}

/** An agent's OS process exited; episode-scoped when it happens mid-episode. */
export class AgentExited extends Schema.TaggedClass<AgentExited>()(
  "agent.exited",
  {
    ...envelopeFields,
    source: Schema.Literal("lifecycle"),
    agent: AgentName,
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
    to: AgentName,
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
    faultKind: FaultKind,
    target: AgentName,
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
    faultKind: FaultKind,
    target: AgentName,
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
    raw: JsonValue.annotations({ description: "Verbatim OTLP span JSON" }),
    episodeId: Schema.optional(EpisodeId),
  },
) {}

/**
 * A society message drained from the server's storage, attributed to its
 * original sender. Observer traffic itself never appears as a society
 * event. `conversationSeq` is the server's storage-level per-conversation
 * **persistence** sequence (the wire list API does not expose it; the v0
 * drain reads storage, which does). Per-recipient delivery order and
 * delivery wall times are not in storage; that evidence is graded from
 * the captured `moltzap.message.delivered` spans in `traces.json`,
 * relatable to transcript events by message id. `message` preserves the
 * wire message losslessly (multipart body, message id, reply target,
 * tags) under the redaction policy.
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
      description: "Storage-level per-conversation persistence sequence",
    }),
    senderId: Schema.String.annotations({
      description: "Original sender's agent id",
    }),
    message: JsonValue.annotations({
      description:
        "The protocol message verbatim (all parts and metadata), redaction applied",
    }),
    createdAtWallTime: WallTimeMs.annotations({
      description:
        "Storage creation time; delivery evidence lives in the delivered spans",
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
    agent: AgentName,
    mount: Schema.String.annotations({ description: "MCP server mount name" }),
    tool: Schema.String.annotations({ description: "Tool name invoked" }),
    args: JsonValue.annotations({
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
    agent: AgentName,
    mount: Schema.String,
    tool: Schema.String,
    result: JsonValue.annotations({
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

/**
 * Boundary decoder for one already-parsed event value. A store that hands
 * back parsed JSON decodes through this rather than re-serializing to
 * reach `decodeEventLine`.
 */
export function decodeEvent(
  value: unknown,
): Effect.Effect<SimulatorEvent, RecordingInvalid, never> {
  return Schema.decodeUnknown(SimulatorEvent)(value).pipe(
    Effect.catchTag("ParseError", (cause) =>
      Effect.fail(eventLineNotDecodable(cause)),
    ),
  );
}

/** Boundary decoder for one `events.ndjson` line (graders, `recording check | events`). */
export function decodeEventLine(
  line: string,
): Effect.Effect<SimulatorEvent, RecordingInvalid, never> {
  return Effect.try({
    try: (): unknown => JSON.parse(line),
    catch: eventLineNotJson,
  }).pipe(Effect.flatMap(decodeEvent));
}

const EVENTS_FILE = "events.ndjson";

function eventLineNotJson(cause: unknown): RecordingInvalid {
  return new RecordingInvalid({
    file: EVENTS_FILE,
    issues: [{ path: [], message: String(cause) }],
    message:
      "The event line is not JSON; the recording is unreadable at this line.",
  });
}

function eventLineNotDecodable(cause: {
  readonly message: string;
}): RecordingInvalid {
  return new RecordingInvalid({
    file: EVENTS_FILE,
    issues: [{ path: [], message: cause.message }],
    message:
      "The event line does not decode against any event class; the recording does not match this reader's schema.",
  });
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
 * Handle every source enqueues through. `enqueue` resolves at drain with
 * the stamped `logicalSequence`, so producers that need the assigned
 * position (the OTLP receiver pairing spans, predicate causation) get it
 * from the acknowledgment. `awaitFailure` resolves only if the writer's
 * sink fails mid-run; `run` races it against episode termination.
 * `seal` closes the queue, drains the remainder, appends the final
 * checkpoint, and returns the final sequence; the recording marker write
 * follows in `RecordingStore.seal`.
 */
export interface EventLog {
  enqueue(
    event: PendingEvent,
  ): Effect.Effect<LogicalSequence, EventLogSealed, never>;
  awaitFailure(): Effect.Effect<never, RecordingStoreFailed, never>;
  seal(): Effect.Effect<SealSummary, RecordingStoreFailed, never>;
}

/** Create the single-writer event log for one run; the writer redacts at serialization. */
export function makeEventLog(deps: {
  readonly runId: RunId;
  readonly clock: LogicalClock;
  readonly sink: EventSink;
  readonly secrets: Secrets;
}): Effect.Effect<EventLog, never, Scope.Scope> {
  return Effect.gen(function* () {
    const ctx: WriterContext = {
      deps,
      intake: yield* Queue.unbounded<WriterEntry>(),
      failure: yield* Deferred.make<never, RecordingStoreFailed>(),
      taps: yield* PubSub.unbounded<SimulatorEvent>(),
      state: { sealRequested: false, nextSequence: 0, eventCount: 0 },
    };
    yield* Effect.forkScoped(writerLoop(ctx));
    const log: EventLog = {
      enqueue: (event) => enqueueEvent(ctx, event),
      awaitFailure: () => Deferred.await(ctx.failure),
      seal: () => sealLog(ctx),
    };
    registerEventTaps(log, ctx.taps);
    return log;
  }).pipe(Effect.withSpan("makeEventLog"));
}

type SealRequest = {
  readonly _tag: "seal";
  readonly done: Deferred.Deferred<SealSummary, RecordingStoreFailed>;
};

type WriterEntry =
  | {
      readonly _tag: "event";
      readonly pending: PendingEvent;
      readonly ack: Deferred.Deferred<LogicalSequence, never>;
    }
  | SealRequest;

type WriterContext = {
  readonly deps: {
    readonly runId: RunId;
    readonly clock: LogicalClock;
    readonly sink: EventSink;
    readonly secrets: Secrets;
  };
  readonly intake: Queue.Queue<WriterEntry>;
  readonly failure: Deferred.Deferred<never, RecordingStoreFailed>;
  readonly taps: PubSub.PubSub<SimulatorEvent>;
  readonly state: {
    sealRequested: boolean;
    nextSequence: number;
    eventCount: number;
  };
};

type StampedLine = { readonly stamped: SimulatorEvent; readonly line: string };

/**
 * Pending fields carry the same runtime representation as the encoded
 * side, so one decode both validates and constructs the event class with
 * the writer-stamped envelope; the line is the redacted canonical form.
 */
function stampAndSerialize(
  ctx: WriterContext,
  pending: PendingEvent,
): StampedLine {
  const sequence = ctx.state.nextSequence;
  ctx.state.nextSequence += 1;
  ctx.state.eventCount += 1;
  const stamped = Schema.decodeUnknownSync(SimulatorEvent)({
    ...pending,
    runId: ctx.deps.runId,
    logicalSequence: sequence,
    logicalTime: ctx.deps.clock.now(),
  });
  const encodedJson = Schema.decodeUnknownSync(JsonValue)(
    Schema.encodeSync(SimulatorEvent)(stamped),
  );
  const line = serializeJsonCanonical(ctx.deps.secrets.redactJson(encodedJson));
  return { stamped, line };
}

type DrainedBatch = {
  readonly stamped: Array<StampedLine>;
  readonly acks: Array<{
    readonly ack: Deferred.Deferred<LogicalSequence, never>;
    readonly sequence: LogicalSequence;
  }>;
  readonly sealEntry: SealRequest | undefined;
};

/**
 * Checkpoints are drain boundaries: every drained batch ends with one,
 * and the seal's final checkpoint is the last event of the log.
 */
function stampBatch(
  ctx: WriterContext,
  entries: ReadonlyArray<WriterEntry>,
): DrainedBatch {
  const stamped: Array<StampedLine> = [];
  const acks: DrainedBatch["acks"] = [];
  let sealEntry: SealRequest | undefined;
  for (const entry of entries) {
    if (entry._tag === "seal") {
      sealEntry = entry;
      continue;
    }
    const one = stampAndSerialize(ctx, entry.pending);
    stamped.push(one);
    acks.push({ ack: entry.ack, sequence: one.stamped.logicalSequence });
  }
  stamped.push(
    stampAndSerialize(ctx, {
      _tag: "checkpoint",
      source: "lifecycle",
      wallTime: wallTimeNow(),
    }),
  );
  return { stamped, acks, sealEntry };
}

/**
 * Acks resolve at drain either way: the stamp is assigned, and a sink
 * failure surfaces through awaitFailure, sealing the run with reason
 * recording-store-failed rather than failing producers.
 */
function drainBatch(
  ctx: WriterContext,
  entries: ReadonlyArray<WriterEntry>,
): Effect.Effect<boolean, never, never> {
  const batch = stampBatch(ctx, entries);
  return ctx.deps.sink.appendEvents(batch.stamped.map((one) => one.line)).pipe(
    Effect.as(true),
    Effect.catchAll((cause) =>
      Deferred.fail(ctx.failure, cause).pipe(Effect.as(false)),
    ),
    Effect.tap(() =>
      Effect.forEach(
        batch.acks,
        ({ ack, sequence }) => Deferred.succeed(ack, sequence),
        { concurrency: 1, discard: true },
      ),
    ),
    Effect.tap(() =>
      Effect.forEach(
        batch.stamped,
        (one) => PubSub.publish(ctx.taps, one.stamped),
        { concurrency: 1, discard: true },
      ),
    ),
    Effect.flatMap((appended) => resolveSealEntry(ctx, batch, appended)),
  );
}

function resolveSealEntry(
  ctx: WriterContext,
  batch: DrainedBatch,
  appended: boolean,
): Effect.Effect<boolean, never, never> {
  if (batch.sealEntry === undefined) return Effect.succeed(false);
  const done = batch.sealEntry.done;
  if (!appended) {
    return Deferred.await(ctx.failure).pipe(
      Effect.flip,
      Effect.flatMap((failed) => Deferred.fail(done, failed)),
      Effect.as(true),
    );
  }
  return Deferred.succeed(done, {
    finalLogicalSequence: lastSequence(ctx.state.nextSequence),
    eventCount: ctx.state.eventCount,
  }).pipe(Effect.as(true));
}

function writerLoop(ctx: WriterContext): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    let done = false;
    while (!done) {
      const head = yield* Queue.take(ctx.intake);
      const more = Chunk.toReadonlyArray(yield* Queue.takeAll(ctx.intake));
      done = yield* drainBatch(ctx, [head, ...more]);
    }
  });
}

function enqueueEvent(
  ctx: WriterContext,
  event: PendingEvent,
): Effect.Effect<LogicalSequence, EventLogSealed, never> {
  return Effect.gen(function* () {
    if (ctx.state.sealRequested) {
      return yield* Effect.fail(
        new EventLogSealed({
          source: event.source,
          kind: event._tag,
          message: `The log is sealed; a late ${event._tag} from ${event.source} is rejected, never silently dropped.`,
        }),
      );
    }
    const ack = yield* Deferred.make<LogicalSequence, never>();
    yield* Queue.offer(ctx.intake, { _tag: "event", pending: event, ack });
    return yield* Deferred.await(ack);
  });
}

function sealLog(
  ctx: WriterContext,
): Effect.Effect<SealSummary, RecordingStoreFailed, never> {
  return Effect.gen(function* () {
    ctx.state.sealRequested = true;
    const done = yield* Deferred.make<SealSummary, RecordingStoreFailed>();
    yield* Queue.offer(ctx.intake, { _tag: "seal", done });
    return yield* Deferred.await(done);
  });
}

function lastSequence(nextSequence: number): LogicalSequence {
  return Schema.decodeSync(LogicalSequence)(Math.max(0, nextSequence - 1));
}

// ---------------------------------------------------------------------------
// Internal event taps (package-internal, not part of the exported surface)
// ---------------------------------------------------------------------------

const EVENT_TAPS = new WeakMap<EventLog, PubSub.PubSub<SimulatorEvent>>();

function registerEventTaps(
  log: EventLog,
  taps: PubSub.PubSub<SimulatorEvent>,
): void {
  EVENT_TAPS.set(log, taps);
}

/**
 * Observation channel over the drained, stamped event stream. The
 * episode's predicate triggers, done-signal, and inactivity bound read
 * it. Available exactly for logs built by `makeEventLog` (the contract's
 * one v0 implementation); the composition root guarantees that, so a
 * miss is a precondition violation, not an expected failure.
 */
export function getEventTaps(
  log: EventLog,
): Option.Option<Stream.Stream<SimulatorEvent>> {
  const taps = EVENT_TAPS.get(log);
  return taps === undefined
    ? Option.none()
    : Option.some(Stream.fromPubSub(taps));
}

// ---------------------------------------------------------------------------
// OTLP receiver (trace-capture fold)
// ---------------------------------------------------------------------------

/**
 * The per-run OTLP receiver. Owns `traces.json` construction: it enqueues
 * a `span.accepted` event per accepted span, pairs the acknowledged
 * `logicalSequence` with the raw span, and hands the finished file back
 * from `drainTraces` during the draining phase. `awaitFailure` resolves
 * only on a post-bind acknowledgment stall exceeding the configured
 * bound.
 */
export type Receiver = {
  /** OTLP/HTTP endpoint the server container exports spans to. */
  readonly endpoint: string;
  awaitFailure(): Effect.Effect<never, TraceCaptureFailed, never>;
  drainTraces(): Effect.Effect<TracesJson, never, never>;
};

type ReceiverDeps = {
  readonly runId: RunId;
  readonly log: EventLog;
  readonly failBoundMs: number;
  readonly secrets: Secrets;
};

/**
 * Bring up the per-run OTLP receiver. A span is accepted when the
 * receiver acknowledges the export request carrying it; accepted spans
 * reach the recording before seal. Bind failure fails acquisition; an
 * acknowledgment stall longer than `failBoundMs` surfaces through
 * `awaitFailure`. Either way the run seals with `span-acceptance-lost`.
 * `secrets` redacts raw spans both at event enqueue and in the
 * `drainTraces` output, so `traces.json` passes the same hygiene
 * boundary as the event log.
 */
export function makeReceiver(
  deps: ReceiverDeps,
): Effect.Effect<Receiver, TraceCaptureFailed, Scope.Scope> {
  return Effect.gen(function* () {
    const ctx: ReceiverContext = {
      deps,
      failure: yield* Deferred.make<never, TraceCaptureFailed>(),
      captured: [],
    };
    const endpoint = yield* serveReceiver(ctx);
    return {
      endpoint,
      awaitFailure: () => Deferred.await(ctx.failure),
      drainTraces: () => Effect.sync(() => drainedTraces(ctx)),
    };
  }).pipe(Effect.withSpan("makeReceiver"));
}

const RECEIVER_HOST = "127.0.0.1";

type AcceptOutcome = "accepted" | "stalled" | "sealed";

type ReceiverContext = {
  readonly deps: ReceiverDeps;
  readonly failure: Deferred.Deferred<never, TraceCaptureFailed>;
  readonly captured: Array<CapturedSpan>;
};

function stallFailure(deps: ReceiverDeps): TraceCaptureFailed {
  return new TraceCaptureFailed({
    boundMs: deps.failBoundMs,
    phase: "stall",
    message: `The OTLP receiver could not acknowledge an export within ${String(deps.failBoundMs)}ms; the run fails with reason span-acceptance-lost rather than losing spans silently.`,
  });
}

function bindFailure(
  deps: ReceiverDeps,
): (cause: unknown) => TraceCaptureFailed {
  return (cause) =>
    new TraceCaptureFailed({
      boundMs: deps.failBoundMs,
      phase: "bind",
      message: `The OTLP receiver could not bind and serve a local port: ${String(cause)}. Free local ephemeral ports are required to run the simulator.`,
    });
}

function acceptSpan(
  ctx: ReceiverContext,
  span: { readonly name: string; readonly raw: JsonValue },
): Effect.Effect<AcceptOutcome, never, never> {
  const wallTime = wallTimeNow();
  return ctx.deps.log
    .enqueue({
      _tag: "span.accepted",
      source: "span",
      wallTime,
      spanName: span.name,
      raw: span.raw,
    })
    .pipe(
      Effect.map((sequence): AcceptOutcome => {
        ctx.captured.push(
          new CapturedSpan({
            acceptedAtWallTime: wallTime,
            logicalSequence: sequence,
            raw: ctx.deps.secrets.redactJson(span.raw),
          }),
        );
        return "accepted";
      }),
      Effect.timeoutFail({
        duration: Duration.millis(ctx.deps.failBoundMs),
        onTimeout: () => stallFailure(ctx.deps),
      }),
      Effect.catchTag("TraceCaptureFailed", (cause) =>
        Deferred.fail(ctx.failure, cause).pipe(
          Effect.as<AcceptOutcome>("stalled"),
        ),
      ),
      // An export arriving after seal is never acknowledged, so the span
      // is not accepted and the seal guarantee holds; 503 lets a
      // conforming exporter treat it as retryable.
      Effect.catchTag("EventLogSealed", () =>
        Effect.succeed<AcceptOutcome>("sealed"),
      ),
    );
}

function exportHandler(
  ctx: ReceiverContext,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
> {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const spans = extractOtlpSpans(body);
    if (spans === null) {
      return HttpServerResponse.unsafeJson(
        { error: "body is not an OTLP/HTTP JSON trace export" },
        { status: 400 },
      );
    }
    const outcomes = yield* Effect.forEach(
      spans,
      (span) => acceptSpan(ctx, span),
      { concurrency: 1 },
    );
    return outcomes.every((outcome) => outcome === "accepted")
      ? HttpServerResponse.unsafeJson({ partialSuccess: {} })
      : HttpServerResponse.unsafeJson(
          { error: "receiver is not accepting spans" },
          { status: 503 },
        );
  });
}

function serveReceiver(
  ctx: ReceiverContext,
): Effect.Effect<string, TraceCaptureFailed, Scope.Scope> {
  const router = HttpRouter.empty.pipe(
    HttpRouter.post("/v1/traces", exportHandler(ctx)),
    HttpRouter.catchAllCause(() =>
      Effect.succeed(
        HttpServerResponse.unsafeJson(
          { error: "unsupported request" },
          { status: 404 },
        ),
      ),
    ),
  );
  return NodeHttpServer.make(makeNodeServer, {
    port: 0,
    host: RECEIVER_HOST,
  }).pipe(
    Effect.tap((server) => server.serve(router)),
    Effect.map((server) => {
      const address = server.address;
      const port = address._tag === "TcpAddress" ? address.port : 0;
      return `http://${RECEIVER_HOST}:${String(port)}/v1/traces`;
    }),
    Effect.mapError(bindFailure(ctx.deps)),
  );
}

function drainedTraces(ctx: ReceiverContext): TracesJson {
  return new TracesJson({
    recordingSchemaVersion: RECORDING_SCHEMA_VERSION,
    runId: ctx.deps.runId,
    spans: ctx.captured.map(
      (span) =>
        new CapturedSpan({
          acceptedAtWallTime: span.acceptedAtWallTime,
          logicalSequence: span.logicalSequence,
          // Redaction re-runs at drain so secrets registered after
          // capture are covered; redact is a fixpoint.
          raw: ctx.deps.secrets.redactJson(span.raw),
        }),
    ),
  });
}

type OtlpSpan = { readonly name: string; readonly raw: JsonValue };

/**
 * Structural walk of an OTLP/HTTP JSON export
 * (`resourceSpans[].scopeSpans[].spans[]`). Spans pass through verbatim;
 * a body outside that shape, or a span without a string name, rejects
 * the whole export (the exporter retries; nothing is silently dropped).
 */
function extractOtlpSpans(body: unknown): Array<OtlpSpan> | null {
  const decoded = Schema.decodeUnknownOption(JsonValue)(body);
  if (Option.isNone(decoded)) return null;
  const root = decoded.value;
  if (!isJsonRecord(root)) return null;
  const resourceSpans = root["resourceSpans"];
  if (!Array.isArray(resourceSpans)) return null;
  const collected: Array<OtlpSpan> = [];
  for (const resource of resourceSpans) {
    if (!collectResourceSpans(resource, collected)) return null;
  }
  return collected;
}

function collectResourceSpans(
  resource: JsonValue,
  out: Array<OtlpSpan>,
): boolean {
  if (!isJsonRecord(resource)) return false;
  const scopeSpans = resource["scopeSpans"];
  if (scopeSpans === undefined) return true;
  if (!Array.isArray(scopeSpans)) return false;
  return scopeSpans.every((scope) => collectScopeSpans(scope, out));
}

function collectScopeSpans(scope: JsonValue, out: Array<OtlpSpan>): boolean {
  if (!isJsonRecord(scope)) return false;
  const spans = scope["spans"];
  if (spans === undefined) return true;
  if (!Array.isArray(spans)) return false;
  return spans.every((span) => collectSpan(span, out));
}

function collectSpan(span: JsonValue, out: Array<OtlpSpan>): boolean {
  if (!isJsonRecord(span)) return false;
  const name = span["name"];
  if (typeof name !== "string") return false;
  out.push({ name, raw: span });
  return true;
}

// ---------------------------------------------------------------------------
// Transcript drain
// ---------------------------------------------------------------------------

/**
 * Attempt-scoped access to one run's server storage: the host path of the
 * per-run container's data volume. Minted by launch (one run, one world)
 * and carried on `ServerHandle.storage`, so a concurrent
 * attempt's drain can only reach its own server.
 */
export type ServerStorageAccess = {
  readonly volumePath: string;
};

/**
 * Transcript drain for one run. The v0 implementation reads the server
 * container's storage volume at drain points (the storage-level
 * persistence sequence backs `conversationSeq`; the wire list API does
 * not expose it); a live observer-credential drain can replace it without
 * surface change once the protocol exposes an ordering key. `finalSweep`
 * runs in the draining phase, before seal, and guarantees every message
 * the server persisted before episode termination is enqueued.
 * `awaitFailure` resolves only on a mid-run drain failure.
 */
export interface TranscriptDrain {
  finalSweep(): Effect.Effect<void, TranscriptDrainFailed, never>;
  awaitFailure(): Effect.Effect<never, TranscriptDrainFailed, never>;
}

type TranscriptDrainDeps = {
  readonly log: EventLog;
  readonly secrets: Secrets;
  readonly storage: ServerStorageAccess;
};

/**
 * Create the v0 transcript drain over one run's server storage; redaction
 * applied at enqueue. PGlite is single-process, so the volume is read in
 * one post-stop sweep (the shutdown sequence runs it after `teardown`,
 * before the log seals); with no live sweep there is no mid-run failure
 * channel and `awaitFailure` never resolves.
 */
export function makeTranscriptDrain(
  deps: TranscriptDrainDeps,
): Effect.Effect<TranscriptDrain, never, Scope.Scope> {
  return Effect.succeed({
    finalSweep: () => sweepServerStorage(deps),
    awaitFailure: () => Effect.never,
  });
}

function drainFailed(detail: string): TranscriptDrainFailed {
  return new TranscriptDrainFailed({
    detail,
    message: `The transcript drain could not read the server storage volume: ${detail}. The run seals failed; message evidence is incomplete.`,
  });
}

function sweepServerStorage(
  deps: TranscriptDrainDeps,
): Effect.Effect<void, TranscriptDrainFailed, never> {
  return Effect.tryPromise({
    try: () => readSocietyMessages(deps.storage.volumePath),
    catch: (cause) => drainFailed(String(cause)),
  }).pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) => enqueueTranscriptRow(deps.log, row), {
        concurrency: 1,
        discard: true,
      }),
    ),
    Effect.withSpan("TranscriptDrain.finalSweep"),
  );
}

/**
 * The per-run container runs without an at-rest encryption secret, so
 * rows persist plaintext (`dekVersion` 0); an
 * encrypted row means a misconfigured container and fails the sweep
 * rather than dropping evidence. Observer traffic needs no filter: the
 * observer credential only subscribes to presence and never sends
 * messages, so storage holds none of its rows.
 */
function enqueueTranscriptRow(
  log: EventLog,
  row: StoredMessageRow,
): Effect.Effect<void, TranscriptDrainFailed, never> {
  if (row.dekVersion !== 0) {
    return Effect.fail(
      drainFailed(
        `message ${row.id} is encrypted (dekVersion ${String(row.dekVersion)}); the simulator's server container must run without an encryption secret`,
      ),
    );
  }
  return decodeParts(row).pipe(
    Effect.flatMap((parts) =>
      log.enqueue({
        _tag: "transcript.message",
        source: "transcript",
        wallTime: wallTimeNow(),
        conversationId: row.conversationId,
        conversationSeq: row.seq,
        senderId: row.senderId,
        message: transcriptMessageBody(row, parts),
        createdAtWallTime: Schema.decodeSync(WallTimeMs)(row.createdAtMs),
      }),
    ),
    Effect.asVoid,
    // The sweep runs before the log seals by the shutdown sequence; a
    // sealed log here is an ordering violation, surfaced typed.
    Effect.catchTag("EventLogSealed", (cause) =>
      Effect.fail(drainFailed(cause.message)),
    ),
  );
}

function decodeParts(
  row: StoredMessageRow,
): Effect.Effect<JsonValue, TranscriptDrainFailed, never> {
  return Effect.try({
    try: (): unknown => JSON.parse(row.partsText),
    catch: (cause) =>
      drainFailed(`message ${row.id} parts are not JSON: ${String(cause)}`),
  }).pipe(
    Effect.flatMap((parsed) =>
      Schema.decodeUnknown(JsonValue)(parsed).pipe(
        Effect.mapError((cause) =>
          drainFailed(
            `message ${row.id} parts are outside the JSON value space: ${cause.message}`,
          ),
        ),
      ),
    ),
  );
}

/** The wire message preserved losslessly: id, multipart body, reply target, deletion mark. */
function transcriptMessageBody(
  row: StoredMessageRow,
  parts: JsonValue,
): JsonValue {
  return {
    id: row.id,
    parts,
    ...(row.replyToId === null ? {} : { replyToId: row.replyToId }),
    ...(row.isDeleted ? { isDeleted: true } : {}),
  };
}
