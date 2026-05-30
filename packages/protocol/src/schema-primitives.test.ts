import { describe, expect, it } from "vitest";
import { JSONSchema, Schema } from "effect";
import {
  stringEnum,
  brandedId,
  brandedString,
  brandedNumber,
  formatString,
  dateTimeStringSchema,
  decodesStrictly,
} from "./schema-primitives.js";

const DateTimeString = dateTimeStringSchema();
const INVALID_ENUM_VALUE = 123;

// Strict decode check (excess-rejecting) — the parity oracle for the former
// `ajv.compile(schema)` strict validators (`decodesStrictly` passes
// `{ onExcessProperty: "error" }`, the wire boundary's option).
const accepts = <A, I>(schema: Schema.Schema<A, I>, value: unknown): boolean =>
  decodesStrictly(schema, value);

// The `description` reaches the wire/docs surface via `JSONSchema.make`'s
// `description` keyword (what the docs walker reads). Assert it there rather
// than digging into the branded `ast.annotations` internals.
const jsonDescription = (schema: Schema.Schema.AnyNoContext): string => {
  const node = JSONSchema.make(schema) as { description?: string };
  return node.description ?? "";
};

describe("stringEnum", () => {
  const schema = stringEnum(["user", "agent"]);

  it("accepts valid enum values", () => {
    expect(accepts(schema, "user")).toBe(true);
    expect(accepts(schema, "agent")).toBe(true);
  });

  it("rejects invalid enum values", () => {
    expect(accepts(schema, "other")).toBe(false);
    expect(accepts(schema, "")).toBe(false);
    expect(accepts(schema, INVALID_ENUM_VALUE)).toBe(false);
  });

  it("renders a literal-union enum in JSONSchema, not anyOf", () => {
    // `Schema.Literal(...)` surfaces an `enum` keyword in JSONSchema.make,
    // which the docs walker reads off `.enum` (NOT `anyOf`).
    const node = JSONSchema.make(schema) as {
      enum?: readonly string[];
      anyOf?: unknown;
    };
    expect(node.enum).toEqual(["user", "agent"]);
    expect(node.anyOf).toBeUndefined();
  });
});

describe("brandedString", () => {
  it("honors minLength/maxLength refinements", () => {
    const schema = brandedString("Tag", { minLength: 3, maxLength: 12 });
    expect(accepts(schema, "ok")).toBe(false);
    expect(accepts(schema, "good")).toBe(true);
    expect(accepts(schema, "waaaaaaaaaaaaaaay-too-long")).toBe(false);
  });

  it("defaults description with brand name embedded when caller omits it", () => {
    const schema = brandedString("Color");
    expect(jsonDescription(schema)).toMatch(/Color/);
  });

  it("respects caller-supplied description override", () => {
    const custom = "the color value";
    const schema = brandedString("Color", { description: custom });
    expect(jsonDescription(schema)).toContain(custom);
  });
});

describe("brandedNumber", () => {
  it("validates numbers and honors min/max bounds", () => {
    const schema = brandedNumber("Year", { minimum: 1900, maximum: 2100 });
    expect(accepts(schema, 2026)).toBe(true);
    expect(accepts(schema, 1899)).toBe(false);
    expect(accepts(schema, 2101)).toBe(false);
    expect(accepts(schema, "2026")).toBe(false);
  });

  it("defaults description with brand name embedded when caller omits it", () => {
    const schema = brandedNumber("Year");
    expect(jsonDescription(schema)).toMatch(/Year/);
  });
});

describe("brandedId", () => {
  const schema = brandedId("UserId");

  it("accepts valid UUIDs", () => {
    expect(accepts(schema, "550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("rejects non-UUID strings", () => {
    expect(accepts(schema, "not-a-uuid")).toBe(false);
    expect(accepts(schema, "")).toBe(false);
  });
});

describe("DateTimeString", () => {
  it("accepts ISO 8601 timestamps", () => {
    expect(accepts(DateTimeString, "2026-03-14T12:00:00.000Z")).toBe(true);
  });

  it("rejects non-datetime strings", () => {
    expect(accepts(DateTimeString, "not-a-date")).toBe(false);
  });
});

/**
 * Format-checker parity corpus (replaces the deleted AJV/`FormatRegistry`
 * side-effect tests, #370/#383). The three wire formats are now decode-time
 * `Schema.pattern` / `Schema.filter` refinements; assert they accept/reject
 * the SAME corpus the old `FormatRegistry` checkers did — in particular the
 * date-time regex-pass-but-`Date.parse`-NaN cliff (the one behavioral case
 * that the finiteness `filter` guards and a regex alone would miss).
 */
describe("wire-format parity corpus", () => {
  it("uuid", () => {
    const schema = brandedId("AgentId");
    expect(accepts(schema, "550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(accepts(schema, "not-a-uuid")).toBe(false);
  });

  it("date-time (incl. the finiteness cliff)", () => {
    expect(accepts(DateTimeString, "2026-03-14T12:00:00.000Z")).toBe(true);
    expect(accepts(DateTimeString, "not-a-date")).toBe(false);
    // Shape-valid (matches DATE_TIME_RE) but `Date.parse` → NaN: month/day
    // out of range. The finiteness `filter` is what rejects it; a bare regex
    // would accept. This is the load-bearing parity case.
    expect(accepts(DateTimeString, "2026-99-99T99:99:99Z")).toBe(false);
    expect(accepts(DateTimeString, "2021-13-01T00:00:00Z")).toBe(false);
  });

  it("uri", () => {
    const uriSchema = formatString("uri");
    expect(accepts(uriSchema, "https://example.com/path")).toBe(true);
    expect(accepts(uriSchema, "moltzap:foo/bar")).toBe(true);
    expect(accepts(uriSchema, "not a uri")).toBe(false);
    expect(accepts(uriSchema, "://missing-scheme")).toBe(false);
  });
});
