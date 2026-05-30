/**
 * Effect `Schema` → fast-check arbitrary derivation.
 *
 * The reference model covers every wire method name in `RpcMap` (AC4 / Tier
 * B); properties therefore need a principled generator for each method's
 * params. Instead of handwriting an `Arbitrary&lt;T>` per RPC, we derive it
 * from the `Schema` already living at `paramsSchema`.
 *
 * Post-#723 (TypeBox+AJV → Effect Schema): the wire schemas are Effect
 * `Schema` values, so the former 270-line hand-rolled TypeBox `Kind` walker
 * is DELETED in favor of Effect's own `Arbitrary.make(schema)` — its native
 * schema→fast-check derivation covers every combinator (unions, refinements,
 * brands, `suspend` recursion) the hand-roll approximated, and shrinks. The
 * P1 `Schema.pattern` / `Schema.filter` refinements (UUID / URI / date-time)
 * are honored by `Arbitrary.make` reading those refinements; the
 * `registerArbitraryRoundTrip` conformance property proves every catalog
 * method's generated samples decode cleanly.
 */
import { Arbitrary, type FastCheck, type Schema } from "effect";

/**
 * Derive an `Arbitrary&lt;Schema.Schema.Type&lt;S>>` for any Effect `Schema`. The
 * derivation is pure: given the same schema + fast-check seed, it yields the
 * same value tree (AC10 reproducibility). The return type is Effect's
 * re-exported `FastCheck.Arbitrary` — the SAME `fast-check` module the rest of
 * the suite samples with (both pinned to fast-check v3, the version Effect's
 * `Arbitrary.make` binds to), so no cross-module cast is needed.
 */
export function arbitraryFromSchema<S extends Schema.Schema.AnyNoContext>(
  schema: S,
): FastCheck.Arbitrary<Schema.Schema.Type<S>> {
  return Arbitrary.make(schema);
}

/**
 * Narrowing alias kept for call-site intent. The former hand-roll narrowed
 * to "small typical" values; `Arbitrary.make` already reads the schema's
 * `maxItems` / `maxLength` / `between` bounds, so this delegates to
 * {@link arbitraryFromSchema}.
 */
export function arbitraryForParams<S extends Schema.Schema.AnyNoContext>(
  schema: S,
): FastCheck.Arbitrary<Schema.Schema.Type<S>> {
  return arbitraryFromSchema(schema);
}
