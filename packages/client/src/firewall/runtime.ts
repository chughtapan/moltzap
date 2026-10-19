/** @file Runtime-safe projections of local message policy, separate from peer content. */

import { Data, Schema } from "effect";

const exactStruct = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct(fields).annotations({
    parseOptions: { exact: true, onExcessProperty: "error" },
  });

/** An opaque local assessment reference conveys no approval or lookup authority. */
const checkIdSchema = Schema.String.pipe(Schema.pattern(/^chk_[a-f0-9]{64}$/u));

/** Only registered instructions and runtime-visible subjects cross into a host. */
const checkedGuidance = {
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
};

/**
 * A result's guidance: one entry per answer whose check produced advice,
 * keyed by the member's `agent:` address, and one for the question when the
 * question was checked with the result. Each entry carries its own check.
 */
const resultGuidance = exactStruct({
  question: Schema.optionalWith(exactStruct(checkedGuidance), { exact: true }),
  answers: Schema.Array(
    exactStruct({ member: Schema.NonEmptyTrimmedString, ...checkedGuidance }),
  ),
});

/**
 * Guidance for one checked message or request, or per checked text of a
 * collective result.
 */
export const localGuidanceSchema = Schema.Union(
  exactStruct(checkedGuidance),
  resultGuidance,
).annotations({ identifier: "LocalGuidance" });

/** Local advice accompanies the envelope and never changes a certified item. */
export type LocalGuidance = typeof localGuidanceSchema.Type;

/** The guidance of one checked text: a message, a request, an answer or a question. */
export type CheckedGuidance = Extract<
  LocalGuidance,
  { readonly checkId: string }
>;

/** Why a local check holds a text: the same closed set for a refused send and a withheld incoming text. */
const firewallRefusal = Schema.Literal(
  "prohibited",
  "unresolved-evidence",
  "check-unavailable",
  "norm-violation",
  "approval-required",
);

/**
 * Text the local firewall withheld from the runtime, in place of a peer's
 * answer or question: the check that withheld it and why. It is local
 * projection, not peer content.
 */
export const withheldText = exactStruct({
  kind: Schema.Literal("withheld"),
  checkId: checkIdSchema,
  reason: firewallRefusal,
});

/** Closed refusal data is retained verbatim for idempotent send retries. */
export const firewallRefusalSchema = exactStruct({
  checkId: checkIdSchema,
  refusal: firewallRefusal,
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
  "norm-violation": "the message does not satisfy local norms",
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
    const feedback = this.feedback
      .map((item) => `Next action: ${item.nextAction}. ${item.text}`)
      .join(" ");
    const description = `send withheld (check ${this.checkId}): ${refusalText[this.refusal]}.`;
    return feedback.length === 0 ? description : `${description} ${feedback}`;
  }
}
