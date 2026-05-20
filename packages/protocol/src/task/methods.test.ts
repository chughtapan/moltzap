import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { validateMessage, validateTextPart } from "./methods.js";
import { inferConversationType } from "./tasks.js";
import type { AgentId } from "../identity/index.js";

const INFER_PROPERTY_RUNS = 100;
const DM_PAIR_TOTAL = 2;

function uuid(suffix: number): AgentId {
  const hex = suffix.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}` as AgentId;
}

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

const labelMatchesCardinality = (invitedCount: number): boolean => {
  const invited = Array.from({ length: invitedCount }, (_, i) => uuid(i + 1));
  const label = inferConversationType(invited);
  const isDmCardinality = 1 + invitedCount === DM_PAIR_TOTAL;
  return isDmCardinality ? label === "dm" : label === "group";
};

describe("inferConversationType (Spec D1 cardinality → label)", () => {
  it("returns 'dm' iff caller + invited participants totals 2", () => {
    const dmInvariant = fc.property(
      fc.integer({ min: 0, max: 16 }),
      labelMatchesCardinality,
    );
    expect(() =>
      fc.assert(dmInvariant, { numRuns: INFER_PROPERTY_RUNS }),
    ).not.toThrow();
  });
});
