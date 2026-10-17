/** @file Shared middleware semantics independent of an English decision provider. */

import { effect as it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FastCheck as fc,
  Fiber,
  TestClock,
} from "effect";
import { expect } from "vitest";
import {
  type FirewallSettings,
  makeFirewall,
  type Message,
  type MessageContext,
  type MessageMiddleware,
  MiddlewareError,
  type MiddlewareInput,
  type MiddlewareResult,
  type RuleDescription,
} from "../service/index.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Public judgments, findings and feedback are the behavior under test. */

type PolicyFinding = MiddlewareResult["findings"][number];
type NormExpectation = MiddlewareResult["expectations"][number];

const draft: typeof Message.Encoded = {
  id: "draft",
  sender: "local-agent",
  recipients: ["peer-agent"],
  text: "Tuesday works.",
};
const incoming: typeof Message.Encoded = {
  id: "request",
  sender: "peer-agent",
  recipients: ["local-agent"],
  text: "Does Tuesday work?",
};
const context: typeof MessageContext.Encoded = {
  agentId: "local-agent",
  principal: "owner",
  participants: [{ agentId: "peer-agent", principal: "peer-owner" }],
  history: [
    {
      ...incoming,
      id: "earlier",
      visibility: "runtime",
      admission: "admitted",
    },
  ],
  facts: [
    {
      id: "private-fact",
      text: "Owner's private schedule",
      source: "owner",
      visibility: "assessor",
    },
  ],
  gaps: [],
  authorization: { kind: "absent" },
};
const settings: typeof FirewallSettings.Encoded = {
  timeoutMilliseconds: 1_000,
  middlewareTimeoutMilliseconds: 100,
  maximumInputBytes: 100_000,
  maximumResultBytes: 100_000,
};
/** Generated cases check whole chains alongside the package suite's CI workers. */
const propertyTimeoutMilliseconds = 15_000;
const rule: typeof RuleDescription.Encoded = {
  id: "rule",
  kind: "norm",
  guidance: "Respond only to the open request.",
};
const pass: PolicyFinding = { ruleId: rule.id, outcome: "pass" };
const block: PolicyFinding = { ruleId: rule.id, outcome: "block" };

function policy(
  id: string,
  findings: readonly PolicyFinding[] = [pass],
  expectations: readonly NormExpectation[] = [],
): MessageMiddleware {
  return {
    id,
    revision: "v1",
    rules: [rule],
    check: () => Effect.succeed({ findings, expectations }),
  };
}

const firewallFor = (
  middleware: readonly MessageMiddleware[],
  overrides: Partial<FirewallSettings> = {},
) =>
  makeFirewall({
    incoming: middleware,
    outgoing: middleware,
    settings: { ...settings, ...overrides },
  });

it.prop(
  "a pass never overrides any registered prohibition",
  [fc.array(fc.boolean(), { minLength: 1, maxLength: 8 })],
  ([prohibitions]) =>
    Effect.gen(function* () {
      const firewall = yield* firewallFor(
        prohibitions.map((prohibited, index) =>
          policy(`policy-${index}`, [prohibited ? block : pass]),
        ),
      );
      const result = yield* firewall.checkOutgoing(draft, context);
      expect(result.judgment).toBe(
        prohibitions.some(Boolean) ? "block" : "allow",
      );
    }),
  { timeout: propertyTimeoutMilliseconds },
);

it("isolates returned findings from mutation while later middleware waits", () =>
  Effect.gen(function* () {
    const result = { findings: [block], expectations: [] };
    const started = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const first: MessageMiddleware = {
      ...policy("first"),
      check: () => Effect.succeed(result),
    };
    const second: MessageMiddleware = {
      ...policy("second"),
      check: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.zipRight(Deferred.await(release)),
          Effect.as({ findings: [pass], expectations: [] }),
        ),
    };
    const firewall = yield* firewallFor([first, second]);
    const running = yield* firewall
      .checkOutgoing(draft, context)
      .pipe(Effect.fork);
    yield* Deferred.await(started);
    result.findings.splice(0, 1, pass);
    yield* Deferred.succeed(release, undefined);
    const checked = yield* Fiber.join(running);
    expect(checked.judgment).toBe("block");
    expect(checked.checks[0]?.findings).toEqual([block]);
  }));

it("runs distinct incoming and outgoing code chains without a provider", () =>
  Effect.gen(function* () {
    const firewall = yield* makeFirewall({
      incoming: [policy("receive")],
      outgoing: [policy("send", [block])],
      settings,
    });
    const received = yield* firewall.checkIncoming(incoming, context);
    const sent = yield* firewall.checkOutgoing(draft, context);
    expect(received.judgment).toBe("allow");
    expect(sent.judgment).toBe("block");
    expect(received.checks.map((entry) => entry.middlewareId)).toEqual([
      "receive",
    ]);
    expect(sent.checks.map((entry) => entry.middlewareId)).toEqual(["send"]);
  }));

