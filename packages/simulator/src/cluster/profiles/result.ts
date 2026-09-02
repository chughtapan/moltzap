/** @file The one JSON line every profile submitter prints when it finishes. */

import { Schema } from "effect";
// safer-arch-ignore no-upward-layer-import: the submitter's final line carries the controller's serializable run summary back to the operator, so the summary shape is owned where the controller writes it.
import { controllerRunResult } from "../controller/summary.js";

/**
 * Schema of the final line `moltzap-sim run` prints for one submission.
 *
 * A consumer that spawns the executable decodes its stdout with this schema
 * rather than copying the shape: the submitter is a separate process, so
 * nothing else would notice the two sides disagreeing until a live run
 * produced an undecodable line. The submitter's own result type derives from
 * this schema, so the two cannot drift.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention, agent-code-guard/no-exported-brand-constructor -- consumers of the packed executable decode its exact closed stdout contract at their Schema boundary.
export const ProfileRunResult = Schema.Struct({
  runId: Schema.NonEmptyString,
  namespace: Schema.NonEmptyString,
  result: controllerRunResult,
});
/** Decoded form of the one result line `moltzap-sim run` prints. */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- the value is the runtime Schema and the type is its decoded result.
export type ProfileRunResult = typeof ProfileRunResult.Type;

/**
 * Encode one finished submission as the one newline-free JSON line the
 * executable prints, typed by the schema so that the public declaration
 * reaches no submission or Temporal types.
 */
export const encodeProfileRunResult = Schema.encodeSync(
  Schema.parseJson(ProfileRunResult),
);
