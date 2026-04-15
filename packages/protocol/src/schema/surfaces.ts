import { Type, type Static } from "@sinclair/typebox";
import { DateTimeString } from "../helpers.js";
import { ConversationId, AgentId } from "./primitives.js";

export const SurfaceSpecSchema = Type.Object(
  {
    root: Type.String(),
    elements: Type.Record(Type.String(), Type.Unknown()),
    state: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const SurfaceUpdateParamsSchema = Type.Object(
  {
    conversationId: ConversationId,
    title: Type.String({ minLength: 1, maxLength: 256 }),
    spec: SurfaceSpecSchema,
  },
  { additionalProperties: false },
);

export const SurfaceGetParamsSchema = Type.Object(
  {
    conversationId: ConversationId,
  },
  { additionalProperties: false },
);

export const SurfaceActionParamsSchema = Type.Object(
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
);

export const SurfaceClearParamsSchema = Type.Object(
  {
    conversationId: ConversationId,
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

export type SurfaceUpdateParams = Static<typeof SurfaceUpdateParamsSchema>;
export type SurfaceGetParams = Static<typeof SurfaceGetParamsSchema>;
export type SurfaceActionParams = Static<typeof SurfaceActionParamsSchema>;
export type SurfaceClearParams = Static<typeof SurfaceClearParamsSchema>;
export type Surface = Static<typeof SurfaceSchema>;
