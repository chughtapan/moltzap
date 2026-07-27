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
import { ConversationId, MessageId } from "@moltzap/protocol/conversation";
import { AgentId } from "@moltzap/protocol/identity";
import { LogicalSequence } from "./ids.js";
import {
  makeMessageLog,
  type AnswerCriteria,
  type ObservedMessage,
} from "./wire-log.js";

const seq = (value: number): LogicalSequence =>
  Schema.decodeSync(LogicalSequence)(value);

function uuid(seedText: string): string {
  const hex = [...seedText]
    .map((char) => char.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(32, "0")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const message = (name: string): MessageId =>
  Schema.decodeSync(MessageId)(uuid(name));
const conversation = (name: string): ConversationId =>
  Schema.decodeSync(ConversationId)(uuid(name));
const agent = (name: string): AgentId => Schema.decodeSync(AgentId)(uuid(name));

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

describe("the answer rule", () => {
  it("names the awaited message when no floor was ever recorded", () => {
    const log = makeMessageLog();
    log.record(seq(1), "received", observed("reply"));
    expect(log.answer(AFTER_FLOOR)).toStrictEqual({
      _tag: "no-floor",
      awaited: FLOOR,
    });
  });

  it("answers with the first message committed after the floor", () => {
    const log = makeMessageLog();
    log.record(undefined, "sent", floorMessage);
    log.record(seq(2), "received", observed("reply", { createdAt: AT(2000) }));
    log.record(seq(3), "received", observed("later", { createdAt: AT(3000) }));
    expect(log.answer(AFTER_FLOOR)).toMatchObject({
      _tag: "answered",
      at: 2,
    });
  });

  it("answers a message observed before the floor was written", () => {
    const log = makeMessageLog();
    // Observation order is not commit order: the server schedules its
    // notification writes before the sender's own send returns.
    log.record(seq(1), "received", observed("reply", { createdAt: AT(2000) }));
    log.record(undefined, "sent", floorMessage);
    expect(log.answer(AFTER_FLOOR)).toMatchObject({ _tag: "answered", at: 1 });
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
  log.record(undefined, "sent", floorMessage);
  const records = senders.map((sender, index) => ({
    observedMessage: observed(`m${String(index)}`, {
      conversationId: conversations[index % conversations.length] ?? CONVERSATION,
      senderId: sender,
      createdAt: AT(2000 + index),
    }),
    sequence: index + 2,
  }));
  for (const record of records) {
    log.record(seq(record.sequence), "received", record.observedMessage);
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
    log.record(undefined, "sent", floorMessage);
    log.record(seq(2), "received", observed("tied", { createdAt: FLOOR_AT }));
    expect(log.answer(AFTER_FLOOR)).toStrictEqual({
      _tag: "ambiguous",
      tiedWith: message("tied"),
    });
  });

  it("prefers a strictly later candidate over a tied one", () => {
    const log = makeMessageLog();
    log.record(undefined, "sent", floorMessage);
    log.record(seq(2), "received", observed("tied", { createdAt: FLOOR_AT }));
    log.record(seq(3), "received", observed("after", { createdAt: AT(2000) }));
    expect(log.answer(AFTER_FLOOR)).toMatchObject({ _tag: "answered", at: 3 });
  });
});

describe("what the answer rule refuses", () => {
  it("gives no answer for another conversation, another sender, or no sender", () => {
    const log = makeMessageLog();
    log.record(undefined, "sent", floorMessage);
    log.record(
      seq(2),
      "received",
      observed("elsewhere", { conversationId: OTHER_CONVERSATION }),
    );
    log.record(
      seq(3),
      "received",
      observed("wrong-agent", { senderId: OTHER_SENDER }),
    );
    expect(log.answer(AFTER_FLOOR)).toStrictEqual({ _tag: "unanswered" });
    expect(
      log.answer({ ...AFTER_FLOOR, senders: new Set<AgentId>() }),
    ).toStrictEqual({ _tag: "unanswered" });
  });

  it("never answers with a message the run sent itself", () => {
    const log = makeMessageLog();
    log.record(undefined, "sent", floorMessage);
    log.record(
      undefined,
      "sent",
      observed("own-follow-up", { createdAt: AT(2000) }),
    );
    expect(log.answer(AFTER_FLOOR)).toStrictEqual({ _tag: "unanswered" });
  });
});

describe("retention", () => {
  it("collapses a repeated message id, so backfill cannot double-count", () => {
    const log = makeMessageLog();
    const reply = observed("reply");
    expect(log.record(seq(1), "received", reply)).toBe(true);
    expect(log.record(seq(2), "received", reply)).toBe(false);
    expect(log.countFrom(SENDER)).toBe(1);
  });

  it("counts messages per sender across origins", () => {
    const log = makeMessageLog();
    log.record(seq(1), "received", observed("one"));
    log.record(seq(2), "received", observed("two"));
    log.record(seq(3), "received", observed("other", { senderId: OTHER_SENDER }));
    expect(log.countFrom(SENDER)).toBe(2);
    expect(log.countFrom(OTHER_SENDER)).toBe(1);
    expect(log.countFrom(agent("never-spoke"))).toBe(0);
  });

  it("counts exactly the distinct ids it accepted (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 1, maxLength: 12 }),
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
    if (log.record(seq(accepted + 1), "received", observed(`m${String(id)}`))) {
      accepted += 1;
    }
  }
  expect(log.countFrom(SENDER)).toBe(accepted);
  expect(accepted).toBe(new Set(ids).size);
}
