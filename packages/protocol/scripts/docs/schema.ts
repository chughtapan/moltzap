import { rpcMethods, taskCallbackMethods } from "../../src/rpc-registry.js";
import * as protocolSchema from "../../src/index.js";
import {
  SORT_KEY_PAD_WIDTH,
  TypeBoxKind,
  type AnyRpcDocDefinition,
  type SchemaPropertyDoc,
  type TypeBoxSchema,
} from "./types.js";

type RpcDefinitionField = readonly [
  key: string,
  predicate: (value: unknown) => boolean,
];

type TypeNameReader = (schema: TypeBoxSchema) => string;

const RPC_DEFINITION_FIELDS: readonly RpcDefinitionField[] = [
  ["name", isString],
  ["paramsSchema", isObjectRecord],
  ["resultSchema", isObjectRecord],
  ["validateParams", isFunction],
  ["validateResult", isFunction],
];

const TYPE_NAME_READERS: Readonly<Record<string, TypeNameReader>> = {
  Array: () => "array",
  Boolean: () => "boolean",
  Integer: () => "integer",
  Literal: getLiteralTypeName,
  Number: () => "number",
  Object: () => "object",
  Optional: getOptionalTypeName,
  Record: () => "object (map)",
  String: getStringTypeName,
  Union: () => "union",
  Unsafe: getUnsafeTypeName,
};

export function protocolRpcDefinitions(): readonly AnyRpcDocDefinition[] {
  const ordered = [
    ...rpcMethods,
    ...taskCallbackMethods,
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

function getSchemaKind(schema: TypeBoxSchema): string | undefined {
  const kind = schema[TypeBoxKind];
  return typeof kind === "string" ? kind : undefined;
}

function getStringTypeName(schema: TypeBoxSchema): string {
  if (schema.format === "uuid") return "string (UUID)";
  if (schema.format === "uri") return "string (URI)";
  if (schema.format === "date-time") return "string (ISO 8601)";
  if (schema.enum) return schema.enum.join(" | ");
  return "string";
}

function getUnsafeTypeName(schema: TypeBoxSchema): string {
  if (schema.enum) return schema.enum.join(" | ");
  return typeof schema.type === "string" ? schema.type : "unknown";
}

function getOptionalTypeName(schema: TypeBoxSchema): string {
  return getTypeName(schema.anyOf?.[1] ?? schema);
}

function getLiteralTypeName(schema: TypeBoxSchema): string {
  return String(schema.const);
}

function getTypeName(schema: TypeBoxSchema): string {
  const kind = getSchemaKind(schema);
  if (!kind) return "unknown";
  const reader = TYPE_NAME_READERS[kind];
  return reader ? reader(schema) : kind.toLowerCase();
}

function schemaPropertyDoc(
  name: string,
  prop: TypeBoxSchema,
  required: boolean,
): SchemaPropertyDoc {
  return {
    name,
    type: getTypeName(prop),
    required,
    description: prop.description ?? "",
  };
}

function extractObjectProperties(schema: TypeBoxSchema): SchemaPropertyDoc[] {
  if (getSchemaKind(schema) !== "Object" || !schema.properties) return [];

  const requiredSet = new Set<string>(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, prop]) =>
    schemaPropertyDoc(name, prop, requiredSet.has(name)),
  );
}

function extractUnionProperties(schema: TypeBoxSchema): SchemaPropertyDoc[] {
  const seen = new Map<string, SchemaPropertyDoc>();
  for (const member of schema.anyOf ?? []) {
    for (const prop of extractObjectProperties(member)) {
      if (!seen.has(prop.name)) seen.set(prop.name, prop);
    }
  }
  return Array.from(seen.values()).map((prop) => ({
    ...prop,
    required: false,
  }));
}

export function extractProperties(schema: TypeBoxSchema): SchemaPropertyDoc[] {
  if (getSchemaKind(schema) === "Union") return extractUnionProperties(schema);
  return extractObjectProperties(schema);
}
