import { Data } from "effect";
import { Type, type Static } from "@sinclair/typebox";
import {
  stringEnum,
  dateTimeStringSchema,
  brandedId,
} from "../schema-primitives.js";
import { AgentId } from "../identity/agents.js";
import { defineRpc, defineNotification } from "../transport/method.js";
import {
  registerErrorClass,
  type RpcErrorPayload,
} from "../transport/wire-errors.js";
// Direct per-file imports (NOT via `./capabilities/index.js`) to keep
// the runtime dep graph one-way: the barrel re-exports
// `conversation-not-archived.js` which value-imports
// `ConversationArchivedError` from THIS file, so going via the barrel
// closes a runtime cycle. The capability files this descriptor needs
// only consume conversations.ts as type imports — direct paths skip the
// barrel and the cycle.
import {
  AddParticipantPermission,
  type ObtainAddParticipantPermissionInput,
} from "./capabilities/add-participant-permission.js";
import {
  ConversationCreateAuthorization,
  type ObtainConversationCreateAuthorizationInput,
} from "./capabilities/conversation-create-authorization.js";
import { ConversationParticipantAccess } from "./capabilities/conversation-participant-access.js";

const DateTimeString = dateTimeStringSchema();

export const ConversationId = brandedId("ConversationId");
export type ConversationId = Static<typeof ConversationId>;
// MessageId brand lives here (rather than in messages.ts) to break the
// otherwise-circular `conversations <-> messages` import: the participant
// schema below references MessageId, and messages.ts already references
// ConversationId. Owning the brand at the upstream end keeps the dep
// graph one-way.
export const MessageId = brandedId("MessageId");
export type MessageId = Static<typeof MessageId>;

export class ConversationArchivedError extends Data.TaggedError(
  "ConversationArchived",
)<RpcErrorPayload> {
  static readonly code = -32022;
  static readonly message = "Conversation is archived";
}
registerErrorClass(ConversationArchivedError);

export class ConversationFullError extends Data.TaggedError(
  "ConversationFull",
)<RpcErrorPayload> {
  static readonly code = -32007;
  static readonly message = "Conversation is full";
}
registerErrorClass(ConversationFullError);

export const ConversationTypeEnum = stringEnum(["dm", "group"]);

