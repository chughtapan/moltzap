import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { stringEnum, brandedId, DateTimeString } from "./helpers.js";

const ajv = addFormats(new Ajv({ strict: true }));

describe("stringEnum", () => {
  const schema = stringEnum(["user", "agent"]);

  it("accepts valid enum values", () => {
    const validate = ajv.compile(schema);
    expect(validate("user")).toBe(true);
    expect(validate("agent")).toBe(true);
  });

  it("rejects invalid enum values", () => {
    const validate = ajv.compile(schema);
    expect(validate("other")).toBe(false);
    expect(validate("")).toBe(false);
    expect(validate(123)).toBe(false);
  });

  it("produces enum schema, not anyOf", () => {
    expect(schema).toHaveProperty("enum", ["user", "agent"]);
    expect(schema).not.toHaveProperty("anyOf");
  });
});

describe("brandedId", () => {
  const schema = brandedId("UserId");

  it("accepts valid UUIDs", () => {
    const validate = ajv.compile(schema);
    expect(validate("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("rejects non-UUID strings", () => {
    const validate = ajv.compile(schema);
    expect(validate("not-a-uuid")).toBe(false);
    expect(validate("")).toBe(false);
  });
});

describe("DateTimeString", () => {
  it("accepts ISO 8601 timestamps", () => {
    const validate = ajv.compile(DateTimeString);
    expect(validate("2026-03-14T12:00:00.000Z")).toBe(true);
  });

  it("rejects non-datetime strings", () => {
    const validate = ajv.compile(DateTimeString);
    expect(validate("not-a-date")).toBe(false);
  });
});
