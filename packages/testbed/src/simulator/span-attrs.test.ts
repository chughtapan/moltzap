/**
 * @file Gates for the delivered-span reader and the answer match rule.
 *
 * Both consumers of this module turn a verdict on what it returns, and
 * the spans it reads are written by a process under test. So the cases
 * that matter are the ones where a span is malformed, incomplete, or
 * ambiguous: each must read as *no* evidence. A reader that resolves a
 * partial or contradictory span into a match hands the episode a reply
 * that never happened.
 */
import { describe, expect, it } from "vitest";
/* eslint-disable sonarjs/assertions-in-tests -- property bodies are extracted to named top-level functions to satisfy the nesting caps; every property test delegates to one */
import { FastCheck as fc, Schema } from "effect";
import { LogicalSequence } from "./ids.js";
import {
  MESSAGE_DELIVERED_SPAN,
  makeDeliveredLog,
  readDeliveredMessage,
} from "./span-attrs.js";
import type { JsonValue } from "./run-spec.js";

const seq = (value: number): LogicalSequence =>
  Schema.decodeSync(LogicalSequence)(value);

const CONVERSATION = "conversation-1";
const SENDER = "agent-one";
const OTHER_SENDER = "agent-two";
const OTHER_CONVERSATION = "conversation-2";

function attribute(key: string, value: string): JsonValue {
  return { key, value: { stringValue: value } };
}

function spanWith(attributes: ReadonlyArray<JsonValue>): JsonValue {
  return { name: MESSAGE_DELIVERED_SPAN, attributes: [...attributes] };
}

const FULL_ATTRIBUTES: ReadonlyArray<JsonValue> = [
  attribute("moltzap.message.id", "m1"),
  attribute("moltzap.message.conversation_id", CONVERSATION),
  attribute("moltzap.message.sender_id", SENDER),
];

function deliveredSpan(
  messageId: string,
  conversationId = CONVERSATION,
  senderId = SENDER,
): JsonValue {
  return spanWith([
    attribute("moltzap.message.id", messageId),
    attribute("moltzap.message.conversation_id", conversationId),
    attribute("moltzap.message.sender_id", senderId),
  ]);
}

describe("readDeliveredMessage", () => {
  it("reads the three attributes off a well-formed span", () => {
    expect(readDeliveredMessage(spanWith(FULL_ATTRIBUTES))).toStrictEqual({
      messageId: "m1",
      conversationId: CONVERSATION,
      senderId: SENDER,
    });
  });

  it("reads a span missing any one attribute as no evidence", () => {
    for (let omitted = 0; omitted < FULL_ATTRIBUTES.length; omitted += 1) {
      const partial = FULL_ATTRIBUTES.filter((_, index) => index !== omitted);
      expect(readDeliveredMessage(spanWith(partial))).toBeUndefined();
    }
  });

  it("reads a span repeating any attribute key as no evidence", () => {
    const doubled = spanWith([
      ...FULL_ATTRIBUTES,
      attribute("moltzap.message.sender_id", OTHER_SENDER),
    ]);
    expect(readDeliveredMessage(doubled)).toBeUndefined();
  });

  it("reads non-string and malformed attribute encodings as no evidence", () => {
    const intValued = spanWith([
      attribute("moltzap.message.id", "m1"),
      attribute("moltzap.message.conversation_id", CONVERSATION),
      { key: "moltzap.message.sender_id", value: { intValue: 7 } },
    ]);
    expect(readDeliveredMessage(intValued)).toBeUndefined();
    expect(
      readDeliveredMessage({ attributes: "not-an-array" }),
    ).toBeUndefined();
    expect(readDeliveredMessage(["not", "a", "record"])).toBeUndefined();
    expect(
      readDeliveredMessage(spanWith(["not-an-attribute"])),
    ).toBeUndefined();
  });

  it("is evidence only when all three keys appear exactly once (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 2 }), { maxLength: 6 }),
        assertEvidenceRequiresExactlyOneOfEach,
      ),
      { numRuns: 60 },
    );
  });
});

/**
 * The reader's contract in one sentence: a delivered message is evidence
 * only when each of the three keys appears exactly once. A key short is a
 * partial match and a key twice is a contested one, and neither may pass
 * for a message that was delivered.
 */
function assertEvidenceRequiresExactlyOneOfEach(
  keys: ReadonlyArray<number>,
): void {
  const attributes = keys.map(
    (index) => FULL_ATTRIBUTES[index] ?? attribute("unused", "unused"),
  );
  const exactlyOneOfEach = [0, 1, 2].every(
    (key) => keys.filter((index) => index === key).length === 1,
  );
  expect(readDeliveredMessage(spanWith(attributes)) !== undefined).toBe(
    exactlyOneOfEach,
  );
}

const AFTER_FLOOR = {
  conversationId: CONVERSATION,
  afterMessageId: "floor",
  senders: new Set([SENDER]),
};

