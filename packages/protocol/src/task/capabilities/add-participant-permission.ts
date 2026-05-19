import { Context } from "effect";
import type { ConversationId } from "../conversations.js";
import type { AgentId } from "../../identity/index.js";

/**
 * Single-arm composite capability for `ConversationService.addParticipant`
 * — Architect plan #606 r3 Decision D.
 *
 * Carries the resolved `targetOwnerUserId` so the service body skips
 * the downstream re-fetch (payload reuse parallel to
 * `MessageSendPermission` carrying `task` + `replyTarget`).
 */
export interface AddParticipantPermissionValue {
  readonly conversationId: ConversationId;
  readonly requesterAgentId: AgentId;
  readonly targetAgentId: AgentId;
  readonly targetOwnerUserId: string | null;
}

export class AddParticipantPermission extends Context.Tag(
  "@moltzap/protocol/AddParticipantPermission",
)<AddParticipantPermission, AddParticipantPermissionValue>() {}

export interface ObtainAddParticipantPermissionInput {
  readonly conversationId: ConversationId;
  readonly requesterAgentId: AgentId;
  readonly targetAgentId: AgentId;
}
