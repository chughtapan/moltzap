/** @file Public evaluator behavior: precedence, provenance and provider faults. */

import { effect as it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Array as EffectArray,
  FastCheck as fc,
  Fiber,
  TestClock,
} from "effect";
import { expect } from "vitest";
import {
  makeMessagePolicyEvaluator,
  type MessagePolicySnapshot,
  type PolicyDecisionProvider,
  type PolicyDecisionRequest,
  type PolicyDecisionResponse,
  PolicyProviderFailure,
  type PolicyStage,
  type PolicyStageTrace,
} from "../service/index.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Closed policy judgments, reasons and next actions are the public behavior under test. */

const privateEvidence = "PRIVATE: unrelated medical appointment at 14:00";
const repair =
  "Ask for acceptance of the chosen proposal. Do not claim agreement yet.";
const reminder =
  "After proposing a time, wait for every required participant to accept that proposal.";
const draft = "The meeting is confirmed; everyone agreed.";
const settings = {
  minimumProbability: 0.5,
  maximumRequestBytes: 60_000,
  timeoutMilliseconds: 100,
};
const snapshot = {
  binding: "candidate-owner-recipients-policy-evidence-v1",
  principal: "organizer",
  direction: "outgoing",
  candidate: {
    id: "draft",
    sender: "organizer",
    recipients: ["participant"],
    text: draft,
  },
  policy: {
    digest: "coordination-v1",
    rules: [
      {
        id: "privacy",
        kind: "safety",
        text: "Do not disclose unrelated private appointments.",
      },
      {
        id: "authority",
        kind: "autonomy",
        text: "Tentative proposals are autonomous. Final commitments require owner approval.",
      },
      {
        id: "proposal-acceptance",
        kind: "norm",
        text: "Availability is not acceptance. Everyone must accept the same concrete proposal before it is finalized.",
        guidance: reminder,
        feedback: { text: repair, nextAction: "revise" },
      },
    ],
  },
  history: [
    {
      id: "availability",
      sender: "participant",
      recipients: ["organizer"],
      text: "I am free Tuesday.",
      visibility: "runtime",
      admission: "admitted",
    },
  ],
  facts: [
    {
      id: "private-calendar",
      source: "owner-calendar",
      text: privateEvidence,
      visibility: "assessor",
    },
  ],
  gaps: [],
  authorization: { kind: "absent" },
} satisfies typeof MessagePolicySnapshot.Encoded;

function responseFor(
  request: PolicyDecisionRequest,
  choices: Readonly<Record<string, string>> = {},
): typeof PolicyDecisionResponse.Encoded {
  return {
    provider: "test-decisions",
    model: "test-model",
    raw: privateEvidence,
    usage: {},
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => {
        const selected =
          choices[
            `${request.stage}:${question.ruleId}:${question.purpose}:${question.subject ?? ""}`
          ] ??
          choices[`${request.stage}:${question.ruleId}:${question.purpose}`] ??
          defaultChoice(question.criteria);
        return [
          id,
          {
            choice: selected,
            probabilities: Object.fromEntries(
              Object.keys(question.criteria).map((choice) => [
                choice,
                choice === selected ? 1 : 0,
              ]),
            ),
          },
        ];
      }),
    ),
  };
}

function defaultChoice(criteria: Readonly<Record<string, string>>): string {
  return (
    ["compliant", "autonomous", "none", "relevant"].find((choice) =>
      Object.hasOwn(criteria, choice),
    ) ?? "unresolved"
  );
}

function provider(
  choices: Readonly<Record<string, string>> = {},
): PolicyDecisionProvider {
  return { decide: (request) => Effect.succeed(responseFor(request, choices)) };
}

function stageState(
  trace: readonly PolicyStageTrace[],
  stage: PolicyStage,
): string | undefined {
  const entry = trace.find((item) => item.stage === stage);
  return entry?.status === "answered" ? entry.request.state : undefined;
}

