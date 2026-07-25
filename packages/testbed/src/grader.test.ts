/**
 * @file The grading surface's refusal behaviour and joins, exercised
 * against recordings written by the real store.
 *
 * The refusals carry most of the weight here: every one exists so an
 * invalid run reaches a grader as a refusal instead of a verdict, and a
 * refusal that silently stops firing is indistinguishable from a
 * regression in the agents being studied.
 */
/* eslint-disable sonarjs/assertions-in-tests -- assertion bodies are extracted to named top-level functions to satisfy the nesting caps; every test delegates to one */
import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, FastCheck as fc, Option } from "effect";
import {
  attributeSenders,
  mergedTimeline,
  openRecording,
  projectBundle,
  type GradeableRecording,
  type GradingPreconditions,
} from "./grader.js";
import {
  AGENT_ID_ONE,
  AGENT_ID_TWO,
  AGENT_ONE,
  AGENT_TWO,
  DEFAULT_EVENT_COUNT,
  launched,
  FIXTURE_RUN_ID,
  makeRecording,
  tamper,
  type FixtureOptions,
  tempStoreRoot,
  transcript,
} from "./__tests__/recording-fixture.js";
import { EpisodeOutcome, FailureOutcome } from "./simulator/index.js";
import { ERROR_TAG, OUTCOME, REASON, TERMINATION } from "./simulator/__tests__/tags.js";

const GRADEABLE: GradingPreconditions = {
  contentVersion: null,
  outcome: "completed-only",
};
const PERMISSIVE: GradingPreconditions = {
  contentVersion: null,
  outcome: "any",
};

const CONTENT_KEY = "cold-outreach/2";
const OTHER_CONTENT_KEY = "cold-outreach/1";
const NO_FAILURE = "no-failure";

function failureTag(exit: Exit.Exit<unknown, { readonly _tag: string }>): string {
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
          expect(recording.events).toHaveLength(DEFAULT_EVENT_COUNT);
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
        const exit = yield* Effect.exit(
          openRecording(fixture.path, GRADEABLE),
        );
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

  it("refuses a recording produced under a different content key", () =>
    Effect.runPromise(
      refusalOf(
        { contentVersion: OTHER_CONTENT_KEY },
        { contentVersion: CONTENT_KEY, outcome: "completed-only" },
      ).pipe(
        Effect.map((tag) => {
          expect(tag).toBe(ERROR_TAG.contentVersionMismatch);
        }),
      ),
    ));

  it("accepts a matching content key", () =>
    Effect.runPromise(
      openedOf(
        { contentVersion: CONTENT_KEY },
        { contentVersion: CONTENT_KEY, outcome: "completed-only" },
      ).pipe(
        Effect.map((recording) => {
          expect(recording.manifest.contentVersion).toBe(CONTENT_KEY);
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

describe("mergedTimeline", () => {
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
      Effect.gen(function* () {
        const recording = yield* openedOf(
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
        );
        const timeline = yield* mergedTimeline(recording).pipe(Effect.orDie);
        expect(timeline).toHaveLength(3);
      }),
    ));
});

/** The timeline is a permutation of the written lines, sorted by sequence. */
function assertOrdered(
  sequences: ReadonlyArray<number>,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const recording = yield* openedOf(
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
    );
    const timeline = yield* mergedTimeline(recording).pipe(Effect.orDie);
    const observed = timeline.map((event) => event.logicalSequence);
    expect(observed).toStrictEqual([...sequences].sort((a, b) => a - b));
  });
}

function timelineRefusal(
  events: ReadonlyArray<Record<string, unknown>>,
): Effect.Effect<string, never, never> {
  return Effect.gen(function* () {
    const recording = yield* openedOf({ events }, PERMISSIVE);
    const exit = yield* Effect.exit(mergedTimeline(recording));
    return failureTag(exit);
  });
}

describe("attributeSenders", () => {
  it("joins transcript senders to the slots that were launched", () =>
    Effect.runPromise(
      sendersOf().pipe(
        Effect.map((senders) => {
          expect(senders.get(AGENT_ID_ONE)).toBe(AGENT_ONE);
          expect(senders.get(AGENT_ID_TWO)).toBe(AGENT_TWO);
        }),
      ),
    ));

  it("leaves senders the run never launched unattributed", () =>
    Effect.runPromise(
      sendersOf().pipe(
        Effect.map((senders) => {
          expect(senders.get("some-principal")).toBeUndefined();
        }),
      ),
    ));

  it("rejects one agent id claimed by two slots", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const recording = yield* openedOf(
          {
            events: [
              launched(FIXTURE_RUN_ID, 1, AGENT_ONE, "shared"),
              launched(FIXTURE_RUN_ID, 2, AGENT_TWO, "shared"),
            ],
          },
          PERMISSIVE,
        );
        const timeline = yield* mergedTimeline(recording).pipe(Effect.orDie);
        const exit = yield* Effect.exit(attributeSenders(timeline));
        expect(failureTag(exit)).toBe(ERROR_TAG.recordingInvalid);
      }),
    ));
});

