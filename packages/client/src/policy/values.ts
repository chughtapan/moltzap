/** @file Data-only contracts for message assessment at trusted composition. */

import { Data, type Effect, Schema } from "effect";

const identifier = Schema.NonEmptyTrimmedString;
const visibility = Schema.Literal("runtime", "assessor");
const probability = Schema.Number.pipe(Schema.between(0, 1));
const nextAction = Schema.Literal("revise", "wait", "stop", "seek-approval");
const rule = Schema.Struct({
  id: identifier,
  kind: Schema.Literal("safety", "autonomy", "norm"),
  text: Schema.NonEmptyString,
  guidance: Schema.optional(Schema.NonEmptyString),
  feedback: Schema.optional(
    Schema.Struct({ text: Schema.NonEmptyString, nextAction }),
  ),
});
const message = Schema.Struct({
  id: identifier,
  sender: identifier,
  recipients: Schema.NonEmptyArray(identifier),
  text: Schema.String,
});

/**
 * Trusted composition supplies authenticated attribution, authorized evidence
 * and an opaque binding of the exact candidate, owner, recipients and versions.
 * Verified authorization is an upstream capability, never a peer claim. Only
 * explicitly publishable rule guidance/feedback and safe evaluator-owned
 * fallback feedback may reach the runtime.
 */
export class MessagePolicySnapshot extends Schema.Class<MessagePolicySnapshot>(
  "MessagePolicySnapshot",
)({
  binding: identifier,
  principal: identifier,
  direction: Schema.Literal("incoming", "outgoing"),
  candidate: message,
  policy: Schema.Struct({
    digest: identifier,
    rules: Schema.NonEmptyArray(rule),
  }),
  history: Schema.Array(
    message.pipe(
      Schema.extend(
        Schema.Struct({
          visibility,
          admission: Schema.Literal("admitted", "withheld"),
        }),
      ),
    ),
  ),
  facts: Schema.Array(
    Schema.Struct({
      id: identifier,
      source: identifier,
      text: Schema.NonEmptyString,
      visibility,
    }),
  ),
  gaps: Schema.Array(Schema.NonEmptyString),
  authorization: Schema.Union(
    Schema.Struct({ kind: Schema.Literal("absent") }),
    Schema.Struct({ kind: Schema.Literal("verified"), binding: identifier }),
  ),
}) {}

/**
 * Byte budgets bound serialized input without estimating tokenizer output.
 * A selected probability is a routing threshold, not provider confidence or
 * a claimed safety guarantee. Every stage uses this same recorded setting.
 */
export class MessagePolicySettings extends Schema.Class<MessagePolicySettings>(
  "MessagePolicySettings",
)({
  minimumProbability: Schema.Number.pipe(Schema.between(0.5, 1)),
  maximumRequestBytes: Schema.Positive.pipe(Schema.int()),
  timeoutMilliseconds: Schema.Positive.pipe(Schema.int()),
}) {}

/** The fixed chain is versioned independently of policy wording and models. */
export type PolicyStage =
  | "applicability"
  | "safety"
  | "autonomy"
  | "expectations"
  | "conformance";

/**
 * State is serialized JSON. Question ids and purpose are audit metadata;
 * instructions carry rule identity because providers need not expose ids to
 * the underlying model.
 */
export interface PolicyDecisionRequest {
  readonly stage: PolicyStage;
  readonly state: string;
  readonly questions: Readonly<
    Record<
      string,
      {
        readonly ruleId: string;
        readonly purpose: "assessment" | "subject";
        readonly subject?: string;
        readonly instructions: string;
        readonly criteria: Readonly<Record<string, string>>;
      }
    >
  >;
}

/** Raw distributions and provider confidence survive routing unchanged. */
export class PolicyDecisionResponse extends Schema.Class<PolicyDecisionResponse>(
  "PolicyDecisionResponse",
)({
  provider: identifier,
  model: identifier,
  answers: Schema.Record({
    key: identifier,
    value: Schema.Struct({
      choice: identifier,
      probabilities: Schema.Record({ key: identifier, value: probability }),
      confidence: Schema.optional(probability),
    }),
  }),
  usage: Schema.Record({ key: identifier, value: Schema.NonNegativeInt }),
  raw: Schema.String,
}) {}

/**
 * Closed operational reasons are safe to project without provider diagnostics.
 * The optional response belongs only in the private audit and must be scrubbed
 * of credentials by the provider adapter.
 */
export class PolicyProviderFailure extends Data.TaggedError(
  "PolicyProviderFailure",
)<{
  readonly reason:
    | "configuration"
    | "transport"
    | "http"
    | "timeout"
    | "invalid-response"
    | "budget";
  readonly status?: number;
  readonly response?: string;
}> {}

/** A provider cannot send, approve, activate policy or query additional facts. */
export interface PolicyDecisionProvider {
  readonly decide: (
    request: PolicyDecisionRequest,
  ) => Effect.Effect<PolicyDecisionResponse, PolicyProviderFailure>;
}

/** Invalid composition input never reaches inference or becomes permission. */
export class MessagePolicyInputError extends Data.TaggedError(
  "MessagePolicyInputError",
)<{
  readonly reason: "settings" | "snapshot";
}> {}

/**
 * An unavailable dependency is distinct from an answered but uncertain question.
 * Trace requests, responses and evidence are private assessor material.
 * A preparation-budget failure has no request; partial requests never escape.
 */
export type PolicyStageTrace = {
  readonly stage: PolicyStage;
  readonly elapsedMilliseconds: number;
} & (
  | {
      readonly status: "answered";
      readonly request: PolicyDecisionRequest;
      readonly response: PolicyDecisionResponse;
      readonly uncertainQuestions: readonly string[];
    }
  | {
      readonly status: "failed";
      readonly request?: PolicyDecisionRequest;
      readonly failure: PolicyProviderFailure;
    }
  | { readonly status: "empty" }
  | { readonly status: "unavailable"; readonly dependency: "expectations" }
);

/** References are selected independently from admitted runtime-visible messages. */
export interface PolicyNormGuidance {
  readonly ruleId: string;
  readonly expectation: "required" | "permitted" | "wait" | "none";
  readonly subjects: readonly string[];
  readonly instruction?: string;
}

/**
 * The judgment is not an admission receipt. Client must still fence the binding
 * atomically with delivery or intent publication. Guidance is absent on refusals.
 */
export interface MessagePolicyAssessment {
  readonly binding: string;
  readonly questionEdition: string;
  readonly policyDigest: string;
  readonly settings: MessagePolicySettings;
  readonly judgment: "allow" | "block" | "hold" | "revise";
  readonly reason:
    | "eligible"
    | "prohibited"
    | "unresolved-evidence"
    | "assessment-unavailable"
    | "norm-violation"
    | "approval-required";
  readonly feedback: ReadonlyArray<{
    readonly nextAction: typeof nextAction.Type;
    readonly text: string;
  }>;
  readonly guidance: readonly PolicyNormGuidance[];
  readonly trace: readonly PolicyStageTrace[];
}

/** Pure assessment with typed composition errors and normal Effect cancellation. */
export interface MessagePolicyEvaluator {
  readonly evaluate: (
    snapshot: unknown,
  ) => Effect.Effect<MessagePolicyAssessment, MessagePolicyInputError>;
}
