import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId, TaskId } from "@moltzap/protocol/task";
import type { Effect } from "effect";

type ContactPolicyCheck = (
  ownerUserIdA: string,
  ownerUserIdB: string,
) => Effect.Effect<boolean, never>;

export type ContactPolicyResolver = () => ContactPolicyCheck | null;
export type ConversationArchiveFilter = "exclude" | "include" | "only";

export interface ListRow {
  readonly id: ConversationId;
  readonly name: string | null;
  readonly updated_at: Date;
  readonly has_last_message: boolean;
  readonly last_message_at: Date | null;
  readonly unread_count: number;
}

export interface ConversationColumns {
  readonly id: ConversationId;
  readonly name: string | null;
  readonly created_by_id: AgentId;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly archived_at: Date | null;
}

export interface CreateConversationOptions<TaskMintError = never> {
  readonly name: string | undefined;
  readonly agentIds: ReadonlyArray<AgentId>;

  /**
   * Creator-of-record FK (`conversations.created_by_id`). For the
   * agent-originated `task/request → mintInitialConversation` path this
   * is the requesting agent (who IS a participant). For the
   * app-originated `task/conversation/create` path (D #705 R3) this is
   * `task.initiatorAgentId` — the agent that sent the initial
   * `task/request` — and is NOT seeded as a participant (see
   * {@link seedCreatorAsParticipant}). Either way the FK stays a valid
   * `AgentId` referencing `agents`, so no schema migration.
   */
  readonly creatorAgentId: AgentId;

  /**
   * Whether the creator is auto-seeded into `conversation_participants`
   * (and subscribed). Defaults to `true` for the agent path. The
   * app-originated `task/conversation/create` path passes `false`:
   * participants = exactly `params.participants`, never the
   * TM-backing-agent creator-of-record (D #705 R3 — fixes the latent
   * "creator silently added as a member" bug).
   */
  readonly seedCreatorAsParticipant?: boolean;
  readonly mintTask: Effect.Effect<{ id: TaskId }, TaskMintError>;
}

export interface CreatorContactPolicyInput {
  readonly creatorAgentId: AgentId;
  readonly targetAgentIds: ReadonlyArray<AgentId>;
  readonly ownerByAgentId: ReadonlyMap<AgentId, string | null>;
  readonly policy: ContactPolicyCheck;
}

export interface ContactEdgeInput {
  readonly requesterAgentId: AgentId;
  readonly requesterOwnerUserId: string | null;
  readonly targetAgentId: AgentId;
  readonly targetOwnerUserId: string | null;
  readonly policy: ContactPolicyCheck;
}
