import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { stringEnum, brandedId, DateTimeString } from "../helpers.js";
import { AgentId, ConversationId } from "./primitives.js";

export const AppSessionId = brandedId("AppSessionId");
export const appSessionId = (value: string): Static<typeof AppSessionId> =>
  Value.Decode(AppSessionId, value);

export const AppParticipantStatusEnum = stringEnum([
  "pending",
  "admitted",
  "rejected",
]);

export const AppPermissionSchema = Type.Object(
  {
    resource: Type.String(),
    access: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

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
    permissions: Type.Object(
      {
        required: Type.Array(AppPermissionSchema),
        optional: Type.Array(AppPermissionSchema),
      },
      { additionalProperties: false },
    ),
    skillUrl: Type.Optional(Type.String()),
    skillMinVersion: Type.Optional(Type.String()),
    challengeTimeoutMs: Type.Optional(Type.Integer({ default: 30000 })),
    permissionTimeoutMs: Type.Optional(Type.Integer({ default: 120000 })),
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
          on_join: Type.Optional(HookEntrySchema),
          on_close: Type.Optional(HookEntrySchema),
          on_session_active: Type.Optional(HookEntrySchema),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const AppSessionSchema = Type.Object(
  {
    id: AppSessionId,
    appId: Type.String(),
    initiatorAgentId: AgentId,
    status: stringEnum(["waiting", "active", "failed", "closed"]),
    conversations: Type.Record(Type.String(), ConversationId),
    createdAt: DateTimeString,
    closedAt: Type.Optional(DateTimeString),
  },
  { additionalProperties: false },
);

export type AppPermission = Static<typeof AppPermissionSchema>;
export type AppManifest = Static<typeof AppManifestSchema>;
export type AppManifestConversation = Static<
  typeof AppManifestConversationSchema
>;
export type AppSession = Static<typeof AppSessionSchema>;
export type AppParticipantStatus = Static<typeof AppParticipantStatusEnum>;
