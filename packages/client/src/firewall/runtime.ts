/** @file Runtime-safe projections of local message policy, separate from peer content. */

import { Data, Schema } from "effect";

/** An opaque local assessment reference conveys no approval or lookup authority. */
const checkIdSchema = Schema.String.pipe(Schema.pattern(/^chk_[a-f0-9]{64}$/u));

/**
 * Only registered instructions and runtime-visible subjects cross into a
 * host. An instruction names either the expectation the decision provider settled and
 * the messages it refers to, or the choice and probability of a norm
 * judgment the decision provider left unsettled.
 */
const checkedGuidance = {
  checkId: checkIdSchema,
  subjects: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyTrimmedString,
      sender: Schema.NonEmptyTrimmedString,
      recipients: Schema.Array(Schema.NonEmptyTrimmedString),
      text: Schema.String,
    }),
  ),
  instructions: Schema.Array(
    Schema.Union(
      Schema.Struct({
        middlewareId: Schema.NonEmptyTrimmedString,
        ruleId: Schema.NonEmptyTrimmedString,
        expectation: Schema.Literal("required", "permitted", "wait", "none"),
        subjects: Schema.Array(Schema.NonEmptyTrimmedString),
        instruction: Schema.NonEmptyString,
      }),
      Schema.Struct({
        middlewareId: Schema.NonEmptyTrimmedString,
        ruleId: Schema.NonEmptyTrimmedString,
        uncertain: Schema.Struct({
          choice: Schema.NonEmptyTrimmedString,
          probability: Schema.Number.pipe(Schema.between(0, 1)),
        }),
        instruction: Schema.NonEmptyString,
      }),
    ),
  ),
};

/** One check's guidance, wherever a host receives it. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- Send results and inbox items embed one check's guidance; each decodes it through its own boundary function.
export const checkedGuidanceSchema = Schema.Struct(checkedGuidance);

/** The guidance of one checked text: a message, a request, an answer, a question or a send. */
export type CheckedGuidance = typeof checkedGuidanceSchema.Type;

/**
 * A result's guidance: one entry per answer whose check produced advice,
 * keyed by the member's `agent:` address, and one for the question when the
 * question was checked with the result. Each entry carries its own check.
 */
const resultGuidance = Schema.Struct({
  question: Schema.optionalWith(checkedGuidanceSchema, { exact: true }),
  answers: Schema.Array(
    Schema.Struct({ member: Schema.NonEmptyTrimmedString, ...checkedGuidance }),
  ),
});

/**
 * Guidance for one checked message or request, or per checked text of a
 * collective result.
 */
export const localGuidanceSchema = Schema.Union(
  checkedGuidanceSchema,
  resultGuidance,
).annotations({ identifier: "LocalGuidance" });

/** Local advice accompanies the envelope and never changes a certified item. */
export type LocalGuidance = typeof localGuidanceSchema.Type;

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
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- Collective results embed withheld text; InboundItem decodes it.
export const withheldText = Schema.Struct({
  kind: Schema.Literal("withheld"),
  checkId: checkIdSchema,
  reason: firewallRefusal,
});

/** Closed refusal data is retained verbatim for idempotent send retries. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- A refused send's error data embeds the refusal; decodeHarnessSendErrorData decodes it.
export const firewallRefusalSchema = Schema.Struct({
  checkId: checkIdSchema,
  refusal: firewallRefusal,
  feedback: Schema.Array(
    Schema.Struct({
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
