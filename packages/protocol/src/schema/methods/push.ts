import { Type, type Static } from "@sinclair/typebox";
import { stringEnum } from "../../helpers.js";

export const PushRegisterParamsSchema = Type.Object(
  {
    deviceToken: Type.String(),
    platform: stringEnum(["web", "ios", "android"]),
  },
  { additionalProperties: false },
);

export const PushUnregisterParamsSchema = Type.Object(
  {
    deviceToken: Type.String(),
  },
  { additionalProperties: false },
);

export const PushPreferencesSchema = Type.Object(
  {
    messages: Type.Boolean(),
    contactsAndInvites: Type.Boolean(),
    agentUpdates: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type PushRegisterParams = Static<typeof PushRegisterParamsSchema>;
export type PushUnregisterParams = Static<typeof PushUnregisterParamsSchema>;
export type PushPreferences = Static<typeof PushPreferencesSchema>;
