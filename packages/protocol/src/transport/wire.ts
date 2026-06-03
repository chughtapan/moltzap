import { Brand, Schema } from "effect";
import { brandedString, decodesStrictly } from "../schema-primitives.js";

// ── JSON-RPC ids and methods ─────────────────────────────────────────

export const JSON_RPC_VERSION = "2.0" as const;

const JsonRpcIdSchema = brandedString("JsonRpcId");
const JsonRpcMethodSchema = brandedString("JsonRpcMethod", {
  minLength: 1,
});

export type JsonRpcId = Schema.Schema.Type<typeof JsonRpcIdSchema>;
export type JsonRpcMethod<Name extends string = string> = Name &
  Brand.Brand<"JsonRpcMethod">;

const JsonRpcMethodBrand = Brand.nominal<JsonRpcMethod>();

/**
 * Internal factory for descriptor construction (`defineRpc`,
 * `defineNotification`). Not on the package barrel — callers pass plain
 * strings to descriptors, which brand internally.
 */
export const jsonRpcMethod = <const Name extends string>(
  method: Name,
): JsonRpcMethod<Name> => JsonRpcMethodBrand(method) as JsonRpcMethod<Name>;

// ── Wire error envelope schema ───────────────────────────────────────
//
// The wire `error` is a `_tag`-discriminated tagged error: `_tag` names the
// error class (the decode discriminant), `message`/`data` are supplemental.
// There is no numeric code — the per-method error union decodes by `_tag`.

const RpcErrorSchema = Schema.Struct({
  _tag: Schema.String,
  message: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
});

// ── Frame schemas ────────────────────────────────────────────────────
//
// The wire dialect is JSON-RPC-2.0. These `Schema` values pin the canonical
// frame shapes the conformance driver generates and checks against: a request
// carries `method + id`, a response carries `id + result/error`, a notification
// carries `method` without `id`. The `@effect/rpc` engines own the production
// encode/decode path; these schemas serve the testing layer's frame vocabulary.

const ResponseIdSchema = Schema.Union(JsonRpcIdSchema, Schema.Null);

const RequestFrameSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: JsonRpcIdSchema,
  method: JsonRpcMethodSchema,
  params: Schema.optional(Schema.Unknown),
});

const ResponseSuccessFrameSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: ResponseIdSchema,
  result: Schema.Unknown,
});

const ResponseErrorFrameSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: ResponseIdSchema,
  error: RpcErrorSchema,
});

const ResponseFrameSchema = Schema.Union(
  ResponseSuccessFrameSchema,
  ResponseErrorFrameSchema,
);

const NotificationFrameSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  method: JsonRpcMethodSchema,
  params: Schema.optional(Schema.Unknown),
});

export type RequestFrame = Schema.Schema.Type<typeof RequestFrameSchema>;
export type ResponseFrame = Schema.Schema.Type<typeof ResponseFrameSchema>;
export type NotificationFrame = Schema.Schema.Type<
  typeof NotificationFrameSchema
>;

export function requestFrameSchema(): typeof RequestFrameSchema {
  return RequestFrameSchema;
}

export function responseFrameSchema(): typeof ResponseFrameSchema {
  return ResponseFrameSchema;
}

export function notificationFrameSchema(): typeof NotificationFrameSchema {
  return NotificationFrameSchema;
}

// A Response frame's `result` / `error` are `Schema.Unknown`; a REQUIRED
// `Schema.Unknown` field ACCEPTS an absent key (it reads as `undefined`).
// Re-assert key PRESENCE on the RAW input so `{jsonrpc, id}` stays malformed
// (it carries no body to resolve a pending call).
const hasResponseBodyKey = (parsed: unknown): boolean =>
  typeof parsed === "object" &&
  parsed !== null &&
  ("result" in parsed || "error" in parsed);

export const validateRequestFrame = (v: unknown): v is RequestFrame =>
  decodesStrictly(RequestFrameSchema, v);
export const validateResponseFrame = (v: unknown): v is ResponseFrame =>
  decodesStrictly(ResponseFrameSchema, v) && hasResponseBodyKey(v);
export const validateNotificationFrame = (v: unknown): v is NotificationFrame =>
  decodesStrictly(NotificationFrameSchema, v);