it("runs every entry and preserves all findings without a later override", () =>
  Effect.gen(function* () {
    const observed: MiddlewareInput[] = [];
    const later: MessageMiddleware = {
      ...policy("later"),
      check: (input) =>
        Effect.sync(() => {
          observed.push(input);
          return { findings: [pass], expectations: [] };
        }),
    };
    const firewall = yield* firewallFor([
      policy("earlier", [block, pass]),
      later,
    ]);
    const result = yield* firewall.checkOutgoing(draft, context);
    expect(result.judgment).toBe("block");
    expect(result.checks.map((entry) => entry.middlewareId)).toEqual([
      "earlier",
      "later",
    ]);
    expect(observed[0]?.previous[0]?.findings).toEqual([block, pass]);
  }));

it.each(["failure", "defect", "timeout"])(
  "retains completed findings through a later middleware %s",
  (fault) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<undefined>();
      const failing: MessageMiddleware = {
        ...policy("failing"),
        check: () => {
          if (fault === "failure") {
            return Effect.fail(new MiddlewareError({ reason: "unavailable" }));
          }
          if (fault === "defect") {
            return Effect.die("private exception");
          }
          return Deferred.succeed(started, undefined).pipe(
            Effect.zipRight(Effect.never),
          );
        },
      };
      const firewall = yield* firewallFor([
        policy("earlier", [block]),
        failing,
        policy("later"),
      ]);
      const running = yield* firewall
        .checkOutgoing(draft, context)
        .pipe(Effect.fork);
      if (fault === "timeout") {
        yield* Deferred.await(started);
        yield* TestClock.adjust(settings.middlewareTimeoutMilliseconds);
      }
      const result = yield* Fiber.join(running);
      expect(result.judgment).toBe("block");
      expect(result.checks.map((entry) => entry.status)).toEqual([
        "completed",
        "unavailable",
        "completed",
      ]);
      expect(JSON.stringify(result)).not.toContain("private exception");
    }),
);

it("marks unrun entries unavailable after the total deadline", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<undefined>();
    let laterRan = false;
    const waiting: MessageMiddleware = {
      ...policy("waiting"),
      check: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.zipRight(Effect.never),
        ),
    };
    const later: MessageMiddleware = {
      ...policy("later"),
      check: () =>
        Effect.sync(() => {
          laterRan = true;
          return { findings: [pass], expectations: [] };
        }),
    };
    const firewall = yield* firewallFor([waiting, later], {
      timeoutMilliseconds: 50,
    });
    const running = yield* firewall
      .checkOutgoing(draft, context)
      .pipe(Effect.fork);
    yield* Deferred.await(started);
    yield* TestClock.adjust(50);
    const result = yield* Fiber.join(running);
    expect(result.reason).toBe("check-unavailable");
    expect(result.checks.map((entry) => entry.failure?.reason)).toEqual([
      "timeout",
      "timeout",
    ]);
    expect(laterRan).toBe(false);
  }));

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
      new MiddlewareError({ reason: "unavailable" }),
    ).pipe(Effect.ensuring(Effect.interrupt)),
  },
])("preserves self-interruption with $name", ({ cancellation }) =>
  Effect.gen(function* () {
    let laterRan = false;
    const first: MessageMiddleware = {
      ...policy("cancel"),
      check: () => cancellation,
    };
    const later: MessageMiddleware = {
      ...policy("later"),
      check: () =>
        Effect.sync(() => {
          laterRan = true;
          return { findings: [pass], expectations: [] };
        }),
    };
    const firewall = yield* firewallFor([first, later]);
    const running = yield* firewall
      .checkOutgoing(draft, context)
      .pipe(Effect.fork);
    const exit = yield* Fiber.await(running);
    expect(
      Exit.match(exit, {
        onFailure: Cause.isInterrupted,
        onSuccess: () => false,
      }),
    ).toBe(true);
    expect(laterRan).toBe(false);
  }),
);

it("propagates cancellation without returning admission", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<undefined>();
    const waiting: MessageMiddleware = {
      ...policy("waiting"),
      check: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.zipRight(Effect.never),
        ),
    };
    const firewall = yield* firewallFor([waiting]);
    const running = yield* firewall
      .checkOutgoing(draft, context)
      .pipe(Effect.fork);
    yield* Deferred.await(started);
    const exit = yield* Fiber.interrupt(running);
    expect(exit._tag).toBe("Failure");
  }));

