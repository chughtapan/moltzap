import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { ParticipantRefSchema, AgentSchema } from "./identity.js";

const ajv = addFormats(new Ajv({ strict: true }));

describe("ParticipantRefSchema", () => {
  const validate = ajv.compile(ParticipantRefSchema);

  it("accepts valid user ref", () => {
    expect(
      validate({
        type: "user",
        id: "550e8400-e29b-41d4-a716-446655440000",
      }),
    ).toBe(true);
  });

  it("accepts valid agent ref", () => {
    expect(
      validate({
        type: "agent",
        id: "550e8400-e29b-41d4-a716-446655440000",
      }),
    ).toBe(true);
  });

  it("rejects unknown type", () => {
    expect(
      validate({
        type: "bot",
        id: "550e8400-e29b-41d4-a716-446655440000",
      }),
    ).toBe(false);
  });

  it("rejects extra properties", () => {
    expect(
      validate({
        type: "user",
        id: "550e8400-e29b-41d4-a716-446655440000",
        extra: true,
      }),
    ).toBe(false);
  });
});

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
