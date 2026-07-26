/**
 * @file The recording-backed cc-judge binding: a dist file beside
 * `trace-capture-harness.ts`, deliberately not an export-map entry.
 *
 * cc-judge's loaded-plan contract is `load(args)` returning a plan, a
 * harness, and a coordinator, where the harness runs for effect only and
 * a custom coordinator produces the judgment bundle. The online adapter already
 * uses that shape; this one differs only in where the evidence comes
 * from — a sealed directory instead of a live server — so the harness is
 * inert and the coordinator does all the work.
 *
 * The bundle mapping is this file's own. `buildTraceBundle` cannot serve
 * it: its inputs are a live payload, wall-clock stamps taken as the run
 * ends, and per-conversation participants. A recording has none of those
 * live inputs; every field here comes from the sealed manifest, result,
 * and timeline instead.
 *
 * Outcome policy is binary because cc-judge's pipeline is binary. On
 * coordinator success the bundle is judged; on failure a deterministic
 * failed record is emitted and nothing is judged. There is no
 * judged-but-flagged middle, so a run that never completed is refused
 * here rather than scored — and under the shipped recipe it never gets
 * this far, because preflight refuses it at exit 14 first.
 */
import { Data, Effect, Option, Schema } from "effect";
import { absurd } from "effect/Function";
import {
  openRecording,
  type EpisodeTermination,
  type GradeableRecording,
  type JsonValue,
  type RunOutcome,
} from "./grader.js";

/** Placeholder image for slots the coordinator never launches. */
const PLACEHOLDER_IMAGE = "managed/by-moltzap-recording";

type PlanEnvelope = {
  readonly project: string;
  readonly scenarioId: string;
  readonly name: string;
  readonly description: string;
  readonly requirements: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

type HarnessLoadArgs = {
  readonly sourcePath: string;
  readonly plan: PlanEnvelope;
  readonly payload: unknown;
};

/** cc-judge folds a coordinator failure into a deterministic failed record. */
class RunCoordinationError extends Data.TaggedError("RunCoordinationError")<{
  readonly message: string;
}> {}

type HarnessFailure = { readonly cause: RunCoordinationError };

function coordinationFailure(message: string): HarnessFailure {
  return { cause: new RunCoordinationError({ message }) };
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

type RecordingPayload = {
  readonly recording: string;
  readonly condition: string | null;
};

function decodePayload(
  sourcePath: string,
  payload: unknown,
): Effect.Effect<RecordingPayload, HarnessFailure, never> {
  if (typeof payload !== "object" || payload === null) {
    return Effect.fail(
      coordinationFailure(
        `${sourcePath}: harness.payload must be an object carrying { recording }.`,
      ),
    );
  }
  const recording = "recording" in payload ? payload.recording : undefined;
  if (typeof recording !== "string" || recording.length === 0) {
    return Effect.fail(
      coordinationFailure(
        `${sourcePath}: harness.payload.recording must be the path of a sealed recording directory.`,
      ),
    );
  }
  const condition =
    "condition" in payload && typeof payload.condition === "string"
      ? payload.condition
      : null;
  return Effect.succeed({ recording, condition });
}

// ---------------------------------------------------------------------------
// Judgment bundle
// ---------------------------------------------------------------------------

/**
 * cc-judge's judgment-bundle grammar, restated here for the same reason
 * `cc-judge-bundle-plan.ts` restates its plan grammar: a consumer's
 * vocabulary lives in that consumer's own adapter, never on `./grader`.
 * It covers the fields this adapter emits, under the constraints cc-judge
 * places on them.
 *
 * It is decoded, not merely typed, because cc-judge decodes a bundle only
 * on its own default-coordinator path — a custom coordinator's bundle
 * reaches the judge unchecked. This decode is therefore the only place a
 * bundle the judge cannot read is still refused instead of graded, which
 * is the same promise the outcome policy makes: invalidity is a refusal,
 * never a verdict.
 */
const TraceEvent = Schema.Struct({
  type: Schema.Literal("message"),
  from: Schema.String,
  channel: Schema.String,
  text: Schema.String,
  ts: Schema.Number,
});
type TraceEvent = typeof TraceEvent.Type;

const AgentRef = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
  metadata: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});
type AgentRef = typeof AgentRef.Type;

/** cc-judge's lifecycle vocabulary; a recording's terminations map onto it. */
const AgentLifecycleStatus = Schema.Literal(
  "completed",
  "timed_out",
  "failed_to_start",
  "runtime_error",
  "cancelled",
);
type AgentLifecycleStatus = typeof AgentLifecycleStatus.Type;

