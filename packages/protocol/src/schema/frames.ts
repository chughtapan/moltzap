import { Type, type Static } from "@sinclair/typebox";
import { RpcErrorSchema } from "./errors.js";
import {
  JsonRpcIdSchema,
  JsonRpcMethodSchema,
  JsonRpcStringIdSchema,
} from "./json-rpc.js";
export { JSON_RPC_VERSION, JsonRpcIdSchema } from "./json-rpc.js";

/**
 * JSON-RPC 2.0 Request object. Direction is derived from the local peer role
 * and socket path, not carried on the wire.
 */
export const RequestFrameSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: JsonRpcStringIdSchema,
    method: JsonRpcMethodSchema,
    params: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

/**
 * JSON-RPC 2.0 Response object. Success and error are modeled as a union so
 * a well-typed response cannot carry both `result` and `error`.
 */
export const ResponseFrameSchema = Type.Union([
  Type.Object(
    {
      jsonrpc: Type.Literal("2.0"),
      id: JsonRpcIdSchema,
      result: Type.Unknown(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      jsonrpc: Type.Literal("2.0"),
      id: JsonRpcIdSchema,
      error: RpcErrorSchema,
    },
    { additionalProperties: false },
  ),
]);

/**
 * JSON-RPC 2.0 Notification object. MoltZap notification delivery uses this
 * shape: the notification name is the JSON-RPC `method`, and the payload is
 * `params`.
 */
export const NotificationFrameSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    method: JsonRpcMethodSchema,
    params: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

declare const frameBrand: unique symbol;
type FrameBrand<Kind extends string> = { readonly [frameBrand]: Kind };

type RawRequestFrame = Static<typeof RequestFrameSchema>;
type RawResponseFrame = Static<typeof ResponseFrameSchema>;
type RawNotificationFrame = Static<typeof NotificationFrameSchema>;

export type RequestFrame = RawRequestFrame & FrameBrand<"RequestFrame">;
export type ResponseFrame = RawResponseFrame & FrameBrand<"ResponseFrame">;
export type NotificationFrame = RawNotificationFrame &
  FrameBrand<"NotificationFrame">;
