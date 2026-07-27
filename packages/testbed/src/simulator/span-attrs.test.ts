/**
 * @file Gates for the delivered-span reader.
 *
 * The spans it reads are written by a process under test, so the cases
 * that matter are the ones where a span is malformed, incomplete, or
 * ambiguous: each must read as *no* evidence. A reader that resolves a
 * partial or contradictory span into a message hands its consumer a
 * delivery that never happened.
 */
import { describe, expect, it } from "vitest";
/* eslint-disable sonarjs/assertions-in-tests -- property bodies are extracted to named top-level functions to satisfy the nesting caps; every property test delegates to one */
import { FastCheck as fc } from "effect";
import {
  MESSAGE_DELIVERED_SPAN,
  readDeliveredMessage,
} from "./span-attrs.js";
import type { JsonValue } from "./run-spec.js";

const CONVERSATION = "conversation-1";
const SENDER = "agent-one";
const OTHER_SENDER = "agent-two";

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