const AgentOutcome = Schema.Struct({
  agentId: Schema.NonEmptyString,
  status: AgentLifecycleStatus,
  startedAt: Schema.String,
  endedAt: Schema.String,
});
type AgentOutcome = typeof AgentOutcome.Type;

const JudgmentBundleShape = Schema.Struct({
  runId: Schema.NonEmptyString,
  project: Schema.NonEmptyString,
  scenarioId: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  description: Schema.String,
  requirements: Schema.Struct(
    {
      expectedBehavior: Schema.String,
      validationChecks: Schema.Array(Schema.NonEmptyString),
    },
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
  agents: Schema.NonEmptyArray(AgentRef),
  events: Schema.Array(TraceEvent),
  context: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  outcomes: Schema.NonEmptyArray(AgentOutcome),
});

/**
 * The bundle as this adapter assembles it. `requirements` is the one field
 * it cannot prove at construction — it arrives from the plan document — so
 * it stays an untyped bag here and is proved by the decode.
 */
type JudgmentBundle = {
  readonly runId: string;
  readonly project: string;
  readonly scenarioId: string;
  readonly name: string;
  readonly description: string;
  readonly requirements: Readonly<Record<string, unknown>>;
  readonly agents: ReadonlyArray<AgentRef>;
  readonly events: ReadonlyArray<TraceEvent>;
  readonly context: Readonly<Record<string, unknown>>;
  readonly outcomes: ReadonlyArray<AgentOutcome>;
};

/**
 * A protocol message body, as far as the judge's message grammar reads it.
 * Bodies whose parts carry no text — tool calls, attachments — are handed
 * over verbatim rather than dropped: a transcript row the judge never sees
 * reads to it as a turn that never happened.
 */
const MessageBody = Schema.Struct({
  parts: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      text: Schema.optional(Schema.String),
    }),
  ),
});

function messageText(message: JsonValue): string {
  const verbatim = JSON.stringify(message);
  return Option.match(Schema.decodeUnknownOption(MessageBody)(message), {
    onNone: () => verbatim,
    onSome: (body) => {
      const text = body.parts
        .flatMap((part) =>
          part.type === "text" && part.text !== undefined ? [part.text] : [],
        )
        .join("\n");
      return text.length === 0 ? verbatim : text;
    },
  });
}

function eventsOf(recording: GradeableRecording): ReadonlyArray<TraceEvent> {
  const events: Array<TraceEvent> = [];
  for (const event of recording.timeline) {
    if (event._tag !== "transcript.message") continue;
    events.push({
      type: "message",
      from: recording.senders.get(event.senderId) ?? event.senderId,
      channel: event.conversationId,
      text: messageText(event.message),
      ts: event.createdAtWallTime,
    });
  }
  return events;
}

function agentsOf(recording: GradeableRecording): ReadonlyArray<AgentRef> {
  return recording.manifest.slots.map((slot) => ({
    id: slot.agent,
    name: slot.agent,
    metadata: {
      runtimeKind: slot.runtimeKind,
      modelId: slot.modelId ?? null,
      isolation: slot.isolation,
    },
  }));
}

function terminationStatus(
  termination: EpisodeTermination,
): AgentLifecycleStatus {
  switch (termination) {
    case "completed":
      return "completed";
    case "timeout":
      return "timed_out";
    case "agent-crashed":
      return "runtime_error";
    case "interrupted":
      return "cancelled";
    default:
      return absurd(termination);
  }
}

/**
 * The recipe admits only `completed` runs, so the other arms never fire
 * today. The mapping is total anyway: loosening the outcome policy must
 * not be able to relabel a crashed run as a completed one.
 */
function lifecycleStatus(outcome: RunOutcome): AgentLifecycleStatus {
  switch (outcome._tag) {
    case "episode":
      return terminationStatus(outcome.termination);
    case "infrastructure-failure":
      return "failed_to_start";
    default:
      return absurd(outcome);
  }
}

function outcomesOf(
  recording: GradeableRecording,
  startedAt: string,
  endedAt: string,
): ReadonlyArray<AgentOutcome> {
  const status = lifecycleStatus(recording.result.outcome);
  return recording.manifest.slots.map((slot) => ({
    agentId: slot.agent,
    status,
    startedAt,
    endedAt,
  }));
}

