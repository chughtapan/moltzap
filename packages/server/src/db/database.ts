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
} from "./database.generated.js";

// Re-export enum types
export type {
  AgentStatus,
  ConversationType,
  DeliveryStatus,
  EncryptionKeyStatus,
  ParticipantRole,
} from "./database.generated.js";

// App-specific types (hand-written — not in generated file until kysely-codegen runs)
export type AppSessionStatus = "waiting" | "active" | "closed";
export type AppParticipantDbStatus = "pending" | "admitted" | "rejected";

import type { Generated, Timestamp } from "./database.generated.js";

export interface AppSessions {
  id: Generated<string>;
  app_id: string;
  initiator_agent_id: string;
  status: Generated<AppSessionStatus>;
  closed_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface AppSessionParticipants {
  session_id: string;
  agent_id: string;
  status: Generated<AppParticipantDbStatus>;
  rejection_reason: string | null;
  admitted_at: Timestamp | null;
  updated_at: Generated<Timestamp>;
}

export interface AppSessionConversations {
  session_id: string;
  conversation_key: string;
  conversation_id: string;
}

export interface AppPermissionGrants {
  id: Generated<string>;
  user_id: string;
  app_id: string;
  resource: string;
  access: string[];
  granted_at: Generated<Timestamp>;
}

// Re-export table interfaces
export type {
  Agents,
  ConversationKeys,
  ConversationParticipants,
  Conversations,
  EncryptionKeys,
  MessageDelivery,
  Messages,
} from "./database.generated.js";

// Selectable / Insertable / Updateable aliases
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

export type EncryptionKeyRow = Selectable<EncryptionKeys>;
export type NewEncryptionKey = Insertable<EncryptionKeys>;
export type EncryptionKeyUpdate = Updateable<EncryptionKeys>;

export type ConversationKeyRow = Selectable<ConversationKeys>;
export type NewConversationKey = Insertable<ConversationKeys>;
export type ConversationKeyUpdate = Updateable<ConversationKeys>;

export type AppSessionRow = Selectable<AppSessions>;
export type NewAppSession = Insertable<AppSessions>;

export type AppSessionParticipantRow = Selectable<AppSessionParticipants>;
export type NewAppSessionParticipant = Insertable<AppSessionParticipants>;

export type AppSessionConversationRow = Selectable<AppSessionConversations>;
export type NewAppSessionConversation = Insertable<AppSessionConversations>;

export type AppPermissionGrantRow = Selectable<AppPermissionGrants>;
export type NewAppPermissionGrant = Insertable<AppPermissionGrants>;

// Database interface (core tables only — no contacts, invites, push, surfaces)
export interface Database {
  agents: Agents;
  conversations: Conversations;
  conversation_participants: ConversationParticipants;
  messages: Messages;
  message_delivery: MessageDelivery;
  encryption_keys: EncryptionKeys;
  conversation_keys: ConversationKeys;
  app_sessions: AppSessions;
  app_session_participants: AppSessionParticipants;
  app_session_conversations: AppSessionConversations;
  app_permission_grants: AppPermissionGrants;
}
