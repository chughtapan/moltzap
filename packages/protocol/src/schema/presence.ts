import { Type, type Static } from "@sinclair/typebox";
import { stringEnum } from "../helpers.js";
import { ParticipantRefSchema } from "./identity.js";

export const PresenceStatusEnum = stringEnum(["online", "offline", "away"]);

export const PresenceEntrySchema = Type.Object(
  {
    participant: ParticipantRefSchema,
    status: PresenceStatusEnum,
  },
  { additionalProperties: false },
);

export type PresenceEntry = Static<typeof PresenceEntrySchema>;
