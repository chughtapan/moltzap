/**
 * @file The grading surface's refusal behaviour and joins, exercised
 * against recordings written by the real store.
 *
 * The refusals carry most of the weight here: every one exists so an
 * invalid run reaches a grader as a refusal instead of a verdict, and a
 * refusal that silently stops firing is indistinguishable from a
 * regression in the agents being studied.
 */
/* eslint-disable max-lines-per-function, sonarjs/max-lines-per-function, max-nested-callbacks, agent-code-guard/no-example-only-tests -- regression-only suite: each case names one refusal openRecording owes a grader (no marker, moved bytes, wrong schema, missing result, wrong condition, each non-completed outcome, colliding sequences, disagreeing storage order, one id claimed twice). That is a closed enumeration of preconditions, not an input domain to generate over; the one axis that is a domain — line order — carries the fast-check property in this file. The enumeration makes each describe body long, and `Effect.runPromise(fixture.pipe(Effect.map(assert)))` nests three deep before any assertion. */
import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, FastCheck as fc, Option } from "effect";
import {
  openRecording,
  type GradeableRecording,
  type GradingPreconditions,
} from "./grader.js";
import {
  AGENT_ID_ONE,
  AGENT_ID_TWO,
  AGENT_ONE,
  AGENT_TWO,
  DEFAULT_EVENT_COUNT,
  ready,
  FIXTURE_RUN_ID,
  makeRecording,
  tamper,
  type FixtureOptions,
  tempStoreRoot,
  transcript,
} from "../__tests__/recording-fixture.js";
import { EpisodeOutcome, FailureOutcome } from "../simulator/index.js";
import {
  ERROR_TAG,
  OUTCOME,
  REASON,
  TERMINATION,
} from "../simulator/__tests__/tags.js";

const GRADEABLE: GradingPreconditions = {
  condition: null,
  outcome: "completed-only",
};
const PERMISSIVE: GradingPreconditions = {
  condition: null,
  outcome: "any",
};

const CONDITION = "cold-outreach/2";
const OTHER_CONDITION = "cold-outreach/1";
const NO_FAILURE = "no-failure";

function failureTag(
  exit: Exit.Exit<unknown, { readonly _tag: string }>,
): string {
  if (!Exit.isFailure(exit)) return NO_FAILURE;
  return Option.match(Cause.failureOption(exit.cause), {
    onNone: () => "defect",
    onSome: (error) => error._tag,
  });
}

type FixtureShape = Omit<FixtureOptions, "storeRoot">;

/** Open a fresh fixture and report the tag its refusal carried. */
function refusalOf(
  options: FixtureShape,
  preconditions: GradingPreconditions = GRADEABLE,
): Effect.Effect<string, never, never> {
  return Effect.gen(function* () {
    const storeRoot = yield* tempStoreRoot();
    const fixture = yield* makeRecording({ ...options, storeRoot });
    const exit = yield* Effect.exit(openRecording(fixture.path, preconditions));
    return failureTag(exit);
  });
}

/** Open a fresh fixture that is expected to pass preflight. */
function openedOf(
  options: FixtureShape,
  preconditions: GradingPreconditions = GRADEABLE,
): Effect.Effect<GradeableRecording, never, never> {
  return Effect.gen(function* () {
    const storeRoot = yield* tempStoreRoot();
    const fixture = yield* makeRecording({ ...options, storeRoot });
    return yield* openRecording(fixture.path, preconditions);
  }).pipe(Effect.orDie);
}

