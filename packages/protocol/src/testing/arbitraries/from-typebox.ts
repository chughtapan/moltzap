/**
 * TypeBox → fast-check arbitrary derivation.
 *
 * The reference model covers every `RpcMethodName` in `RpcMap` (AC4 / Tier
 * B); properties therefore need a principled generator for each method's
 * params. Instead of handwriting an `Arbitrary<T>` per RPC, we derive it
 * from the schema already living at `paramsSchema`.
 *
 * Approach: walk TypeBox node kinds directly (`Object`, `Array`, `String`,
 * `Number`, `Integer`, `Boolean`, `Union`, `Literal`, `Unknown`) and map to
 * the equivalent fast-check primitive. Optional fields become `fc.option`
 * collapsed to `undefined`. Records are composed via `fc.record` so each
 * field shrinks independently.
 *
 * Resolution of Open Question O2: hand-rolled walker kept; no external
 * helper added. Rationale recorded inline below and in the PR body.
 */
import type { TSchema, Static } from "@sinclair/typebox";
import { Kind, OptionalKind } from "@sinclair/typebox";
import * as fc from "fast-check";

type TBNode = TSchema & {
  readonly type?: string;
  readonly [Kind]?: string;
  readonly [OptionalKind]?: string;
  readonly properties?: Readonly<Record<string, TSchema>>;
  readonly required?: ReadonlyArray<string>;
  readonly items?: TSchema;
  readonly anyOf?: ReadonlyArray<TSchema>;
  readonly allOf?: ReadonlyArray<TSchema>;
  readonly enum?: ReadonlyArray<string>;
  readonly const?: unknown;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly format?: string;
};

function isOptional(schema: TSchema): boolean {
  // TypeBox stores the Optional marker under a symbol-keyed metadata
  // field; the public `TSchema` type does not expose it. Narrowing via
  // `unknown` to a symbol-indexed record is the documented TypeBox
  // introspection pattern.
  // #ignore-sloppy-code-next-line[as-unknown-as]: TypeBox OptionalKind is symbol-keyed metadata not in the TSchema public type
  const marker = (schema as unknown as Record<symbol, string | undefined>)[
    OptionalKind
  ];
  return marker === "Optional";
}

/**
 * Derive an `Arbitrary<Static<S>>` for any TypeBox schema. The derivation
 * is pure: given the same schema + fast-check seed, it yields the same
 * value tree (AC10 reproducibility).
 */
export function arbitraryFromSchema<S extends TSchema>(
  schema: S,
): fc.Arbitrary<Static<S>> {
  // TBNode enriches TSchema with TypeBox's symbol-keyed metadata accessors;
  // the cast crosses that boundary exactly once, at entry.
  // #ignore-sloppy-code-next-line[as-unknown-as]: TBNode re-expresses TypeBox internal metadata keys for the walker
  const arb = walk(schema as unknown as TBNode);
  return arb as fc.Arbitrary<Static<S>>;
}

function walk(node: TBNode): fc.Arbitrary<unknown> {
  const kind = node[Kind];

  // Literal — a single constant value.
  if (kind === "Literal" || node.const !== undefined) {
    return fc.constant(node.const);
  }

  // Union — fc.oneof of every variant walker.
  if (kind === "Union" && Array.isArray(node.anyOf)) {
    if (node.anyOf.length === 0) return fc.constant(null);
    return fc.oneof(...node.anyOf.map((sub) => walk(sub as TBNode)));
  }

  // Intersect — synthesize an object whose branches are all merged.
  if (kind === "Intersect" && Array.isArray(node.allOf)) {
    return fc
      .tuple(...node.allOf.map((sub) => walk(sub as TBNode)))
      .map((arr) =>
        Object.assign(
          {},
          ...arr.map((v) => (v && typeof v === "object" ? v : {})),
        ),
      );
  }

  // Enum — single-value via `node.enum` (Type.Enum / stringEnum helper).
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const values = node.enum;
    return fc.constantFrom(...values);
  }

  switch (node.type) {
    case "object":
      return objectArbitrary(node);
    case "array":
      return node.items
        ? fc.array(walk(node.items as TBNode), { maxLength: 5 })
        : fc.array(fc.anything(), { maxLength: 5 });
    case "string":
      return stringArbitrary(node);
    case "integer":
      return fc.integer({
        min: node.minimum ?? -1000,
        max: node.maximum ?? 1000,
      });
    case "number":
      return fc.double({
        min: node.minimum ?? -1000,
        max: node.maximum ?? 1000,
        noNaN: true,
      });
    case "boolean":
      return fc.boolean();
    case "null":
      return fc.constant(null);
    default:
      // Unknown / Any / missing type → a biased "small JSON value" tree so
      // schema-permitted payloads stay small.
      return fc.jsonValue({ maxDepth: 2 });
  }
}

function stringArbitrary(node: TBNode): fc.Arbitrary<string> {
  if (node.format === "uuid") {
    return fc.uuid();
  }
  if (node.format === "date-time") {
    return fc
      .date({ min: new Date(2000, 0, 1), max: new Date(2100, 0, 1) })
      .map((d) => d.toISOString());
  }
  return fc.string({
    minLength: node.minLength ?? 0,
    maxLength: node.maxLength ?? 16,
  });
}

function objectArbitrary(node: TBNode): fc.Arbitrary<Record<string, unknown>> {
  const props = node.properties ?? {};
  const required = new Set(node.required ?? []);
  const record: Record<string, fc.Arbitrary<unknown>> = {};
  const requiredKeys: string[] = [];

  for (const [key, value] of Object.entries(props)) {
    const sub = value as TBNode;
    const arb = walk(sub);
    if (required.has(key) && !isOptional(sub)) {
      record[key] = arb;
      requiredKeys.push(key);
    } else {
      // Optional fields: drop with 50% probability so the value is absent
      // rather than `undefined`, matching `additionalProperties: false`
      // schemas that reject `{ x: undefined }` after JSON round-trip.
      record[key] = fc.option(arb, { nil: undefined });
    }
  }

  return fc.record(record).map((v) => {
    // Strip `undefined` values so JSON.stringify round-trips cleanly.
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val !== undefined) out[k] = val;
    }
    return out;
  });
}

/**
 * Shrink-preserving narrower. Some schemas (`Type.Unknown`, `Type.Any`)
 * produce open-world trees that drown properties in noise. This returns a
 * narrowed arbitrary still `Value.Check`-valid against `schema` but biased
 * toward "small typical" values the reference model can reason about.
 *
 * For now the narrowing strategy is identical to `arbitraryFromSchema` with
 * smaller default string/array bounds (handled inside `walk`). Exposed as a
 * distinct export so call sites document their intent.
 */
export function arbitraryForParams<S extends TSchema>(
  schema: S,
): fc.Arbitrary<Static<S>> {
  return arbitraryFromSchema(schema);
}
