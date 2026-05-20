import {
  FormatRegistry,
  Type,
  type Static,
  type TString,
  type TNumber,
} from "@sinclair/typebox";
import type { Brand } from "effect";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const URI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/;

if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set(
    "uuid",
    (value) => typeof value === "string" && UUID_RE.test(value),
  );
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (value) => {
    if (typeof value !== "string" || !DATE_TIME_RE.test(value)) return false;
    return Number.isFinite(Date.parse(value));
  });
}
if (!FormatRegistry.Has("uri")) {
  FormatRegistry.Set(
    "uri",
    (value) => typeof value === "string" && URI_RE.test(value),
  );
}

/**
 * A `string` carrying a nominal `Brand.Brand&lt;BrandName>` tag. Prevents
 * a `string` from accidentally type-fitting a slot expecting the brand.
 */
export type BrandedString<BrandName extends string> = string &
  Brand.Brand<BrandName>;

/** A `number` carrying a nominal `Brand.Brand&lt;BrandName>` tag. */
export type BrandedNumber<BrandName extends string> = number &
  Brand.Brand<BrandName>;

/**
 * Build a `TString` TypeBox schema whose static type is
 * `BrandedString&lt;BrandName>`. The brand exists only at the type level —
 * the AJV validator runs against the underlying string. Passes
 * `options` through to `Type.String` so callers can add `format`,
 * `minLength`, `maxLength`, `pattern`, etc.
 */
export function brandedString<const BrandName extends string>(
  brand: BrandName,
  options: Parameters<typeof Type.String>[0] = {},
) {
  return Type.String({
    ...options,
    description: options.description ?? `Branded ${brand}`,
  }) as TString & { static: BrandedString<BrandName> };
}

/**
 * Build a `TNumber` TypeBox schema whose static type is
 * `BrandedNumber&lt;BrandName>`. Same shape as `brandedString` for the
 * numeric case.
 */
export function brandedNumber<const BrandName extends string>(
  brand: BrandName,
  options: Parameters<typeof Type.Number>[0] = {},
) {
  return Type.Number({
    ...options,
    description: options.description ?? `Branded ${brand}`,
  }) as TNumber & { static: BrandedNumber<BrandName> };
}

/**
 * Convenience over `brandedString` that adds `format: "uuid"`. The
 * canonical way to define wire id types in this package
 * (`AgentId = brandedId("AgentId")`, `TaskId = brandedId("TaskId")`,
 * etc.). The format check runs against the FormatRegistry's UUID
 * regex registered at module load.
 */
export function brandedId<const BrandName extends string>(brand: BrandName) {
  return brandedString(brand, {
    format: "uuid",
    description: `Branded ${brand}`,
  });
}

/**
 * `Type.String({ enum: values })` typed as the union of the literal
 * values. Use instead of `Type.Union([Type.Literal("a"), Type.Literal("b")])`
 * — same wire shape, simpler schema, single AJV `enum` keyword.
 */
export function stringEnum<T extends string[]>(values: [...T]) {
  return Type.String({ enum: values }) as TString & { static: T[number] };
}

const DateTimeStringSchema = Type.String({ format: "date-time" });

/**
 * ISO-8601 date-time string. Validated by the FormatRegistry `date-time`
 * checker registered at module load (regex plus `Date.parse` finiteness).
 */
export type DateTimeString = Static<typeof DateTimeStringSchema>;

/**
 * Returns the shared `DateTimeStringSchema` singleton. Functioned so
 * callers can keep `as const` references stable while the schema body
 * is owned here.
 */
export function dateTimeStringSchema(): typeof DateTimeStringSchema {
  return DateTimeStringSchema;
}
