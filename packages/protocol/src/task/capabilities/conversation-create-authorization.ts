import { Context } from "effect";
import type { AgentId } from "../../identity/index.js";

export interface ConversationCreateAuthorizationValue {
  readonly ownerByAgentId: ReadonlyMap<AgentId, string | null>;
}

export class ConversationCreateAuthorization extends Context.Tag(
  "@moltzap/protocol/ConversationCreateAuthorization",
)<ConversationCreateAuthorization, ConversationCreateAuthorizationValue>() {}

export interface ObtainConversationCreateAuthorizationInput {
  readonly agentIds: ReadonlyArray<AgentId>;
  readonly creatorAgentId: AgentId;
}