function contextOf(
  recording: GradeableRecording,
): Readonly<Record<string, unknown>> {
  return {
    recording: {
      path: recording.path,
      specHash: recording.manifest.specHash,
      seed: recording.manifest.seed,
      attemptId: recording.manifest.attemptId,
      condition: recording.manifest.materializedSpec.condition?.label ?? null,
      outcome: recording.result.outcome,
    },
  };
}

/**
 * Epoch milliseconds as ISO-8601. `Date` covers ±8.64e15 ms around the
 * epoch and yields an invalid instant outside it, so a stamp that far out
 * is refused here instead of escaping as a `toISOString` throw.
 */
function isoTime(
  field: string,
  wallTime: number,
): Effect.Effect<string, HarnessFailure, never> {
  const at = new Date(wallTime);
  return Number.isNaN(at.getTime())
    ? Effect.fail(
        coordinationFailure(
          `${field} is ${String(wallTime)}, which is not a representable instant. The recording's clock stamps are corrupt, so its run has no timeline a grader can report.`,
        ),
      )
    : Effect.succeed(at.toISOString());
}

function buildBundle(
  plan: PlanEnvelope,
  recording: GradeableRecording,
): Effect.Effect<JudgmentBundle, HarnessFailure, never> {
  return Effect.gen(function* () {
    const startedAt = yield* isoTime(
      "manifest.createdAtWallTime",
      recording.manifest.createdAtWallTime,
    );
    const endedAt = yield* isoTime(
      "result.endedAtWallTime",
      recording.result.endedAtWallTime,
    );
    const bundle: JudgmentBundle = {
      runId: recording.manifest.runId,
      project: plan.project,
      scenarioId: plan.scenarioId,
      name: plan.name,
      description: plan.description,
      requirements: plan.requirements,
      agents: agentsOf(recording),
      events: eventsOf(recording),
      context: contextOf(recording),
      outcomes: outcomesOf(recording, startedAt, endedAt),
    };
    yield* Schema.decodeUnknown(JudgmentBundleShape)(bundle).pipe(
      Effect.mapError((cause) =>
        coordinationFailure(
          `${recording.path} does not yield a bundle cc-judge can read: ${cause.message} Fix the mapping in this adapter; a bundle the judge cannot read comes back as an agent-failure verdict, not as a decode error.`,
        ),
      ),
    );
    return bundle;
  });
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

function executeRecordingRun(
  plan: PlanEnvelope,
  payload: RecordingPayload,
): Effect.Effect<JudgmentBundle, HarnessFailure, never> {
  return openRecording(payload.recording, {
    condition: payload.condition,
    outcome: "completed-only",
  }).pipe(
    Effect.mapError((error) =>
      coordinationFailure(
        error._tag === "RunNotCompleted"
          ? `${error.message} Preflight (exit 14) is where this check belongs; the recipe refuses such a recording before cc-judge starts.`
          : error.message,
      ),
    ),
    Effect.flatMap((recording) => buildBundle(plan, recording)),
  );
}

function createCoordinator(payload: RecordingPayload) {
  return {
    execute(
      plan: PlanEnvelope,
    ): Effect.Effect<JudgmentBundle, HarnessFailure, never> {
      return executeRecordingRun(plan, payload);
    },
  };
}

function buildPlan(args: HarnessLoadArgs, recordingPath: string) {
  return {
    project: args.plan.project,
    scenarioId: args.plan.scenarioId,
    name: args.plan.name,
    description: args.plan.description,
    agents: [
      {
        id: "recording",
        name: "recording",
        role: "target",
        artifact: {
          _tag: "DockerImageArtifact",
          image: PLACEHOLDER_IMAGE,
          pullPolicy: "never",
        },
        promptInputs: {},
      },
    ],
    requirements: args.plan.requirements,
    metadata: {
      ...args.plan.metadata,
      harness: "moltzap-recording",
      recording: recordingPath,
    },
  };
}

const recordingHarness = {
  load(args: HarnessLoadArgs) {
    return decodePayload(args.sourcePath, args.payload).pipe(
      Effect.map((payload) => ({
        plan: buildPlan(args, payload.recording),
        harness: {
          name: "moltzap-recording",
          run: () =>
            Effect.fail(
              coordinationFailure(
                "Recording-backed plans grade through the custom coordinator; the harness executes nothing.",
              ),
            ),
        },
        coordinator: createCoordinator(payload),
      })),
    );
  },
};

export default recordingHarness;
