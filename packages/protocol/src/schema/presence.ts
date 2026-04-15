import { Type, type Static } from "@sinclair/typebox";
import { stringEnum } from "../helpers.js";
import { AgentId } from "./primitives.js";

export const PresenceStatusEnum = stringEnum(["online", "offline", "away"]);

export const PresenceEntrySchema = Type.Object(
  {
    agentId: AgentId,
    status: PresenceStatusEnum,
  },
  { additionalProperties: false },
);

export type PresenceEntry = Static<typeof PresenceEntrySchema>;
