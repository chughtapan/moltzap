/**
 * @file `@moltzap/testbed/grader`: the generic code-based grading surface
 * over sealed recordings. It serves any grader that reads recordings and
 * carries no grader's name, types, or vocabulary — a consumer-shaped
 * binding (plan assembly, rubric wiring, verdict bundles) belongs in that
 * consumer's own adapter, which consumes this surface like any other.
 *
 * The division of labour it encodes: **invalidity is a refusal, never a
 * verdict.** A run that never terminated, a recording whose bytes moved
 * after sealing, or evidence produced under different experiment content
 * are all refused here, before a rubric is consulted, so a grader never
 * has to report an invalid run as an agent failure.
 *
 * ```mermaid
 * flowchart LR
 *   R[recording dir] --> O[openRecording: sealed, schema, key, outcome]
 *   O --> M[mergedTimeline: order by logicalSequence]
 *   M --> A[attributeSenders: senderId to agent name]
 *   A --> G[the grader's own bundle and rubric]
 *   B[bundle document] --> P[projectBundle: run half]
 *   P --> S[bare RunSpec for run]
 * ```
 */
import { resolve } from "node:path";
import { Effect, Schema } from "effect";
import { absurd } from "effect/Function";
import { decodeEventLine, type SimulatorEvent } from "./simulator/event-log.js";
import {
  EpisodeTermination,
  FailureReason,
  makeLocalRecordingStore,
  type ManifestJson,
  type ResultJson,
  type RunOutcome,
  type SealMarker,
  type TracesJson,
} from "./simulator/index.js";
import {
  JsonObject,
  type AgentName,
  type JsonValue,
} from "./simulator/run-spec.js";
import {
  RecordingInvalid,
  RecordingUnsealed,
  type RecordingSchemaMismatch,
  type RecordingStoreFailed,
} from "./simulator/errors.js";

// ---------------------------------------------------------------------------
// Convention-level refusals
// ---------------------------------------------------------------------------

/**
 * The recording was produced from different experiment content than the
 * caller holds. The content key moves on task text, persona generation,
 * and environment assumptions — never on a rubric, so re-grading the same
 * recording with a stricter rubric is legal and does not trip this.
 */
export class ContentVersionMismatch extends Schema.TaggedError<ContentVersionMismatch>()(
  "ContentVersionMismatch",
  {
    recordingPath: Schema.String,
    expected: Schema.NonEmptyString,
    observed: Schema.NullOr(Schema.NonEmptyString),
    message: Schema.String,
  },
) {}

/** What a recording sealed instead of an answered episode; closed over the outcome taxonomy. */
const NotCompletedOutcome = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("episode"), termination: EpisodeTermination }),
  Schema.Struct({
    kind: Schema.Literal("infrastructure-failure"),
    reason: FailureReason,
    errorTag: Schema.String,
  }),
);

/**
 * The run is valid evidence of something, but not of how an agent
 * behaved: it timed out, crashed, was interrupted, or never got past
 * infrastructure. Judging it would make a run that never happened
 * indistinguishable from an agent that answered and failed the rubric.
 */
export class RunNotCompleted extends Schema.TaggedError<RunNotCompleted>()(
  "RunNotCompleted",
  {
    recordingPath: Schema.String,
    observed: NotCompletedOutcome,
    message: Schema.String,
  },
) {}

