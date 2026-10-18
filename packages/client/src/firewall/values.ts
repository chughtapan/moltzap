/** @file Validated evidence and shared code/English middleware contracts. */

import { Cause, Data, Effect, Either, Schema } from "effect";

const identifier = Schema.NonEmptyTrimmedString;
const visibility = Schema.Literal("runtime", "assessor");
const probability = Schema.Number.pipe(Schema.between(0, 1));
const nextAction = Schema.Literal("revise", "wait", "stop", "seek-approval");

/** Attribution is supplied by Client, never inferred from names in the body. */
export class Message extends Schema.Class<Message>("Message")({
  id: identifier,
  sender: identifier,
  recipients: Schema.NonEmptyArray(identifier),
  text: Schema.String,
}) {}

const approval = Schema.Struct({
  kind: Schema.Literal("verified"),
  principal: identifier,
  candidate: Message,
});

/**
 * Trusted composition supplies authorized earlier evidence and candidate-specific
 * approval. Agent identity and principal identity have different meanings.
 * The first live composition supplies absent approval.
 */
export class MessageContext extends Schema.Class<MessageContext>(
  "MessageContext",
)({
  agentId: identifier,
  principal: identifier,
  participants: Schema.Array(
    Schema.Struct({
      agentId: identifier,
      principal: identifier,
    }),
  ),
  history: Schema.Array(
    Schema.Struct({
      ...Message.fields,
      visibility,
      admission: Schema.Literal("admitted", "withheld"),
    }),
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
    approval,
  ),
}) {}

/** A direction is assigned by the boundary method, not by a peer's payload. */
const messageEvent = Schema.Union(
  Schema.Struct({ direction: Schema.Literal("incoming"), message: Message }),
  Schema.Struct({ direction: Schema.Literal("outgoing"), message: Message }),
);

/** Direction determines whether the message is received or still an unsent draft. */
export type MessageEvent = typeof messageEvent.Type;

/** Runtime advice can only select templates registered by trusted composition. */
export class RuleDescription extends Schema.Class<RuleDescription>(
  "RuleDescription",
)({
  id: identifier,
  kind: Schema.Literal("safety", "autonomy", "norm"),
  source: Schema.optional(identifier),
  guidance: Schema.optional(Schema.NonEmptyString),
  feedback: Schema.optional(
    Schema.Struct({
      text: Schema.NonEmptyString,
      nextAction,
    }),
  ),
}) {}

/** Text is interpreted by the provider; it is never compiled into executable code. */
export class EnglishRule extends Schema.Class<EnglishRule>("EnglishRule")({
  ...RuleDescription.fields,
  text: Schema.NonEmptyString,
}) {}

/** Pass is local to one rule; only the complete firewall may return allow. */
const policyFinding = Schema.Union(
  Schema.Struct({
    ruleId: identifier,
    outcome: Schema.Literal(
      "pass",
      "not-applicable",
      "block",
      "revise",
      "approval-required",
    ),
  }),
  Schema.Struct({
    ruleId: identifier,
    outcome: Schema.Literal("hold"),
    reason: Schema.Literal("unresolved-evidence", "check-unavailable"),
  }),
);

/** Rule findings accumulate independently of their English or code representation. */
export type PolicyFinding = typeof policyFinding.Type;

/** Subjects refer only to admitted runtime-visible messages or the incoming event. */
export class NormExpectation extends Schema.Class<NormExpectation>(
  "NormExpectation",
)({
  ruleId: identifier,
  expectation: Schema.Literal("required", "permitted", "wait", "none"),
  subjects: Schema.Array(identifier),
}) {}

/** Opaque bounded diagnostics stay private; the runner never interprets their format. */
export class PrivateCheckTrace extends Schema.Class<PrivateCheckTrace>(
  "PrivateCheckTrace",
)({
  format: identifier,
  data: Schema.String,
}) {}

/** A result is atomic: interrupted middleware has no returned partial findings. */
export class MiddlewareResult extends Schema.Class<MiddlewareResult>(
  "MiddlewareResult",
)({
  findings: Schema.Array(policyFinding),
  expectations: Schema.Array(NormExpectation),
  trace: Schema.optional(PrivateCheckTrace),
}) {}

