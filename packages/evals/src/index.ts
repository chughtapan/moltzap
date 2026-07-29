/** @file Code-first MoltZap behavioral evaluation suites and graders. */

import { effectRuntime, openClawRuntime } from "@moltzap/simulator";
import { Effect } from "effect";
import { defineEvaluationSuite } from "./evaluations.js";

/** Ledger condition suffix for the real-protocol echo instrument. */
export const EFFECT_CONDITION_SUFFIX = "-effect";

/** The model-backed suite used for behavioral measurements. */
export const openClawEvaluations = defineEvaluationSuite(openClawRuntime());

/** The real-protocol echo suite used to exercise the instrument itself. */
export const effectEvaluations = defineEvaluationSuite(
  effectRuntime({
    onMessage: (context) => Effect.succeed(context.message.parts),
  }),
  EFFECT_CONDITION_SUFFIX,
);

export {
  defineEvaluationSuite,
  type CodeEvaluation,
  type EvaluationRunDefaults,
  type EvaluationSuite,
} from "./evaluations.js";
export {
  CheckOutcome,
  type GradeCheckResult,
  type GradeReport,
  type GraderId,
} from "./grading-report.js";
export { GradingRefused, type EvaluationEvidence } from "./grading-model.js";

/**
 * The check vocabulary a grader composes. A check reports what it
 * established, so a detector that finds nothing says `undecided` rather
 * than claiming the property holds.
 */
export {
  atMostWords,
  defineCodeGrader,
  detectsFailure,
  exactFinalText,
  requiresJudgment,
  responseText,
  validMessages,
  type CodeCheck,
  type CodeGraderDefinition,
} from "./grading-checks.js";