function uncertainExpectations(
  request: PolicyDecisionRequest,
): PolicyDecisionResponse["answers"] {
  return Object.fromEntries(
    Object.entries(request.questions).map(([id, question]) => [
      id,
      question.purpose === "assessment"
        ? {
            choice: "required",
            probabilities: {
              required: 0.4,
              permitted: 0.3,
              wait: 0.1,
              none: 0.1,
              unresolved: 0.1,
            },
          }
        : {
            choice: "irrelevant",
            probabilities: Object.fromEntries(
              Object.keys(question.criteria).map((choice) => [
                choice,
                choice === "irrelevant" ? 1 : 0,
              ]),
            ),
          },
    ]),
  );
}

const defaultProvider = provider();

const malformedAnswers: ReadonlyArray<{
  readonly name: string;
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
}> = [
  {
    name: "unknown choice",
    choice: "allow-everything",
    probabilities: { compliant: 1, prohibited: 0, unresolved: 0 },
  },
  {
    name: "missing option",
    choice: "compliant",
    probabilities: { compliant: 1 },
  },
  {
    name: "negative probability",
    choice: "compliant",
    probabilities: { compliant: 1, prohibited: -0.1, unresolved: 0.1 },
  },
  {
    name: "wrong sum",
    choice: "compliant",
    probabilities: { compliant: 0.9, prohibited: 0.9, unresolved: 0.9 },
  },
  {
    name: "nonmaximal selection",
    choice: "compliant",
    probabilities: { compliant: 0.1, prohibited: 0.8, unresolved: 0.1 },
  },
];

const evaluate = (input: unknown, decisions = defaultProvider) =>
  Effect.gen(function* () {
    const evaluator = yield* makeMessagePolicyEvaluator({
      provider: decisions,
      settings,
    });
    return yield* evaluator.evaluate(input);
  });

it("preserves the receiver of an injected provider method", () =>
  Effect.gen(function* () {
    const stateful = {
      model: "stateful-provider",
      decide(request: PolicyDecisionRequest) {
        return Effect.succeed({ ...responseFor(request), model: this.model });
      },
    };
    const result = yield* evaluate(snapshot, stateful);
    expect(result.judgment).toBe("allow");
    for (const stage of result.trace) {
      if (stage.status === "answered") {
        expect(stage.response.model).toBe(stateful.model);
      }
    }
  }));

it.prop(
  "changing any unsent draft cannot change the evidence used for expectations",
  [fc.string()],
  ([text]) =>
    Effect.gen(function* () {
      const original = yield* evaluate(snapshot);
      const changed = yield* evaluate({
        ...snapshot,
        candidate: { ...snapshot.candidate, text },
      });
      const normRequests = (assessment: typeof original) =>
        assessment.trace.flatMap((entry) =>
          entry.stage === "expectations" && entry.status === "answered"
            ? [entry.request]
            : [],
        );
      expect(normRequests(changed)).toEqual(normRequests(original));
    }),
);

it.each(malformedAnswers)("holds malformed provider answers: $name", (answer) =>
  Effect.gen(function* () {
    const decisions: PolicyDecisionProvider = {
      decide: (request) =>
        Effect.succeed(
          request.stage === "safety"
            ? {
                provider: "test",
                model: "test",
                usage: {},
                raw: privateEvidence,
                answers: Object.fromEntries(
                  Object.keys(request.questions).map((id) => [
                    id,
                    {
                      choice: answer.choice,
                      probabilities: answer.probabilities,
                    },
                  ]),
                ),
              }
            : responseFor(request),
        ),
    };
    const result = yield* evaluate(snapshot, decisions);
    expect(result.reason).toBe("assessment-unavailable");
    expect(result.guidance).toEqual([]);
  }),
);

it("distinguishes low probability from provider failure and withholds dependent conformance", () =>
  Effect.gen(function* () {
    const decisions: PolicyDecisionProvider = {
      decide: (request) =>
        Effect.succeed(
          request.stage === "expectations"
            ? {
                provider: "test",
                model: "test",
                usage: {},
                raw: "low-probability",
                answers: uncertainExpectations(request),
              }
            : responseFor(request),
        ),
    };
    const result = yield* evaluate(snapshot, decisions);
    expect(result.reason).toBe("unresolved-evidence");
    expect(
      result.trace.find((entry) => entry.stage === "conformance")?.status,
    ).toBe("unavailable");
  }));

