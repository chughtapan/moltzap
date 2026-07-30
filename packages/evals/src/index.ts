/** @file Code-first MoltZap behavioral evaluation suites and graders. */
// safer-arch-ignore no-large-public-surface: The single evals entrypoint intentionally publishes the cohesive suite, report model, and grader vocabulary as one customer-facing API.

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

/** Re-exports the public API from `./evaluations.js`. */
export {
  defineEvaluationSuite,
  type CodeEvaluation,
  type EvaluationRunDefaults,
  type EvaluationSuite,
} from "./evaluations.js";
/** Re-exports the public API from `./grading-report.js`. */
export {
  type CheckOutcome,
  checkOutcome,
  type GradeCheckResult,
  type GradeReport,
  type GraderId,
} from "./grading-report.js";
/** Re-exports the public API from `./grading-model.js`. */
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