/** Operational failures carry closed reasons, never arbitrary exception text. */
export class MiddlewareError extends Data.TaggedError("MiddlewareError")<{
  readonly reason:
    | "unavailable"
    | "timeout"
    | "invalid-result"
    | "budget"
    | "defect";
}> {}

/** Earlier judgments cannot replace evidence or erase another rule's restriction. */
export class MiddlewareObservation extends Schema.Class<MiddlewareObservation>(
  "MiddlewareObservation",
)({
  middlewareId: identifier,
  revision: identifier,
  status: Schema.Literal("completed", "unavailable"),
  findings: Schema.Array(policyFinding),
  expectations: Schema.Array(NormExpectation),
}) {}

/** Each invocation gets immutable evidence and previously validated observations. */
export class MiddlewareInput extends Schema.Class<MiddlewareInput>(
  "MiddlewareInput",
)({
  event: messageEvent,
  context: MessageContext,
  previous: Schema.Array(MiddlewareObservation),
}) {}

/**
 * Code and English policies have the same contract. Registered code is trusted;
 * it receives no messaging/store capability and must not retain conversation
 * state or perform messaging side effects.
 */
export interface MessageMiddleware {
  readonly id: string;
  readonly revision: string;
  readonly rules: readonly RuleDescription[];
  /** Descriptive audit data declared by trusted composition, never authority. */
  readonly provenance?: PrivateCheckTrace;
  readonly check: (
    input: MiddlewareInput,
  ) => Effect.Effect<MiddlewareResult, MiddlewareError>;
}

/** Sequential execution is bounded per entry and across the whole attempt. */
export class FirewallSettings extends Schema.Class<FirewallSettings>(
  "FirewallSettings",
)({
  timeoutMilliseconds: Schema.Positive.pipe(Schema.int()),
  middlewareTimeoutMilliseconds: Schema.Positive.pipe(Schema.int()),
  maximumInputBytes: Schema.Positive.pipe(Schema.int()),
  maximumResultBytes: Schema.Positive.pipe(Schema.int()),
}) {}

/** Invalid construction or evidence is a typed failure, never permission. */
export class CheckInputError extends Data.TaggedError("CheckInputError")<{
  readonly reason: "settings" | "registration" | "message" | "context";
}> {}

/** Every installed entry is attributed, including a skipped or failed check. */
export interface MiddlewareCheck extends MiddlewareObservation {
  readonly elapsedMilliseconds: number;
  readonly failure?: MiddlewareError;
  readonly trace?: PrivateCheckTrace;
}

/** Templates are projected only after the complete chain permits admission. */
export interface NormGuidance extends NormExpectation {
  readonly middlewareId: string;
  readonly instruction: string;
}

/** Private audit is separate from the only fields intended for a runtime. */
export interface FirewallCheck {
  readonly judgment: "allow" | "block" | "hold" | "revise";
  readonly reason:
    | "eligible"
    | "prohibited"
    | "unresolved-evidence"
    | "check-unavailable"
    | "norm-violation"
    | "approval-required";
  readonly feedback: ReadonlyArray<{
    readonly nextAction: typeof nextAction.Type;
    readonly text: string;
  }>;
  readonly guidance: readonly NormGuidance[];
  readonly checks: readonly MiddlewareCheck[];
}

/** Incoming checks can guide the recipient but cannot ask the sender to revise. */
interface IncomingCheck extends FirewallCheck {
  readonly judgment: "allow" | "block" | "hold";
}

/** A refusal leaves revision to a new explicit agent-authored send attempt. */
type OutgoingCheck = FirewallCheck;

/** Checking returns data; Client separately owns fresh, atomic send/delivery admission. */
export interface Firewall {
  readonly checkIncoming: (
    message: Message,
    context: MessageContext,
  ) => Effect.Effect<IncomingCheck, CheckInputError>;
  readonly checkOutgoing: (
    draft: Message,
    context: MessageContext,
  ) => Effect.Effect<OutgoingCheck, CheckInputError>;
}