it("isolates the captured snapshot from caller mutation during inference", () =>
  Effect.gen(function* () {
    const mutable = structuredClone(snapshot);
    const started = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const decisions: PolicyDecisionProvider = {
      decide: (request) =>
        request.stage === "applicability"
          ? Deferred.succeed(started, undefined).pipe(
              Effect.zipRight(Deferred.await(release)),
              Effect.as(responseFor(request)),
            )
          : Effect.succeed(responseFor(request)),
    };
    const running = yield* evaluate(mutable, decisions).pipe(Effect.fork);
    yield* Deferred.await(started);
    mutable.candidate.text = "Replacement after capture";
    yield* Deferred.succeed(release, undefined);
    const result = yield* Fiber.join(running);
    expect(stageState(result.trace, "safety")).toContain(draft);
  }));

it("returns actionable norm repair before asking for approval", () =>
  Effect.gen(function* () {
    const result = yield* evaluate(
      snapshot,
      provider({
        "autonomy:authority:assessment": "approval-required",
        "conformance:proposal-acceptance:assessment": "violation",
      }),
    );
    expect(result.judgment).toBe("revise");
    expect(result.reason).toBe("norm-violation");
    expect(result.feedback).toEqual([{ nextAction: "revise", text: repair }]);
    expect(result.guidance).toEqual([]);
  }));

it("keeps independent diagnostics after a prohibition and does not let an outage override it", () =>
  Effect.gen(function* () {
    const decisions: PolicyDecisionProvider = {
      decide: (request) =>
        request.stage === "autonomy"
          ? Effect.fail(
              new PolicyProviderFailure({ reason: "http", status: 503 }),
            )
          : Effect.succeed(
              responseFor(request, {
                "safety:privacy:assessment": "prohibited",
              }),
            ),
    };
    const result = yield* evaluate(snapshot, decisions);
    expect(result.judgment).toBe("block");
    expect(
      result.trace.find((entry) => entry.stage === "autonomy")?.status,
    ).toBe("failed");
    expect(
      result.trace.find((entry) => entry.stage === "conformance")?.status,
    ).toBe("answered");
    expect(
      JSON.stringify({
        feedback: result.feedback,
        guidance: result.guidance,
      }),
    ).not.toContain(privateEvidence);
  }));

it("does not prune a safety rule labeled irrelevant", () =>
  Effect.gen(function* () {
    const result = yield* evaluate(
      snapshot,
      provider({
        "applicability:privacy:assessment": "irrelevant",
        "safety:privacy:assessment": "prohibited",
      }),
    );
    expect(result.judgment).toBe("block");
  }));

it("accepts verified approval only for the same binding", () =>
  Effect.gen(function* () {
    const decisions = provider({
      "autonomy:authority:assessment": "approval-required",
    });
    const missing = yield* evaluate(snapshot, decisions);
    const stale = yield* evaluate(
      {
        ...snapshot,
        authorization: { kind: "verified", binding: "other-candidate" },
      },
      decisions,
    );
    const approved = yield* evaluate(
      {
        ...snapshot,
        authorization: { kind: "verified", binding: snapshot.binding },
      },
      decisions,
    );
    expect(missing.reason).toBe("approval-required");
    expect(stale.reason).toBe("approval-required");
    expect(approved.judgment).toBe("allow");
  }));

it("selects owner approval feedback but never offers approval to override a prohibition", () =>
  Effect.gen(function* () {
    const approvalText = "Obtain approval for this exact commitment.";
    const input = {
      ...snapshot,
      policy: {
        ...snapshot.policy,
        rules: snapshot.policy.rules.map((rule) =>
          rule.id === "authority"
            ? {
                ...rule,
                feedback: { text: approvalText, nextAction: "seek-approval" },
              }
            : rule,
        ),
      },
    };
    const held = yield* evaluate(
      input,
      provider({ "autonomy:authority:assessment": "approval-required" }),
    );
    expect(held.feedback).toEqual([
      { text: approvalText, nextAction: "seek-approval" },
    ]);
    const blocked = yield* evaluate(
      input,
      provider({ "autonomy:authority:assessment": "prohibited" }),
    );
    expect(blocked.judgment).toBe("block");
    expect(blocked.feedback[0]?.nextAction).toBe("stop");
    expect(JSON.stringify(blocked.feedback)).not.toContain(approvalText);
  }));

