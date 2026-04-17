import { Type, type Static } from "@sinclair/typebox";
import { stringEnum, brandedId, DateTimeString } from "../helpers.js";
import { AgentId, ConversationId } from "./primitives.js";

export const AppSessionId = brandedId("AppSessionId");

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
          before_message_delivery: Type.Optional(
            Type.Object(
              {
                /**
                 * Optional HTTPS endpoint. When set the MoltZap server POSTs
                 * hook context to this URL instead of dispatching to an
                 * in-process handler. Body and response shape are documented
                 * in `docs/guides/app-hooks.mdx`.
                 */
                webhook: Type.Optional(Type.String({ format: "uri" })),
                timeout_ms: Type.Optional(
                  Type.Integer({ default: 5000, minimum: 100, maximum: 30000 }),
                ),
              },
              { additionalProperties: false },
            ),
          ),
          on_join: Type.Optional(
            Type.Object(
              {
                webhook: Type.Optional(Type.String({ format: "uri" })),
                timeout_ms: Type.Optional(
                  Type.Integer({ default: 5000, minimum: 100, maximum: 30000 }),
                ),
              },
              { additionalProperties: false },
            ),
          ),
          on_close: Type.Optional(
            Type.Object(
              {
                webhook: Type.Optional(Type.String({ format: "uri" })),
                timeout_ms: Type.Optional(
                  Type.Integer({ default: 5000, minimum: 100, maximum: 30000 }),
                ),
              },
              { additionalProperties: false },
            ),
          ),
          on_session_active: Type.Optional(
            Type.Object(
              {
                webhook: Type.Optional(Type.String({ format: "uri" })),
                timeout_ms: Type.Optional(
                  Type.Integer({ default: 5000, minimum: 100, maximum: 30000 }),
                ),
              },
              { additionalProperties: false },
            ),
          ),
          /**
           * Optional shared secret used to HMAC-SHA256 sign outbound webhook
           * bodies. The signature is sent as `X-MoltZap-Signature:
           * sha256=<hex>`. If unset, webhooks are sent unsigned — apps
           * should only configure webhook URLs on trusted private networks
           * in that case.
           */
          secret: Type.Optional(Type.String()),
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
