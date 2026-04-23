/**
 * TypeBox → fast-check arbitrary derivation.
 *
 * The reference model covers every `RpcMethodName` in `RpcMap` (AC4 / Tier
 * B); properties therefore need a principled generator for each method's
 * params. Instead of handwriting an `Arbitrary<T>` per RPC, we derive it
 * from the schema already living at `paramsSchema`.
 *
 * Approach (per architect choice, not implementation): use the already-
 * available JSON-schema export path (`generate-json-schema.ts`) to project
 * each TypeBox schema to JSON-schema, then feed it to fast-check via the
 * implementer's chosen reflective adapter (fast-check 4.x's own helpers or
 * a thin hand-rolled walker — final choice is an implement-staff
 * decision, flagged in Open Questions O2).
 */
import type { TSchema, Static } from "@sinclair/typebox";
import type { Arbitrary } from "fast-check";

/**
 * Derive an `Arbitrary<Static<S>>` for any TypeBox schema. The derivation
 * is pure: given the same schema + fast-check seed, it yields the same
 * value tree (AC10 reproducibility).
 */
export function arbitraryFromSchema<S extends TSchema>(
  schema: S,
): Arbitrary<Static<S>> {
  throw new Error("not implemented");
}

/**
 * Shrink-preserving narrower. Some schemas (`Type.Unknown`, `Type.Any`)
 * produce open-world trees that drown properties in noise. This returns a
 * narrowed arbitrary still `Value.Check`-valid against `schema` but biased
 * toward "small typical" values the reference model can reason about.
 */
export function arbitraryForParams<S extends TSchema>(
  schema: S,
): Arbitrary<Static<S>> {
  throw new Error("not implemented");
}
