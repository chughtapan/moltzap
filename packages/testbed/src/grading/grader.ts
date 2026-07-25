/**
 * @file `@moltzap/testbed/grader`: the generic code-based grading surface
 * over sealed recordings. It serves any grader that reads recordings and
 * carries no grader's name, types, or vocabulary — a consumer-shaped
 * binding (plan assembly, rubric wiring, verdict bundles) belongs in that
 * consumer's own adapter, which consumes this surface like any other.
 *
 * The division of labour it encodes: **invalidity is a refusal, never a
 * verdict.** A run that never terminated, a recording whose bytes moved
 * after sealing, or evidence produced under a different condition are all
 * refused here, before a rubric is consulted, so a grader never has to
 * report an invalid run as an agent failure.
 *
 * One function opens a recording. `events.ndjson` is written by one writer
 * in `logicalSequence` order, so reading it in order is already the whole
 * timeline; there is no separate merge to call, and therefore no way to
 * reach the events while skipping the integrity checks that come with them.
 *
 * ```mermaid
 * flowchart LR
 *   R[recording dir] --> O[openRecording]
 *   O --> C[sealed, schema, condition, outcome]
 *   C --> T[timeline in logicalSequence order, senders named]
 *   T --> G[the grader's own rubric]
 * ```
 */
import { resolve } from "node:path";
import { Effect, Schema } from "effect";
import { absurd } from "effect/Function";
import { decodeEvent, type SimulatorEvent } from "../simulator/event-log.js";
import {
  EpisodeTermination,
  makeLocalRecordingStore,
  type ManifestJson,
  type ResultJson,
  type RunOutcome,
  type SealMarker,
  type TracesJson,
} from "../simulator/index.js";
import type { AgentName } from "../simulator/run-spec.js";
import {
  RecordingInvalid,
  RecordingUnsealed,
  type RecordingSchemaMismatch,
  type RecordingStoreFailed,
} from "../simulator/errors.js";

// ---------------------------------------------------------------------------
// Convention-level refusals
// ---------------------------------------------------------------------------

/**
 * The recording was produced under a different condition than the caller
 * holds. The condition label moves on task text, persona generation, and
 * environment assumptions — never on a rubric, so re-grading the same
 * recording with a stricter rubric is legal and does not trip this.
 */
export class ConditionMismatch extends Schema.TaggedError<ConditionMismatch>()(
  "ConditionMismatch",
  {
    recordingPath: Schema.String,
    expected: Schema.NonEmptyString,
    observed: Schema.NullOr(Schema.NonEmptyString),
    message: Schema.String,
  },
) {}

/** What a recording sealed instead of an answered episode. */
const NotCompletedOutcome = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("episode"),
    termination: EpisodeTermination,
  }),
  Schema.Struct({
    kind: Schema.Literal("infrastructure-failure"),
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
  /** The condition label the caller holds, or `null` when it holds none. */
  readonly condition: string | null;
  /** Whether a non-`completed` run is refused or accepted as-is. */
  readonly outcome: "completed-only" | "any";
};

/**
 * Server-registered agent id to the slot name the spec declared. Ids the
 * run never launched — principals speaking into a conversation — are
 * absent by design; a caller that finds no entry is looking at a sender
 * the society did not spawn.
 */
export type SenderAttribution = ReadonlyMap<string, AgentName>;

/**
 * A recording that passed every stage-1 check. `seal` and `result` are
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
  /** Every event, decoded, in the one total order the writer stamped. */
  readonly timeline: ReadonlyArray<SimulatorEvent>;
  readonly senders: SenderAttribution;
};

/** Every way stage 1 refuses a recording. */
export type OpenRecordingError =
  | RecordingStoreFailed
  | RecordingUnsealed
  | RecordingSchemaMismatch
  | RecordingInvalid
  | ConditionMismatch
  | RunNotCompleted;

/** A recording path is `{storeRoot}/{specHash}/s{seed}/{attemptId}`. */
function storeRootOf(recordingPath: string): string {
  return resolve(recordingPath, "..", "..", "..");
}

