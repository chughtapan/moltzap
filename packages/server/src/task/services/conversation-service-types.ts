import type { ConversationType } from "../../db/database.js";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId, MessageId, TaskId } from "@moltzap/protocol/task";
import type { Effect } from "effect";

export type ContactPolicyCheck = (
  ownerUserIdA: string,
  ownerUserIdB: string,
) => Effect.Effect<boolean, never>;

export type ContactPolicyResolver = () => ContactPolicyCheck | null;
export type ConversationArchiveFilter = "exclude" | "include" | "only";

export interface ListRow {
  readonly id: ConversationId;
  readonly type: ConversationType;
  readonly name: string | null;
  readonly updated_at: Date;
  readonly has_last_message: boolean;
  readonly last_message_at: Date | null;
  readonly unread_count: number;
}

export interface ConversationColumns {
  readonly id: ConversationId;
  readonly type: ConversationType;
  readonly name: string | null;
  readonly created_by_id: AgentId;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly archived_at: Date | null;
}

export interface ParticipantRow {
  readonly conversation_id: ConversationId;
  readonly agent_id: AgentId;
  readonly joined_at: Date;
  readonly last_read_seq: string;
  readonly muted_until: Date | null;
  readonly agent_name?: string | null;
  readonly agent_display_name?: string | null;
  readonly last_read_message_id?: MessageId | null;
}

export interface CreateConversationOptions<TaskMintError = never> {
  readonly type: "dm" | "group";
  readonly name: string | undefined;
  readonly agentIds: ReadonlyArray<AgentId>;
  readonly creatorAgentId: AgentId;
  readonly mintTask: Effect.Effect<{ id: TaskId }, TaskMintError>;
}

export interface AddParticipantOptions {
  readonly conversationId: ConversationId;
  readonly agentId: AgentId;
  readonly requesterAgentId: AgentId;
}

export interface ParticipantAddedBroadcast {
  readonly conversationId: ConversationId;
  readonly targetAgentIds: readonly AgentId[];
  readonly addedAgentId: AgentId;
  readonly addedBy: AgentId;
  readonly addedAt: Date;
}

export interface ParticipantRemovedBroadcast {
  readonly conversationId: ConversationId;
  readonly targetAgentIds: readonly AgentId[];
  readonly removedAgentId: AgentId;
  readonly removedBy: AgentId;
  readonly removedAt: Date;
}

export interface CreatorContactPolicyInput {
  readonly creatorAgentId: AgentId;
  readonly targetAgentIds: ReadonlyArray<AgentId>;
  readonly ownerByAgentId: ReadonlyMap<AgentId, string | null>;
  readonly policy: ContactPolicyCheck;
  readonly pathLabel: "dm" | "group";
}

export interface ContactEdgeInput {
  readonly requesterAgentId: AgentId;
  readonly requesterOwnerUserId: string | null;
  readonly targetAgentId: AgentId;
  readonly targetOwnerUserId: string | null;
  readonly policy: ContactPolicyCheck;
  readonly pathLabel: "dm" | "group" | "addParticipant";
}

export interface ParticipantInsertResult {
  readonly row: ParticipantRow;
  readonly wasAlreadyMember: boolean;
}
