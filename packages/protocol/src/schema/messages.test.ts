import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { MessageSchema, TextPartSchema } from "./messages.js";

const ajv = addFormats(new Ajv({ strict: true }));

describe("TextPartSchema", () => {
  const validate = ajv.compile(TextPartSchema);

  it("accepts valid text part", () => {
    expect(validate({ type: "text", text: "hello" })).toBe(true);
  });

  it("rejects empty text", () => {
    expect(validate({ type: "text", text: "" })).toBe(false);
  });

  it("rejects extra properties", () => {
    expect(validate({ type: "text", text: "hello", extra: true })).toBe(false);
  });
});

describe("MessageSchema", () => {
  const validate = ajv.compile(MessageSchema);

  const validMessage = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    conversationId: "660e8400-e29b-41d4-a716-446655440000",
    senderId: "770e8400-e29b-41d4-a716-446655440000",
    parts: [{ type: "text", text: "Hello!" }],
    createdAt: "2026-03-14T12:00:00.000Z",
  };

  it("accepts valid message", () => {
    expect(validate(validMessage)).toBe(true);
  });

  it("rejects message with no parts", () => {
    expect(validate({ ...validMessage, parts: [] })).toBe(false);
  });

  it("accepts message with replyToId", () => {
    expect(
      validate({
        ...validMessage,
        replyToId: "880e8400-e29b-41d4-a716-446655440000",
      }),
    ).toBe(true);
  });

  it("rejects message with extra properties", () => {
    expect(validate({ ...validMessage, extra: true })).toBe(false);
  });
});
