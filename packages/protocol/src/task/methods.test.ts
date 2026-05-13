import { describe, expect, it } from "vitest";
import { validateMessage, validateTextPart } from "./methods.js";

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

describe("MessageSchema", () => {
  const validMessage = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    conversationId: "660e8400-e29b-41d4-a716-446655440000",
    senderId: "770e8400-e29b-41d4-a716-446655440000",
    parts: [{ type: "text", text: "Hello!" }],
    createdAt: "2026-03-14T12:00:00.000Z",
  };

  it("accepts valid message", () => {
    expect(validateMessage(validMessage)).toBe(true);
  });

  it("rejects message with no parts", () => {
    expect(validateMessage({ ...validMessage, parts: [] })).toBe(false);
  });

  it("accepts message with replyToId", () => {
    expect(
      validateMessage({
        ...validMessage,
        replyToId: "880e8400-e29b-41d4-a716-446655440000",
      }),
    ).toBe(true);
  });

  it("rejects message with extra properties", () => {
    expect(validateMessage({ ...validMessage, extra: true })).toBe(false);
  });
});
