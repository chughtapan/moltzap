import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  validateDispatchDecision,
  validateMessage,
  validateTextPart,
} from "../message/index.js";

describe("TextPartSchema", () => {
  it("accepts valid text part", () => {
    expect(validateTextPart({ type: "text", text: "hello" })).toBe(true);
  });

  it("rejects empty text", () => {
    expect(validateTextPart({ type: "text", text: "" })).toBe(false);
  });

  it("rejects extra properties", () => {
    expect(validateTextPart({ type: "text", text: "hello", extra: true })).toBe(
      false,
    );
  });
});

const VALID_MESSAGE = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  conversationId: "660e8400-e29b-41d4-a716-446655440000",
  senderId: "770e8400-e29b-41d4-a716-446655440000",
  parts: [{ type: "text", text: "Hello!" }],
  createdAt: "2026-03-14T12:00:00.000Z",
};

describe("MessageSchema acceptance", () => {
  it("accepts valid message", () => {
    expect(validateMessage(VALID_MESSAGE)).toBe(true);
  });

  it("accepts message with replyToId", () => {
    expect(
      validateMessage({
        ...VALID_MESSAGE,
        replyToId: "880e8400-e29b-41d4-a716-446655440000",
      }),
    ).toBe(true);
  });
});

describe("MessageSchema rejection", () => {
  it("rejects message with no parts", () => {
    expect(validateMessage({ ...VALID_MESSAGE, parts: [] })).toBe(false);
  });

  it("rejects message with extra properties", () => {
    expect(validateMessage({ ...VALID_MESSAGE, extra: true })).toBe(false);
  });
});

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";

const VALID_DISPATCH_DECISIONS = [
  { tag: "pending" },
  { tag: "forward", recipients: [AGENT_ID] },
  { tag: "block", reason: "spam" },
] as const;

const RESERVED_DECISION_KEYS = new Set(["tag", "recipients", "reason"]);

// `validateDispatchDecision` guards the `app_decision` JSONB re-read at
// `server/.../message.service.ts → decodeDispatchDecision`. The strict
// excess-rejection arm had no coverage; an extra key on any verdict arm must
// fail so a malformed persisted decision cannot type-fit `DispatchDecision`.
describe("DispatchDecisionSchema", () => {
  it("accepts every verdict arm", () => {
    for (const decision of VALID_DISPATCH_DECISIONS) {
      expect(validateDispatchDecision(decision)).toBe(true);
    }
  });

  it("rejects an unknown tag", () => {
    expect(validateDispatchDecision({ tag: "approve" })).toBe(false);
  });

  // Invariant: a valid decision carrying any extra (non-reserved) key is
  // rejected at the strict boundary, across every arm and every injected key.
  it("rejects any valid decision with an injected extra key", () => {
    const extraKey = fc
      .string({ minLength: 1 })
      .filter((key) => !RESERVED_DECISION_KEYS.has(key));
    const property = fc.property(
      fc.constantFrom(...VALID_DISPATCH_DECISIONS),
      extraKey,
      fc.jsonValue(),
      (decision, key, value) =>
        validateDispatchDecision({ ...decision, [key]: value }) === false,
    );
    fc.assert(property, { numRuns: 50 });
    expect(validateDispatchDecision({ tag: "pending", extra: true })).toBe(
      false,
    );
  });
});
