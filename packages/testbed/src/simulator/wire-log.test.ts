/**
 * @file Gates for the message log and its answer rule.
 *
 * Two consumers turn a verdict on what `answer` returns, so the cases
 * that matter are the ones where it must refuse to decide: no floor, a
 * candidate that shares the floor's commit millisecond, a candidate the
 * run sent itself. Each has its own outcome, and none of them may
 * collapse into "not yet" — a run that cannot tell "no answer" from "I
 * cannot see the question" is the defect this log replaces.
 */
import { describe, expect, it } from "vitest";
/* eslint-disable sonarjs/assertions-in-tests -- property bodies are extracted to named top-level functions to satisfy the nesting caps; every property test delegates to one */
import { FastCheck as fc, Schema } from "effect";
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { AgentId } from "@moltzap/protocol/identity";
import { agentId, conversationId, messageId } from "@moltzap/protocol/testing";
import { LogicalSequence } from "./ids.js";
import { deterministicUuid } from "./__tests__/ids.js";
import {
  makeMessageLog,
  type AnswerCriteria,
  type ObservedMessage,
} from "./wire-log.js";

const seq = (value: number): LogicalSequence =>
  Schema.decodeSync(LogicalSequence)(value);

const message = (name: string) => messageId(deterministicUuid(name));
const conversation = (name: string) => conversationId(deterministicUuid(name));
const agent = (name: string) => agentId(deterministicUuid(name));

const CONVERSATION = conversation("conversation-1");
const OTHER_CONVERSATION = conversation("conversation-2");
const SENDER = agent("agent-one");
const OTHER_SENDER = agent("agent-two");
const FLOOR = message("floor");

/** Commit times a millisecond apart, so ordering is total unless a test makes it tie. */
const AT = (millis: number): string =>
  new Date(Date.UTC(2026, 0, 1) + millis).toISOString();

const FLOOR_AT = AT(1000);

function observed(
  name: string,
  overrides: Partial<ObservedMessage> = {},
): ObservedMessage {
  return {
    messageId: message(name),
    conversationId: CONVERSATION,
    senderId: SENDER,
    replyToId: undefined,
    createdAt: AT(2000),
    ...overrides,
  };
}

const floorMessage: ObservedMessage = {
  messageId: FLOOR,
  conversationId: CONVERSATION,
  senderId: agent("principal"),
  replyToId: undefined,
  createdAt: FLOOR_AT,
};

const AFTER_FLOOR: AnswerCriteria = {
  conversationId: CONVERSATION,
  afterMessageId: FLOOR,
  senders: new Set([SENDER]),
};

function assertNoFloorNamesTheAwaitedMessage(): void {
  const log = makeMessageLog();
  log.record({ origin: "received", at: seq(1) }, observed("reply"));
  expect(log.answer(AFTER_FLOOR)).toStrictEqual({
    _tag: "no-floor",
    awaited: FLOOR,
  });
}

function assertAnswersWithTheFirstLaterMessage(): void {
  const log = makeMessageLog();
  log.record({ origin: "sent" }, floorMessage);
  log.record(
    { origin: "received", at: seq(2) },
    observed("reply", { createdAt: AT(2000) }),
  );
  log.record(
    { origin: "received", at: seq(3) },
    observed("later", { createdAt: AT(3000) }),
  );
  expect(log.answer(AFTER_FLOOR)).toMatchObject({ _tag: "answered", at: 2 });
}

/**
 * Observation order is not commit order: the server schedules its
 * notification writes before the sender's own send returns.
 */
function assertAnswersAMessageObservedFirst(): void {
  const log = makeMessageLog();
  log.record(
    { origin: "received", at: seq(1) },
    observed("reply", { createdAt: AT(2000) }),
  );
  log.record({ origin: "sent" }, floorMessage);
  expect(log.answer(AFTER_FLOOR)).toMatchObject({ _tag: "answered", at: 1 });
}

describe("the answer rule", () => {
  it("names the awaited message when no floor was ever recorded", () => {
    assertNoFloorNamesTheAwaitedMessage();
  });

  it("answers with the first message committed after the floor", () => {
    assertAnswersWithTheFirstLaterMessage();
  });

  it("answers a message observed before the floor was written", () => {
    assertAnswersAMessageObservedFirst();
  });

  it("only ever answers with an admissible message (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(SENDER, OTHER_SENDER), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.array(fc.constantFrom(CONVERSATION, OTHER_CONVERSATION), {
          minLength: 1,
          maxLength: 3,
        }),
        assertAnswerIsAlwaysAdmissible,
      ),
      { numRuns: 40 },
    );
  });
});

/**
 * However many messages arrive and whoever sent them, an answer is always
 * one this log retained: in the awaited conversation, from an accepted
 * sender, committed after the floor. That is the whole contract the reply
 * gate and the done-signal rest on, so it holds for every input rather
 * than for the orderings the examples happen to name.
 */
