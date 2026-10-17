/** @file English policies implement the same atomic middleware contract as code. */

import { Clock, Effect, Either, Schema } from "effect";
import { createHash } from "node:crypto";
import { makeEnglishRequest, questionEdition } from "./questions.js";
import {
  captureResult,
  CheckInputError,
  type DecisionProvider,
  DecisionProviderError,
  type DecisionRequest,
  DecisionResponse,
  decodeFrozen,
  type EnglishCheck,
  EnglishPolicySettings,
  EnglishRule,
  type MessageMiddleware,
  type MiddlewareInput,
  type MiddlewareResult,
  NormExpectation,
  type PolicyFinding,
  type PolicyStageTrace,
  RuleDescription,
} from "./values.js";

const decideWithinBudget = Effect.fn("EnglishPolicy.decideWithinBudget")(
  function* (
    request: DecisionRequest,
    provider: DecisionProvider,
    settings: EnglishPolicySettings,
  ) {
    const received = yield* provider.decide(request).pipe(
      Effect.timeoutFail({
        duration: settings.timeoutMilliseconds,
        onTimeout: () => new DecisionProviderError({ reason: "timeout" }),
      }),
    );
    const response = yield* Schema.decodeUnknown(DecisionResponse)(
      received,
    ).pipe(
      Effect.flatMap(Schema.encode(Schema.parseJson(DecisionResponse))),
      Effect.flatMap(Schema.decode(Schema.parseJson(DecisionResponse))),
      Effect.catchTag("ParseError", () =>
        Effect.fail(new DecisionProviderError({ reason: "invalid-response" })),
      ),
    );
    if (!validAnswers(request, response)) {
      return yield* new DecisionProviderError({
        reason: "invalid-response",
        response: response.raw,
      });
    }
    return response;
  },
);

function validAnswers(
  request: DecisionRequest,
  response: DecisionResponse,
): boolean {
  const questions = Object.entries(request.questions);
  if (questions.length !== Object.keys(response.answers).length) {
    return false;
  }
  return questions.every(([id, question]) => {
    const answer = response.answers[id];
    if (answer === undefined) {
      return false;
    }
    const choices = Object.keys(question.criteria);
    const probabilities = Object.values(answer.probabilities);
    const selected = answer.probabilities[answer.choice];
    if (
      selected === undefined ||
      !choices.includes(answer.choice) ||
      choices.length !== probabilities.length
    ) {
      return false;
    }
    return (
      choices.every((choice) => Object.hasOwn(answer.probabilities, choice)) &&
      probabilities.every((value) => value <= selected) &&
      Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1) <=
        roundingTolerance(probabilities)
    );
  });
}

/** Jev rounds to hundredths; retain its distribution without normalization. */
function roundingTolerance(probabilities: readonly number[]): number {
  const rounded = probabilities.every(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8,
  );
  return (
    (rounded ? Math.min(probabilities.length * 0.005, 0.02) : 0.001) +
    Number.EPSILON * probabilities.length
  );
}

const runStage = Effect.fn("EnglishPolicy.runStage")(function* (
  preparation: ReturnType<typeof makeEnglishRequest>,
  provider: DecisionProvider,
  settings: EnglishPolicySettings,
): Effect.fn.Return<PolicyStageTrace> {
  if ("status" in preparation) {
    return preparation;
  }
  const request = preparation;
  if (Object.keys(request.questions).length === 0) {
    return { stage: request.stage, status: "empty", elapsedMilliseconds: 0 };
  }
  const started = yield* Clock.currentTimeMillis;
  const response = yield* captureResult(
    decideWithinBudget(request, provider, settings),
    () => new DecisionProviderError({ reason: "defect" }),
  );
  const finished = yield* Clock.currentTimeMillis;
  const base = {
    stage: request.stage,
    request,
    elapsedMilliseconds: finished - started,
  };
  return Either.match(response, {
    onLeft: (failure): PolicyStageTrace => ({
      ...base,
      status: "failed",
      failure,
    }),
    onRight: (value): PolicyStageTrace => ({
      ...base,
      status: "answered",
      response: value,
      uncertainQuestions: Object.entries(value.answers).flatMap(
        ([id, answer]) =>
          answer.choice === "unresolved" ||
          (answer.probabilities[answer.choice] ?? 0) <
            settings.minimumProbability
            ? [id]
            : [],
      ),
    }),
  });
});