it("captures metadata, preserves method receivers and freezes previous observations", () =>
  Effect.gen(function* () {
    const mutableRule = { ...rule, guidance: "Original registered advice" };
    const stateful = {
      id: "stateful",
      revision: "original",
      rules: [mutableRule],
      acceptedText: incoming.text,
      check(input: MiddlewareInput): Effect.Effect<MiddlewareResult> {
        return Effect.succeed({
          findings: [
            input.event.message.text === this.acceptedText ? pass : block,
          ],
          expectations: [
            {
              ruleId: rule.id,
              expectation: "required",
              subjects: [incoming.id],
            },
          ],
        });
      },
    };
    const later: MessageMiddleware = {
      ...policy("later"),
      check: (input) =>
        Effect.sync(() => {
          expect(Reflect.set(input.context, "principal", "forged")).toBe(false);
          expect(Reflect.set(input.event.message, "text", "forged")).toBe(
            false,
          );
          expect(Reflect.set(input.previous, "length", 0)).toBe(false);
          const earlier = input.previous[0];
          expect(
            earlier === undefined || Reflect.set(earlier.findings, "length", 0),
          ).toBe(false);
          return { findings: [pass], expectations: [] };
        }),
    };
    const firewall = yield* firewallFor([stateful, later]);
    stateful.revision = "mutated";
    mutableRule.guidance = "Mutated advice";
    const result = yield* firewall.checkIncoming(incoming, context);
    expect(result.judgment).toBe("allow");
    expect(result.checks[0]?.revision).toBe("original");
    expect(result.guidance[0]?.instruction).toBe("Original registered advice");
  }));

it.each(["private-history", "withheld-history", "private-fact", "draft"])(
  "rejects an unsafe code-policy subject: %s",
  (subject) =>
    Effect.gen(function* () {
      const firewall = yield* firewallFor([
        policy(
          "code",
          [pass],
          [{ ruleId: rule.id, expectation: "required", subjects: [subject] }],
        ),
      ]);
      const result = yield* firewall.checkOutgoing(draft, {
        ...context,
        history: [
          ...context.history,
          {
            ...incoming,
            id: "private-history",
            visibility: "assessor",
            admission: "admitted",
          },
          {
            ...incoming,
            id: "withheld-history",
            visibility: "runtime",
            admission: "withheld",
          },
        ],
      });
      expect(result.reason).toBe("check-unavailable");
      expect(result.checks[0]?.failure?.reason).toBe("invalid-result");
      expect(result.guidance).toEqual([]);
    }),
);

it("rejects missing or unknown rule findings and unregistered advice", () =>
  Effect.gen(function* () {
    const extra = {
      findings: [pass],
      expectations: [],
      guidance: "Unregistered text",
    };
    const variants: MessageMiddleware[] = [
      policy("missing", []),
      policy("unknown", [{ ruleId: "unknown", outcome: "pass" }]),
      { ...policy("advice"), check: () => Effect.succeed(extra) },
    ];
    for (const middleware of variants) {
      const firewall = yield* firewallFor([middleware]);
      const result = yield* firewall.checkOutgoing(draft, context);
      expect(result.reason).toBe("check-unavailable");
      expect(result.checks[0]?.failure?.reason).toBe("invalid-result");
    }
  }));

it("does not ask an incoming sender to revise or accept non-autonomy approval", () =>
  Effect.gen(function* () {
    const repair = yield* firewallFor([
      policy("repair", [{ ruleId: rule.id, outcome: "revise" }]),
    ]);
    const approve = yield* firewallFor([
      policy("approve", [{ ruleId: rule.id, outcome: "approval-required" }]),
    ]);
    expect((yield* repair.checkIncoming(incoming, context)).reason).toBe(
      "check-unavailable",
    );
    expect((yield* approve.checkOutgoing(draft, context)).reason).toBe(
      "check-unavailable",
    );
  }));

it("holds opposing expectations about the same subject", () =>
  Effect.gen(function* () {
    const firewall = yield* firewallFor([
      policy(
        "respond",
        [pass],
        [{ ruleId: rule.id, expectation: "required", subjects: [incoming.id] }],
      ),
      policy(
        "wait",
        [pass],
        [{ ruleId: rule.id, expectation: "wait", subjects: [incoming.id] }],
      ),
    ]);
    const result = yield* firewall.checkIncoming(incoming, context);
    expect(result.reason).toBe("unresolved-evidence");
    expect(result.guidance).toEqual([]);
  }));

it("holds missing context and publishes no incoming advice", () =>
  Effect.gen(function* () {
    const firewall = yield* firewallFor([
      policy(
        "respond",
        [pass],
        [{ ruleId: rule.id, expectation: "required", subjects: [incoming.id] }],
      ),
    ]);
    const result = yield* firewall.checkIncoming(incoming, {
      ...context,
      gaps: ["Unknown sender relationship"],
    });
    expect(result.reason).toBe("unresolved-evidence");
    expect(result.guidance).toEqual([]);
  }));

