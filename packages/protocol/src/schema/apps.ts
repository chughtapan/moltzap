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
 * Per-hook configuration entry. The lone surviving hook entry post
 * Phase 9b is `task_authorize_dispatch`; only `timeout_ms` is
 * configurable today.
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
    // Phase 9b consumer-migration (sub-issue #460, plan §2.4): the
    // four-verb appCallback group retired; only `task/authorizeDispatch`
    // (renamed from `apps/onBeforeDispatch`) survives. The
    // `before_message_delivery`, `on_close`, and `on_session_active`
    // hook keys retired with their wire RPCs; `before_dispatch` was
    // renamed to `task_authorize_dispatch` so the manifest key matches
    // the new wire RPC.
    hooks: Type.Optional(
      Type.Object(
        {
          task_authorize_dispatch: Type.Optional(HookEntrySchema),
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
