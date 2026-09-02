/** @file The one JSON line every profile submitter prints when it finishes. */

import { Schema } from "effect";
// safer-arch-ignore no-upward-layer-import: the submitter's final line carries the controller's serializable run summary back to the operator, so the summary shape is owned where the controller writes it.
import {
  controllerFailedRunSummary,
  controllerProgramFinishedSummary,
} from "../controller/summary.js";

/**
 * Schema of the final line `moltzap-sim run` prints for one submission.
 *
 * A consumer that spawns the executable decodes its stdout with this schema
 * rather than copying the shape: the submitter is a separate process, so
 * nothing else would notice the two sides disagreeing until a live run
 * produced an undecodable line. The failed branch's `diagnostic` is optional
 * because the submitter carries one only when the controller Job's own output
 * was still readable.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention, agent-code-guard/no-exported-brand-constructor -- consumers of the packed executable decode its exact closed stdout contract at their Schema boundary.
export const ProfileRunResult = Schema.Struct({
  runId: Schema.NonEmptyString,
  namespace: Schema.NonEmptyString,
  result: Schema.Union(
    Schema.Struct({
      exitCode: Schema.Literal(0),
      summary: controllerProgramFinishedSummary,
    }),
    Schema.Struct({
      exitCode: Schema.Literal(1),
      summary: controllerFailedRunSummary,
      diagnostic: Schema.optional(Schema.String),
    }),
  ),
});
/** Decoded final line of one profile submission. */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- the value is the runtime Schema and the type is its decoded result.
export type ProfileRunResult = typeof ProfileRunResult.Type;

const encodeLine = Schema.encodeSync(Schema.parseJson(ProfileRunResult));

/**
 * Encode one finished submission as the line the executable prints.
 *
 * Typed by the schema rather than by the submitter's own result so that the
 * public declaration reaches no submission or Temporal types; the canary
 * beside this module pins the two as the same shape.
 *
 * @param submission Coarse run result and ephemeral run identity.
 * @returns One newline-free JSON line decodable with `ProfileRunResult`.
 */
export function encodeProfileRunResult(submission: ProfileRunResult): string {
  return encodeLine(submission);
}
