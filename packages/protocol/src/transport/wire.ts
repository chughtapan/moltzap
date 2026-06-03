/* eslint-disable jsdoc/text-escaping -- mermaid flowchart blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import { Brand, Data, Effect, Either, Schema } from "effect";
import {
  brandedString,
  decodesStrictly,
  STRICT_DECODE,
} from "../schema-primitives.js";

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
 * strings to frame builders, which brand internally.
 */
export const jsonRpcMethod = <const Name extends string>(
  method: Name,
): JsonRpcMethod<Name> => JsonRpcMethodBrand(method) as JsonRpcMethod<Name>;

const JsonRpcIdBrand = Brand.nominal<JsonRpcId>();

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
// The wire dialect is unchanged JSON-RPC-2.0: the exact same bytes flow on
// the socket as before. What changed is the validation ENGINE — these are
// Effect `Schema` values decoded by `Schema.decodeUnknownEither(...,
// { onExcessProperty: "error" })` rather than AJV `strict` compiled
// validators. The `{ onExcessProperty: "error" }` option is LOAD-BEARING:
// `Schema.Struct` STRIPS excess keys by default, but AJV `strict` +
// `additionalProperties:false` REJECTED them, and the conformance
// `extra-property` / `oversized` mutators assert frames with an extra key
// still FAIL. `decodeFrame` passes that option (`STRICT_DECODE`) so the
// rejection is preserved.

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

// Eager per-frame strict decoders, built once. Each rejects excess keys so
// the strict AJV parity holds at the wire boundary.
const decodeRequestFrame = Schema.decodeUnknownEither(RequestFrameSchema);
const decodeResponseFrame = Schema.decodeUnknownEither(ResponseFrameSchema);
const decodeNotificationFrame = Schema.decodeUnknownEither(
  NotificationFrameSchema,
);

// A Response frame's `result` / `error` are `Schema.Unknown`; a REQUIRED
// `Schema.Unknown` field ACCEPTS an absent key (it reads as `undefined`),
// whereas AJV `strict` REJECTED a `{jsonrpc, id}` frame carrying neither
// key. Re-assert key PRESENCE on the RAW input so `{jsonrpc, id}` stays
// malformed (it must not resolve a pending call).
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

// ── Frame decoder + builders ─────────────────────────────────────────

export type DecodedFrame =
  | { readonly _tag: "Request"; readonly frame: RequestFrame }
  | { readonly _tag: "Response"; readonly frame: ResponseFrame }
  | { readonly _tag: "Notification"; readonly frame: NotificationFrame };

export class FrameDecodeError extends Data.TaggedError("FrameDecodeError")<{
  readonly raw: unknown;
  readonly id: JsonRpcId | null;
}> {}

/**
 * Classify one already-`JSON.parse`d value as a JSON-RPC Request, Response,
 * or Notification frame — fail-closed on anything else.
 *
 * The discrimination runs `Schema.decodeUnknownEither(...,
 * { onExcessProperty: "error" })` against each frame schema in precedence order
 * (Request → Response → Notification). The `{ onExcessProperty: "error" }`
 * option rejects excess keys: a frame with an extra top-level key fails decode
 * at EVERY arm and falls through to `FrameDecodeError` — the conformance
 * `extra-property` / `oversized` mutators depend on this.
 *
 * ```mermaid
 * flowchart TD
 *   A["parsed: unknown<br>(JSON.parse already ran)"]
 *   A --> B["Schema.decodeUnknownEither(RequestFrame, STRICT)"]
 *   B -- Right --> R["tag Request"]
 *   B -- Left --> C["Schema.decodeUnknownEither(ResponseFrame, STRICT)"]
 *   C -- Right --> S["tag Response"]
 *   C -- Left --> D["Schema.decodeUnknownEither(NotificationFrame, STRICT)"]
 *   D -- Right --> N["tag Notification"]
 *   D -- Left --> X["FrameDecodeError (id salvaged if string)"]
 * ```
 */
