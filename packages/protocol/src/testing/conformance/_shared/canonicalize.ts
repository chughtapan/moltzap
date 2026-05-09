/**
 * Canonicalization primitives — narrow, composable building blocks for
 * body-compare property assertions.
 *
 * Per architect #197 §3: properties that compare response bodies route
 * through a named canonical-projection function that normalizes order
 * **only where the protocol spec marks it unordered**. These primitives
 * let the property author that projection without reaching for a
 * blanket deep-sort that would hide real re-ordering regressions inside
 * nested arrays.
 *
 * Callers cite the spec clause for each array they sort, in JSDoc on
 * the projection. Reviewer spot-checks during stamina pass.
 *
 * No blanket `canonicalizeUnordered` helper: picking which arrays to
 * sort is a spec decision, not an ergonomic default.
 */

/**
 * Sort a JSON-array by the canonical stringification of each element.
 * Shallow: does NOT recurse into elements. Caller composes with
 * `sortObjectKeysDeep` per element if element-wise key-order stability
 * matters. Preserves input immutability (returns a fresh array).
 */
export function sortJsonArray(
  arr: ReadonlyArray<unknown>,
): ReadonlyArray<unknown> {
  const keyed = arr.map((el) => ({ el, key: canonicalJson(el) }));
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return keyed.map((k) => k.el);
}

/**
 * Deep key-sort on objects; array order preserved at every depth.
 * Use before final `JSON.stringify` so key-order noise does not break
 * byte-compare. Safe to apply over any payload.
 */
export function sortObjectKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeysDeep);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const v: unknown = (value as { readonly [k: string]: unknown })[key];
    out[key] = sortObjectKeysDeep(v);
  }
  return out;
}

/**
 * Final stable serialization: `sortObjectKeysDeep → JSON.stringify`.
 * Intended as the last step after the property has applied whatever
 * array-scoped sorts its spec citation allows. Array order is
 * preserved; object key order is normalized.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortObjectKeysDeep(value));
}
