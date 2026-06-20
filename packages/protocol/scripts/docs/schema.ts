import { JSONSchema, type Schema } from "effect";
import { appCallbackMethods, serverInboundMethods } from "#socket/catalog";
import * as protocolSchema from "../../src/index.js";
import {
  SORT_KEY_PAD_WIDTH,
  type AnyRpcDocDefinition,
  type JsonSchemaNode,
  type SchemaPropertyDoc,
} from "./types.js";

type RpcDefinitionField = readonly [
  key: string,
  predicate: (value: unknown) => boolean,
];

// Duck-type predicate for an RPC descriptor in the module namespace. Keyed on
// the runtime descriptor field set: `paramsSchema`/`resultSchema` are Effect
// `Schema` values, `validateParams`/`validateResult` strict decode guards.
// Dropping `validateParams`/`validateResult` from the descriptor would zero the
// docs silently, so they stay in the predicate.
const RPC_DEFINITION_FIELDS: readonly RpcDefinitionField[] = [
  ["name", isString],
  ["paramsSchema", isSchema],
  ["resultSchema", isSchema],
  ["validateParams", isFunction],
  ["validateResult", isFunction],
];

export function protocolRpcDefinitions(): readonly AnyRpcDocDefinition[] {
  const ordered = [
    ...serverInboundMethods,
    ...appCallbackMethods,
    ...Object.values(protocolSchema).filter(isRpcDefinition),
  ];
  const byName = new Map<string, AnyRpcDocDefinition>();
  for (const definition of ordered) {
    byName.set(definition.name, definition);
  }
  return [...byName.values()].sort((left, right) =>
    methodSortKey(left.name).localeCompare(methodSortKey(right.name)),
  );
}

function isRpcDefinition(value: unknown): value is AnyRpcDocDefinition {
  return (
    isObjectRecord(value) &&
    RPC_DEFINITION_FIELDS.every(([key, predicate]) =>
      predicate(getOwnProperty(value, key)),
    )
  );
}

function isObjectRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

// An Effect `Schema` is an object carrying an `ast` field. Duck-type on that.
function isSchema(value: unknown): value is Schema.Schema.AnyNoContext {
  return isObjectRecord(value) && "ast" in value;
}

function getOwnProperty(value: object, key: string): unknown {
  return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
}

function methodSortKey(method: string): string {
  const prefixOrder = [
    "auth",
    "agents",
    "messages",
    "conversations",
    "contacts",
    "invites",
    "presence",
    "apps",
    "system",
  ];
  const prefix = method.split("/")[0] ?? "";
  const index = prefixOrder.indexOf(prefix);
  const order = index === -1 ? prefixOrder.length : index;
  return `${order.toString().padStart(SORT_KEY_PAD_WIDTH, "0")}:${method}`;
}

// ── Schema Introspection ─────────────────────────────────────────────────
//
// The source is `JSONSchema.make(schema)` (draft-07), so the readers below
// branch on `.type` / `.anyOf` / `.const` / `.enum` / `.format`. The wire
// schemas use the inline `Schema.Number.pipe(Schema.int(), …)` form (renders
// inline `{"type":"integer"}`) rather than `Schema.Int` (which would hoist a
// `$defs`/`$ref`), so no `$ref` dereference is needed.

function getStringTypeName(node: JsonSchemaNode): string {
  if (node.format === "uuid") return "string (UUID)";
  if (node.format === "uri") return "string (URI)";
  if (node.format === "date-time") return "string (ISO 8601)";
  if (node.enum) return node.enum.join(" | ");
  return "string";
}

function getTypeName(node: JsonSchemaNode): string {
  if (node.anyOf) return "union";
  if (node.const !== undefined) return String(node.const);
  if (node.enum && node.type !== "string") return node.enum.join(" | ");
  const type = node.type;
  if (type === "string") return getStringTypeName(node);
  if (type === "integer") return "integer";
  if (type === "number") return "number";
  if (type === "boolean") return "boolean";
  if (type === "array") return "array";
  if (type === "null") return "null";
  if (type === "object") {
    // A `Schema.Record` renders `{ type: "object", additionalProperties: V }`
    // with no `properties`; a struct renders with `properties`. Split those as
    // "object (map)" / "object".
    return node.properties === undefined ? "object (map)" : "object";
  }
  return typeof type === "string" ? type : "unknown";
}

// `JSONSchema.make` injects an AUTO-GENERATED description on a refined
// primitive that carries no explicit `description` annotation (e.g. "a number
// less than or equal to 200", "a string matching the pattern ^...", "an
// integer"). Those are validator prose, not field documentation — strip them
// so the renderer's "The <name> field." fallback applies. Human descriptions
// (annotated via `Schema.annotations({ description })`) do NOT match these
// patterns and are preserved.
const AUTO_DESCRIPTION_PATTERNS: readonly RegExp[] = [
  /^a number /,
  /^an? integer$/,
  /^a (non-negative|positive|non-positive|negative) number$/,
  /^a string (matching the pattern|at least|at most|of length)/,
  /^a string$/,
  /^an? array /,
  /^a non-empty /,
];

function fieldDescription(prop: JsonSchemaNode): string {
  const description = prop.description ?? "";
  if (AUTO_DESCRIPTION_PATTERNS.some((re) => re.test(description))) {
    return "";
  }
  return description;
}

function schemaPropertyDoc(
  name: string,
  prop: JsonSchemaNode,
  required: boolean,
): SchemaPropertyDoc {
  return {
    name,
    type: getTypeName(prop),
    required,
    description: fieldDescription(prop),
  };
}

function extractObjectProperties(node: JsonSchemaNode): SchemaPropertyDoc[] {
  if (node.type !== "object" || !node.properties) return [];
  const requiredSet = new Set<string>(node.required ?? []);
  return Object.entries(node.properties).map(([name, prop]) =>
    schemaPropertyDoc(name, prop, requiredSet.has(name)),
  );
}

function extractUnionProperties(node: JsonSchemaNode): SchemaPropertyDoc[] {
  const seen = new Map<string, SchemaPropertyDoc>();
  for (const member of node.anyOf ?? []) {
    for (const prop of extractObjectProperties(member)) {
      if (!seen.has(prop.name)) seen.set(prop.name, prop);
    }
  }
  return Array.from(seen.values()).map((prop) => ({
    ...prop,
    required: false,
  }));
}

export function extractProperties(
  schema: Schema.Schema.AnyNoContext,
): SchemaPropertyDoc[] {
  // `JSONSchema.make` emits a draft-07 root; read it through the structural
  // `JsonSchemaNode` reader interface (the shapes overlap, no `unknown`).
  const node = JSONSchema.make(schema) as JsonSchemaNode;
  if (node.anyOf) return extractUnionProperties(node);
  return extractObjectProperties(node);
}
