import { Type, type Static } from "@sinclair/typebox";
import { DateTimeString } from "../helpers.js";
import { ConversationId, AgentId } from "./primitives.js";
import { defineRpc } from "../rpc.js";

export const SurfaceSpecSchema = Type.Object(
  {
    root: Type.String(),
    elements: Type.Record(Type.String(), Type.Unknown()),
    state: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const SurfaceSchema = Type.Object(
  {
    conversationId: ConversationId,
    title: Type.String(),
    spec: SurfaceSpecSchema,
    updatedBy: AgentId,
    updatedAt: DateTimeString,
    version: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// RpcDefinition manifests.
// ---------------------------------------------------------------------------

export const SurfaceUpdate = defineRpc({
  name: "surface/update",
  params: Type.Object(
    {
      conversationId: ConversationId,
      title: Type.String({ minLength: 1, maxLength: 256 }),
      spec: SurfaceSpecSchema,
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

export const SurfaceGet = defineRpc({
  name: "surface/get",
  params: Type.Object(
    {
      conversationId: ConversationId,
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { surface: Type.Union([SurfaceSchema, Type.Null()]) },
    { additionalProperties: false },
  ),
});

export const SurfaceAction = defineRpc({
  name: "surface/action",
  params: Type.Object(
    {
      conversationId: ConversationId,
      action: Type.Object(
        {
          name: Type.String({ minLength: 1, maxLength: 128 }),
          payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

export const SurfaceClear = defineRpc({
  name: "surface/clear",
  params: Type.Object(
    {
      conversationId: ConversationId,
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

// `Surface` is the shared shape schema (not an RPC manifest), so its type
// alias stays public for downstream consumers.
export type Surface = Static<typeof SurfaceSchema>;