it("selects compatible owner review feedback for uncertain evidence", () =>
  Effect.gen(function* () {
    const reviewText = "Wait while the owner checks the disclosure scope.";
    const input = {
      ...snapshot,
      policy: {
        ...snapshot.policy,
        rules: snapshot.policy.rules.map((rule) =>
          rule.id === "privacy"
            ? { ...rule, feedback: { text: reviewText, nextAction: "wait" } }
            : rule,
        ),
      },
    };
    const result = yield* evaluate(
      input,
      provider({ "safety:privacy:assessment": "unresolved" }),
    );
    expect(result.reason).toBe("unresolved-evidence");
    expect(result.feedback).toEqual([{ text: reviewText, nextAction: "wait" }]);
  }));

it("retains rounded probabilities and routes by selected probability independently of confidence", () =>
  Effect.gen(function* () {
    const probabilities = { compliant: 0.71, prohibited: 0.2, unresolved: 0.1 };
    const decisions: PolicyDecisionProvider = {
      decide: (request) => {
        const response = responseFor(request);
        return Effect.succeed(
          request.stage === "safety"
            ? {
                ...response,
                answers: Object.fromEntries(
                  Object.keys(request.questions).map((id) => [
                    id,
                    { choice: "compliant", probabilities, confidence: 0.01 },
                  ]),
                ),
              }
            : response,
        );
      },
    };
    const allowed = yield* evaluate(snapshot, decisions);
    expect(allowed.judgment).toBe("allow");
    const safety = allowed.trace.find((entry) => entry.stage === "safety");
    expect(
      safety?.status === "answered" &&
        Object.values(safety.response.answers)[0]?.probabilities,
    ).toEqual(probabilities);
    const stricter = yield* makeMessagePolicyEvaluator({
      provider: decisions,
      settings: { ...settings, minimumProbability: 0.8 },
    });
    const held = yield* stricter.evaluate(snapshot);
    expect(held.reason).toBe("unresolved-evidence");
  }));

it("approval does not override independent prohibition or norm repair", () =>
  Effect.gen(function* () {
    const approved = {
      ...snapshot,
      authorization: { kind: "verified", binding: snapshot.binding },
    };
    const blocked = yield* evaluate(
      approved,
      provider({ "safety:privacy:assessment": "prohibited" }),
    );
    const repairNeeded = yield* evaluate(
      approved,
      provider({
        "conformance:proposal-acceptance:assessment": "violation",
      }),
    );
    expect(blocked.judgment).toBe("block");
    expect(repairNeeded.judgment).toBe("revise");
  }));

it("holds missing evidence while retaining independent stage results", () =>
  Effect.gen(function* () {
    const result = yield* evaluate({
      ...snapshot,
      gaps: ["The original proposal is unavailable."],
    });
    expect(result.reason).toBe("unresolved-evidence");
    expect(result.trace.every((entry) => entry.status === "answered")).toBe(
      true,
    );
    expect(result.guidance).toEqual([]);
  }));

it("holds a confidently unresolved answer while retaining independent diagnostics", () =>
  Effect.gen(function* () {
    const result = yield* evaluate(
      snapshot,
      provider({ "safety:privacy:assessment": "unresolved" }),
    );
    expect(result.reason).toBe("unresolved-evidence");
    expect(result.guidance).toEqual([]);
    expect(result.trace.every((entry) => entry.status === "answered")).toBe(
      true,
    );
  }));

it("keeps renderer templates outside the model's assessment rules", () =>
  Effect.gen(function* () {
    const result = yield* evaluate(snapshot);
    for (const entry of result.trace) {
      if (entry.status === "answered") {
        expect(entry.request.state).not.toContain(reminder);
        expect(entry.request.state).not.toContain(repair);
        expect(entry.request.state).toContain(snapshot.policy.rules[2].text);
      }
    }
  }));

