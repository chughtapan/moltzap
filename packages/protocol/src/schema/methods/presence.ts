import { Type, type Static } from "@sinclair/typebox";
import { PresenceStatusEnum, PresenceEntrySchema } from "../presence.js";
import { ParticipantRefSchema } from "../identity.js";

export const PresenceUpdateParamsSchema = Type.Object(
  { status: PresenceStatusEnum },
  { additionalProperties: false },
);

export const PresenceSubscribeParamsSchema = Type.Object(
  { participants: Type.Array(ParticipantRefSchema) },
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
