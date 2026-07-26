/**
 * @file The recording-backed coordinator's judgment bundle, built from
 * recordings the real store wrote.
 *
 * The bundle is a wire contract with a consumer this package does not
 * import, so these cases are the only thing holding the mapping to
 * cc-judge's grammar. A bundle that drifts out of that grammar does not
 * fail at the seam: the judge reads a run with no evidence and returns a
 * critical agent-failure verdict for every scenario, which is a statement
 * about the bundle wearing the shape of a statement about the agents.
 */
import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Option } from "effect";
import recordingHarness from "./cc-judge-recording-harness.js";
import { openRecording } from "./grader.js";
import {
  AGENT_ID_ONE,
  AGENT_ONE,
  AGENT_TWO,
  CONVERSATION,
  FIXTURE_RUN_ID,
  makeRecording,
  ready,
  slot,
  tempStoreRoot,
  transcript,
  type FixtureOptions,
} from "../__tests__/recording-fixture.js";
import { EpisodeOutcome } from "../simulator/index.js";
import { TERMINATION } from "../simulator/__tests__/tags.js";

/** cc-judge's own vocabulary, which this package models but does not import. */
const MESSAGE_EVENT = "message";
const COMPLETED = "completed";
const REQUIRED_RUBRIC_FIELD = "expectedBehavior";
const REQUIRED_AGENTS_FIELD = "agents";
const PREFLIGHT_MARKER = "Preflight (exit 14)";

const RUNTIME_KIND = "stub";
const ISOLATION = "host";
const MODEL_ID = "test/model-1";
const TOOL_PART = "tool-call";
const FIRST_TEXT = "hello";
const SECOND_TEXT = "hi back";

const REQUIREMENTS = {
  expectedBehavior: "The agent answers the greeting it receives.",
  validationChecks: ["The agent replies at least once."],
};

const PLAN = {
  project: "simulator",
  scenarioId: "EVAL-000.hermetic",
  name: "greeting",
  description: "one greeting and one reply",
  requirements: REQUIREMENTS,
};

const SLOTS = [slot(AGENT_ONE), slot(AGENT_TWO, MODEL_ID)];
const NO_REFUSAL = "no-refusal";

type FixtureShape = Omit<FixtureOptions, "storeRoot">;

function gradeRecording(
  options: FixtureShape,
  requirements: Readonly<Record<string, unknown>> = REQUIREMENTS,
) {
  return Effect.gen(function* () {
    const storeRoot = yield* tempStoreRoot();
    const fixture = yield* makeRecording({ ...options, storeRoot });
    const loaded = yield* recordingHarness.load({
      sourcePath: "greeting.bundle.yaml",
      plan: { ...PLAN, requirements },
      payload: { recording: fixture.path },
    });
    const bundle = yield* loaded.coordinator.execute(loaded.plan);
    const recording = yield* openRecording(fixture.path, {
      condition: null,
      outcome: "any",
    }).pipe(Effect.orDie);
    return { bundle, recording };
  });
}

/** Grade a fixture that is expected to produce a bundle. */
function bundleOf(options: FixtureShape) {
  return gradeRecording(options).pipe(
    Effect.orDieWith((failure) => failure.cause),
  );
}

/** Grade a fixture that is expected to be refused, and report the reason. */
function refusalOf(
  options: FixtureShape,
  requirements?: Readonly<Record<string, unknown>>,
): Effect.Effect<string, never, never> {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(gradeRecording(options, requirements));
    if (!Exit.isFailure(exit)) return NO_REFUSAL;
    return Option.match(Cause.failureOption(exit.cause), {
      onNone: () => "defect",
      onSome: (failure) => failure.cause.message,
    });
  });
}