describe("openRecording", () => {
  it("opens a sealed, completed recording", () =>
    Effect.runPromise(
      openedOf({}).pipe(
        Effect.map((recording) => {
          expect(recording.result.outcome._tag).toBe(OUTCOME.episode);
          expect(recording.timeline).toHaveLength(DEFAULT_EVENT_COUNT);
        }),
      ),
    ));

  it("refuses a recording that was never sealed", () =>
    Effect.runPromise(
      refusalOf({ unsealed: true }).pipe(
        Effect.map((tag) => {
          expect(tag).toBe(ERROR_TAG.recordingUnsealed);
        }),
      ),
    ));

  it("refuses a sealed recording whose bytes moved afterwards", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const storeRoot = yield* tempStoreRoot();
        const fixture = yield* makeRecording({ storeRoot });
        yield* tamper(fixture.path, "traces.json");
        const exit = yield* Effect.exit(openRecording(fixture.path, GRADEABLE));
        expect(failureTag(exit)).toBe(ERROR_TAG.recordingUnsealed);
      }),
    ));

  it("refuses a run that timed out, rather than judging it", () =>
    Effect.runPromise(
      refusalOf({
        outcome: new EpisodeOutcome({ termination: TERMINATION.timeout }),
      }).pipe(
        Effect.map((tag) => {
          expect(tag).toBe(ERROR_TAG.runNotCompleted);
        }),
      ),
    ));

  it("refuses an infrastructure failure the same way", () =>
    Effect.runPromise(
      refusalOf({
        outcome: new FailureOutcome({
          reason: REASON.loggingProxyFailed,
          errorTag: "LoggingProxyFailed",
          errorMessage: "the proxy failed",
        }),
      }).pipe(
        Effect.map((tag) => {
          expect(tag).toBe(ERROR_TAG.runNotCompleted);
        }),
      ),
    ));

  it("accepts a non-completed run when the caller's policy allows it", () =>
    Effect.runPromise(
      openedOf(
        { outcome: new EpisodeOutcome({ termination: TERMINATION.timeout }) },
        PERMISSIVE,
      ).pipe(
        Effect.map((recording) => {
          expect(recording.result.outcome).toMatchObject({
            termination: TERMINATION.timeout,
          });
        }),
      ),
    ));

  it("refuses a recording produced under a different condition", () =>
    Effect.runPromise(
      refusalOf(
        { condition: OTHER_CONDITION },
        { condition: CONDITION, outcome: "completed-only" },
      ).pipe(
        Effect.map((tag) => {
          expect(tag).toBe(ERROR_TAG.conditionMismatch);
        }),
      ),
    ));

  it("accepts a matching condition", () =>
    Effect.runPromise(
      openedOf(
        { condition: CONDITION },
        { condition: CONDITION, outcome: "completed-only" },
      ).pipe(
        Effect.map((recording) => {
          expect(recording.manifest.materializedSpec.condition?.label).toBe(
            CONDITION,
          );
        }),
      ),
    ));

  it("refuses every non-completed outcome, for any termination", () =>
    Effect.runPromise(
      Effect.forEach(
        [
          TERMINATION.timeout,
          TERMINATION.agentCrashed,
          TERMINATION.interrupted,
        ],
        (termination) =>
          refusalOf({
            outcome: new EpisodeOutcome({ termination }),
          }).pipe(
            Effect.map((tag) => {
              expect(tag).toBe(ERROR_TAG.runNotCompleted);
            }),
          ),
        { concurrency: 1, discard: true },
      ),
    ));
});

