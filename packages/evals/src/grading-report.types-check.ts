/**
 * A grading report is nominal, so spreading one into contradictory structural
 * data does not produce another report. Only grading code derives verdicts.
 */

import type { GradeReport } from "./grading-report.js";

type Expect<Value extends true> = Value;
type StructuralCopy = {
  readonly [Key in keyof GradeReport]: GradeReport[Key];
};

/** Represents grade report nominality canary values. */
export type GradeReportNominalityCanary = Expect<
  StructuralCopy extends GradeReport ? false : true
>;