// @agent-code-guard/regression-only: the bundle's grammar is a closed set of fields a named consumer requires, not an input domain; the one axis that is a domain — the recording's line order — carries a property in grader.test.ts
describe("the bundle's transcript", () => {
  it("reaches cc-judge as message events, one per transcript row", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { bundle } = yield* bundleOf({ slots: SLOTS });
        expect(bundle.events).toEqual([
          {
            type: MESSAGE_EVENT,
            from: AGENT_ONE,
            channel: CONVERSATION,
            text: FIRST_TEXT,
            ts: expect.any(Number),
          },
          {
            type: MESSAGE_EVENT,
            from: AGENT_TWO,
            channel: CONVERSATION,
            text: SECOND_TEXT,
            ts: expect.any(Number),
          },
        ]);
      }),
    ));

  it("keeps a body with no readable text rather than dropping the row", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { bundle } = yield* bundleOf({
          slots: SLOTS,
          events: [
            ready(FIXTURE_RUN_ID, 1, AGENT_ONE, AGENT_ID_ONE),
            transcript({
              runId: FIXTURE_RUN_ID,
              logicalSequence: 2,
              senderId: AGENT_ID_ONE,
              conversationSeq: 1,
              text: FIRST_TEXT,
              parts: [{ type: TOOL_PART, tool: "search" }],
            }),
          ],
        });
        expect(bundle.events).toHaveLength(1);
        expect(bundle.events[0]?.text).toContain(TOOL_PART);
      }),
    ));
});

function agentRef(agent: string, modelId: string | null) {
  return {
    id: agent,
    name: agent,
    metadata: {
      runtimeKind: RUNTIME_KIND,
      modelId,
      isolation: ISOLATION,
    },
  };
}

function agentIdOf(outcome: { readonly agentId: string }): string {
  return outcome.agentId;
}

// @agent-code-guard/regression-only: same closed field set; each case names one field cc-judge requires of every bundle
describe("the bundle's run identity", () => {
  it("carries the recording's own runId", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { bundle, recording } = yield* bundleOf({ slots: SLOTS });
        expect(bundle.runId).toBe(recording.manifest.runId);
      }),
    ));

  it("names every slot the manifest pinned", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { bundle } = yield* bundleOf({ slots: SLOTS });
        expect(bundle.agents).toEqual([
          agentRef(AGENT_ONE, null),
          agentRef(AGENT_TWO, MODEL_ID),
        ]);
      }),
    ));
});

// @agent-code-guard/regression-only: the outcome list is one row per manifest slot, a closed set rather than a generated domain
describe("the bundle's outcomes", () => {
  it("reports one outcome per slot, bounded by the run's clock", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { bundle } = yield* bundleOf({ slots: SLOTS });
        expect(bundle.outcomes.map(agentIdOf)).toEqual([AGENT_ONE, AGENT_TWO]);
        for (const outcome of bundle.outcomes) {
          expect(outcome.status).toBe(COMPLETED);
          expect(Date.parse(outcome.startedAt)).toBeLessThanOrEqual(
            Date.parse(outcome.endedAt),
          );
        }
      }),
    ));
});

// @agent-code-guard/regression-only: a closed enumeration of the ways a bundle can fail cc-judge's grammar, each of which must reach the caller as a refusal instead of a verdict
describe("bundles cc-judge could not read", () => {
  it("refuses a recording whose manifest declares no slot", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* refusalOf({})).toContain(REQUIRED_AGENTS_FIELD);
      }),
    ));

  it("refuses a rubric that is not cc-judge's requirements shape", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const reason = yield* refusalOf(
          { slots: SLOTS },
          { checks: ["the agent replies"] },
        );
        expect(reason).toContain(REQUIRED_RUBRIC_FIELD);
      }),
    ));

  it("refuses a run that never completed rather than bundling it", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const reason = yield* refusalOf({
          slots: SLOTS,
          outcome: new EpisodeOutcome({ termination: TERMINATION.timeout }),
        });
        expect(reason).toContain(PREFLIGHT_MARKER);
      }),
    ));
});