it("accepts approval only for the same principal and complete candidate", () =>
  Effect.gen(function* () {
    const authority: MessageMiddleware = {
      ...policy("autonomy", [
        { ruleId: rule.id, outcome: "approval-required" },
      ]),
      rules: [{ ...rule, kind: "autonomy" }],
    };
    const firewall = yield* firewallFor([authority]);
    const approved: typeof MessageContext.Encoded = {
      ...context,
      authorization: {
        kind: "verified",
        principal: context.principal,
        candidate: draft,
      },
    };
    expect((yield* firewall.checkOutgoing(draft, approved)).judgment).toBe(
      "allow",
    );
    expect((yield* firewall.checkOutgoing(draft, context)).reason).toBe(
      "approval-required",
    );
    for (const candidate of [
      { ...draft, id: "different" },
      { ...draft, sender: "forged" },
      { ...draft, recipients: ["other-peer"] },
      { ...draft, text: "Other commitment" },
    ] satisfies readonly Message[]) {
      const result = yield* firewall.checkOutgoing(draft, {
        ...context,
        authorization: {
          kind: "verified",
          principal: context.principal,
          candidate,
        },
      });
      expect(result.reason).toBe("approval-required");
    }
    const wrongOwner = yield* firewall.checkOutgoing(draft, {
      ...context,
      authorization: {
        kind: "verified",
        principal: "different-owner",
        candidate: draft,
      },
    });
    expect(wrongOwner.reason).toBe("approval-required");
  }));

it("approval cannot override prohibition or repair and cannot invite an invalid next action", () =>
  Effect.gen(function* () {
    const approved: typeof MessageContext.Encoded = {
      ...context,
      authorization: {
        kind: "verified",
        principal: context.principal,
        candidate: draft,
      },
    };
    const feedback = {
      text: "Ask for approval",
      nextAction: "seek-approval",
    } satisfies NonNullable<RuleDescription["feedback"]>;
    const blocked = yield* firewallFor([
      { ...policy("block", [block]), rules: [{ ...rule, feedback }] },
    ]);
    const repair = yield* firewallFor([
      policy("repair", [{ ruleId: rule.id, outcome: "revise" }]),
    ]);
    const result = yield* blocked.checkOutgoing(draft, approved);
    expect(result.judgment).toBe("block");
    expect(result.feedback[0]?.nextAction).toBe("stop");
    expect((yield* repair.checkOutgoing(draft, approved)).judgment).toBe(
      "revise",
    );
  }));

it("bounds input and results without converting skipped checks into passes", () =>
  Effect.gen(function* () {
    let ran = false;
    const code: MessageMiddleware = {
      ...policy("code"),
      check: () =>
        Effect.sync(() => {
          ran = true;
          return { findings: [pass], expectations: [] };
        }),
    };
    const smallInput = yield* firewallFor([code], { maximumInputBytes: 1 });
    expect((yield* smallInput.checkOutgoing(draft, context)).reason).toBe(
      "check-unavailable",
    );
    expect(ran).toBe(false);
    const smallResult = yield* firewallFor([code], { maximumResultBytes: 1 });
    expect((yield* smallResult.checkOutgoing(draft, context)).reason).toBe(
      "check-unavailable",
    );
  }));

it("rejects empty or ambiguous registrations", () =>
  Effect.gen(function* () {
    for (const chain of [
      [],
      [policy("same"), policy("same")],
      [{ ...policy("rules"), rules: [rule, rule] }],
    ]) {
      expect((yield* firewallFor(chain).pipe(Effect.flip)).reason).toBe(
        "registration",
      );
    }
  }));

it("rejects ambiguous references, wrong attribution and duplicate recipients", () =>
  Effect.gen(function* () {
    const firewall = yield* firewallFor([policy("code")]);
    const duplicate = yield* firewall
      .checkOutgoing(draft, {
        ...context,
        history: [...context.history, ...context.history],
      })
      .pipe(Effect.flip);
    const forged = yield* firewall
      .checkOutgoing({ ...draft, sender: "owner" }, context)
      .pipe(Effect.flip);
    const otherEndpoint = yield* firewall
      .checkIncoming({ ...incoming, recipients: ["elsewhere"] }, context)
      .pipe(Effect.flip);
    const recipients = yield* firewall
      .checkOutgoing({ ...draft, recipients: ["peer", "peer"] }, context)
      .pipe(Effect.flip);
    expect(duplicate.reason).toBe("context");
    expect(forged.reason).toBe("message");
    expect(otherEndpoint.reason).toBe("message");
    expect(recipients.reason).toBe("message");
  }));

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore default assertion rules outside the public contract tests. */
