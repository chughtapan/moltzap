import Ajv from "ajv";
import addFormats from "ajv-formats";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Brand, Data, Effect } from "effect";
import { brandedString } from "../schema-primitives.js";

// ── AJV ──────────────────────────────────────────────────────────────

/** Single shared AJV instance for the protocol package. Both `defineRpc()`
 * and `defineNotification()` register their TypeBox schemas against this
 * instance, so every wire boundary uses the same compiled validator pool
 * with identical options. The instance itself is not exported because
 * AJV mutates its own `opts` on first compile; the factory exposes only
 * `compile`, sealed inside the closure. */
const ajvInstance = addFormats(new Ajv({ strict: true, allErrors: true }));

export const ajv: {
  readonly compile: <T extends TSchema>(
    schema: T,
  ) => (data: unknown) => data is Static<T>;
} = Object.freeze({
  compile: <T extends TSchema>(
    schema: T,
  ): ((data: unknown) => data is Static<T>) => {
    const validate = ajvInstance.compile<Static<T>>(schema);
    return (data: unknown): data is Static<T> => validate(data);
  },
});

// ── JSON-RPC ids and methods ─────────────────────────────────────────

export const JSON_RPC_VERSION = "2.0" as const;

const JsonRpcIdSchema = brandedString("JsonRpcId");
const JsonRpcMethodSchema = brandedString("JsonRpcMethod", {
  minLength: 1,
});

export type JsonRpcId = Static<typeof JsonRpcIdSchema>;
export type JsonRpcMethod<Name extends string = string> = Name &
  Brand.Brand<"JsonRpcMethod">;

const JsonRpcMethodBrand = Brand.nominal<JsonRpcMethod>();

/** Internal factory for descriptor construction (`defineRpc`,
 * `defineNotification`). Not on the package barrel — callers pass plain
 * strings to frame builders, which brand internally. */
export const jsonRpcMethod = <const Name extends string>(
  method: Name,
): JsonRpcMethod<Name> => JsonRpcMethodBrand(method) as JsonRpcMethod<Name>;

const JsonRpcIdBrand = Brand.nominal<JsonRpcId>();

// ── Wire error envelope schema ───────────────────────────────────────

const RpcErrorSchema = Type.Object(
  {
    code: Type.Integer(),
    message: Type.String(),
    data: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

// ── Frame schemas ────────────────────────────────────────────────────

const ResponseIdSchema = Type.Union([JsonRpcIdSchema, Type.Null()]);

export const RequestFrameSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: JsonRpcIdSchema,
    method: JsonRpcMethodSchema,
    params: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const ResponseFrameSchema = Type.Union([
  Type.Object(
    {
      jsonrpc: Type.Literal("2.0"),
      id: ResponseIdSchema,
      result: Type.Unknown(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      jsonrpc: Type.Literal("2.0"),
      id: ResponseIdSchema,
      error: RpcErrorSchema,
    },
    { additionalProperties: false },
  ),
]);

export const NotificationFrameSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    method: JsonRpcMethodSchema,
    params: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export type RequestFrame = Static<typeof RequestFrameSchema>;
export type ResponseFrame = Static<typeof ResponseFrameSchema>;
export type NotificationFrame = Static<typeof NotificationFrameSchema>;

export const validateRequestFrame = ajv.compile(RequestFrameSchema) as (
  v: unknown,
) => v is RequestFrame;
export const validateResponseFrame = ajv.compile(ResponseFrameSchema) as (
  v: unknown,
) => v is ResponseFrame;
export const validateNotificationFrame = ajv.compile(
  NotificationFrameSchema,
) as (v: unknown) => v is NotificationFrame;

// ── Frame decoder + builders ─────────────────────────────────────────

export type DecodedFrame =
  | { readonly _tag: "Request"; readonly frame: RequestFrame }
  | { readonly _tag: "Response"; readonly frame: ResponseFrame }
  | { readonly _tag: "Notification"; readonly frame: NotificationFrame };

export class FrameDecodeError extends Data.TaggedError("FrameDecodeError")<{
  readonly raw: unknown;
  readonly id: JsonRpcId | null;
}> {}

export function decodeFrame(
  parsed: unknown,
): Effect.Effect<DecodedFrame, FrameDecodeError> {
  if (validateRequestFrame(parsed))
    return Effect.succeed({ _tag: "Request", frame: parsed });
  if (validateResponseFrame(parsed))
    return Effect.succeed({ _tag: "Response", frame: parsed });
  if (validateNotificationFrame(parsed))
    return Effect.succeed({ _tag: "Notification", frame: parsed });
  const idValue = (parsed as { id?: unknown } | null)?.id;
  const id = typeof idValue === "string" ? (idValue as JsonRpcId) : null;
  return Effect.fail(new FrameDecodeError({ raw: parsed, id }));
}

// `RpcDefinition` and `NotificationDefinition` live in `./method.ts` (one
// import cycle below); the frame builders take `definition.name` only and
// don't need the full descriptor surface. Importing the types lazily here
// avoids the cycle.
import type { RpcDefinition, NotificationDefinition } from "./method.js";

export function requestFrame<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
>(
  id: string,
  definition: RpcDefinition<Name, P, R>,
  params: Static<P>,
): RequestFrame & {
  readonly method: JsonRpcMethod<Name>;
  readonly params: Static<P>;
} {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id: JsonRpcIdBrand(id),
    method: definition.name,
    params,
  } as RequestFrame & {
    readonly method: JsonRpcMethod<Name>;
    readonly params: Static<P>;
  };
}

type ResponseFrameError = {
  code: number;
  message: string;
  data?: unknown;
};
export type ResponseFrameBody =
  | { result: unknown }
  | { error: ResponseFrameError };

export function responseFrame(
  id: string | null,
  body: ResponseFrameBody,
): ResponseFrame {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id: id === null ? null : JsonRpcIdBrand(id),
    ...body,
  } as ResponseFrame;
}

/** Public wire-error response encoder. Constructs a JSON-RPC error
 * response for any wire id (no method binding). Method-tied success
 * responses go through `RpcDefinition.encodeResponse`. */
export function encodeErrorResponse(
  id: JsonRpcId | null,
  error: ResponseFrameError,
): ResponseFrame {
  return responseFrame(id, { error });
}

export function notificationFrame<Name extends string, P extends TSchema>(
  definition: NotificationDefinition<Name, P>,
  params: Static<P>,
): NotificationFrame & {
  readonly method: JsonRpcMethod<Name>;
  readonly params: Static<P>;
} {
  return {
    jsonrpc: JSON_RPC_VERSION,
    method: definition.name,
    params,
  } as NotificationFrame & {
    readonly method: JsonRpcMethod<Name>;
    readonly params: Static<P>;
  };
}