/** The bundle document does not decode against the bundle shape. */
export class BundleInvalid extends Schema.TaggedError<BundleInvalid>()(
  "BundleInvalid",
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

/**
 * The bundle envelope and its run half both name a content key and they
 * disagree. There is no winner: picking one would silently decide which
 * half of the document describes the experiment.
 */
export class ContentVersionConflict extends Schema.TaggedError<ContentVersionConflict>()(
  "ContentVersionConflict",
  {
    envelope: Schema.NonEmptyString,
    spec: Schema.NonEmptyString,
    message: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// openRecording
// ---------------------------------------------------------------------------

/**
 * What a caller requires of a recording before grading it. Both fields
 * are required so the policy is stated rather than defaulted into: a
 * caller that omits the outcome check does not discover the omission when
 * a suite of timeouts reads as a suite of regressions.
 */
export type GradingPreconditions = {
  /** The content key the caller holds, or `null` when it holds none. */
  readonly contentVersion: string | null;
  /** Whether a non-`completed` run is refused or accepted as-is. */
  readonly outcome: "completed-only" | "any";
};

/**
 * A recording that passed the stage-1 checks. `seal` and `result` are
 * non-optional because passing the checks is what proves they exist;
 * under `outcome: "completed-only"` the result is additionally known to
 * be an answered episode.
 */
export type GradeableRecording = {
  readonly path: string;
  readonly manifest: ManifestJson;
  readonly seal: SealMarker;
  readonly result: ResultJson;
  readonly traces: TracesJson | undefined;
  /** Raw `events.ndjson` lines; `mergedTimeline` decodes and orders them. */
  readonly events: ReadonlyArray<JsonValue>;
};

/** Every way stage 1 refuses a recording. */
export type OpenRecordingError =
  | RecordingStoreFailed
  | RecordingUnsealed
  | RecordingSchemaMismatch
  | RecordingInvalid
  | ContentVersionMismatch
  | RunNotCompleted;

/** A recording path is `{storeRoot}/{specHash}/s{seed}/{attemptId}`. */
function storeRootOf(recordingPath: string): string {
  return resolve(recordingPath, "..", "..", "..");
}

/**
 * Open a recording for grading: read it, require the seal, require this
 * reader's schema version, compare the content key, and apply the
 * caller's outcome policy. This is the library half of the same check set
 * the `recording check` verb runs, so the two cannot drift.
 */
export function openRecording(
  path: string,
  preconditions: GradingPreconditions,
): Effect.Effect<GradeableRecording, OpenRecordingError, never> {
  const absolute = resolve(path);
  return Effect.gen(function* () {
    const store = makeLocalRecordingStore(storeRootOf(absolute));
    const snapshot = yield* store.read(absolute);
    if (snapshot.seal === undefined) {
      return yield* Effect.fail(
        new RecordingUnsealed({
          recordingPath: absolute,
          observed: "no-marker",
          message: `${absolute} has no sealed.json, so the attempt never completed its seal. Only a sealed recording is complete evidence; rerun the spec to produce one.`,
        }),
      );
    }
    if (snapshot.result === undefined) {
      return yield* Effect.fail(
        new RecordingInvalid({
          file: "result.json",
          issues: [{ path: [], message: "result.json is missing" }],
          message: `${absolute} carries a seal marker but no result.json. The seal protocol writes the result before the marker, so this recording is inconsistent with its own marker.`,
        }),
      );
    }
    const sealed: GradeableRecording = {
      path: absolute,
      manifest: snapshot.manifest,
      seal: snapshot.seal,
      result: snapshot.result,
      traces: snapshot.traces,
      events: snapshot.events,
    };
    yield* checkContentVersion(sealed, preconditions.contentVersion);
    yield* checkOutcome(sealed, preconditions.outcome);
    return sealed;
  }).pipe(Effect.withSpan("openRecording"));
}

function checkContentVersion(
  recording: GradeableRecording,
  expected: string | null,
): Effect.Effect<void, ContentVersionMismatch, never> {
  if (expected === null) return Effect.void;
  const observed = recording.manifest.contentVersion;
  if (observed === expected) return Effect.void;
  return Effect.fail(
    new ContentVersionMismatch({
      recordingPath: recording.path,
      expected,
      observed: observed ?? null,
      message: `${recording.path} was produced under content version ${observed ?? "(none)"}, and this grading run expects ${expected}. The recording describes different experiment content; grade a recording produced from the same content, or drop the key if the two really are comparable.`,
    }),
  );
}

function checkOutcome(
  recording: GradeableRecording,
  policy: GradingPreconditions["outcome"],
): Effect.Effect<void, RunNotCompleted, never> {
  if (policy === "any") return Effect.void;
  const outcome: RunOutcome = recording.result.outcome;
  switch (outcome._tag) {
    case "episode":
      return outcome.termination === "completed"
        ? Effect.void
        : Effect.fail(
            notCompleted(recording, {
              kind: "episode",
              termination: outcome.termination,
            }),
          );
    case "infrastructure-failure":
      return Effect.fail(
        notCompleted(recording, {
          kind: "infrastructure-failure",
          reason: outcome.reason,
          errorTag: outcome.errorTag,
        }),
      );
    default:
      return absurd(outcome);
  }
}

function notCompleted(
  recording: GradeableRecording,
  observed: typeof NotCompletedOutcome.Type,
): RunNotCompleted {
  const what =
    observed.kind === "episode"
      ? `the episode ended \`${observed.termination}\``
      : `infrastructure ended the run (\`${observed.reason}\`, ${observed.errorTag})`;
  return new RunNotCompleted({
    recordingPath: recording.path,
    observed,
    message: `${recording.path} is not a verdict about an agent: ${what}. Fix the run rather than the rubric — a spec that can end \`completed\` carries a done-signal driver that cannot pre-empt a scheduled step.`,
  });
}

// ---------------------------------------------------------------------------
// mergedTimeline
// ---------------------------------------------------------------------------

/**
 * Decode every event line into one flat timeline ordered by
 * `logicalSequence` — the single total order the writer stamped, across
 * all six producers.
 *
 * `conversationSeq` is not a second ordering axis; it is a consistency
 * check. Within one conversation the server's persistence sequence must
 * increase along that same timeline, and a violation means the two
 * orderings disagree about the same messages. The recording is then the
 * corrupt party, so this fails rather than picking an order.
 */
export function mergedTimeline(
  recording: GradeableRecording,
): Effect.Effect<ReadonlyArray<SimulatorEvent>, RecordingInvalid, never> {
  return Effect.forEach(
    recording.events,
    (line) => decodeEventLine(JSON.stringify(line)),
    { concurrency: 1 },
  ).pipe(
    Effect.map((events) =>
      [...events].sort((left, right) => left.logicalSequence - right.logicalSequence),
    ),
    Effect.tap(checkSequenceUnique),
    Effect.tap(checkConversationSeq),
    Effect.withSpan("mergedTimeline"),
  );
}

function checkSequenceUnique(
  timeline: ReadonlyArray<SimulatorEvent>,
): Effect.Effect<void, RecordingInvalid, never> {
  for (let index = 1; index < timeline.length; index += 1) {
    const previous = timeline[index - 1];
    const current = timeline[index];
    if (previous === undefined || current === undefined) continue;
    if (previous.logicalSequence === current.logicalSequence) {
      return Effect.fail(
        new RecordingInvalid({
          file: "events.ndjson",
          issues: [
            {
              path: ["logicalSequence"],
              message: `sequence ${String(current.logicalSequence)} appears more than once`,
            },
          ],
          message: `events.ndjson repeats logicalSequence ${String(current.logicalSequence)} (${previous._tag}, ${current._tag}). The writer stamps a unique strictly-increasing sequence, so this log was concatenated from two attempts or edited.`,
        }),
      );
    }
  }
  return Effect.void;
}

function checkConversationSeq(
  timeline: ReadonlyArray<SimulatorEvent>,
): Effect.Effect<void, RecordingInvalid, never> {
  const highest = new Map<string, number>();
  for (const event of timeline) {
    if (event._tag !== "transcript.message") continue;
    const previous = highest.get(event.conversationId);
    if (previous !== undefined && event.conversationSeq <= previous) {
      return Effect.fail(
        new RecordingInvalid({
          file: "events.ndjson",
          issues: [
            {
              path: ["conversationSeq"],
              message: `conversation ${event.conversationId} goes ${String(previous)} then ${String(event.conversationSeq)}`,
            },
          ],
          message: `In conversation ${event.conversationId}, storage sequence ${String(event.conversationSeq)} follows ${String(previous)} in logicalSequence order. Persistence order and observation order disagree, so the transcript cannot be reconstructed from this recording.`,
        }),
      );
    }
    highest.set(event.conversationId, event.conversationSeq);
  }
  return Effect.void;
}

// ---------------------------------------------------------------------------
// attributeSenders
// ---------------------------------------------------------------------------

/**
 * Server-registered agent id to the slot name the spec declared. Ids the
 * run never launched — principals speaking into a conversation — are
 * absent by design; a caller that finds no entry is looking at a sender
 * the society did not spawn.
 */
export type SenderAttribution = ReadonlyMap<string, AgentName>;

/**
 * Join transcript senders to agent names through the identities the
 * launcher provisioned, as recorded on `agent.launched` / `agent.ready`.
 * Ids do not exist when the manifest persists, which is why the join
 * reads events rather than the manifest's slots.
 */
export function attributeSenders(
  timeline: ReadonlyArray<SimulatorEvent>,
): Effect.Effect<SenderAttribution, RecordingInvalid, never> {
  const byAgentId = new Map<string, AgentName>();
  for (const event of timeline) {
    if (event._tag !== "agent.launched" && event._tag !== "agent.ready") {
      continue;
    }
    const claimed = byAgentId.get(event.agentId);
    if (claimed !== undefined && claimed !== event.agent) {
      return Effect.fail(
        new RecordingInvalid({
          file: "events.ndjson",
          issues: [
            {
              path: ["agentId"],
              message: `agent id ${event.agentId} is claimed by both ${claimed} and ${event.agent}`,
            },
          ],
          message: `Agent id ${event.agentId} is claimed by slots ${claimed} and ${event.agent}. Provisioning mints one identity per slot, so transcript senders cannot be attributed from this recording.`,
        }),
      );
    }
    byAgentId.set(event.agentId, event.agent);
  }
  return Effect.succeed(byAgentId);
}

// ---------------------------------------------------------------------------
// projectBundle
// ---------------------------------------------------------------------------

/**
 * One experiment in one document: the envelope, the run half (a RunSpec
 * in encoded form), and the grade half (a grader reference plus that
 * grader's own config, which nothing here reads).
 */
export const Bundle = Schema.Struct({
  name: Schema.NonEmptyString.annotations({
    description: "Human-readable experiment name; becomes the grader plan's name",
  }),
  description: Schema.NonEmptyString.annotations({
    description: "What the experiment tests",
  }),
  project: Schema.optional(
    Schema.NonEmptyString.annotations({ description: "Grader project key" }),
  ),
  scenarioId: Schema.optional(
    Schema.NonEmptyString.annotations({
      description: "Scenario identity; defaults to the bundle file stem",
    }),
  ),
  contentVersion: Schema.optional(
    Schema.NonEmptyString.annotations({
      description: "Consumer content key naming the gradeable content, not the rubric",
    }),
  ),
  run: JsonObject.annotations({
    description: "The simulator RunSpec in encoded form",
  }),
  grade: Schema.Struct({
    grader: Schema.NonEmptyString.annotations({
      description: "Grader reference: module path or well-known binary",
    }),
    config: JsonObject.annotations({
      description: "Grader-owned configuration; never interpreted here",
    }),
  }).annotations({ description: "The grade half" }),
}).annotations({ description: "A run and its grader in one document" });
export type Bundle = typeof Bundle.Type;

/** Where the bundle came from; supplies the defaults the document omits. */
export type BundleSource = {
  /** The bundle file's stem, the default `scenarioId`. */
  readonly stem: string;
};

/** The bundle split into the two artifacts the existing tools accept. */
export type ProjectedBundle = {
  readonly envelope: {
    readonly name: string;
    readonly description: string;
    readonly project: string;
    readonly scenarioId: string;
  };
  /** A bare RunSpec, encoded, with the effective content key injected. */
  readonly spec: JsonObject;
  /** Carried through for the grader's own emitter; never read here. */
  readonly grade: { readonly grader: string; readonly config: JsonObject };
  readonly contentVersion: string | undefined;
};

const DEFAULT_PROJECT = "simulator";
const CONTENT_VERSION_FIELD = "contentVersion";

/**
 * Split a bundle into its run half and its carried grade half. Total and
 * mechanical: it moves fields and resolves declared defaults, never reads
 * `grade.config`, and never touches a recording. The emitted spec is a
 * bare RunSpec, which is what keeps the run path bundle-unaware — no
 * consumer's grader half can reach a run.
 */
export function projectBundle(
  input: unknown,
  source: BundleSource,
): Effect.Effect<
  ProjectedBundle,
  BundleInvalid | ContentVersionConflict,
  never
> {
  return Schema.decodeUnknown(Bundle)(input).pipe(
    Effect.catchTag("ParseError", (cause) =>
      Effect.fail(
        new BundleInvalid({
          issues: [{ path: [], message: cause.message }],
          message: `The bundle does not decode against the bundle shape: ${cause.message}. A bundle needs name, description, run, and grade.`,
        }),
      ),
    ),
    Effect.flatMap((bundle) =>
      effectiveContentVersion(bundle).pipe(
        Effect.map((contentVersion) => project(bundle, source, contentVersion)),
      ),
    ),
    Effect.withSpan("projectBundle"),
  );
}

/**
 * The key may be written on the envelope, inside the run half, or both.
 * Agreement resolves to the shared value; disagreement has no winner.
 */
function effectiveContentVersion(
  bundle: Bundle,
): Effect.Effect<string | undefined, ContentVersionConflict, never> {
  const envelope = bundle.contentVersion;
  const inSpec = bundle.run[CONTENT_VERSION_FIELD];
  const spec = typeof inSpec === "string" && inSpec.length > 0 ? inSpec : undefined;
  if (envelope === undefined) return Effect.succeed(spec);
  if (spec === undefined || spec === envelope) return Effect.succeed(envelope);
  return Effect.fail(
    new ContentVersionConflict({
      envelope,
      spec,
      message: `The bundle envelope declares contentVersion ${envelope} and its run half declares ${spec}. There is no winner; delete one so the document names its content once.`,
    }),
  );
}

function project(
  bundle: Bundle,
  source: BundleSource,
  contentVersion: string | undefined,
): ProjectedBundle {
  const spec: JsonObject =
    contentVersion === undefined
      ? bundle.run
      : { ...bundle.run, [CONTENT_VERSION_FIELD]: contentVersion };
  return {
    envelope: {
      name: bundle.name,
      description: bundle.description,
      project: bundle.project ?? DEFAULT_PROJECT,
      scenarioId: bundle.scenarioId ?? source.stem,
    },
    spec,
    grade: { grader: bundle.grade.grader, config: bundle.grade.config },
    contentVersion,
  };
}

// ---------------------------------------------------------------------------
// Recording surface re-exports
// ---------------------------------------------------------------------------

export {
  RECORDING_SCHEMA_VERSION,
  ManifestJson,
  ResultJson,
  TracesJson,
  SealMarker,
  EpisodeTermination,
  FailureReason,
  type RunOutcome,
} from "./simulator/index.js";

export {
  decodeEventLine,
  type SimulatorEvent,
} from "./simulator/event-log.js";

export {
  RecordingStoreFailed,
  RecordingUnsealed,
  RecordingSchemaMismatch,
  RecordingInvalid,
} from "./simulator/errors.js";

export { AgentName, JsonValue, JsonObject } from "./simulator/run-spec.js";
export type { CanonicalJson } from "./simulator/run-spec.js";