it("isolates future evaluations from changes to earlier audit and feedback values", () =>
  Effect.gen(function* () {
    const decisions = provider({ "safety:privacy:assessment": "prohibited" });
    const evaluator = yield* makeMessagePolicyEvaluator({
      provider: decisions,
      settings,
    });
    const first = yield* evaluator.evaluate(snapshot);
    const safety = first.trace.find((entry) => entry.stage === "safety");
    if (safety?.status !== "answered") {
      return yield* Effect.die(
        "Safety trace missing from completed assessment",
      );
    }
    const question = Object.values(safety.request.questions)[0];
    if (question === undefined || first.feedback[0] === undefined) {
      return yield* Effect.die("Expected assessment projection missing");
    }
    expect(Reflect.deleteProperty(question.criteria, "prohibited")).toBe(false);
    Object.assign(first.feedback[0], { text: "caller-modified feedback" });
    const second = yield* evaluator.evaluate(snapshot);
    expect(second.judgment).toBe("block");
    expect(second.feedback).not.toEqual(first.feedback);
  }));

it("computes outgoing expectations without the unsent draft", () =>
  Effect.gen(function* () {
    const result = yield* evaluate(snapshot);
    const expectations = result.trace.find(
      (entry) => entry.stage === "expectations",
    );
    expect(expectations?.status).toBe("answered");
    expect(stageState(result.trace, "expectations")).not.toContain(draft);
    const conformance = result.trace.find(
      (entry) => entry.stage === "conformance",
    );
    expect(
      conformance?.status === "answered" &&
        conformance.request.state.includes(draft),
    ).toBe(true);
  }));

it("projects only approved advice and a visible subject on incoming admission", () =>
  Effect.gen(function* () {
    const result = yield* evaluate(
      {
        ...snapshot,
        direction: "incoming",
        candidate: {
          id: "proposal",
          sender: "participant",
          recipients: ["organizer"],
          text: "Can we meet Tuesday?",
        },
      },
      provider({
        "expectations:proposal-acceptance:assessment": "required",
        "expectations:proposal-acceptance:subject": "irrelevant",
        "expectations:proposal-acceptance:subject:proposal": "relevant",
      }),
    );
    expect(result.judgment).toBe("allow");
    expect(result.guidance).toEqual([
      {
        ruleId: "proposal-acceptance",
        expectation: "required",
        subjects: ["proposal"],
        instruction: reminder,
      },
    ]);
    expect(result.trace.some((entry) => entry.stage === "conformance")).toBe(
      false,
    );
    expect(JSON.stringify(result.guidance)).not.toContain(privateEvidence);
  }));

it("never publishes guidance for a held incoming candidate", () =>
  Effect.gen(function* () {
    const result = yield* evaluate(
      {
        ...snapshot,
        direction: "incoming",
        gaps: ["Unknown sender relationship."],
        candidate: {
          id: "proposal",
          sender: "stranger",
          recipients: ["organizer"],
          text: "Please respond now.",
        },
      },
      provider({ "expectations:proposal-acceptance:assessment": "required" }),
    );
    expect(result.judgment).toBe("hold");
    expect(result.guidance).toEqual([]);
  }));

it("selects multiple admitted visible subjects without exposing private or withheld references", () =>
  Effect.gen(function* () {
    const result = yield* evaluate(
      {
        ...snapshot,
        direction: "incoming",
        candidate: {
          id: "proposal",
          sender: "participant",
          recipients: ["organizer"],
          text: "Can we meet Tuesday?",
        },
        history: [
          ...snapshot.history,
          {
            ...snapshot.history[0],
            id: "private-history",
            visibility: "assessor",
          },
          {
            ...snapshot.history[0],
            id: "withheld-history",
            admission: "withheld",
          },
        ],
      },
      provider({ "expectations:proposal-acceptance:assessment": "required" }),
    );
    expect(result.judgment).toBe("allow");
    expect(result.guidance[0]?.subjects).toEqual(["availability", "proposal"]);
    expect(JSON.stringify(result.guidance)).not.toContain("private-history");
    expect(JSON.stringify(result.guidance)).not.toContain("withheld-history");
  }));

