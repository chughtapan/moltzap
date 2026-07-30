/** @file Closed grading outcomes and immutable report values. */

import { Array as Arr, Schema } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";

/** Closed result vocabulary for one executable check. */
const checkOutcomeSchema = Schema.Literal("passed", "failed", "undecided");
/** Represents check outcome values. */
export type CheckOutcome = typeof checkOutcomeSchema.Type;
const gradeReportTypeId: unique symbol = Symbol.for(
  "@moltzap/evals/GradeReport",
);

/** Stable identity for the code that produced a grading report. */
export type GraderId = `${string}.grader/v${number}`;

const [passed, failed, undecided] = checkOutcomeSchema.literals;

/** Named outcome values for code that constructs or inspects reports. */
export const checkOutcome = Object.freeze({
  passed,
  failed,
  undecided,
}) satisfies Readonly<Record<string, CheckOutcome>>;

/** Result of one named grading check. */
export interface GradeCheckResult {
  readonly name: string;
  readonly outcome: CheckOutcome;
  /** What the check had to establish, so `undecided` states its own question. */
  readonly detail: string;
}

const OUTCOME_PRECEDENCE = {
  [checkOutcome.passed]: 0,
  [checkOutcome.undecided]: 1,
  [checkOutcome.failed]: 2,
} as const satisfies Readonly<Record<CheckOutcome, number>>;

/**
 * A failure dominates an undecided check, and an undecided check dominates a
 * pass. The nonempty input prevents a grader with no evidence from passing.
 * @param checks Value supplied to the operation.
 * @returns The verdict of result.
 */
export function verdictOf(
  checks: NonEmptyReadonlyArray<GradeCheckResult>,
): CheckOutcome {
  return checks.reduce<CheckOutcome>(
    (verdict, check) =>
      OUTCOME_PRECEDENCE[check.outcome] > OUTCOME_PRECEDENCE[verdict]
        ? check.outcome
        : verdict,
    checkOutcome.passed,
  );
}

/** Immutable nominal result produced by one versioned grader. */
export class GradeReport {
  private readonly [gradeReportTypeId] = gradeReportTypeId;
  readonly graderId: GraderId;
  readonly checks: NonEmptyReadonlyArray<GradeCheckResult>;
  readonly verdict: CheckOutcome;

  private constructor({
    graderId,
    checks,
  }: {
    readonly graderId: GraderId;
    readonly checks: NonEmptyReadonlyArray<GradeCheckResult>;
  }) {
    this.graderId = graderId;
    this.checks = Object.freeze(
      Arr.map(checks, (check) => Object.freeze({ ...check })),
    );
    this.verdict = verdictOf(this.checks);
    Object.freeze(this);
  }

  /**
   * Own the checks and derive the only verdict exposed by the report.
   * @param input Input value to process.
   * @param input.graderId Value supplied to the operation.
   * @param input.checks Value supplied to the operation.
   * @returns The created .
   */
  static make(input: {
    readonly graderId: GraderId;
    readonly checks: NonEmptyReadonlyArray<GradeCheckResult>;
  }): GradeReport {
    return new GradeReport(input);
  }
}
