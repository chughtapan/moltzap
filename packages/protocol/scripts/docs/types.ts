import type { Schema } from "effect";

/** Provides the sort key pad width runtime value. */
export const SORT_KEY_PAD_WIDTH = 2;
/** Provides the json indent runtime value. */
export const JSON_INDENT = 2;

/**
 * Draft-07 JSON-Schema node shape, as emitted by Effect's `JSONSchema.make`.
 * The docs walker reads this projection of a wire `Schema`, branching on the
 * draft-07 shape contract — `type` / `properties` / `required` / `anyOf` /
 * `format` / `enum` / `const`.
 */
export interface JsonSchemaNode {
  readonly anyOf?: readonly JsonSchemaNode[];
  readonly const?: unknown;
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly format?: string;
  readonly properties?: JsonSchemaProperties;
  readonly required?: readonly string[];
  readonly type?: unknown;
  readonly items?: JsonSchemaNode | readonly JsonSchemaNode[];
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, JsonSchemaNode>>;
}

type JsonSchemaProperties = Readonly<Record<string, JsonSchemaNode>>;

/**
 * The runtime descriptor shape the docs walker consumes. `paramsSchema` /
 * `resultSchema` are Effect `Schema` values; the walker passes them through
 * `JSONSchema.make` to obtain the draft-07 {@link JsonSchemaNode} projection.
 */
export interface AnyRpcDocDefinition {
  readonly name: string;
  readonly paramsSchema: Schema.Schema.AnyNoContext;
  readonly resultSchema: Schema.Schema.AnyNoContext;
  readonly validateParams: (data: unknown) => boolean;
  readonly validateResult: (data: unknown) => boolean;
}

/** Describes notification doc definition. */
export interface NotificationDocDefinition {
  readonly name: string;
  readonly paramsSchema: Schema.Schema.AnyNoContext;
}

/** Describes schema property doc. */
export interface SchemaPropertyDoc {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly description: string;
}
