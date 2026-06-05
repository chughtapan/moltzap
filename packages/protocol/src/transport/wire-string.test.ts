import { describe, expect, it } from "vitest";
import { JSONSchema, Schema } from "effect";
import {
  stringEnum,
  formatString,
  dateTimeStringSchema,
} from "./wire-string.js";
import { decodesStrictly } from "./strict-decode.js";

const DateTimeString = dateTimeStringSchema();
const INVALID_ENUM_VALUE = 123;

// Strict decode check (excess-rejecting) — the parity oracle for the former
// `ajv.compile(schema)` strict validators (`decodesStrictly` passes
// `{ onExcessProperty: "error" }`, the wire boundary's option).
const accepts = <A, I>(schema: Schema.Schema<A, I>, value: unknown): boolean =>
  decodesStrictly(schema, value);

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
    const schema = formatString("uuid");
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
