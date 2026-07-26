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
import { Effect, Option, Schema } from "effect";
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
import type {
  AgentName,
  JsonValue as JsonValueType,
  PrincipalName,
} from "../simulator/run-spec.js";
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
 * Server-registered sender id to the name the spec declared for it: a
 * slot name for an agent the run launched, a principal name for a
 * principal that spoke. Both identities are minted at run time, so a
 * caller that finds no entry is looking at a sender no event in the
 * recording accounts for.
 */
export type SenderAttribution = ReadonlyMap<string, AgentName | PrincipalName>;

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
 * Join transcript senders to the names the spec declared, through the
 * identities the run minted. Neither id exists when the manifest
 * persists, which is why both joins read events rather than slots.
 *
 * An agent's identity is provisioned before its runtime starts and
 * announced on `agent.ready`, so that event names it directly. A
 * principal's is minted on its first speech and announced nowhere: the
 * only record binding it to a spec name is `step.spoken`, which carries
 * the principal and the id of the message that speech produced. Matching
 * that id against the transcript names the principal's sender id, and
 * from then on every row it sent is named — including rows no step
 * spoke, such as the task request that opens a conversation.
 *
 * Both joins feed one map, so a name reaches a grader the same way
 * whichever side of the society spoke.
 */
function attributeSenders(
  timeline: ReadonlyArray<SimulatorEvent>,
): Effect.Effect<SenderAttribution, RecordingInvalid, never> {
  return principalByMessageId(timeline).pipe(
    Effect.flatMap((spokenBy) => bindEveryClaim(timeline, spokenBy)),
  );
}

function bindEveryClaim(
  timeline: ReadonlyArray<SimulatorEvent>,
  spokenBy: ReadonlyMap<string, PrincipalName>,
): Effect.Effect<SenderAttribution, RecordingInvalid, never> {
  const bySenderId = new Map<string, AgentName | PrincipalName>();
  for (const event of timeline) {
    const claim = claimOf(event, spokenBy);
    const conflict =
      claim === undefined ? undefined : bindSender(bySenderId, claim);
    if (conflict !== undefined) return Effect.fail(conflict);
  }
  return Effect.succeed(bySenderId);
}

/** One binding the recording states: this sender id belongs to this name. */
type SenderClaim = {
  readonly senderId: string;
  readonly name: AgentName | PrincipalName;
};

function claimOf(
  event: SimulatorEvent,
  spokenBy: ReadonlyMap<string, PrincipalName>,
): SenderClaim | undefined {
  if (event._tag === "agent.ready") {
    return { senderId: event.agentId, name: event.agent };
  }
  if (event._tag !== "transcript.message") return undefined;
  const principal = spokenPrincipal(event.message, spokenBy);
  return principal === undefined
    ? undefined
    : { senderId: event.senderId, name: principal };
}

/** The principal that spoke this body, when a recorded step names its message. */
function spokenPrincipal(
  message: JsonValueType,
  spokenBy: ReadonlyMap<string, PrincipalName>,
): PrincipalName | undefined {
  // A run with no recorded speech has no join to make, and skipping the
  // check here spares every transcript body a decode that cannot match.
  if (spokenBy.size === 0) return undefined;
  const messageId = messageIdOf(message);
  return messageId === undefined ? undefined : spokenBy.get(messageId);
}

/**
 * Bind one sender id to one name, reporting the conflict when the
 * recording disagrees with itself about who spoke: every attribution it
 * carries is then unsound rather than merely incomplete.
 */
function bindSender(
  bySenderId: Map<string, AgentName | PrincipalName>,
  claim: SenderClaim,
): RecordingInvalid | undefined {
  const claimed = bySenderId.get(claim.senderId);
  if (claimed !== undefined && claimed !== claim.name) {
    return new RecordingInvalid({
      file: "events.ndjson",
      issues: [
        {
          path: ["senderId"],
          message: `sender id ${claim.senderId} is claimed by both ${claimed} and ${claim.name}`,
        },
      ],
      message: `Sender id ${claim.senderId} is claimed by ${claimed} and ${claim.name}. The run mints one identity per agent slot and per principal, so transcript senders cannot be attributed from this recording.`,
    });
  }
  bySenderId.set(claim.senderId, claim.name);
  return undefined;
}

/**
 * The principal each recorded speech step spoke as, keyed by the message
 * it produced. Two steps claiming one message id would make the join
 * order-dependent, so that is a refusal rather than a last-writer rule:
 * the server mints one id per send, and a log that repeats one is
 * describing a send that did not happen the way it says.
 */
function principalByMessageId(
  timeline: ReadonlyArray<SimulatorEvent>,
): Effect.Effect<ReadonlyMap<string, PrincipalName>, RecordingInvalid, never> {
  const byMessageId = new Map<string, PrincipalName>();
  for (const event of timeline) {
    if (event._tag !== "step.spoken") continue;
    const claimed = byMessageId.get(event.messageId);
    if (claimed !== undefined && claimed !== event.principal) {
      return Effect.fail(
        new RecordingInvalid({
          file: "events.ndjson",
          issues: [
            {
              path: ["messageId"],
              message: `message ${event.messageId} is spoken by both ${claimed} and ${event.principal}`,
            },
          ],
          message: `Message ${event.messageId} is claimed by steps spoken as ${claimed} and ${event.principal}. One send produces one message id, so this log cannot say which principal spoke it.`,
        }),
      );
    }
    byMessageId.set(event.messageId, event.principal);
  }
  return Effect.succeed(byMessageId);
}

/** The wire message's own identity, the field both sides of the speech join share. */
const MessageIdentity = Schema.Struct({ id: Schema.String });
const decodeMessageIdentity = Schema.decodeUnknownOption(MessageIdentity);

function messageIdOf(message: JsonValueType): string | undefined {
  return Option.getOrUndefined(
    Option.map(decodeMessageIdentity(message), (body) => body.id),
  );
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

export {
  AgentName,
  PrincipalName,
  JsonValue,
  JsonObject,
} from "../simulator/run-spec.js";
export type { CanonicalJson } from "../simulator/run-spec.js";
