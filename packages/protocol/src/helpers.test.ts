import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { FormatRegistry, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
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

/**
 * Regression #370: importing `@moltzap/protocol` (or any of its helpers)
 * must register the `uuid`, `date-time`, and `uri` formats with TypeBox's
 * `FormatRegistry` as a side effect. Otherwise `Value.Decode` against any
 * schema using these formats fails with "Unknown format <name>" and every
 * frame is rejected.
 */
describe("TypeBox FormatRegistry side-effect registration", () => {
  it("registers uuid", () => {
    expect(FormatRegistry.Has("uuid")).toBe(true);
    const schema = brandedId("AgentId");
    expect(Value.Check(schema, "550e8400-e29b-41d4-a716-446655440000")).toBe(
      true,
    );
    expect(Value.Check(schema, "not-a-uuid")).toBe(false);
  });

  it("registers date-time", () => {
    expect(FormatRegistry.Has("date-time")).toBe(true);
    expect(Value.Check(DateTimeString, "2026-03-14T12:00:00.000Z")).toBe(true);
    expect(Value.Check(DateTimeString, "not-a-date")).toBe(false);
    // Shape-valid but semantically impossible — must reject.
    expect(Value.Check(DateTimeString, "2026-99-99T99:99:99Z")).toBe(false);
  });

  it("registers uri", () => {
    expect(FormatRegistry.Has("uri")).toBe(true);
    const uriSchema = Type.String({ format: "uri" });
    expect(Value.Check(uriSchema, "https://example.com/path")).toBe(true);
    expect(Value.Check(uriSchema, "moltzap:foo/bar")).toBe(true);
    expect(Value.Check(uriSchema, "not a uri")).toBe(false);
    expect(Value.Check(uriSchema, "://missing-scheme")).toBe(false);
  });
});