function assertRetainsOnlyDeliveredSpans(): void {
  const log = makeDeliveredLog();
  expect(log.record(seq(1), "some.other.span", deliveredSpan("m1"))).toBe(
    false,
  );
  expect(log.record(seq(2), MESSAGE_DELIVERED_SPAN, deliveredSpan("m1"))).toBe(
    true,
  );
  expect(log.record(seq(3), MESSAGE_DELIVERED_SPAN, spanWith([]))).toBe(false);
}

function assertNoAnswerBeforeTheFloorArrives(): void {
  const log = makeDeliveredLog();
  log.record(seq(1), MESSAGE_DELIVERED_SPAN, deliveredSpan("reply"));
  expect(log.answer(AFTER_FLOOR)).toBeUndefined();
  // A reply recorded before the floor cannot answer it: the log's order
  // is the order the spans arrived.
  log.record(seq(2), MESSAGE_DELIVERED_SPAN, deliveredSpan("floor"));
  expect(log.answer(AFTER_FLOOR)).toBeUndefined();
}

function assertAnswersWithFirstLaterMessage(): void {
  const log = makeDeliveredLog();
  log.record(seq(1), MESSAGE_DELIVERED_SPAN, deliveredSpan("floor"));
  log.record(seq(2), MESSAGE_DELIVERED_SPAN, deliveredSpan("reply"));
  log.record(seq(3), MESSAGE_DELIVERED_SPAN, deliveredSpan("later"));
  expect(log.answer(AFTER_FLOOR)).toBe(2);
}

function assertDiscriminatesConversationAndSender(): void {
  const log = makeDeliveredLog();
  log.record(seq(1), MESSAGE_DELIVERED_SPAN, deliveredSpan("floor"));
  log.record(
    seq(2),
    MESSAGE_DELIVERED_SPAN,
    deliveredSpan("elsewhere", OTHER_CONVERSATION),
  );
  log.record(
    seq(3),
    MESSAGE_DELIVERED_SPAN,
    deliveredSpan("wrong-agent", CONVERSATION, OTHER_SENDER),
  );
  expect(log.answer(AFTER_FLOOR)).toBeUndefined();
  expect(
    log.answer({ ...AFTER_FLOOR, senders: new Set<string>() }),
  ).toBeUndefined();
}

/**
 * However many spans arrive and whoever sent them, an answer is always a
 * span this log retained: in the awaited conversation, from an accepted
 * sender, strictly after the floor. That is the whole contract the reply
 * gate and the done-signal rest on, so it holds for every input rather
 * than for the three orderings the examples happen to name.
 */
function assertAnswerIsAlwaysAdmissible(
  senders: ReadonlyArray<string>,
  conversations: ReadonlyArray<string>,
): void {
  const log = makeDeliveredLog();
  const records = senders.map((sender, index) => ({
    messageId: index === 0 ? "floor" : `m${String(index)}`,
    conversationId: conversations[index % conversations.length] ?? CONVERSATION,
    senderId: sender,
    sequence: index + 1,
  }));
  for (const record of records) {
    log.record(
      seq(record.sequence),
      MESSAGE_DELIVERED_SPAN,
      deliveredSpan(record.messageId, record.conversationId, record.senderId),
    );
  }
  const answer = log.answer(AFTER_FLOOR);
  if (answer === undefined) return;
  const matched = records.find((record) => record.sequence === answer);
  expect(matched?.conversationId).toBe(CONVERSATION);
  expect(matched?.senderId).toBe(SENDER);
  expect(answer).toBeGreaterThan(1);
}

describe("makeDeliveredLog retention", () => {
  it("retains only delivered-message spans", () => {
    assertRetainsOnlyDeliveredSpans();
  });

  it("gives no answer until the awaited message's own span arrives", () => {
    assertNoAnswerBeforeTheFloorArrives();
  });

  it("retains exactly the spans it reports retaining (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }),
        assertRetentionMatchesReport,
      ),
      { numRuns: 40 },
    );
  });
});

/** Every span `record` accepts is findable; every one it rejects is not. */
function assertRetentionMatchesReport(
  wellFormed: ReadonlyArray<boolean>,
): void {
  const log = makeDeliveredLog();
  log.record(seq(1), MESSAGE_DELIVERED_SPAN, deliveredSpan("floor"));
  wellFormed.forEach((formed, index) => {
    const sequence = index + 2;
    const span = formed ? deliveredSpan(`m${String(sequence)}`) : spanWith([]);
    const accepted = log.record(seq(sequence), MESSAGE_DELIVERED_SPAN, span);
    expect(accepted).toBe(formed);
  });
  const answer = log.answer(AFTER_FLOOR);
  expect(answer === undefined).toBe(!wellFormed.includes(true));
}

describe("makeDeliveredLog matching", () => {
  it("answers with the first later message from an accepted sender", () => {
    assertAnswersWithFirstLaterMessage();
  });

  it("gives no answer for another conversation, another sender, or no sender", () => {
    assertDiscriminatesConversationAndSender();
  });

  it("only ever answers with an admissible span (property)", () => {
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
