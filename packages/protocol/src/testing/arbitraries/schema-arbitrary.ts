/**
 * Effect `Schema` → fast-check arbitrary derivation.
 *
 * Conformance properties need a principled generator for each method's params.
 * Rather than handwrite an `Arbitrary&lt;T>` per RPC, derive it from the `Schema`
 * already living at `paramsSchema` via Effect's `Arbitrary.make(schema)`: its
 * native schema→fast-check derivation covers every combinator (unions,
 * refinements, brands, `suspend` recursion) and shrinks. The `Schema.pattern` /
 * `Schema.filter` refinements (UUID / URI / date-time) are honored because
 * `Arbitrary.make` reads them; the `registerArbitraryRoundTrip` conformance
 * property proves every catalog method's generated samples decode cleanly.
 */
import { Arbitrary, type FastCheck, type Schema } from "effect";

/**
 * Derive an `Arbitrary&lt;Schema.Schema.Type&lt;S>>` for any Effect `Schema`. The
 * derivation is pure: given the same schema + fast-check seed, it yields the
 * same value tree (AC10 reproducibility). The return type is Effect's
 * re-exported `FastCheck.Arbitrary` — the SAME `fast-check` module the rest of
 * the suite samples with (both pinned to fast-check v3, the version Effect's
 * `Arbitrary.make` binds to), so no cross-module cast is needed.
 * @param schema Value supplied to the operation.
 * @returns The arbitrary from schema result.
 */
export function arbitraryFromSchema<S extends Schema.Schema.AnyNoContext>(
  schema: S,
): FastCheck.Arbitrary<Schema.Schema.Type<S>> {
  return Arbitrary.make(schema);
}
