export const TypeBoxKind = Symbol.for("TypeBox.Kind");
export const SORT_KEY_PAD_WIDTH = 2;
export const JSON_INDENT = 2;

export interface TypeBoxSchema {
  readonly [key: symbol]: unknown;
  readonly anyOf?: readonly TypeBoxSchema[];
  readonly const?: unknown;
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly format?: string;
  readonly properties?: TypeBoxProperties;
  readonly required?: readonly string[];
  readonly type?: unknown;
}

type TypeBoxProperties = Readonly<Record<string, TypeBoxSchema>>;

export interface AnyRpcDocDefinition {
  readonly name: string;
  readonly paramsSchema: TypeBoxSchema;
  readonly resultSchema: TypeBoxSchema;
  readonly validateParams: (data: unknown) => boolean;
  readonly validateResult: (data: unknown) => boolean;
}

export interface NotificationDocDefinition {
  readonly name: string;
  readonly paramsSchema: TypeBoxSchema;
}

export interface SchemaPropertyDoc {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly description: string;
}