const AgentParticipantRefSchema = Type.Object(
  {
    type: stringEnum(["agent"]),
    id: Type.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);

const ConversationMetadataSchema = Type.Object(
  {
    tags: Type.Optional(Type.Array(Type.Record(Type.String(), Type.String()))),
  },
  { additionalProperties: false },
);

const ConversationSchema = Type.Object(
  {
    id: ConversationId,
    type: ConversationTypeEnum,
    name: Type.Optional(Type.String()),
    createdBy: AgentId,
    metadata: Type.Optional(ConversationMetadataSchema),
    lastMessageTimestamp: Type.Optional(DateTimeString),
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
    // Spec D1 (#598) — additive field. Present iff the conversation
    // is archived. Clients filter `archivedAt !== undefined` to
    // exclude archived rows from a `TaskConversationList` response
    // (the server returns archived rows unfiltered; the visibility
    // contract for `TaskConversationList` is "caller in
    // `conversation_participants`", not "archived excluded").
    archivedAt: Type.Optional(DateTimeString),
  },
  { additionalProperties: false },
);

const ConversationParticipantSchema = Type.Object(
  {
    conversationId: ConversationId,
    participant: AgentParticipantRefSchema,
    joinedAt: DateTimeString,
    lastReadMessageId: Type.Optional(MessageId),
    mutedUntil: Type.Optional(DateTimeString),
    agentName: Type.Optional(Type.String()),
    agentDisplayName: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const ConversationSummarySchema = Type.Object(
  {
    id: ConversationId,
    type: ConversationTypeEnum,
    name: Type.Optional(Type.String()),
    lastMessagePreview: Type.Optional(Type.String()),
    lastMessageTimestamp: Type.Optional(DateTimeString),
    unreadCount: Type.Integer({ minimum: 0 }),
    metadata: Type.Optional(ConversationMetadataSchema),
    participants: Type.Optional(Type.Array(AgentParticipantRefSchema)),
  },
  { additionalProperties: false },
);

export type Conversation = Static<typeof ConversationSchema>;
export type ConversationParticipant = Static<
  typeof ConversationParticipantSchema
>;
export type ConversationSummary = Static<typeof ConversationSummarySchema>;

export function agentParticipantRefSchema(): typeof AgentParticipantRefSchema {
  return AgentParticipantRefSchema;
}

export function conversationSchema(): typeof ConversationSchema {
  return ConversationSchema;
}

export const ConversationsCreate = defineRpc({
  name: "conversations/create",
  params: Type.Object(
    {
      type: ConversationTypeEnum,
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      participants: Type.Array(AgentParticipantRefSchema, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { conversation: ConversationSchema },
    { additionalProperties: false },
  ),
  capabilities: [
    {
      tag: ConversationCreateAuthorization,
      argsOf: (
        params: unknown,
        ctx: unknown,
      ): ObtainConversationCreateAuthorizationInput => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (Spec F §3 dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as {
          readonly type: "dm" | "group";
          readonly participants: ReadonlyArray<{ readonly id: string }>;
        };
        const c = ctx as { readonly auth: { readonly agentId: AgentId } };
        return {
          type: p.type,
          agentIds: p.participants.map((x) => x.id as AgentId),
          creatorAgentId: c.auth.agentId,
        };
      },
    },
  ] as const,
});

export const ConversationsList = defineRpc({
  name: "conversations/list",
  params: Type.Object(
    {
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      cursor: Type.Optional(Type.String()),
      archived: Type.Optional(stringEnum(["exclude", "include", "only"])),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      conversations: Type.Array(ConversationSummarySchema),
      cursor: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
});

export const ConversationsGet = defineRpc({
  name: "conversations/get",
  params: Type.Object(
    { conversationId: ConversationId },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      conversation: ConversationSchema,
      participants: Type.Array(ConversationParticipantSchema),
    },
    { additionalProperties: false },
  ),
  capabilities: [
    {
      tag: ConversationParticipantAccess,
      argsOf: (params: unknown, ctx: unknown) => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (Spec F §3 dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as { readonly conversationId: ConversationId };
        const c = ctx as { readonly auth: { readonly agentId: AgentId } };
        return {
          conversationId: p.conversationId,
          callerAgentId: c.auth.agentId,
        };
      },
    },
  ] as const,
});

export const ConversationsUpdate = defineRpc({
  name: "conversations/update",
  params: Type.Object(
    {
      conversationId: ConversationId,
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { conversation: ConversationSchema },
    { additionalProperties: false },
  ),
});

export const ConversationsMute = defineRpc({
  name: "conversations/mute",
  params: Type.Object(
    {
      conversationId: ConversationId,
      until: Type.Optional(DateTimeString),
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

export const ConversationsUnmute = defineRpc({
  name: "conversations/unmute",
  params: Type.Object(
    { conversationId: ConversationId },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

export const ConversationsAddParticipant = defineRpc({
  name: "conversations/addParticipant",
  params: Type.Object(
    {
      conversationId: ConversationId,
      participant: AgentParticipantRefSchema,
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { participant: ConversationParticipantSchema },
    { additionalProperties: false },
  ),
  capabilities: [
    {
      tag: AddParticipantPermission,
      argsOf: (
        params: unknown,
        ctx: unknown,
      ): ObtainAddParticipantPermissionInput => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (Spec F §3 dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as {
          readonly conversationId: ConversationId;
          readonly participant: { readonly id: string };
        };
        const c = ctx as { readonly auth: { readonly agentId: AgentId } };
        return {
          conversationId: p.conversationId,
          requesterAgentId: c.auth.agentId,
          targetAgentId: p.participant.id as AgentId,
        };
      },
    },
  ] as const,
});

export const ConversationsRemoveParticipant = defineRpc({
  name: "conversations/removeParticipant",
  params: Type.Object(
    {
      conversationId: ConversationId,
      participant: AgentParticipantRefSchema,
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

export const ConversationsLeave = defineRpc({
  name: "conversations/leave",
  params: Type.Object(
    { conversationId: ConversationId },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

export const ConversationsArchive = defineRpc({
  name: "conversations/archive",
  params: Type.Object(
    { conversationId: ConversationId },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

export const ConversationsUnarchive = defineRpc({
  name: "conversations/unarchive",
  params: Type.Object(
    { conversationId: ConversationId },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

const ConversationCreatedNotificationSchema = Type.Object(
  { conversation: ConversationSchema },
  { additionalProperties: false },
);

const ConversationUpdatedNotificationSchema = Type.Object(
  { conversation: ConversationSchema },
  { additionalProperties: false },
);

const ConversationArchivedNotificationSchema = Type.Object(
  {
    conversationId: ConversationId,
    archivedAt: DateTimeString,
    by: AgentId,
  },
  { additionalProperties: false },
);

const ConversationUnarchivedNotificationSchema = Type.Object(
  {
    conversationId: ConversationId,
    by: AgentId,
  },
  { additionalProperties: false },
);

// Server fan-out when a participant is added (today: `conversations/
// addParticipant` user RPC). Broadcast targets: post-insert participants
// list of the conversation. The added agent's connections are subscribed
// to the conversation in the same operation so the broadcast reaches
// them through the standard `forConversation` gate.
const ParticipantsAddedNotificationSchema = Type.Object(
  {
    conversationId: ConversationId,
    agentId: AgentId,
    addedBy: AgentId,
    addedAt: DateTimeString,
  },
  { additionalProperties: false },
);

// Server fan-out when a participant is removed (today: `conversations/
// removeParticipant` user RPC; future: lease-registry DENY paths).
// Broadcast targets: pre-delete participants list (so the just-removed
// agent receives the notification) WITHOUT the per-conversation
// subscription gate — the removed agent's `conn.conversationIds` is
// cleared in the same operation, so the gate would suppress the event
// for that very recipient.
const ParticipantsRemovedNotificationSchema = Type.Object(
  {
    conversationId: ConversationId,
    agentId: AgentId,
    removedBy: AgentId,
    removedAt: DateTimeString,
  },
  { additionalProperties: false },
);

export type ConversationCreatedNotification = Static<
  typeof ConversationCreatedNotificationSchema
>;
export type ConversationUpdatedNotification = Static<
  typeof ConversationUpdatedNotificationSchema
>;
export type ConversationArchivedNotification = Static<
  typeof ConversationArchivedNotificationSchema
>;
export type ConversationUnarchivedNotification = Static<
  typeof ConversationUnarchivedNotificationSchema
>;
export type ParticipantsAddedNotification = Static<
  typeof ParticipantsAddedNotificationSchema
>;
export type ParticipantsRemovedNotification = Static<
  typeof ParticipantsRemovedNotificationSchema
>;

export const ConversationCreatedNotificationDefinition = defineNotification({
  name: "conversations/created",
  params: ConversationCreatedNotificationSchema,
});

export const ConversationUpdatedNotificationDefinition = defineNotification({
  name: "conversations/updated",
  params: ConversationUpdatedNotificationSchema,
});

export const ConversationArchivedNotificationDefinition = defineNotification({
  name: "conversations/archived",
  params: ConversationArchivedNotificationSchema,
});

export const ConversationUnarchivedNotificationDefinition = defineNotification({
  name: "conversations/unarchived",
  params: ConversationUnarchivedNotificationSchema,
});

export const ParticipantsAddedNotificationDefinition = defineNotification({
  name: "participants/added",
  params: ParticipantsAddedNotificationSchema,
});

export const ParticipantsRemovedNotificationDefinition = defineNotification({
  name: "participants/removed",
  params: ParticipantsRemovedNotificationSchema,
});