/**
 * Open a recording for grading: read it, require the seal, require this
 * reader's schema version, decode the timeline and check its ordering,
 * compare the condition, and apply the caller's outcome policy. This is
 * the library half of the same check set the `recording check` verb runs,
 * so the two cannot drift.
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
    const timeline = yield* readTimeline(snapshot.events);
    const sealed: GradeableRecording = {
      path: absolute,
      manifest: snapshot.manifest,
      seal: snapshot.seal,
      result: snapshot.result,
      traces: snapshot.traces,
      timeline,
      senders: yield* attributeSenders(timeline),
    };
    yield* checkCondition(sealed, preconditions.condition);
    yield* checkOutcome(sealed, preconditions.outcome);
    return sealed;
  }).pipe(Effect.withSpan("openRecording"));
}

/** The label the recording was produced under; `null` when it declares none. */
function conditionOf(recording: GradeableRecording): string | null {
  return recording.manifest.materializedSpec.condition?.label ?? null;
}

function checkCondition(
  recording: GradeableRecording,
  expected: string | null,
): Effect.Effect<void, ConditionMismatch, never> {
  if (expected === null) return Effect.void;
  const observed = conditionOf(recording);
  if (observed === expected) return Effect.void;
  return Effect.fail(
    new ConditionMismatch({
      recordingPath: recording.path,
      expected,
      observed,
      message: `${recording.path} was produced under condition ${observed ?? "(none)"}, and this grading run expects ${expected}. The recording describes a different condition; grade a recording produced under the same one, or drop the label if the two really are comparable.`,
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
      : `infrastructure ended the run (${observed.errorTag})`;
  return new RunNotCompleted({
    recordingPath: recording.path,
    observed,
    message: `${recording.path} is not a verdict about an agent: ${what}. Fix the run rather than the rubric — a spec that can end \`completed\` carries a done-signal driver that cannot pre-empt a scheduled step.`,
  });
}

// ---------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------

/**
 * Decode every event line and order it by `logicalSequence` — the single
 * total order the writer stamped, across all six producers. The sort
 * re-asserts the file's own order rather than repairing it: a file whose
 * sequences collide is rejected below instead of silently ordered.
 */
function readTimeline(
  events: ReadonlyArray<unknown>,
): Effect.Effect<ReadonlyArray<SimulatorEvent>, RecordingInvalid, never> {
  return Effect.forEach(events, decodeEvent, { concurrency: 1 }).pipe(
    Effect.map((decoded) =>
      [...decoded].sort(
        (left, right) => left.logicalSequence - right.logicalSequence,
      ),
    ),
    Effect.tap(checkSequenceUnique),
    Effect.tap(checkConversationSeq),
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

/**
 * `conversationSeq` is not a second ordering axis; it is a consistency
 * check. Within one conversation the server's persistence sequence must
 * increase along that same timeline, and a violation means the two
 * orderings disagree about the same messages. The recording is then the
 * corrupt party, so this fails rather than picking an order.
 */
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

/**
 * Join transcript senders to the slot names the spec declared, through the
 * identities the launcher provisioned and recorded on `agent.ready`. Ids
 * do not exist when the manifest persists, which is why the join reads
 * events rather than the manifest's slots.
 */
function attributeSenders(
  timeline: ReadonlyArray<SimulatorEvent>,
): Effect.Effect<SenderAttribution, RecordingInvalid, never> {
  const byAgentId = new Map<string, AgentName>();
  for (const event of timeline) {
    if (event._tag !== "agent.ready") continue;
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
// Recording surface re-exports
// ---------------------------------------------------------------------------

export {
  RECORDING_SCHEMA_VERSION,
  ManifestJson,
  ResultJson,
  TracesJson,
  SealMarker,
  EpisodeTermination,
  type RunOutcome,
} from "../simulator/index.js";

export {
  decodeEventLine,
  type SimulatorEvent,
} from "../simulator/event-log.js";

export {
  RecordingStoreFailed,
  RecordingUnsealed,
  RecordingSchemaMismatch,
  RecordingInvalid,
} from "../simulator/errors.js";

export { AgentName, JsonValue, JsonObject } from "../simulator/run-spec.js";
export type { CanonicalJson } from "../simulator/run-spec.js";
