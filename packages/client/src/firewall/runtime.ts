/** @file Runtime-safe projections of local message policy, separate from peer content. */

import { Data, Schema } from "effect";

const exactStruct = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct(fields).annotations({
    parseOptions: { exact: true, onExcessProperty: "error" },
  });

/** An opaque local assessment reference conveys no approval or lookup authority. */
const checkIdSchema = Schema.String.pipe(
  Schema.pattern(/^chk_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u),
);

/** Only registered instructions and runtime-visible subjects cross into a host. */
export const localGuidanceSchema = exactStruct({
  checkId: checkIdSchema,
  subjects: Schema.Array(
    exactStruct({
      id: Schema.NonEmptyTrimmedString,
      sender: Schema.NonEmptyTrimmedString,
      recipients: Schema.Array(Schema.NonEmptyTrimmedString),
      text: Schema.String,
    }),
  ),
  instructions: Schema.Array(
    exactStruct({
      middlewareId: Schema.NonEmptyTrimmedString,
      ruleId: Schema.NonEmptyTrimmedString,
      expectation: Schema.Literal("required", "permitted", "wait", "none"),
      subjects: Schema.Array(Schema.NonEmptyTrimmedString),
      instruction: Schema.NonEmptyString,
    }),
  ),
});

/** Local advice accompanies the envelope and never changes a certified item. */
export type LocalGuidance = typeof localGuidanceSchema.Type;

/** Closed refusal data is retained verbatim for idempotent send retries. */
export const firewallRefusalSchema = exactStruct({
  checkId: checkIdSchema,
  refusal: Schema.Literal(
    "prohibited",
    "unresolved-evidence",
    "check-unavailable",
    "norm-violation",
    "approval-required",
  ),
  feedback: Schema.Array(
    exactStruct({
      nextAction: Schema.Literal("revise", "wait", "stop", "seek-approval"),
      text: Schema.NonEmptyString,
    }),
  ),
});

const refusalText = {
  prohibited: "local policy prohibits this message",
  "unresolved-evidence": "local policy needs more evidence or owner review",
  "check-unavailable": "the message policy check could not complete",
  "norm-violation": "the message needs revision to satisfy local norms",
  "approval-required": "this message requires owner approval",
} as const;

/**
 * A refusal is returned only before an application invocation creates any intent.
 * Its opaque check reference survives hosts that retain only the error message.
 */
export class FirewallSendError extends Data.TaggedError("FirewallSendError")<
  typeof firewallRefusalSchema.Type
> {
  override get message(): string {
    const feedback = this.feedback.map((item) => item.text).join(" ");
    const description = `send withheld (check ${this.checkId}): ${refusalText[this.refusal]}.`;
    return feedback.length === 0 ? description : `${description} ${feedback}`;
  }
}
