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
  CheckOutcome,
  GradeReport,
  type GradeCheckResult,
  type GraderId,
} from "./grading-report.js";

/** One executable property over validated customer-selected evidence. */
export type CodeCheck = (evidence: EvaluationEvidence) => GradeCheckResult;

export function responseText(message: EndpointMessageReceived): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function words(value: string): ReadonlyArray<string> {
  return value
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
}

/** Build a two-sided check for a property that code can decide exactly. */
function assertion(
  name: string,
  detail: string,
  evaluate: (evidence: EvaluationEvidence) => boolean,
): CodeCheck {
  return (evidence): GradeCheckResult => ({
    name,
    outcome: evaluate(evidence) ? CheckOutcome.passed : CheckOutcome.failed,
    detail,
  });
}

/**
 * Preserve a semantic question in the report without claiming that lexical
 * evidence decided it.
 */
export function requiresJudgment(name: string, detail: string): CodeCheck {
  return (): GradeCheckResult => ({
    name,
    outcome: CheckOutcome.undecided,
    detail,
  });
}

/** Build a one-sided detector for a mechanically conclusive violation. */
export function detectsFailure(
  name: string,
  detail: string,
  violated: (evidence: EvaluationEvidence) => boolean,
): CodeCheck {
  return (evidence): GradeCheckResult => ({
    name,
    outcome: violated(evidence) ? CheckOutcome.failed : CheckOutcome.undecided,
    detail,
  });
}

/** Require the final text to satisfy a literal output constraint. */
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

export function atMostWords(limit: number): CodeCheck {
  return assertion(
    `at most ${String(limit)} words`,
    `The final response contains no more than ${String(limit)} words.`,
    (evidence) => words(responseText(evidence.finalResponse)).length <= limit,
  );
}

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
