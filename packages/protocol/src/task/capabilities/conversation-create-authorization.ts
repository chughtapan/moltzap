import { Context } from "effect";
import type { Conversation } from "../conversations.js";
import type { AgentId } from "../../identity/index.js";

/**
 * Composite capability for `ConversationService.create` — Architect
 * plan #606 r3 Decision C.
 *
 * The composite restores the DM-dedup short-circuit AT THE HANDLER
 * TIER: the obtain helper runs the dedup check FIRST and returns
 * `ExistingDm` with the existing row; otherwise it runs the policy +
 * capacity gates and returns `PermittedToCreate { ownerByAgentId }`.
 * Lazy `mintTask` stays in the service body (PermittedToCreate branch),
 * so it never runs on a dedup hit.
 */
export type ConversationCreateAuthorizationValue =
  | {
      readonly _tag: "ExistingDm";
      readonly conversation: Conversation;
    }
  | {
      readonly _tag: "PermittedToCreate";
      readonly ownerByAgentId: ReadonlyMap<AgentId, string | null>;
    };

export class ConversationCreateAuthorization extends Context.Tag(
  "@moltzap/protocol/ConversationCreateAuthorization",
)<ConversationCreateAuthorization, ConversationCreateAuthorizationValue>() {}

export interface ObtainConversationCreateAuthorizationInput {
  readonly type: "dm" | "group";
  readonly agentIds: ReadonlyArray<AgentId>;
  readonly creatorAgentId: AgentId;
}
