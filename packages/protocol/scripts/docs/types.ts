export const TypeBoxKind = Symbol.for("TypeBox.Kind");
export const SORT_KEY_PAD_WIDTH = 2;
export const JSON_INDENT = 2;
export const TASKS_CREATE_METHOD = "tasks/create";

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

export interface ErrorDoc {
  readonly code: number;
  readonly name: string;
  readonly when: string;
}

export interface MethodDocMeta {
  readonly description?: string;

  /**
   * Long-form prose emitted between the H1 and the `## Parameters`
   * section. Use for methods where the one-line `description` cannot
   * capture authorization model, idempotency semantics, or pairing
   * recommendations. Markdown is supported.
   */
  readonly body?: string;
  readonly resultDescription?: string;
  readonly errors?: readonly ErrorDoc[];
  readonly relatedNotifications?: readonly string[];
}

export interface NotificationDocMeta {
  readonly description?: string;
  readonly triggeredBy?: readonly string[];
}

export interface SchemaPropertyDoc {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly description: string;
}