const evaluateConformance = Effect.fn("EnglishPolicy.conformance")(function* (
  snapshot: EnglishCheck,
  expectations: PolicyStageTrace,
  provider: DecisionProvider,
  settings: EnglishPolicySettings,
): Effect.fn.Return<PolicyStageTrace> {
  const ready =
    expectations.status === "empty" ||
    (expectations.status === "answered" &&
      expectations.uncertainQuestions.length === 0);
  if (!ready) {
    return {
      stage: "conformance",
      status: "unavailable",
      dependency: "expectations",
      elapsedMilliseconds: 0,
    };
  }
  return yield* runStage(
    makeEnglishRequest(
      "conformance",
      snapshot,
      settings.maximumRequestBytes,
      readNorms(expectations),
    ),
    provider,
    settings,
  );
});

/**
 * Expectations use only the original evidence; previous middleware judgments
 * have no trustworthy provenance saying whether they were derived from the draft.
 */
const checkEnglish = Effect.fn("EnglishPolicy.check")(function* (
  input: MiddlewareInput,
  policy: Pick<EnglishCheck, "rules" | "revision">,
  provider: DecisionProvider,
  settings: EnglishPolicySettings,
): Effect.fn.Return<MiddlewareResult> {
  const check: EnglishCheck = {
    event: input.event,
    context: input.context,
    rules: policy.rules,
    revision: policy.revision,
  };
  const trace: PolicyStageTrace[] = [];
  for (const stage of [
    "applicability",
    "safety",
    "autonomy",
    "expectations",
  ] as const) {
    trace.push(
      yield* runStage(
        makeEnglishRequest(stage, check, settings.maximumRequestBytes),
        provider,
        settings,
      ),
    );
  }
  const expectations = trace.find((entry) => entry.stage === "expectations");
  const norms = expectations === undefined ? [] : readNorms(expectations);
  if (check.event.direction === "outgoing" && expectations !== undefined) {
    trace.push(
      yield* evaluateConformance(check, expectations, provider, settings),
    );
  }
  return {
    findings: trace.flatMap((stage) => stageFindings(stage, policy.rules)),
    expectations: norms,
    trace: {
      format: "english-policy/v1",
      data: JSON.stringify({ questionEdition, settings, stages: trace }),
    },
  };
});

/**
 * Freezes English documents and provider settings for repeated checks in either
 * direction. Question semantics and documents determine the recorded revision.
 *
 * ```mermaid
 * flowchart TD
 *   I[Original message and context] --> A[Applicability]
 *   A --> S[Personal trust]
 *   S --> U[Autonomy]
 *   U --> N[Norm expectations from permitted evidence]
 *   N --> C[Outgoing conformance when expectations are available]
 *   C --> R[Return all findings and private stage trace]
 * ```
 */
