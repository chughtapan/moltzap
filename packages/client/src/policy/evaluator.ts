/** @file Fixed Effect composition without delivery, storage or host capabilities. */

import { Clock, Effect, Either, Schema } from "effect";
import { composeAssessment, readNorms } from "./assessment.js";
import { makePolicyRequest } from "./questions.js";
import {
  type MessagePolicyEvaluator,
  MessagePolicyInputError,
  MessagePolicySettings,
  MessagePolicySnapshot,
  type PolicyDecisionProvider,
  type PolicyDecisionRequest,
  PolicyDecisionResponse,
  PolicyProviderFailure,
  type PolicyStageTrace,
} from "./values.js";

const decodeSnapshot = Effect.fn("MessagePolicy.decodeSnapshot")(function* (
  input: unknown,
) {
  const snapshot = yield* Schema.decodeUnknown(MessagePolicySnapshot)(input, {
    onExcessProperty: "error",
  }).pipe(
    Effect.flatMap(Schema.encode(Schema.parseJson(MessagePolicySnapshot))),
    Effect.flatMap(Schema.decode(Schema.parseJson(MessagePolicySnapshot))),
    Effect.catchTag("ParseError", () =>
      Effect.fail(new MessagePolicyInputError({ reason: "snapshot" })),
    ),
  );
  const references = [
    snapshot.candidate.id,
    ...snapshot.history.map((entry) => entry.id),
    ...snapshot.facts.map((entry) => entry.id),
  ];
  if (
    new Set(references).size !== references.length ||
    new Set(snapshot.policy.rules.map((rule) => rule.id)).size !==
      snapshot.policy.rules.length ||
    new Set(snapshot.candidate.recipients).size !==
      snapshot.candidate.recipients.length
  ) {
    return yield* new MessagePolicyInputError({ reason: "snapshot" });
  }
  const validAttribution =
    snapshot.direction === "outgoing"
      ? snapshot.candidate.sender === snapshot.principal
      : snapshot.candidate.recipients.includes(snapshot.principal);
  if (!validAttribution) {
    return yield* new MessagePolicyInputError({ reason: "snapshot" });
  }
  return snapshot;
});

const decideWithinBudget = Effect.fn("MessagePolicy.decideWithinBudget")(
  function* (
    request: PolicyDecisionRequest,
    provider: PolicyDecisionProvider,
    settings: MessagePolicySettings,
  ) {
    const received = yield* provider.decide(request).pipe(
      Effect.timeoutFail({
        duration: settings.timeoutMilliseconds,
        onTimeout: () => new PolicyProviderFailure({ reason: "timeout" }),
      }),
    );
    const response = yield* Schema.decodeUnknown(PolicyDecisionResponse)(
      received,
    ).pipe(
      Effect.flatMap(Schema.encode(Schema.parseJson(PolicyDecisionResponse))),
      Effect.flatMap(Schema.decode(Schema.parseJson(PolicyDecisionResponse))),
      Effect.catchTag("ParseError", () =>
        Effect.fail(new PolicyProviderFailure({ reason: "invalid-response" })),
      ),
    );
    if (!validAnswers(request, response)) {
      return yield* new PolicyProviderFailure({
        reason: "invalid-response",
        response: response.raw,
      });
    }
    return response;
  },
);

function validAnswers(
  request: PolicyDecisionRequest,
  response: PolicyDecisionResponse,
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

const runStage = Effect.fn("MessagePolicy.runStage")(function* (
  preparation: ReturnType<typeof makePolicyRequest>,
  provider: PolicyDecisionProvider,
  settings: MessagePolicySettings,
): Effect.fn.Return<PolicyStageTrace> {
  if ("status" in preparation) {
    return preparation;
  }
  const request = preparation;
  if (Object.keys(request.questions).length === 0) {
    return { stage: request.stage, status: "empty", elapsedMilliseconds: 0 };
  }
  const started = yield* Clock.currentTimeMillis;
  const response = yield* decideWithinBudget(request, provider, settings).pipe(
    Effect.either,
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

const evaluateConformance = Effect.fn("MessagePolicy.conformance")(function* (
  snapshot: MessagePolicySnapshot,
  expectations: PolicyStageTrace,
  provider: PolicyDecisionProvider,
  settings: MessagePolicySettings,
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
    makePolicyRequest(
      "conformance",
      snapshot,
      settings.maximumRequestBytes,
      readNorms(expectations),
    ),
    provider,
    settings,
  );
});

const evaluateSnapshot = Effect.fn("MessagePolicyEvaluator.evaluate")(
  function* (
    input: unknown,
    provider: PolicyDecisionProvider,
    settings: MessagePolicySettings,
  ) {
    const snapshot = yield* decodeSnapshot(input);
    const applicability = yield* runStage(
      makePolicyRequest(
        "applicability",
        snapshot,
        settings.maximumRequestBytes,
      ),
      provider,
      settings,
    );
    const safety = yield* runStage(
      makePolicyRequest("safety", snapshot, settings.maximumRequestBytes),
      provider,
      settings,
    );
    const autonomy = yield* runStage(
      makePolicyRequest("autonomy", snapshot, settings.maximumRequestBytes),
      provider,
      settings,
    );
    const expectations = yield* runStage(
      makePolicyRequest("expectations", snapshot, settings.maximumRequestBytes),
      provider,
      settings,
    );
    const norms = readNorms(expectations);
    const trace: PolicyStageTrace[] = [
      applicability,
      safety,
      autonomy,
      expectations,
    ];
    if (snapshot.direction === "outgoing") {
      trace.push(
        yield* evaluateConformance(snapshot, expectations, provider, settings),
      );
    }
    return composeAssessment(snapshot, settings, trace, norms);
  },
);

/**
 * Builds the same value-oriented evaluator for offline and live composition.
 * Interruption propagates normally. A semantic rejection does not skip later
 * independent diagnostics; missing expectations make conformance unavailable.
 *
 * ```mermaid
 * flowchart TD
 *   S[Validated immutable snapshot] --> A[Applicability]
 *   A --> F[Safety]
 *   F --> U[Autonomy]
 *   U --> N[Norm expectations]
 *   N --> C[Outgoing conformance when expectations are valid]
 *   C --> R[Compose judgment and permitted feedback]
 * ```
 */
export const makeMessagePolicyEvaluator = Effect.fn(
  "makeMessagePolicyEvaluator",
)(function* (options: {
  readonly provider: PolicyDecisionProvider;
  readonly settings: unknown;
}): Effect.fn.Return<MessagePolicyEvaluator, MessagePolicyInputError> {
  const settings = yield* Schema.decodeUnknown(MessagePolicySettings)(
    options.settings,
  ).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new MessagePolicyInputError({ reason: "settings" })),
    ),
  );
  const frozenSettings = Object.freeze(new MessagePolicySettings(settings));
  const provider = Object.freeze({
    decide: options.provider.decide.bind(options.provider),
  });
  return {
    evaluate: (input) => evaluateSnapshot(input, provider, frozenSettings),
  };
});
