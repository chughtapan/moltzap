import { Type, type Static } from "@sinclair/typebox";
import { RpcErrorSchema } from "./errors.js";

export const RequestFrameSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    type: Type.Literal("request"),
    id: Type.String(),
    method: Type.String(),
    params: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const ResponseFrameSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    type: Type.Literal("response"),
    id: Type.String(),
    result: Type.Optional(Type.Unknown()),
    error: Type.Optional(RpcErrorSchema),
  },
  { additionalProperties: false },
);

export const EventFrameSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    type: Type.Literal("event"),
    event: Type.String(),
    data: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export type RequestFrame = Static<typeof RequestFrameSchema>;
export type ResponseFrame = Static<typeof ResponseFrameSchema>;
export type EventFrame = Static<typeof EventFrameSchema>;
