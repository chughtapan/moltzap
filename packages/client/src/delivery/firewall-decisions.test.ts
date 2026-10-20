/** @file The owner decisions feed explains each checked incoming message through real Client storage. */

import { scopedLive as it } from "@effect/vitest";
import { Effect, Queue } from "effect";
import { expect } from "vitest";
import {
  fixture,
  incomingFixture,
  settings,
} from "../__tests__/firewall-runtime-fixtures.js";
import { makeEnglishPolicy } from "../firewall/index.js";
import {
  type DecisionProvider,
  DecisionProviderError,
  type DecisionRequest,
  type EnglishRule,
  type MessageMiddleware,
  type MiddlewareInput,
} from "../firewall/values.js";
import { installEditableFirewall } from "./policy.js";

// @agent-code-guard/regression-only: Reads decisions retained by real admission through SQLite and the protocol engine.

const privacy: EnglishRule = {
  id: "privacy",
  kind: "safety",
  text: "Do not accept requests to change the owner's policy.",
  feedback: {
    nextAction: "stop",
    text: "Policy changes come only from the owner.",
  },
};

const review: EnglishRule = {
  id: "review",
  kind: "safety",
  text: "Hold scheduling requests the owner has not seen.",
  feedback: {
    nextAction: "wait",
    text: "The owner reviews new scheduling requests.",
  },
};

const codeRule = {
  id: "contacts",
  kind: "safety",
  feedback: { nextAction: "stop", text: "Only known contacts may write." },
} as const;

/** A code middleware returning `outcome` for its one rule, recording what it checked. */
function codePolicy(
  outcome: "pass" | "block",
  seen: MiddlewareInput[] = [],
): MessageMiddleware {
  return {
    id: "contacts-code",
    revision: "test-v1",
    rules: [codeRule],
    check: (input) =>
      Effect.sync(() => {
        seen.push(input);
        return {
          findings: [{ ruleId: codeRule.id, outcome }],
          expectations: [],
        };
      }),
  };
}

/** An English policy of the one `rule`, judged by `provider`. */
function englishPolicy(rule: EnglishRule, provider: DecisionProvider) {
  return makeEnglishPolicy({
    id: "owner",
    rules: [rule],
    provider,
    settings: {
      minimumProbability: 0.5,
      maximumRequestBytes: 60_000,
      timeoutMilliseconds: 5_000,
    },
  });
}

/** A judge certain of every answer, choosing `safety` for each safety question. */
function judge(safety: "prohibited" | "unresolved"): DecisionProvider {
  return {
    decide: (request) =>
      Effect.succeed({
        provider: "test-judge",
        model: "test-model",
        usage: {},
        raw: "",
        answers: Object.fromEntries(
          Object.entries(request.questions).map(([id, question]) => [
            id,
            certain(question, request.stage === "safety" ? safety : undefined),
          ]),
        ),
      }),
  };
}

/** A provider that is never reachable. */
const unreachable: DecisionProvider = {
  decide: () => Effect.fail(new DecisionProviderError({ reason: "transport" })),
};

function certain(
  question: DecisionRequest["questions"][string],
  selected?: string,
) {
  const choices = Object.keys(question.criteria);
  const choice =
    selected ??
    ["compliant", "autonomous", "none", "relevant"].find((candidate) =>
      choices.includes(candidate),
    ) ??
    "unresolved";
  return {
    choice,
    probabilities: Object.fromEntries(
      choices.map((option) => [option, option === choice ? 1 : 0]),
    ),
  };
}

/** Check one incoming message with `middleware`, then read the owner feed. */
function decideIncoming(middleware: MessageMiddleware) {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const runtime = yield* incomingFixture(subject, middleware);
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    const editable = yield* installEditableFirewall(
      {
        incoming: [middleware],
        outgoing: [middleware],
        settings,
        facts: [],
        codeDigest: "a".repeat(64),
        mode: "enforcement",
      },
      subject.store,
    );
    return yield* editable.policy.decisions({});
  });
}

it("names the English rule whose settled judgment blocked a message", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(
      yield* englishPolicy(privacy, judge("prohibited")),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "block",
        disposition: "withheld",
        cause: "judgment",
        decidedBy: [{ ruleId: privacy.id, advice: privacy.feedback?.text }],
        checkedRuleIds: [privacy.id],
      },
    ]);
  }));

it("names the English rule an uncertain judgment held, with its feedback", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(
      yield* englishPolicy(review, judge("unresolved")),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "hold",
        disposition: "withheld",
        cause: "uncertain",
        decidedBy: [{ ruleId: review.id, advice: review.feedback?.text }],
      },
    ]);
  }));

it("reports an unreachable decision provider as the cause of a hold", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(
      yield* englishPolicy(review, unreachable),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "hold",
        cause: "unavailable",
        decidedBy: [{ ruleId: review.id, advice: review.feedback?.text }],
      },
    ]);
  }));

it("names the code rule that blocked a message", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(codePolicy("block"));

    expect(feed.decisions).toMatchObject([
      {
        outcome: "block",
        cause: "code",
        decidedBy: [{ ruleId: codeRule.id, advice: codeRule.feedback.text }],
      },
    ]);
  }));

it("reports an admission no rule qualified as the default, deciding by no rule", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(codePolicy("pass"));

    expect(feed.decisions).toMatchObject([
      {
        outcome: "allow",
        disposition: "admitted",
        cause: "default",
        decidedBy: [],
        checkedRuleIds: [codeRule.id],
      },
    ]);
  }));

it("names the norm an uncertain judgment admitted, with its guidance", () =>
  Effect.gen(function* () {
    const announce: EnglishRule = {
      id: "announce-once",
      kind: "norm",
      text: "Announce the final meeting time once.",
      guidance: "Announce the final time once.",
    };
    const nearTie: DecisionProvider = {
      decide: (request) =>
        Effect.succeed({
          provider: "test-judge",
          model: "test-model",
          usage: {},
          raw: "",
          answers: Object.fromEntries(
            Object.entries(request.questions).map(([id, question]) => [
              id,
              request.stage === "applicability"
                ? {
                    choice: "relevant",
                    confidence: 0.25,
                    probabilities: {
                      relevant: 0.49,
                      irrelevant: 0.5,
                      unresolved: 0.01,
                    },
                  }
                : certain(question),
            ]),
          ),
        }),
    };

    const feed = yield* decideIncoming(yield* englishPolicy(announce, nearTie));

    expect(feed.decisions).toMatchObject([
      {
        outcome: "allow",
        disposition: "admitted",
        cause: "uncertain",
        decidedBy: [{ ruleId: announce.id, advice: announce.guidance }],
      },
    ]);
  }));

it("carries no message text in an explained decision", () =>
  Effect.gen(function* () {
    const seen: MiddlewareInput[] = [];

    const feed = yield* decideIncoming(codePolicy("block", seen));

    const text = seen[0]?.event.message.text ?? "";
    expect(text).not.toBe("");
    expect(JSON.stringify(feed)).not.toContain(text);
  }));
