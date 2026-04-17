import { Type, type Static } from "@sinclair/typebox";
import { stringEnum } from "../../helpers.js";
import { defineRpc } from "../../rpc.js";

export const PushRegister = defineRpc({
  name: "push/register",
  params: Type.Object(
    {
      deviceToken: Type.String(),
      platform: stringEnum(["web", "ios", "android"]),
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

export const PushUnregister = defineRpc({
  name: "push/unregister",
  params: Type.Object(
    {
      deviceToken: Type.String(),
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

/**
 * Shape schema used by clients to express push preferences. Not an RPC method —
 * kept here because the `validators` table treats it like one.
 */
export const PushPreferencesSchema = Type.Object(
  {
    messages: Type.Boolean(),
    contactsAndInvites: Type.Boolean(),
    agentUpdates: Type.Boolean(),
  },
  { additionalProperties: false },
);

// PushPreferences is a shared shape (not an RPC manifest), so it retains a
// public type alongside its schema.
export type PushPreferences = Static<typeof PushPreferencesSchema>;
