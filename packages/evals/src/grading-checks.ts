/** @file Reusable code checks and exact-ledger grader construction. */

import type { EndpointMessageReceived } from "@moltzap/simulator";
import { Array as Arr, Effect } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import {
  type EvaluationEvidence,
  type EvaluationLedgerView,
  type GradingRefused,
  evidenceFromLedger,
} from "./grading-model.js";
import {
  checkOutcome,
  GradeReport,
  type GradeCheckResult,
  type GraderId,
} from "./grading-report.js";

/** One executable property over validated customer-selected evidence. */
export type CodeCheck = (evidence: EvaluationEvidence) => GradeCheckResult;

/**
 * Executes the response text operation.
 * @param message Value supplied to the operation.
 * @returns The response text result.
 */
export function responseText(message: EndpointMessageReceived): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function words(value: string): readonly string[] {
  return value
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
}

/**
 * Build a two-sided check for a property that code can decide exactly.
 * @param name Name of the operation.
 * @param detail Value supplied to the operation.
 * @param evaluate Value supplied to the operation.
 * @returns The assertion result.
 */
function assertion(
  name: string,
  detail: string,
  evaluate: (evidence: EvaluationEvidence) => boolean,
): CodeCheck {
  return (evidence): GradeCheckResult => ({
    name,
    outcome: evaluate(evidence) ? checkOutcome.passed : checkOutcome.failed,
    detail,
  });
}

/**
 * Preserve a semantic question in the report without claiming that lexical
 * evidence decided it.
 * @param name Name of the operation.
 * @param detail Value supplied to the operation.
 * @returns The requires judgment result.
 */
export function requiresJudgment(name: string, detail: string): CodeCheck {
  return (): GradeCheckResult => ({
    name,
    outcome: checkOutcome.undecided,
    detail,
  });
}

/**
 * Build a one-sided detector for a mechanically conclusive violation.
 * @param name Name of the operation.
 * @param detail Value supplied to the operation.
 * @param violated Value supplied to the operation.
 * @returns The detects failure result.
 */
export function detectsFailure(
  name: string,
  detail: string,
  violated: (evidence: EvaluationEvidence) => boolean,
): CodeCheck {
  return (evidence): GradeCheckResult => ({
    name,
    outcome: violated(evidence) ? checkOutcome.failed : checkOutcome.undecided,
    detail,
  });
}

/**
 * Require the final text to satisfy a literal output constraint.
 * @param expected Expected value used by the assertion.
 * @returns The exact final text result.
 */
export function exactFinalText(expected: string): CodeCheck {
  return assertion(
    `exactly ${expected}`,
    `The final response contains only the text ${expected}.`,
    (evidence) => {
      const [part] = evidence.finalResponse.parts;
      return (
        evidence.finalResponse.parts.length === 1 &&
        part.type === "text" &&
        part.text.trim() === expected
      );
    },
  );
}

/**
 * Executes the at most words operation.
 * @param limit Value supplied to the operation.
 * @returns The at most words result.
 */
export function atMostWords(limit: number): CodeCheck {
  return assertion(
    `at most ${String(limit)} words`,
    `The final response contains no more than ${String(limit)} words.`,
    (evidence) => words(responseText(evidence.finalResponse)).length <= limit,
  );
}

/** Provides the valid messages runtime value. */
export const validMessages = assertion(
  "valid non-empty messages",
  "Every selected protocol message contains non-empty text.",
  (evidence) =>
    evidence.responses.every(
      (message) => responseText(message).trim().length > 0,
    ),
);

/** What a grader reads from a ledger, and the identity it stamps on its report. */
export interface CodeGraderDefinition {
  readonly graderId: GraderId;
  readonly scenarioId: string;
  readonly endpointName: string;
  readonly targetName: string;
  readonly expectedResponses: number;
}

/**
 * Executes the define code grader operation.
 * @param definition Protocol definition to process.
 * @param checks Value supplied to the operation.
 * @returns The define code grader result.
 */
export function defineCodeGrader(
  definition: CodeGraderDefinition,
  ...checks: NonEmptyReadonlyArray<CodeCheck>
): (
  ledger: EvaluationLedgerView,
) => Effect.Effect<GradeReport, GradingRefused> {
  return (ledger) =>
    evidenceFromLedger(ledger, definition).pipe(
      Effect.map((evidence) => {
        const results = Arr.map(checks, (check) => check(evidence));
        return GradeReport.make({
          graderId: definition.graderId,
          checks: results,
        });
      }),
    );
}
