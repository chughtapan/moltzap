import { Context, Effect } from "effect";
import type { Conversation } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import { ConversationServiceTag } from "../layers.js";
import type { ConversationServiceError } from "../../task/services/conversation.service.js";
import { catchSqlErrorAsDefect } from "../../db/effect-kysely-toolkit.js";

/**
 * Composite capability for `ConversationService.create` — Architect
 * plan #606 r3 Decision C.
 *
 * Today's `createConversationEffect` runs the DM-dedup short-circuit
 * BEFORE the contact-policy + group-capacity gates:
 *
 *     ownerByAgentId    = loadAgentOwners(agentIds)
 *     existingDm        = existingDmForCreate(input)
 *     if (existingDm !== null) return existingDm    // ← short-circuit
 *     assertContactPolicyForCreate(...)
 *     assertGroupCapacityForCreate(...)
 *     task              = yield* input.mintTask     // ← lazy mint (#464)
 *
 * The naive "handler provides each gate's capability" migration forces
 * the policy + capacity obtain to run BEFORE the service knows whether
 * dedup will short-circuit. That wastes DB work on the dedup-hit path
 * (the majority case for high-traffic DM creates) and shifts behavior
 * (a dedup hit would now fail-closed if the contact policy was revoked
 * between original create and now).
 *
 * The composite restores the short-circuit AT THE HANDLER TIER. The
 * obtain helper runs the dedup check FIRST and returns `ExistingDm`
 * with the existing row; otherwise it runs the policy + capacity gates
 * and returns `PermittedToCreate { ownerByAgentId }`. Lazy `mintTask`
 * stays in the service body (PermittedToCreate branch), so it never
 * runs on a dedup hit. See plan §3 Decision C for the full rationale.
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
  "@moltzap/server/ConversationCreateAuthorization",
)<ConversationCreateAuthorization, ConversationCreateAuthorizationValue>() {}

export interface ObtainConversationCreateAuthorizationInput {
  readonly type: "dm" | "group";
  readonly agentIds: ReadonlyArray<AgentId>;
  readonly creatorAgentId: AgentId;
}

/**
 * Smart constructor for `ConversationsCreate`. Reaches into
 * `ConversationService` via the service Tag to:
 *  1. Load `ownerByAgentId` via `loadAgentOwners` (NotFound if any
 *     agent missing).
 *  2. Check for an existing DM via `existingDmForCreate` (DM-arity
 *     invariants enforced inside the helper). Returns `ExistingDm`
 *     when found; this is the short-circuit branch.
 *  3. Otherwise: run the contact-policy and group-capacity gates and
 *     return `PermittedToCreate { ownerByAgentId }`.
 */
export const obtainConversationCreateAuthorization = (
  input: ObtainConversationCreateAuthorizationInput,
): Effect.Effect<
  ConversationCreateAuthorizationValue,
  ConversationServiceError,
  ConversationServiceTag
> =>
  catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const conversations = yield* ConversationServiceTag;
      const ownerByAgentId = yield* conversations.loadAgentOwners(
        input.agentIds,
      );
      const existingDm = yield* conversations.existingDmForCreate({
        type: input.type,
        agentIds: input.agentIds,
        creatorAgentId: input.creatorAgentId,
      });
      if (existingDm !== null) {
        return { _tag: "ExistingDm" as const, conversation: existingDm };
      }
      yield* conversations.assertContactPolicyForCreate(
        input.creatorAgentId,
        input.agentIds,
        input.type,
        ownerByAgentId,
      );
      yield* conversations.assertGroupCapacityForCreate(
        input.type,
        input.agentIds,
      );
      return { _tag: "PermittedToCreate" as const, ownerByAgentId };
    }),
  ).pipe(Effect.withSpan("obtainConversationCreateAuthorization"));
