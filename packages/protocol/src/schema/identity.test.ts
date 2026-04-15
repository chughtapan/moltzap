import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { AgentSchema, AgentCardSchema } from "./identity.js";

const ajv = addFormats(new Ajv({ strict: true }));

describe("AgentSchema", () => {
  const validate = ajv.compile(AgentSchema);

  const validAgent = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "atlas-bot",
    status: "active",
    createdAt: "2026-03-14T12:00:00.000Z",
  };

  it("accepts valid agent", () => {
    expect(validate(validAgent)).toBe(true);
  });

  it("rejects invalid agent name (uppercase)", () => {
    expect(validate({ ...validAgent, name: "Atlas" })).toBe(false);
  });

  it("rejects agent name too short", () => {
    expect(validate({ ...validAgent, name: "ab" })).toBe(false);
  });

  it("rejects invalid status", () => {
    expect(validate({ ...validAgent, status: "deleted" })).toBe(false);
  });
});

describe("AgentCardSchema", () => {
  const validate = ajv.compile(AgentCardSchema);

  const validCard = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "atlas-bot",
    status: "active",
  };

  it("accepts valid card with required fields only", () => {
    expect(validate(validCard)).toBe(true);
  });

  it("accepts valid card with all optional fields", () => {
    expect(
      validate({
        ...validCard,
        displayName: "Atlas Bot",
        description: "A helpful bot",
        ownerUserId: "660e8400-e29b-41d4-a716-446655440000",
      }),
    ).toBe(true);
  });

  it("accepts short name (3 chars)", () => {
    expect(validate({ ...validCard, name: "bot" })).toBe(true);
  });

  it("accepts long name (32 chars)", () => {
    expect(
      validate({ ...validCard, name: "a-very-long-agent-name-for-test" }),
    ).toBe(true);
  });

  it("rejects name too short (2 chars)", () => {
    expect(validate({ ...validCard, name: "ab" })).toBe(false);
  });

  it("rejects name too long (33 chars)", () => {
    expect(
      validate({
        ...validCard,
        name: "a-very-long-agent-name-for-testxx",
      }),
    ).toBe(false);
  });

  it("rejects uppercase name", () => {
    expect(validate({ ...validCard, name: "Atlas" })).toBe(false);
  });

  it("rejects invalid status", () => {
    expect(validate({ ...validCard, status: "deleted" })).toBe(false);
  });

  it("rejects missing status", () => {
    const { status: _, ...noStatus } = validCard;
    expect(validate(noStatus)).toBe(false);
  });

  it("rejects extra properties", () => {
    expect(validate({ ...validCard, extra: true })).toBe(false);
  });

  it("rejects missing id", () => {
    const { id: _, ...noId } = validCard;
    expect(validate(noId)).toBe(false);
  });

  it("rejects missing name", () => {
    const { name: _, ...noName } = validCard;
    expect(validate(noName)).toBe(false);
  });
});