export function decodeFrame(
  parsed: unknown,
): Effect.Effect<DecodedFrame, FrameDecodeError> {
  const tagged = Either.match(decodeRequestFrame(parsed, STRICT_DECODE), {
    onLeft: () =>
      // `hasResponseBodyKey` re-asserts `result`/`error` key presence (see
      // its definition) — `Schema.Unknown` alone accepts an absent key.
      hasResponseBodyKey(parsed)
        ? Either.match(decodeResponseFrame(parsed, STRICT_DECODE), {
            onLeft: () => decodeNotificationTag(parsed),
            onRight: (frame): DecodedFrame | null => ({
              _tag: "Response",
              frame,
            }),
          })
        : decodeNotificationTag(parsed),
    onRight: (frame): DecodedFrame | null => ({ _tag: "Request", frame }),
  });
  if (tagged !== null) return Effect.succeed(tagged);
  const idValue = (parsed as { id?: unknown } | null)?.id;
  const id = typeof idValue === "string" ? (idValue as JsonRpcId) : null;
  return Effect.fail(new FrameDecodeError({ raw: parsed, id }));
}

const decodeNotificationTag = (parsed: unknown): DecodedFrame | null =>
  Either.match(decodeNotificationFrame(parsed, STRICT_DECODE), {
    onLeft: () => null,
    onRight: (frame) => ({ _tag: "Notification", frame }),
  });

// `RpcDefinition` and `NotificationDefinition` live in `./method.ts` (one
// import cycle below); the frame builders take `definition.name` only and
// don't need the full descriptor surface. Importing the types lazily here
// avoids the cycle.
import type { RpcDefinition, NotificationDefinition } from "./method.js";

export function requestFrame<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
>(
  id: string,
  definition: RpcDefinition<Name, P, R>,
  params: Schema.Schema.Type<P>,
): RequestFrame & {
  readonly method: JsonRpcMethod<Name>;
  readonly params: Schema.Schema.Type<P>;
} {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id: JsonRpcIdBrand(id),
    method: definition.name,
    params,
  } as RequestFrame & {
    readonly method: JsonRpcMethod<Name>;
    readonly params: Schema.Schema.Type<P>;
  };
}

// The wire shape of a response-frame `error` sub-object: the tagged error's
// `_tag` discriminant plus message/data. This is the WIRE projection a tagged
// error encodes to, not a tagged-error class itself, so it declares `_tag`
// structurally.
// eslint-disable-next-line agent-code-guard/manual-tagged-error -- wire envelope type (the `_tag` projection of a `Schema.TaggedError`), not a tagged-error class
type ResponseFrameError = {
  _tag: string;
  message?: string;
  data?: unknown;
};
export type ResponseFrameBody =
  | { result: unknown }
  | { error: ResponseFrameError };

export function responseFrame(
  id: string | null,
  body: ResponseFrameBody,
): ResponseFrame {
  if (id === null) {
    return {
      jsonrpc: JSON_RPC_VERSION,
      id: null,
      ...body,
    } as ResponseFrame;
  }

  return {
    jsonrpc: JSON_RPC_VERSION,
    id: JsonRpcIdBrand(id),
    ...body,
  } as ResponseFrame;
}

/**
 * Public wire-error response encoder. Constructs a JSON-RPC error
 * response for any wire id (no method binding). Method-tied success
 * responses are framed by the server engine via the per-method result
 * schema; this helper is the method-agnostic error path.
 */
export function encodeErrorResponse(
  id: JsonRpcId | null,
  error: ResponseFrameError,
): ResponseFrame {
  if (id === null) return responseFrame(null, { error });
  return responseFrame(id, { error });
}

export function notificationFrame<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
>(
  definition: NotificationDefinition<Name, P>,
  params: Schema.Schema.Type<P>,
): NotificationFrame & {
  readonly method: JsonRpcMethod<Name>;
  readonly params: Schema.Schema.Type<P>;
} {
  return {
    jsonrpc: JSON_RPC_VERSION,
    method: definition.name,
    params,
  } as NotificationFrame & {
    readonly method: JsonRpcMethod<Name>;
    readonly params: Schema.Schema.Type<P>;
  };
}