function sendersOf(): Effect.Effect<
  ReadonlyMap<string, string>,
  never,
  never
> {
  return Effect.gen(function* () {
    const recording = yield* openedOf({});
    const timeline = yield* mergedTimeline(recording).pipe(Effect.orDie);
    return yield* attributeSenders(timeline).pipe(Effect.orDie);
  });
}

// ---------------------------------------------------------------------------
// projectBundle
// ---------------------------------------------------------------------------

const GRADER_NAME = "cc-judge";
const RUBRIC_FIELD = "expectedBehavior";
const SPEC_FIELD = "seed";
const CONTENT_FIELD = "contentVersion";
const STEM = "cold-outreach";
const DEFAULT_PROJECT = "simulator";

const BUNDLE = {
  name: "Cold outreach response quality",
  description: "Tests helpful response to a first-contact DM.",
  run: { [SPEC_FIELD]: 7 },
  grade: { grader: GRADER_NAME, config: { [RUBRIC_FIELD]: "be helpful" } },
};
const SOURCE = { stem: STEM };

function projected(bundle: unknown) {
  return projectBundle(bundle, SOURCE).pipe(Effect.orDie);
}

function projectionRefusal(bundle: unknown): Effect.Effect<string, never, never> {
  return Effect.exit(projectBundle(bundle, SOURCE)).pipe(Effect.map(failureTag));
}

describe("projectBundle", () => {
  it("carries the envelope and defaults scenarioId to the file stem", () =>
    Effect.runPromise(
      projected(BUNDLE).pipe(
        Effect.map((result) => {
          expect(result.envelope.scenarioId).toBe(STEM);
          expect(result.envelope.project).toBe(DEFAULT_PROJECT);
          expect(result.envelope.name).toBe(BUNDLE.name);
        }),
      ),
    ));

  it("carries grade.config through without letting it reach the spec", () =>
    Effect.runPromise(
      projected(BUNDLE).pipe(
        Effect.map((result) => {
          expect(result.grade.config).toStrictEqual(BUNDLE.grade.config);
          expect(Object.keys(result.spec)).toStrictEqual([SPEC_FIELD]);
        }),
      ),
    ));

  it("injects an envelope-only key into the emitted spec", () =>
    Effect.runPromise(
      projected({ ...BUNDLE, [CONTENT_FIELD]: CONTENT_KEY }).pipe(
        Effect.map((result) => {
          expect(result.contentVersion).toBe(CONTENT_KEY);
          expect(result.spec[CONTENT_FIELD]).toBe(CONTENT_KEY);
        }),
      ),
    ));

  it("keeps a spec-only key", () =>
    Effect.runPromise(
      projected({
        ...BUNDLE,
        run: { [SPEC_FIELD]: 7, [CONTENT_FIELD]: CONTENT_KEY },
      }).pipe(
        Effect.map((result) => {
          expect(result.contentVersion).toBe(CONTENT_KEY);
        }),
      ),
    ));

  it("accepts the two keys when they agree", () =>
    Effect.runPromise(
      projected({
        ...BUNDLE,
        [CONTENT_FIELD]: CONTENT_KEY,
        run: { [SPEC_FIELD]: 7, [CONTENT_FIELD]: CONTENT_KEY },
      }).pipe(
        Effect.map((result) => {
          expect(result.contentVersion).toBe(CONTENT_KEY);
        }),
      ),
    ));

  it("refuses to pick a winner when the two keys disagree", () =>
    Effect.runPromise(
      projectionRefusal({
        ...BUNDLE,
        [CONTENT_FIELD]: CONTENT_KEY,
        run: { [SPEC_FIELD]: 7, [CONTENT_FIELD]: OTHER_CONTENT_KEY },
      }).pipe(
        Effect.map((tag) => {
          expect(tag).toBe(ERROR_TAG.contentVersionConflict);
        }),
      ),
    ));

  it("leaves the key absent when neither half names one", () =>
    Effect.runPromise(
      projected(BUNDLE).pipe(
        Effect.map((result) => {
          expect(result.contentVersion).toBeUndefined();
          expect(result.spec[CONTENT_FIELD]).toBeUndefined();
        }),
      ),
    ));

  it("rejects a document that is not a bundle", () =>
    Effect.runPromise(
      projectionRefusal({ name: "only a name" }).pipe(
        Effect.map((tag) => {
          expect(tag).toBe(ERROR_TAG.bundleInvalid);
        }),
      ),
    ));

  it("is idempotent on its own emitted spec for any content key", () =>
    Effect.runPromise(
      Effect.forEach(
        [CONTENT_KEY, OTHER_CONTENT_KEY],
        (key) =>
          projected({ ...BUNDLE, [CONTENT_FIELD]: key }).pipe(
            Effect.flatMap((once) =>
              projected({ ...BUNDLE, run: once.spec }).pipe(
                Effect.map((twice) => {
                  expect(twice.spec).toStrictEqual(once.spec);
                }),
              ),
            ),
          ),
        { concurrency: 1, discard: true },
      ),
    ));
});
