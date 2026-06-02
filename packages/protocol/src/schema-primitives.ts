import { Either, Schema, type Brand } from "effect";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const URI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/;

/**
 * A `string` carrying a nominal `Brand.Brand&lt;BrandName>` tag. Prevents
 * a `string` from accidentally type-fitting a slot expecting the brand.
 *
 * `Schema.brand` produces `string & Brand.Brand&lt;BrandName>`, identical to
 * this alias, so a `brandedString("Foo")` schema's `Schema.Schema.Type` is
 * assignable both ways with `BrandedString&lt;"Foo">`.
 */
export type BrandedString<BrandName extends string> = string &
  Brand.Brand<BrandName>;

/** The three wire string formats. */
export type WireStringFormat = "uuid" | "uri" | "date-time";

/** Refinement options accepted by {@link brandedString}. */
export interface BrandedStringOptions {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: WireStringFormat;
  readonly description?: string;
}

/**
 * Effect `Schema` whose decoded type is `BrandedString&lt;BrandName>`. The
 * brand exists only at the type level — decode runs against the underlying
 * string with the requested refinements (`minLength`, `maxLength`, `pattern`,
 * and the three wire `format` checkers below) as `Schema.pattern` /
 * `Schema.filter` refinements inside the same `Schema.decode*` engine as
 * everything else.
 *
 * `format` annotates the schema with `{ jsonSchema: { format } }` so
 * `JSONSchema.make` re-emits the draft-07 `format` keyword the docs walker
 * reads (`scripts/docs/schema.ts → getStringTypeName`). The `pattern`/`filter`
 * refinement still runs at decode time regardless of the annotation.
 */
export function brandedString<const BrandName extends string>(
  brand: BrandName,
  options: BrandedStringOptions = {},
): Schema.Schema<BrandedString<BrandName>, string> {
  let base: Schema.Schema<string> = Schema.String;
  if (options.minLength !== undefined) {
    base = base.pipe(Schema.minLength(options.minLength));
  }
  if (options.maxLength !== undefined) {
    base = base.pipe(Schema.maxLength(options.maxLength));
  }
  if (options.pattern !== undefined) {
    base = base.pipe(Schema.pattern(new RegExp(options.pattern)));
  }
  if (options.format !== undefined) {
    base = applyStringFormat(base, options.format);
  }
  return base.pipe(
    Schema.brand(brand),
    Schema.annotations({
      description: options.description ?? `Branded ${brand}`,
    }),
  );
}

// Arbitrary-annotation factories. `Arbitrary.make` derives a generator by
// reading the schema's refinements — but for a `Schema.pattern` like the UUID
// regex it FALLS BACK to filter-rejection (generate random strings, keep ones
// matching the regex), which for a UUID essentially never produces a hit and
// makes conformance fuzzing hang. So each format primitive carries an explicit
// `arbitrary` annotation that generates valid values DIRECTLY. The `fc` arg is
// Effect's re-exported FastCheck instance, passed in by `Arbitrary.make` — no
// top-level `fast-check` import in production code.
const dateTimeArbitrary =
  () =>
  (
    fc: typeof import("effect").FastCheck,
  ): import("effect").FastCheck.Arbitrary<string> =>
    fc.date({ noInvalidDate: true }).map((d) => d.toISOString());

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
 * Convenience over {@link brandedString} that adds the `uuid` format. The
 * canonical way to define wire id types in this package
 * (`AgentId = brandedId("AgentId")`, `TaskId = brandedId("TaskId")`, etc.).
 * The format check runs the `UUID_RE` regex at decode time and annotates the
 * schema so `JSONSchema.make` emits `format:"uuid"` for the docs walker.
 */
export function brandedId<const BrandName extends string>(brand: BrandName) {
  return brandedString(brand, {
    format: "uuid",
    description: `Branded ${brand}`,
  });
}

/**
 * Unbranded `Schema.String` carrying one of the three wire `format` checkers.
 * Use for `result`/nested string fields that need a `format` but no brand
 * (e.g. a `claimUrl` `uri`, a raw `uuid`-shaped id field). Emits the draft-07
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
  // `Schema.Literal(...values)` from a runtime array can't recover the literal
  // tuple type statically; narrow the well-known `string`-union Type with a
  // direct (non-`unknown`) cast.
  return Schema.Literal(...values) as Schema.Schema<T[number]>;
}

/**
 * ISO-8601 date-time string. Validated by the `date-time` `pattern` +
 * `Date.parse` finiteness `filter`. Derive the type off `dateTimeStringSchema()`
 * where needed.
 */
const DateTimeStringSchema = applyStringFormat(Schema.String, "date-time");

/**
 * Returns the shared `DateTimeStringSchema` singleton. Functioned so callers
 * can keep `as const` references stable while the schema body is owned here.
 */
export function dateTimeStringSchema(): typeof DateTimeStringSchema {
  return DateTimeStringSchema;
}

// Opaque pagination token for the cursor-paginated list RPCs. The brand
// makes opacity structural: only the server's `list-cursor` codec
// produces this type; clients echo `nextCursor` back unmodified.
export type ListCursor = BrandedString<"ListCursor">;

const ListCursorSchema = brandedString("ListCursor", {
  description:
    "Opaque pagination cursor. Omit for the first page; pass the prior " +
    "response's nextCursor to fetch the next page. Treat as opaque — do " +
    "not parse, compare, or construct it.",
});

export function listCursorSchema(): typeof ListCursorSchema {
  return ListCursorSchema;
}

// ── Closed (excess-rejecting) struct guards ──────────────────────────

/**
 * Decode-time option that makes a `Schema.Struct` REJECT extra keys.
 *
 * Effect's `Schema.Struct` STRIPS excess keys by default
 * (`onExcessProperty:"ignore"`) — `Schema.decodeUnknownEither(S)({a,extra})`
 * returns `Right` with `extra` silently dropped, and `Schema.is(S)` returns
 * `true`. The wire boundary must REJECT excess instead: the conformance
 * `extra-property` / `oversized` mutators assert that a frame with an extra
 * key FAILS. So every decode boundary MUST pass this option (or use
 * {@link closedStructGuard}) to enforce that rejection.
 */
export const STRICT_DECODE = { onExcessProperty: "error" } as const;

/**
 * Whether `value` decodes cleanly against `schema` with excess-key rejection
 * (the strict AJV-parity check). The canonical boolean form used by the wire
 * frame validators, the standalone struct guards, and the conformance ports —
 * built on `Either.match` (the repo's required Either discriminant).
 */
export function decodesStrictly<A, I>(
  schema: Schema.Schema<A, I>,
  value: unknown,
): boolean {
  return Either.match(
    Schema.decodeUnknownEither(schema)(value, STRICT_DECODE),
    { onLeft: () => false, onRight: () => true },
  );
}

/**
 * Build a boolean type-guard from a `Schema` that REJECTS excess keys,
 * matching the former `ajv.compile(schema)` strict type guards. A bare
 * `Schema.is(schema)` ACCEPTS excess (loosening the trust boundary), so the
 * standalone validators (`validateAgent`, `validateMessage`, …) wrap a
 * strict `decodeUnknownEither` instead.
 */
export function closedStructGuard<A, I>(
  schema: Schema.Schema<A, I>,
): (value: unknown) => value is A {
  const decode = Schema.decodeUnknownEither(schema);
  return (value: unknown): value is A =>
    Either.match(decode(value, STRICT_DECODE), {
      onLeft: () => false,
      onRight: () => true,
    });
}
