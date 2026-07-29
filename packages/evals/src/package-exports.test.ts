import { describe, expect, it } from "vitest";
import * as evalsApi from "./index.js";

// @agent-code-guard/regression-only: the published surface is a compatibility boundary the grading reference cites by name
describe("@moltzap/evals package exports", () => {
  it("publishes the check vocabulary a grader composes", () => {
    expect(Object.keys(evalsApi).sort()).toEqual(
      expect.arrayContaining([
        "CheckOutcome",
        "GradingRefused",
        "atMostWords",
        "defineCodeGrader",
        "defineEvaluationSuite",
        "detectsFailure",
        "exactFinalText",
        "requiresJudgment",
        "responseText",
        "validMessages",
      ]),
    );
  });

  it("keeps the outcome vocabulary closed", () => {
    expect(evalsApi.CheckOutcome).toEqual({
      passed: "passed",
      failed: "failed",
      undecided: "undecided",
    });
  });

  it("exposes every check as a usable value, not a type-only name", () => {
    // A type-only export satisfies the docs gate's named-binding check while
    // being uncallable at runtime, so pin the callable shape here.
    for (const check of [
      evalsApi.detectsFailure,
      evalsApi.requiresJudgment,
      evalsApi.exactFinalText,
      evalsApi.atMostWords,
      evalsApi.defineCodeGrader,
      evalsApi.responseText,
      evalsApi.validMessages,
    ]) {
      expect(check).toBeInstanceOf(Function);
    }
  });
});
