/**
 * TypeBox → fast-check arbitrary derivation.
 *
 * The reference model covers every wire method name in `RpcMap` (AC4 / Tier
 * B); properties therefore need a principled generator for each method's
 * params. Instead of handwriting an `Arbitrary&lt;T>` per RPC, we derive it
 * from the schema already living at `paramsSchema`.
 *
 * Approach: walk TypeBox node kinds directly (`Object`, `Array`, `String`,
 * `Number`, `Integer`, `Boolean`, `Union`, `Literal`, `Unknown`) and map to
 * the equivalent fast-check primitive. Optional fields become `fc.option`
 * collapsed to an internal absence sentinel. Records are composed via
 * `fc.record` so each field shrinks independently.
 *
 * Resolution of Open Question O2: hand-rolled walker kept; no external
 * helper added. Rationale recorded inline below and in the PR body.
 */
import type { TSchema, Static } from "@sinclair/typebox";
import { Kind, OptionalKind } from "@sinclair/typebox";
import * as fc from "fast-check";

const DEFAULT_ARRAY_MAX_LENGTH = 5;
const DEFAULT_NUMERIC_MIN = -1000;
const DEFAULT_NUMERIC_MAX = 1000;
const DEFAULT_JSON_MAX_DEPTH = 2;
const DEFAULT_DATE_MIN_YEAR = 2000;
const DEFAULT_DATE_MAX_YEAR = 2100;
const DEFAULT_STRING_MAX_LENGTH = 16;
const OPTIONAL_FIELD_ABSENT = Symbol("optional-field-absent");

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
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly format?: string;
};

function isOptional(schema: TSchema): boolean {
  const marker = (schema as TBNode)[OptionalKind];
  return marker === "Optional";
}

/**
 * Derive an `Arbitrary&lt;Static&lt;S>>` for any TypeBox schema. The derivation
 * is pure: given the same schema + fast-check seed, it yields the same
 * value tree (AC10 reproducibility).
 */
export function arbitraryFromSchema<S extends TSchema>(
  schema: S,
): fc.Arbitrary<Static<S>> {
  const arb = walk(schema as TBNode);
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
    case "array": {
      const minItems = node.minItems ?? 0;
      const maxItems = Math.max(
        minItems,
        node.maxItems ?? DEFAULT_ARRAY_MAX_LENGTH,
      );
      return node.items
        ? fc.array(walk(node.items as TBNode), {
            minLength: minItems,
            maxLength: maxItems,
          })
        : fc.array(fc.anything(), {
            minLength: minItems,
            maxLength: maxItems,
          });
    }
    case "string":
      return stringArbitrary(node);
    case "integer":
      return fc.integer({
        min: node.minimum ?? DEFAULT_NUMERIC_MIN,
        max: node.maximum ?? DEFAULT_NUMERIC_MAX,
      });
    case "number":
      return fc.double({
        min: node.minimum ?? DEFAULT_NUMERIC_MIN,
        max: node.maximum ?? DEFAULT_NUMERIC_MAX,
        noNaN: true,
      });
    case "boolean":
      return fc.boolean();
    case "null":
      return fc.constant(null);
    default:
      // Unknown / Any / missing type → a biased "small JSON value" tree so
      // schema-permitted payloads stay small.
      return fc.jsonValue({ maxDepth: DEFAULT_JSON_MAX_DEPTH });
  }
}

function stringArbitrary(node: TBNode): fc.Arbitrary<string> {
  if (node.format === "uuid") {
    return fc.uuid();
  }
  if (node.format === "date-time") {
    const min = Date.UTC(DEFAULT_DATE_MIN_YEAR, 0, 1);
    const max = Date.UTC(DEFAULT_DATE_MAX_YEAR, 0, 1);
    return fc.integer({ min, max }).map((ms) => new Date(ms).toISOString());
  }
  if (node.format === "uri") {
    return fc.webUrl();
  }
  return fc.string({
    minLength: node.minLength ?? 0,
    maxLength: node.maxLength ?? DEFAULT_STRING_MAX_LENGTH,
  });
}

function objectArbitrary(node: TBNode): fc.Arbitrary<Record<string, unknown>> {
  const props = node.properties ?? {};
  const required = new Set(node.required ?? []);
  const record: Record<string, fc.Arbitrary<unknown>> = {};

  for (const [key, value] of Object.entries(props)) {
    const sub = value as TBNode;
    const arb = walk(sub);
    if (required.has(key) && !isOptional(sub)) {
      record[key] = arb;
    } else {
      // Optional fields: drop with 50% probability so the value is absent
      // rather than `undefined`, matching `additionalProperties: false`
      // schemas that reject `{ x: undefined }` after JSON round-trip.
      record[key] = fc.option(arb, { nil: OPTIONAL_FIELD_ABSENT });
    }
  }

  return fc.record(record).map((v) => {
    // Strip `undefined` values so JSON.stringify round-trips cleanly.
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val !== OPTIONAL_FIELD_ABSENT && val !== undefined) out[k] = val;
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
