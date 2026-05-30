import type { Schema } from "effect";

export const SORT_KEY_PAD_WIDTH = 2;
export const JSON_INDENT = 2;

/**
 * Draft-07 JSON-Schema node shape, as emitted by Effect's `JSONSchema.make`.
 * The docs walker reads this projection of a wire `Schema` (post-#723: the
 * source moved from the TypeBox AST to `JSONSchema.make` output, but the
 * draft-07 shape contract — `type` / `properties` / `required` / `anyOf` /
 * `format` / `enum` / `const` — is preserved).
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

export interface NotificationDocDefinition {
  readonly name: string;
  readonly paramsSchema: Schema.Schema.AnyNoContext;
}

export interface SchemaPropertyDoc {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly description: string;
}
