/** @file English middleware behavior through the public firewall API. */

import { effect as it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Array as EffectArray,
  Exit,
  FastCheck as fc,
  Fiber,
  TestClock,
} from "effect";
import { expect } from "vitest";
import {
  type DecisionProvider,
  DecisionProviderError,
  type DecisionRequest,
  type DecisionResponse,
  type EnglishPolicySettings,
  type EnglishRule,
  makeEnglishPolicy,
  makeFirewall,
  type Message,
  type MessageContext,
  type MessageMiddleware,
} from "../service/index.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Closed judgments, stages and next actions are the public contract under test. */

const privateEvidence = "PRIVATE: unrelated medical appointment at 14:00";
const repair =
  "Ask for acceptance of the chosen proposal. Do not claim agreement yet.";
const reminder =
  "After proposing a time, wait for every required participant to accept that proposal.";
const draft: typeof Message.Encoded = {
  id: "draft",
  sender: "organizer-agent",
  recipients: ["participant-agent"],
  text: "The meeting is confirmed; everyone agreed.",
};
const context: typeof MessageContext.Encoded = {
  agentId: "organizer-agent",
  principal: "organizer",
  participants: [{ agentId: "participant-agent", principal: "participant" }],
  history: [
    {
      id: "availability",
      sender: "participant-agent",
      recipients: ["organizer-agent"],
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
};
const rules: readonly EnglishRule[] = [
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
];
const settings: typeof EnglishPolicySettings.Encoded = {
  minimumProbability: 0.5,
  maximumRequestBytes: 60_000,
  timeoutMilliseconds: 100,
};
const firewallSettings = {
  timeoutMilliseconds: 2_000,
  middlewareTimeoutMilliseconds: 1_000,
  maximumInputBytes: 300_000,
  maximumResultBytes: 1_000_000,
};
/** Each generated example runs two full chains alongside other CI workers. */
const propertyTimeoutMilliseconds = 15_000;

function uncertainResponseFor(
  request: DecisionRequest,
): typeof DecisionResponse.Encoded {
  if (request.stage !== "expectations") {
    return responseFor(request);
  }
  return {
    ...responseFor(request),
    answers: Object.fromEntries(
      Object.entries(request.questions).map(
        ([id, question]): readonly [
          string,
          DecisionResponse["answers"][string],
        ] => [
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
                probabilities: { relevant: 0, irrelevant: 1, unresolved: 0 },
              },
        ],
      ),
    ),
  };
}

function responseFor(
  request: DecisionRequest,
  choices: Readonly<Record<string, string>> = {},
): typeof DecisionResponse.Encoded {
  return {
    provider: "test-decisions",
    model: "test-model",
    raw: privateEvidence,
    usage: {},
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => {
        const fallback =
          ["compliant", "autonomous", "none", "relevant"].find((choice) =>
            Object.hasOwn(question.criteria, choice),
          ) ?? "unresolved";
        const selected =
          choices[
            `${request.stage}:${question.ruleId}:${question.purpose}:${question.subject ?? ""}`
          ] ??
          choices[`${request.stage}:${question.ruleId}:${question.purpose}`] ??
          fallback;
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

function provider(
  choices: Readonly<Record<string, string>> = {},
  requests: DecisionRequest[] = [],
): DecisionProvider {
  return {
    decide: (request) =>
      Effect.sync(() => {
        requests.push(request);
        return responseFor(request, choices);
      }),
  };
}

const defaultProvider = provider();

const check = (
  decisions: DecisionProvider = defaultProvider,
  options: {
    readonly message?: Message;
    readonly context?: MessageContext;
    readonly rules?: readonly EnglishRule[];
    readonly settings?: EnglishPolicySettings;
    readonly incoming?: boolean;
    readonly before?: readonly MessageMiddleware[];
  } = {},
) =>
  Effect.gen(function* () {
    const english = yield* makeEnglishPolicy({
      id: "owner",
      rules: options.rules ?? rules,
      provider: decisions,
      settings: options.settings ?? settings,
    });
    const chain = [...(options.before ?? []), english];
    const firewall = yield* makeFirewall({
      incoming: chain,
      outgoing: chain,
      settings: firewallSettings,
    });
    const message = options.message ?? draft;
    const evidence = options.context ?? context;
    return yield* options.incoming
      ? firewall.checkIncoming(message, evidence)
      : firewall.checkOutgoing(message, evidence);
  });

it("preserves the receiver of an injected provider method", () =>
  Effect.gen(function* () {
    const stateful = {
      model: "stateful-provider",
      decide(request: DecisionRequest) {
        return Effect.succeed({ ...responseFor(request), model: this.model });
      },
    };
    const result = yield* check(stateful);
    expect(result.judgment).toBe("allow");
    expect(result.checks[0]?.trace?.data).toContain(stateful.model);
  }));

it.prop(
  "outgoing expectations exclude every unsent draft",
  [fc.string()],
  ([text]) =>
    Effect.gen(function* () {
      const original: DecisionRequest[] = [];
      const changed: DecisionRequest[] = [];
      yield* check(provider({}, original));
      yield* check(provider({}, changed), { message: { ...draft, text } });
      const expected = original.find((entry) => entry.stage === "expectations");
      expect(expected).toBeDefined();
      expect(changed.find((entry) => entry.stage === "expectations")).toEqual(
        expected,
      );
    }),
  { timeout: propertyTimeoutMilliseconds },
);

it("does not launder draft-derived permission through previous middleware", () =>
  Effect.gen(function* () {
    const requests: DecisionRequest[] = [];
    const code: MessageMiddleware = {
      id: "draft-derived",
      revision: "v1",
      rules: [{ id: "echo", kind: "norm" }],
      check: (input) =>
        Effect.succeed({
          findings: [{ ruleId: "echo", outcome: "pass" }],
          expectations: [
            { ruleId: "echo", expectation: "permitted", subjects: [] },
          ],
          trace: { format: "draft-echo", data: input.event.message.text },
        }),
    };
    const result = yield* check(provider({}, requests), { before: [code] });
    const expectations = requests.find(
      (entry) => entry.stage === "expectations",
    );
    expect(result.judgment).toBe("allow");
    expect(expectations?.state).not.toContain(draft.text);
    expect(expectations?.state).not.toContain(code.id);
    expect(expectations?.state).not.toContain("echo");
    expect(
      requests.find((entry) => entry.stage === "conformance")?.state,
    ).toContain(draft.text);
  }));

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

it.each(malformedAnswers)("holds malformed provider answers: $name", (answer) =>
  Effect.gen(function* () {
    const result = yield* check({
      decide: (request) =>
        Effect.succeed(
          request.stage === "safety"
            ? {
                ...responseFor(request),
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
    });
    expect(result.reason).toBe("check-unavailable");
    expect(result.guidance).toEqual([]);
  }),
);

it("holds uncertain expectations and withholds dependent conformance", () =>
  Effect.gen(function* () {
    const requests: DecisionRequest[] = [];
    const result = yield* check({
      decide: (request) =>
        Effect.sync(() => {
          requests.push(request);
          return uncertainResponseFor(request);
        }),
    });
    expect(result.reason).toBe("unresolved-evidence");
    expect(requests.some((entry) => entry.stage === "conformance")).toBe(false);
  }));

it("captures evidence before asynchronous inference", () =>
  Effect.gen(function* () {
    const message = { ...draft };
    const requests: DecisionRequest[] = [];
    const started = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const decisions: DecisionProvider = {
      decide: (request) =>
        Effect.gen(function* () {
          requests.push(request);
          if (request.stage === "applicability") {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          }
          return responseFor(request);
        }),
    };
    const running = yield* check(decisions, { message }).pipe(Effect.fork);
    yield* Deferred.await(started);
    message.text = "Replacement after capture";
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(running);
    expect(requests.find((entry) => entry.stage === "safety")?.state).toContain(
      draft.text,
    );
  }));

it("returns norm repair before approval with only registered feedback", () =>
  Effect.gen(function* () {
    const result = yield* check(
      provider({
        "autonomy:authority:assessment": "approval-required",
        "conformance:proposal-acceptance:assessment": "violation",
      }),
    );
    expect(result.judgment).toBe("revise");
    expect(result.feedback).toEqual([{ nextAction: "revise", text: repair }]);
    expect(result.guidance).toEqual([]);
  }));

it.each(["failure", "defect", "timeout"])(
  "retains a prohibition through a later provider %s",
  (fault) =>
    Effect.gen(function* () {
      const requests: DecisionRequest[] = [];
      const started = yield* Deferred.make<undefined>();
      const decisions: DecisionProvider = {
        decide: (request) =>
          Effect.gen(function* () {
            requests.push(request);
            if (request.stage === "autonomy") {
              if (fault === "failure") {
                return yield* new DecisionProviderError({
                  reason: "http",
                  status: 503,
                });
              }
              if (fault === "defect") {
                return yield* Effect.die(privateEvidence);
              }
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }
            return responseFor(request, {
              "safety:privacy:assessment": "prohibited",
            });
          }),
      };
      const running = yield* check(decisions).pipe(Effect.fork);
      if (fault === "timeout") {
        yield* Deferred.await(started);
        yield* TestClock.adjust(settings.timeoutMilliseconds);
      }
      const result = yield* Fiber.join(running);
      expect(result.judgment).toBe("block");
      expect(result.checks[0]?.findings).toContainEqual({
        ruleId: "authority",
        outcome: "hold",
        reason: "check-unavailable",
      });
      expect(requests.some((entry) => entry.stage === "conformance")).toBe(
        true,
      );
      expect(
        JSON.stringify({
          feedback: result.feedback,
          guidance: result.guidance,
        }),
      ).not.toContain(privateEvidence);
    }),
);

it.each([
  { name: "plain", cancellation: Effect.interrupt },
  {
    name: "cleanup defect",
    cancellation: Effect.interrupt.pipe(
      Effect.ensuring(Effect.die("cleanup failed")),
    ),
  },
  {
    name: "typed failure and interruption",
    cancellation: Effect.fail(
      new DecisionProviderError({ reason: "transport" }),
    ).pipe(Effect.ensuring(Effect.interrupt)),
  },
])("preserves provider interruption with $name", ({ cancellation }) =>
  Effect.gen(function* () {
    const stages: string[] = [];
    const decisions: DecisionProvider = {
      decide: (request) =>
        Effect.gen(function* () {
          stages.push(request.stage);
          if (request.stage === "applicability") {
            return yield* cancellation;
          }
          return responseFor(request);
        }),
    };
    const running = yield* check(decisions).pipe(Effect.fork);
    const exit = yield* Fiber.await(running);
    expect(
      Exit.match(exit, {
        onFailure: Cause.isInterrupted,
        onSuccess: () => false,
      }),
    ).toBe(true);
    expect(stages).toEqual(["applicability"]);
  }),
);

it("does not prune a safety rule labeled irrelevant", () =>
  Effect.gen(function* () {
    const result = yield* check(
      provider({
        "applicability:privacy:assessment": "irrelevant",
        "safety:privacy:assessment": "prohibited",
      }),
    );
    expect(result.judgment).toBe("block");
  }));

it("preserves rounded distributions and routes by selected probability independently of confidence", () =>
  Effect.gen(function* () {
    const probabilities = { compliant: 0.71, prohibited: 0.2, unresolved: 0.1 };
    const decisions: DecisionProvider = {
      decide: (request) =>
        Effect.succeed(
          request.stage === "safety"
            ? {
                ...responseFor(request),
                answers: Object.fromEntries(
                  Object.keys(request.questions).map((id) => [
                    id,
                    { choice: "compliant", probabilities, confidence: 0.01 },
                  ]),
                ),
              }
            : responseFor(request),
        ),
    };
    const allowed = yield* check(decisions);
    const held = yield* check(decisions, {
      settings: { ...settings, minimumProbability: 0.8 },
    });
    expect(allowed.judgment).toBe("allow");
    expect(allowed.checks[0]?.trace?.data).toContain(
      JSON.stringify(probabilities),
    );
    expect(held.reason).toBe("unresolved-evidence");
  }));

it("holds confidently unresolved evidence while running independent stages", () =>
  Effect.gen(function* () {
    const requests: DecisionRequest[] = [];
    const result = yield* check(
      provider({ "safety:privacy:assessment": "unresolved" }, requests),
    );
    expect(result.reason).toBe("unresolved-evidence");
    expect(requests.some((entry) => entry.stage === "conformance")).toBe(true);
    expect(result.guidance).toEqual([]);
  }));

it("keeps renderer templates out of model assessment rules", () =>
  Effect.gen(function* () {
    const requests: DecisionRequest[] = [];
    yield* check(provider({}, requests));
    for (const request of requests) {
      expect(request.state).not.toContain(reminder);
      expect(request.state).not.toContain(repair);
      expect(request.state).toContain(rules[2]?.text);
    }
  }));

it("projects incoming advice using only admitted visible subjects", () =>
  Effect.gen(function* () {
    const message: typeof Message.Encoded = {
      id: "proposal",
      sender: "participant-agent",
      recipients: [context.agentId],
      text: "Can we meet Tuesday?",
    };
    const requests: DecisionRequest[] = [];
    const result = yield* check(
      provider(
        { "expectations:proposal-acceptance:assessment": "required" },
        requests,
      ),
      {
        incoming: true,
        message,
        context: {
          ...context,
          history: [
            ...context.history,
            {
              ...message,
              id: "private-history",
              visibility: "assessor",
              admission: "admitted",
            },
            {
              ...message,
              id: "withheld-history",
              visibility: "runtime",
              admission: "withheld",
            },
          ],
        },
      },
    );
    expect(result.judgment).toBe("allow");
    expect(result.guidance).toEqual([
      {
        middlewareId: "owner",
        ruleId: "proposal-acceptance",
        expectation: "required",
        subjects: ["availability", "proposal"],
        instruction: reminder,
      },
    ]);
    expect(requests.some((entry) => entry.stage === "conformance")).toBe(false);
    expect(JSON.stringify(result.guidance)).not.toContain(privateEvidence);
  }));

it("holds a model-selected private subject instead of projecting it", () =>
  Effect.gen(function* () {
    const result = yield* check(
      provider({
        "expectations:proposal-acceptance:subject": "message:private-calendar",
      }),
    );
    expect(result.reason).toBe("check-unavailable");
    expect(result.guidance).toEqual([]);
  }));

it("bounds large policy-history products without submitting partial requests", () =>
  Effect.gen(function* () {
    const requests: DecisionRequest[] = [];
    const result = yield* check(provider({}, requests), {
      rules: EffectArray.makeBy(100, (index) => ({
        id: `norm-${index}`,
        kind: "norm",
        text: "Speak only about open requests.",
      })),
      context: {
        ...context,
        history: EffectArray.makeBy(100, (index) => ({
          ...draft,
          id: `visible-${index}`,
          visibility: "runtime",
          admission: "admitted",
        })),
      },
    });
    expect(result.reason).toBe("check-unavailable");
    expect(requests).toEqual([]);
    expect(
      new TextEncoder().encode(result.checks[0]?.trace?.data).byteLength,
    ).toBeLessThan(settings.maximumRequestBytes);
  }));

it("holds oversized context without truncating it", () =>
  Effect.gen(function* () {
    const requests: DecisionRequest[] = [];
    const result = yield* check(provider({}, requests), {
      settings: { ...settings, maximumRequestBytes: 1 },
    });
    expect(result.reason).toBe("check-unavailable");
    expect(requests).toEqual([]);
  }));

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore the default outside public contract assertions. */
