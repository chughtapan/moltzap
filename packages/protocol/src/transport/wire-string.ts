import { Schema } from "effect";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const URI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/;

/** The three wire string formats. */
export type WireStringFormat = "uuid" | "uri" | "date-time";

/**
 * Unbranded `Schema.String` carrying one of the three wire `format` checkers.
 * Use for `result`/nested string fields that need a `format` but no brand
 * (e.g. a callback URL `uri`, a raw `uuid`-shaped id field). Emits the draft-07
 * `format` keyword for the docs walker and runs the regex/finiteness
 * refinement at decode time.
 */
export function formatString(format: WireStringFormat): Schema.Schema<string> {
  return applyStringFormat(Schema.String, format);
}

/**
 * `Schema.Literal(...values)` typed as the union of the literal values. Use
 * instead of `Schema.Union(Schema.Literal("a"), Schema.Literal("b"))` — same
 * wire shape, simpler schema. `JSONSchema.make` renders a literal union as
 * `{ "enum": [...] }` (string-valued), which the docs walker reads off
 * `.enum`.
 */
export function stringEnum<T extends string[]>(
  values: [...T],
): Schema.Schema<T[number]> {
  return Schema.Literal(...values);
}

/**
 * Returns the shared `DateTimeStringSchema` singleton. Functioned so callers
 * can keep `as const` references stable while the schema body is owned here.
 */
export function dateTimeStringSchema(): typeof DateTimeStringSchema {
  return DateTimeStringSchema;
}

/**
 * Apply one of the three wire string-format checkers as a decode-time
 * refinement, annotating the schema so `JSONSchema.make` re-emits the draft-07
 * `format` keyword AND so `Arbitrary.make` generates valid values directly
 * (not by filter-rejection).
 *
 * - `uuid` / `uri` are pure regex (`Schema.pattern`) + an `fc.uuid()` /
 *   `fc.webUrl()` arbitrary.
 * - `date-time` is a regex PLUS a `Date.parse` finiteness `filter` — the
 *   regex alone admits month/component-out-of-range strings (e.g.
 *   `2021-13-01T00:00:00Z`) that parse to `NaN`. The finiteness check is a
 *   real semantic guard the regex misses, so it MUST be a `filter`; the
 *   arbitrary generates ISO strings off `fc.date`.
 */
function applyStringFormat(
  base: Schema.Schema<string>,
  format: WireStringFormat,
): Schema.Schema<string> {
  const withFormat = (
    schema: Schema.Schema<string>,
    arbitrary: () => (
      fc: typeof import("effect").FastCheck,
    ) => import("effect").FastCheck.Arbitrary<string>,
  ): Schema.Schema<string> =>
    schema.pipe(Schema.annotations({ jsonSchema: { format }, arbitrary }));
  switch (format) {
    case "uuid":
      return withFormat(
        base.pipe(Schema.pattern(UUID_RE)),
        () => (fc) => fc.uuid(),
      );
    case "uri":
      return withFormat(
        base.pipe(Schema.pattern(URI_RE)),
        () => (fc) => fc.webUrl(),
      );
    case "date-time":
      return withFormat(
        base.pipe(
          Schema.pattern(DATE_TIME_RE),
          Schema.filter(
            (s) =>
              Number.isFinite(Date.parse(s)) ||
              "date-time: not a finite instant",
          ),
        ),
        dateTimeArbitrary,
      );
  }
}

/**
 * ISO-8601 date-time string. Validated by the `date-time` `pattern` +
 * `Date.parse` finiteness `filter`. Derive the type off `dateTimeStringSchema()`
 * where needed.
 */
const DateTimeStringSchema = applyStringFormat(Schema.String, "date-time");

// Arbitrary-annotation factories. `Arbitrary.make` derives a generator by
// reading the schema's refinements — but for a `Schema.pattern` like the UUID
// regex it FALLS BACK to filter-rejection (generate random strings, keep ones
// matching the regex), which for a UUID essentially never produces a hit and
// makes conformance fuzzing hang. So each format primitive carries an explicit
// `arbitrary` annotation that generates valid values DIRECTLY. The `fc` arg is
// Effect's re-exported FastCheck instance, passed in by `Arbitrary.make` — no
// top-level `fast-check` import in production code.
function dateTimeArbitrary() {
  return (
    fc: typeof import("effect").FastCheck,
  ): import("effect").FastCheck.Arbitrary<string> =>
    fc.date({ noInvalidDate: true }).map((d) => d.toISOString());
}