export const makeEnglishPolicy = Effect.fn("makeEnglishPolicy")(
  function* (options: {
    readonly id: string;
    readonly rules: readonly EnglishRule[];
    readonly provider: DecisionProvider;
    readonly settings: unknown;
  }): Effect.fn.Return<MessageMiddleware, CheckInputError> {
    const settings = yield* decodeFrozen(
      EnglishPolicySettings,
      options.settings,
    ).pipe(
      Effect.catchTag("ParseError", () =>
        Effect.fail(new CheckInputError({ reason: "settings" })),
      ),
    );
    const { id, rules } = yield* decodeFrozen(
      Schema.Struct({
        id: Schema.NonEmptyTrimmedString,
        rules: Schema.NonEmptyArray(EnglishRule),
      }),
      { id: options.id, rules: options.rules },
    ).pipe(
      Effect.catchTag("ParseError", () =>
        Effect.fail(new CheckInputError({ reason: "registration" })),
      ),
    );
    if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
      return yield* new CheckInputError({ reason: "registration" });
    }
    const descriptions = yield* Schema.decodeUnknown(
      Schema.Array(RuleDescription),
    )(rules).pipe(
      Effect.flatMap((value) =>
        decodeFrozen(Schema.Array(RuleDescription), value),
      ),
      Effect.catchTag("ParseError", () =>
        Effect.fail(new CheckInputError({ reason: "registration" })),
      ),
    );
    const revision = englishRevision(rules, settings);
    const provider = Object.freeze({
      decide: options.provider.decide.bind(options.provider),
    });
    return Object.freeze({
      id,
      revision,
      rules: descriptions,
      check: (input: MiddlewareInput) =>
        checkEnglish(input, { rules, revision }, provider, settings),
    });
  },
);

function englishRevision(
  rules: readonly EnglishRule[],
  settings: EnglishPolicySettings,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ questionEdition, rules, settings }))
    .digest("hex");
}

function readNorms(trace: PolicyStageTrace): readonly NormExpectation[] {
  if (trace.status !== "answered" || trace.uncertainQuestions.length !== 0) {
    return [];
  }
  return Object.entries(trace.request.questions).flatMap(([id, question]) => {
    const expectation = trace.response.answers[id]?.choice;
    if (
      question.purpose !== "assessment" ||
      !Schema.is(NormExpectation.fields.expectation)(expectation)
    ) {
      return [];
    }
    return [
      {
        ruleId: question.ruleId,
        expectation,
        subjects: readSubjects(trace, question.ruleId),
      },
    ];
  });
}

function readSubjects(
  trace: Extract<PolicyStageTrace, { readonly status: "answered" }>,
  ruleId: string,
): readonly string[] {
  return Object.entries(trace.request.questions).flatMap(([id, question]) => {
    if (question.ruleId !== ruleId || question.purpose !== "subject") {
      return [];
    }
    return question.subject !== undefined &&
      trace.response.answers[id]?.choice === "relevant"
      ? [question.subject]
      : [];
  });
}

function stageIncludes(
  rule: EnglishRule,
  stage: PolicyStageTrace["stage"],
): boolean {
  if (stage === "applicability" || rule.kind === stage) {
    return true;
  }
  return (
    rule.kind === "norm" &&
    (stage === "expectations" || stage === "conformance")
  );
}

function answerOutcome(
  choice?: string,
): Exclude<PolicyFinding["outcome"], "hold"> {
  switch (choice) {
    case undefined:
      return "pass";
    case "prohibited":
      return "block";
    case "violation":
      return "revise";
    case "approval-required":
      return "approval-required";
    default:
      return "pass";
  }
}

function stageFindings(
  trace: PolicyStageTrace,
  rules: readonly EnglishRule[],
): PolicyFinding[] {
  switch (trace.status) {
    case "empty":
      return [];
    case "failed":
    case "unavailable":
      return rules
        .filter((rule) => stageIncludes(rule, trace.stage))
        .map((rule) => ({
          ruleId: rule.id,
          outcome: "hold",
          reason:
            trace.status === "failed"
              ? "check-unavailable"
              : "unresolved-evidence",
        }));
    case "answered":
      return Object.entries(trace.request.questions).map(([id, question]) => {
        if (trace.uncertainQuestions.includes(id)) {
          return {
            ruleId: question.ruleId,
            outcome: "hold",
            reason: "unresolved-evidence",
          };
        }
        const choice = trace.response.answers[id]?.choice;
        const outcome = answerOutcome(choice);
        return { ruleId: question.ruleId, outcome };
      });
    default:
      return trace satisfies never;
  }
}
