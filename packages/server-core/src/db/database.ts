// @generated — thin wrapper over kysely-codegen output for core schema.
// Run `pnpm db:generate` after changing src/app/core-schema.sql.

import type { Insertable, Selectable, Updateable } from "kysely";
import type {
  Agents,
  ConversationKeys,
  ConversationParticipants,
  Conversations,
  EncryptionKeys,
  MessageDelivery,
  Messages,
  Reactions,
  Users,
} from "./database.generated.js";

// Re-export enum types
export type {
  AgentStatus,
  ConversationType,
  DeliveryStatus,
  EncryptionKeyStatus,
  ParticipantRole,
  ParticipantType,
  UserStatus,
} from "./database.generated.js";

// Re-export table interfaces
export type {
  Agents,
  ConversationKeys,
  ConversationParticipants,
  Conversations,
  EncryptionKeys,
  MessageDelivery,
  Messages,
  Reactions,
  Users,
} from "./database.generated.js";

// Selectable / Insertable / Updateable aliases
export type UserRow = Selectable<Users>;
export type NewUser = Insertable<Users>;
export type UserUpdate = Updateable<Users>;

export type AgentRow = Selectable<Agents>;
export type NewAgent = Insertable<Agents>;
export type AgentUpdate = Updateable<Agents>;

export type ConversationRow = Selectable<Conversations>;
export type NewConversation = Insertable<Conversations>;
export type ConversationUpdate = Updateable<Conversations>;

export type ConversationParticipantRow = Selectable<ConversationParticipants>;
export type NewConversationParticipant = Insertable<ConversationParticipants>;
export type ConversationParticipantUpdate =
  Updateable<ConversationParticipants>;

export type MessageRow = Selectable<Messages>;
export type NewMessage = Insertable<Messages>;
export type MessageUpdate = Updateable<Messages>;

export type MessageDeliveryRow = Selectable<MessageDelivery>;
export type NewMessageDelivery = Insertable<MessageDelivery>;
export type MessageDeliveryUpdate = Updateable<MessageDelivery>;

export type ReactionRow = Selectable<Reactions>;
export type NewReaction = Insertable<Reactions>;

export type EncryptionKeyRow = Selectable<EncryptionKeys>;
export type NewEncryptionKey = Insertable<EncryptionKeys>;
export type EncryptionKeyUpdate = Updateable<EncryptionKeys>;

export type ConversationKeyRow = Selectable<ConversationKeys>;
export type NewConversationKey = Insertable<ConversationKeys>;
export type ConversationKeyUpdate = Updateable<ConversationKeys>;

// Database interface (core tables only — no contacts, invites, push, surfaces)
export interface Database {
  users: Users;
  agents: Agents;
  conversations: Conversations;
  conversation_participants: ConversationParticipants;
  messages: Messages;
  message_delivery: MessageDelivery;
  reactions: Reactions;
  encryption_keys: EncryptionKeys;
  conversation_keys: ConversationKeys;
}
