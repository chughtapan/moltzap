import { describe, expect, it } from "vitest";
import * as evalsApi from "./index.js";

// @agent-code-guard/regression-only: the published surface is what customer
// graders may compose with, and the grading docs cite it by name
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
    // being unusable at runtime, so assert the callable shape here.
    expect(typeof evalsApi.detectsFailure).toBe("function");
    expect(typeof evalsApi.requiresJudgment).toBe("function");
    expect(typeof evalsApi.exactFinalText).toBe("function");
    expect(typeof evalsApi.atMostWords).toBe("function");
    expect(typeof evalsApi.defineCodeGrader).toBe("function");
    expect(typeof evalsApi.responseText).toBe("function");
    expect(typeof evalsApi.validMessages).toBe("function");
  });
});
