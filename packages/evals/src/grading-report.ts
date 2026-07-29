/** @file Closed grading outcomes and immutable report values. */

import { Array as Arr, Schema } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";

/** Closed result vocabulary for one executable check. */
const CheckOutcomeSchema = Schema.Literal("passed", "failed", "undecided");
export type CheckOutcome = typeof CheckOutcomeSchema.Type;
const GradeReportTypeId: unique symbol = Symbol.for(
  "@moltzap/evals/GradeReport",
);

/** Stable identity for the code that produced a grading report. */
export type GraderId = `${string}.grader/v${number}`;

const [passed, failed, undecided] = CheckOutcomeSchema.literals;

/** Named outcome values for code that constructs or inspects reports. */
export const CheckOutcome = Object.freeze({
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
  [CheckOutcome.passed]: 0,
  [CheckOutcome.undecided]: 1,
  [CheckOutcome.failed]: 2,
} as const satisfies Readonly<Record<CheckOutcome, number>>;

/**
 * A failure dominates an undecided check, and an undecided check dominates a
 * pass. The nonempty input prevents a grader with no evidence from passing.
 */
export function verdictOf(
  checks: NonEmptyReadonlyArray<GradeCheckResult>,
): CheckOutcome {
  return checks.reduce<CheckOutcome>(
    (verdict, check) =>
      OUTCOME_PRECEDENCE[check.outcome] > OUTCOME_PRECEDENCE[verdict]
        ? check.outcome
        : verdict,
    CheckOutcome.passed,
  );
}

/** Immutable nominal result produced by one versioned grader. */
export class GradeReport {
  private readonly [GradeReportTypeId] = GradeReportTypeId;
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

  /** Own the checks and derive the only verdict exposed by the report. */
  static make(input: {
    readonly graderId: GraderId;
    readonly checks: NonEmptyReadonlyArray<GradeCheckResult>;
  }): GradeReport {
    return new GradeReport(input);
  }
}