describe("openRecording: the timeline", () => {
  it("orders by logicalSequence whatever order the lines were written in", () =>
    fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 1, max: 40 }), {
          minLength: 2,
          maxLength: 8,
        }),
        (sequences) => Effect.runPromise(assertOrdered(sequences)),
      ),
      { numRuns: 10 },
    ));

  it("rejects a conversation whose storage order disagrees with the log", () =>
    Effect.runPromise(
      timelineRefusal([
        transcript({
          runId: FIXTURE_RUN_ID,
          logicalSequence: 1,
          senderId: AGENT_ID_ONE,
          conversationSeq: 5,
          text: "persisted later, observed first",
        }),
        transcript({
          runId: FIXTURE_RUN_ID,
          logicalSequence: 2,
          senderId: AGENT_ID_TWO,
          conversationSeq: 2,
          text: "persisted earlier, observed second",
        }),
      ]).pipe(
        Effect.map((tag) => {
          expect(tag).toBe(ERROR_TAG.recordingInvalid);
        }),
      ),
    ));

  it("rejects a log that repeats a sequence", () =>
    Effect.runPromise(
      timelineRefusal([
        transcript({
          runId: FIXTURE_RUN_ID,
          logicalSequence: 1,
          senderId: AGENT_ID_ONE,
          conversationSeq: 1,
          text: "one",
        }),
        transcript({
          runId: FIXTURE_RUN_ID,
          logicalSequence: 1,
          senderId: AGENT_ID_TWO,
          conversationSeq: 2,
          text: "also one",
        }),
      ]).pipe(
        Effect.map((tag) => {
          expect(tag).toBe(ERROR_TAG.recordingInvalid);
        }),
      ),
    ));

  it("lets independent conversations interleave freely", () =>
    Effect.runPromise(
      openedOf(
        {
          events: [
            transcript({
              runId: FIXTURE_RUN_ID,
              logicalSequence: 1,
              senderId: AGENT_ID_ONE,
              conversationSeq: 1,
              text: "a1",
              conversationId: "conv-a",
            }),
            transcript({
              runId: FIXTURE_RUN_ID,
              logicalSequence: 2,
              senderId: AGENT_ID_TWO,
              conversationSeq: 1,
              text: "b1",
              conversationId: "conv-b",
            }),
            transcript({
              runId: FIXTURE_RUN_ID,
              logicalSequence: 3,
              senderId: AGENT_ID_ONE,
              conversationSeq: 2,
              text: "a2",
              conversationId: "conv-a",
            }),
          ],
        },
        PERMISSIVE,
      ).pipe(
        Effect.map((recording) => {
          expect(recording.timeline).toHaveLength(3);
        }),
      ),
    ));
});

/** The timeline is a permutation of the written lines, sorted by sequence. */
function assertOrdered(
  sequences: ReadonlyArray<number>,
): Effect.Effect<void, never, never> {
  return openedOf(
    {
      events: sequences.map((sequence, index) =>
        transcript({
          runId: FIXTURE_RUN_ID,
          logicalSequence: sequence,
          senderId: AGENT_ID_ONE,
          conversationSeq: index + 1,
          text: `m${String(sequence)}`,
          conversationId: `conv-${String(sequence)}`,
        }),
      ),
    },
    PERMISSIVE,
  ).pipe(
    Effect.map((recording) => {
      const observed = recording.timeline.map((event) => event.logicalSequence);
      expect(observed).toStrictEqual([...sequences].sort((a, b) => a - b));
    }),
  );
}

function timelineRefusal(
  events: ReadonlyArray<Record<string, unknown>>,
): Effect.Effect<string, never, never> {
  return refusalOf({ events }, PERMISSIVE);
}

describe("openRecording: sender attribution", () => {
  it("joins transcript senders to the slots that became ready", () =>
    Effect.runPromise(
      openedOf({}).pipe(
        Effect.map((recording) => {
          expect(recording.senders.get(AGENT_ID_ONE)).toBe(AGENT_ONE);
          expect(recording.senders.get(AGENT_ID_TWO)).toBe(AGENT_TWO);
        }),
      ),
    ));

  it("leaves senders the run never launched unattributed", () =>
    Effect.runPromise(
      openedOf({}).pipe(
        Effect.map((recording) => {
          expect(recording.senders.get("some-principal")).toBeUndefined();
        }),
      ),
    ));

  it("rejects one agent id claimed by two slots", () =>
    Effect.runPromise(
      refusalOf(
        {
          events: [
            ready(FIXTURE_RUN_ID, 1, AGENT_ONE, "shared"),
            ready(FIXTURE_RUN_ID, 2, AGENT_TWO, "shared"),
          ],
        },
        PERMISSIVE,
      ).pipe(
        Effect.map((tag) => {
          expect(tag).toBe(ERROR_TAG.recordingInvalid);
        }),
      ),
    ));
});
