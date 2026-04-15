import { Type, type Static } from "@sinclair/typebox";
import { PresenceStatusEnum, PresenceEntrySchema } from "../presence.js";
import { AgentId } from "../primitives.js";

export const PresenceUpdateParamsSchema = Type.Object(
  { status: PresenceStatusEnum },
  { additionalProperties: false },
);

export const PresenceSubscribeParamsSchema = Type.Object(
  { agentIds: Type.Array(AgentId) },
  { additionalProperties: false },
);

export const PresenceSubscribeResultSchema = Type.Object(
  { statuses: Type.Array(PresenceEntrySchema) },
  { additionalProperties: false },
);

export type PresenceUpdateParams = Static<typeof PresenceUpdateParamsSchema>;
export type PresenceSubscribeParams = Static<
  typeof PresenceSubscribeParamsSchema
>;
export type PresenceSubscribeResult = Static<
  typeof PresenceSubscribeResultSchema
>;