it("rejects a model-selected private subject instead of projecting it", () =>
  Effect.gen(function* () {
    const result = yield* evaluate(
      snapshot,
      provider({
        "expectations:proposal-acceptance:subject": "message:private-calendar",
      }),
    );
    expect(result.reason).toBe("assessment-unavailable");
    expect(result.guidance).toEqual([]);
    expect(
      result.trace.find((entry) => entry.stage === "conformance")?.status,
    ).toBe("unavailable");
  }));

it("holds large policy-history products without submitting or retaining partial requests", () =>
  Effect.gen(function* () {
    let providerCalls = 0;
    const evaluator = yield* makeMessagePolicyEvaluator({
      settings,
      provider: {
        decide: (request) =>
          Effect.sync(() => {
            providerCalls += 1;
            return responseFor(request);
          }),
      },
    });
    const result = yield* evaluator.evaluate({
      ...snapshot,
      policy: {
        digest: "large-catalog",
        rules: EffectArray.makeBy(100, (index) => ({
          id: `norm-${index}`,
          kind: "norm",
          text: "Speak only about open requests.",
        })),
      },
      history: EffectArray.makeBy(100, (index) => ({
        ...snapshot.history[0],
        id: `visible-${index}`,
      })),
    });
    expect(result.reason).toBe("assessment-unavailable");
    expect(providerCalls).toBe(0);
    expect(
      new TextEncoder().encode(JSON.stringify(result.trace)).byteLength,
    ).toBeLessThan(settings.maximumRequestBytes);
    expect(
      result.trace.some(
        (entry) =>
          entry.status === "failed" && entry.failure.reason === "budget",
      ),
    ).toBe(true);
  }));

it("holds a timeout without skipping independent norms", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<undefined>();
    const decisions: PolicyDecisionProvider = {
      decide: (request) =>
        request.stage === "safety"
          ? Deferred.succeed(started, undefined).pipe(
              Effect.zipRight(Effect.never),
            )
          : Effect.succeed(responseFor(request)),
    };
    const running = yield* evaluate(snapshot, decisions).pipe(Effect.fork);
    yield* Deferred.await(started);
    yield* TestClock.adjust(settings.timeoutMilliseconds);
    const result = yield* Fiber.join(running);
    expect(result.reason).toBe("assessment-unavailable");
    expect(
      result.trace.find((entry) => entry.stage === "conformance")?.status,
    ).toBe("answered");
  }));

it("bounds context without truncating evidence", () =>
  Effect.gen(function* () {
    const evaluator = yield* makeMessagePolicyEvaluator({
      provider: provider(),
      settings: { ...settings, maximumRequestBytes: 1 },
    });
    const result = yield* evaluator.evaluate(snapshot);
    expect(result.reason).toBe("assessment-unavailable");
    expect(
      result.trace.some(
        (entry) =>
          entry.status === "failed" && entry.failure.reason === "budget",
      ),
    ).toBe(true);
  }));

it("rejects ambiguous reference ids and forged outgoing attribution", () =>
  Effect.gen(function* () {
    const duplicate = yield* evaluate({
      ...snapshot,
      history: [...snapshot.history, ...snapshot.history],
    }).pipe(Effect.flip);
    const forged = yield* evaluate({
      ...snapshot,
      candidate: { ...snapshot.candidate, sender: "someone-else" },
    }).pipe(Effect.flip);
    expect(duplicate.reason).toBe("snapshot");
    expect(forged.reason).toBe("snapshot");
  }));

it("cancellation remains interruption rather than a successful allow", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<undefined>();
    const decisions: PolicyDecisionProvider = {
      decide: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.zipRight(Effect.never),
        ),
    };
    const running = yield* evaluate(snapshot, decisions).pipe(Effect.fork);
    yield* Deferred.await(started);
    const exit = yield* Fiber.interrupt(running);
    expect(exit._tag).toBe("Failure");
  }));

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore assertion rules outside these public policy contract tests. */
