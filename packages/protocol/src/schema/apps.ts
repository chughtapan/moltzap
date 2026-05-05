import { Type, type Static } from "@sinclair/typebox";
import { stringEnum } from "../helpers.js";

export const AppManifestConversationSchema = Type.Object(
  {
    key: Type.String(),
    name: Type.String(),
    participantFilter: Type.Optional(stringEnum(["all", "initiator", "none"])),
  },
  { additionalProperties: false },
);

/**
 * Per-hook configuration entry. All five lifecycle hooks share the same
 * shape — only `timeout_ms` is configurable today.
 */
const HookEntrySchema = Type.Object(
  {
    timeout_ms: Type.Optional(Type.Integer({ default: 5000, minimum: 1 })),
  },
  { additionalProperties: false },
);

export const AppManifestSchema = Type.Object(
  {
    appId: Type.String(),
    name: Type.String(),
    description: Type.Optional(Type.String()),
    limits: Type.Optional(
      Type.Object(
        {
          maxParticipants: Type.Optional(Type.Integer({ default: 50 })),
        },
        { additionalProperties: false },
      ),
    ),
    conversations: Type.Optional(Type.Array(AppManifestConversationSchema)),
    hooks: Type.Optional(
      Type.Object(
        {
          before_message_delivery: Type.Optional(HookEntrySchema),
          before_dispatch: Type.Optional(HookEntrySchema),
          on_close: Type.Optional(HookEntrySchema),
          on_session_active: Type.Optional(HookEntrySchema),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type AppManifest = Static<typeof AppManifestSchema>;
export type AppManifestConversation = Static<
  typeof AppManifestConversationSchema
>;
