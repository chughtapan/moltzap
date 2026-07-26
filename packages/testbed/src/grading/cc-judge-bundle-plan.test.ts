/**
 * @file The grade half of a bundle, turned into a cc-judge plan.
 *
 * The harness path is the load-bearing case: cc-judge imports whatever
 * `harness.module` names, so a plan that cannot name it is a plan that
 * cannot run. Consumers that pass `harnessModule` themselves never
 * exercise the default, which is how a broken default reaches a release.
 */
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import {
  ccJudgePlanFromBundle,
  emitCcJudgePlan,
  resolveRecordingHarness,
} from "./cc-judge-bundle-plan.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STEM = "greeting";
const RECORDING = "recordings/0000/s7/a1";

const BUNDLE = {
  grade: {
    grader: "cc-judge",
    config: {
      expectedBehavior: "The agent answers the greeting it receives.",
      validationChecks: ["The agent replies at least once."],
    },
  },
};

describe("resolveRecordingHarness", () => {
  it("names the harness module beside this one", () => {
    expect(resolveRecordingHarness()).toBe(
      join(HERE, "cc-judge-recording-harness.js"),
    );
  });

  it("is the default cc-judge loads when no override is given", () => {
    const plan = emitCcJudgePlan(BUNDLE, {
      recording: RECORDING,
      stem: STEM,
    });

    expect(plan.harness.module).toBe(resolveRecordingHarness());
    expect(isAbsolute(plan.harness.module)).toBe(true);
  });
});

describe("ccJudgePlanFromBundle", () => {
  it("carries the grade config through as the rubric", () =>
    Effect.runPromise(
      ccJudgePlanFromBundle(BUNDLE, {
        recording: RECORDING,
        stem: STEM,
      }).pipe(
        Effect.map((plan) => {
          expect(plan.scenarioId).toBe(STEM);
          expect(plan.requirements).toEqual(BUNDLE.grade.config);
          expect(plan.harness.payload.recording).toBe(
            join(process.cwd(), RECORDING),
          );
        }),
      ),
    ));

  it("rejects a document that carries no grade section", () =>
    Effect.runPromise(
      Effect.exit(
        ccJudgePlanFromBundle(
          { agents: [] },
          { recording: RECORDING, stem: STEM },
        ),
      ).pipe(
        Effect.map((exit) => {
          expect(Exit.isFailure(exit)).toBe(true);
        }),
      ),
    ));
});