function assertAnswerIsAlwaysAdmissible(
  senders: ReadonlyArray<AgentId>,
  conversations: ReadonlyArray<ConversationId>,
): void {
  const log = makeMessageLog();
  log.record({ origin: "sent" }, floorMessage);
  const records = senders.map((sender, index) => ({
    observedMessage: observed(`m${String(index)}`, {
      conversationId:
        conversations[index % conversations.length] ?? CONVERSATION,
      senderId: sender,
      createdAt: AT(2000 + index),
    }),
    sequence: index + 2,
  }));
  for (const record of records) {
    log.record(
      { origin: "received", at: seq(record.sequence) },
      record.observedMessage,
    );
  }
  const answer = log.answer(AFTER_FLOOR);
  if (answer._tag !== "answered") return;
  const matched = records.find((record) => record.sequence === answer.at);
  expect(matched?.observedMessage.conversationId).toBe(CONVERSATION);
  expect(matched?.observedMessage.senderId).toBe(SENDER);
  expect(answer.message.createdAt > FLOOR_AT).toBe(true);
}

describe("an unorderable pair", () => {
  it("waits rather than guessing when a candidate shares the floor's millisecond", () => {
    const log = makeMessageLog();
    log.record({ origin: "sent" }, floorMessage);
    log.record(
      { origin: "received", at: seq(2) },
      observed("tied", { createdAt: FLOOR_AT }),
    );
    expect(log.answer(AFTER_FLOOR)).toStrictEqual({
      _tag: "ambiguous",
      tiedWith: message("tied"),
    });
  });

  it("prefers a strictly later candidate over a tied one", () => {
    const log = makeMessageLog();
    log.record({ origin: "sent" }, floorMessage);
    log.record(
      { origin: "received", at: seq(2) },
      observed("tied", { createdAt: FLOOR_AT }),
    );
    log.record(
      { origin: "received", at: seq(3) },
      observed("after", { createdAt: AT(2000) }),
    );
    expect(log.answer(AFTER_FLOOR)).toMatchObject({ _tag: "answered", at: 3 });
  });
});

describe("what the answer rule refuses", () => {
  it("gives no answer for another conversation, another sender, or no sender", () => {
    const log = makeMessageLog();
    log.record({ origin: "sent" }, floorMessage);
    log.record(
      { origin: "received", at: seq(2) },
      observed("elsewhere", { conversationId: OTHER_CONVERSATION }),
    );
    log.record(
      { origin: "received", at: seq(3) },
      observed("wrong-agent", { senderId: OTHER_SENDER }),
    );
    expect(log.answer(AFTER_FLOOR)).toStrictEqual({ _tag: "unanswered" });
    expect(
      log.answer({ ...AFTER_FLOOR, senders: new Set<AgentId>() }),
    ).toStrictEqual({ _tag: "unanswered" });
  });

  it("never answers with a message the run sent itself", () => {
    const log = makeMessageLog();
    log.record({ origin: "sent" }, floorMessage);
    log.record(
      { origin: "sent" },
      observed("own-follow-up", { createdAt: AT(2000) }),
    );
    expect(log.answer(AFTER_FLOOR)).toStrictEqual({ _tag: "unanswered" });
  });
});

describe("retention", () => {
  it("collapses a repeated message id, so backfill cannot double-count", () => {
    const log = makeMessageLog();
    const reply = observed("reply");
    expect(log.record({ origin: "received", at: seq(1) }, reply)).toBe(true);
    expect(log.record({ origin: "received", at: seq(2) }, reply)).toBe(false);
    expect(log.countFrom(SENDER)).toBe(1);
  });

  it("counts messages per sender across origins", () => {
    const log = makeMessageLog();
    log.record({ origin: "received", at: seq(1) }, observed("one"));
    log.record({ origin: "received", at: seq(2) }, observed("two"));
    log.record(
      { origin: "received", at: seq(3) },
      observed("other", { senderId: OTHER_SENDER }),
    );
    expect(log.countFrom(SENDER)).toBe(2);
    expect(log.countFrom(OTHER_SENDER)).toBe(1);
    expect(log.countFrom(agent("never-spoke"))).toBe(0);
  });

  it("counts exactly the distinct ids it accepted (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 4 }), {
          minLength: 1,
          maxLength: 12,
        }),
        assertCountMatchesDistinctIds,
      ),
      { numRuns: 40 },
    );
  });
});

/** Every record `record` accepts moves the count; every one it rejects does not. */
function assertCountMatchesDistinctIds(ids: ReadonlyArray<number>): void {
  const log = makeMessageLog();
  let accepted = 0;
  for (const id of ids) {
    if (
      log.record(
        { origin: "received", at: seq(accepted + 1) },
        observed(`m${String(id)}`),
      )
    ) {
      accepted += 1;
    }
  }
  expect(log.countFrom(SENDER)).toBe(accepted);
  expect(accepted).toBe(new Set(ids).size);
}