/** Bytes bound allocation, not tokenizer capacity; probability is a routing setting. */
export class EnglishPolicySettings extends Schema.Class<EnglishPolicySettings>(
  "EnglishPolicySettings",
)({
  minimumProbability: Schema.Number.pipe(Schema.between(0.5, 1)),
  maximumRequestBytes: Schema.Positive.pipe(Schema.int()),
  timeoutMilliseconds: Schema.Positive.pipe(Schema.int()),
}) {}

/** Question semantics have a recorded edition independent of English wording. */
export type PolicyStage =
  | "applicability"
  | "safety"
  | "autonomy"
  | "expectations"
  | "conformance";

/** Provider input contains explicit questions and state, never execution authority. */
export interface DecisionRequest {
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
export class DecisionResponse extends Schema.Class<DecisionResponse>(
  "DecisionResponse",
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

/** The adapter scrubs credentials before retaining optional private diagnostics. */
export class DecisionProviderError extends Data.TaggedError(
  "DecisionProviderError",
)<{
  readonly reason:
    | "configuration"
    | "transport"
    | "http"
    | "timeout"
    | "invalid-response"
    | "budget"
    | "defect";
  readonly status?: number;
  readonly response?: string;
}> {}

/** Entirely code-based chains have no dependency on this optional capability. */
export interface DecisionProvider {
  /** Requested provider configuration, retained even when no response arrives. */
  readonly provenance?: PrivateCheckTrace;
  readonly decide: (
    request: DecisionRequest,
  ) => Effect.Effect<DecisionResponse, DecisionProviderError>;
}

/** Returned stages retain failures and uncertainty without inventing an answer. */
export type PolicyStageTrace = {
  readonly stage: PolicyStage;
  readonly elapsedMilliseconds: number;
} & (
  | {
      readonly status: "answered";
      readonly request: DecisionRequest;
      readonly response: DecisionResponse;
      readonly uncertainQuestions: readonly string[];
    }
  | {
      readonly status: "failed";
      readonly request?: DecisionRequest;
      readonly failure: DecisionProviderError;
    }
  | { readonly status: "empty" }
  | { readonly status: "unavailable"; readonly dependency: "expectations" }
);

/** Internal English state adds frozen documents without a public snapshot/binding. */
export interface EnglishCheck {
  readonly event: typeof messageEvent.Type;
  readonly context: MessageContext;
  readonly revision: string;
  readonly rules: readonly EnglishRule[];
}

/** Inspect the full cause before capturing failures so cleanup cannot erase cancellation. */
export function captureResult<A, E, R>(
  check: Effect.Effect<A, E, R>,
  onDefect: () => E,
): Effect.Effect<Either.Either<A, E>, never, R> {
  return Effect.matchCauseEffect(check, {
    onFailure: (cause) => {
      if (Cause.isInterrupted(cause)) {
        return Effect.failCause(Cause.stripFailures(cause));
      }
      if (Cause.isDie(cause)) {
        return Effect.succeed(Either.left(onDefect()));
      }
      return Either.match(Cause.failureOrCause(cause), {
        onLeft: (error) => Effect.succeed(Either.left(error)),
        onRight: Effect.failCause,
      });
    },
    onSuccess: (value) => Effect.succeed(Either.right(value)),
  });
}

/** Copy before freezing so callers and injected policies cannot alter later checks. */
export function decodeFrozen<A, I>(
  schema: Schema.Schema<A, I>,
  input: unknown,
) {
  return Schema.decodeUnknown(schema)(input, {
    onExcessProperty: "error",
  }).pipe(
    Effect.flatMap(Schema.encode(Schema.parseJson(schema))),
    Effect.flatMap(Schema.decode(Schema.parseJson(schema))),
    Effect.tap((value) =>
      Effect.sync(() => {
        freezeData(value);
      }),
    ),
  );
}

function freezeData(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const child of Object.values(value)) {
    freezeData(child);
  }
  Object.freeze(value);
}
