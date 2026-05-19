import { Context, Effect } from "effect";
import type { Conversation } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationServiceError } from "../../task/services/conversation.service.js";
import { ConversationServiceTag } from "../layers.js";
import { notImplemented } from "./not-implemented.js";

/**
 * Composite capability for `ConversationService.create` — the load-
 * bearing outcome of **Architect Decision C** in plan #606 (r3
 * amendment).
 *
 * ## Why a composite (and not three sibling tags)?
 *
 * Today's `createConversationEffect` body runs the DM-dedup short-
 * circuit BEFORE the contact-policy + group-capacity gates:
 *
 * ```
 * const ownerByAgentId = yield* loadAgentOwners(input.agentIds);
 * const existingDm = yield* existingDmForCreate(input);
 * if (existingDm !== null) return existingDm;       // ← short-circuit
 * yield* assertContactPolicyForCreate(...);
 * yield* assertGroupCapacityForCreate(...);
 * const task = yield* input.mintTask;               // ← lazy mint (#464)
 * ```
 *
 * A naive handler-provides-each-tag migration would force the policy +
 * capacity obtain to run BEFORE the service body knows whether dedup
 * will short-circuit. That is wasted work on every cache hit AND
 * shifts behavior for revoked-contact cases (today dedup hit returns
 * existing DM even if contact policy revoked; with unconditional
 * policy fan-out the dedup hit would fail).
 *
 * The composite restores the short-circuit AT THE HANDLER TIER: the
 * obtain helper runs the dedup check FIRST, and EITHER returns
 * `ExistingDm(conversation)` (skipping policy + capacity) OR runs the
 * gates and returns `PermittedToCreate{ownerByAgentId}`. The service
 * body destructures on `_tag`: `ExistingDm` short-circuits, `PermittedToCreate`
 * proceeds to mint the task + insert.
 *
 * Lazy `mintTask` (#464) is preserved: it lives in the service body's
 * `PermittedToCreate` branch, NOT in the obtain helper, so it never
 * runs on a dedup hit.
 *
 * ## Shape
 *
 * - `ExistingDm` — DM-dedup hit; `conversation` is the row the service
 *   returns verbatim. `ownerByAgentId` is NOT computed (we never reach
 *   the gates).
 * - `PermittedToCreate` — dedup miss (or non-DM); policy + capacity
 *   gates already passed; `ownerByAgentId` is the resolved owner map
 *   from `loadAgentOwners` (carried forward so the service body's
 *   `insertConversation` does not refetch).
 *
 * The carried `ownerByAgentId` is a payload-reuse optimization. It is
 * NOT used today by `insertConversation`; Phase 3 may consume it in
 * the participant-insert loop if it proves load-bearing.
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

/**
 * Input shape consumed by the dispatch-time smart constructor. Matches
 * `CreateConversationOptions` minus the `mintTask` effect (the obtain
 * never mints; mint happens in the service body's `PermittedToCreate`
 * branch).
 */
export interface ObtainConversationCreateAuthorizationInput {
  readonly type: "dm" | "group";
  readonly name: string | undefined;
  readonly agentIds: ReadonlyArray<AgentId>;
  readonly creatorAgentId: AgentId;
}

/**
 * Architect-stub. Body shape (Phase 3 implements):
 *
 *   const convService = yield* ConversationServiceTag;
 *   const ownerByAgentId = yield* convService.loadAgentOwners(
 *     input.agentIds);
 *   const existingDm = yield* convService.existingDmForCreate({
 *     type: input.type,
 *     agentIds: input.agentIds,
 *     creatorAgentId: input.creatorAgentId,
 *     name: input.name,
 *   });
 *   if (existingDm !== null) {
 *     return { _tag: "ExistingDm", conversation: existingDm };
 *   }
 *   yield* convService.assertContactPolicyForCreate(
 *     input.creatorAgentId,
 *     input.agentIds,
 *     input.type,
 *     ownerByAgentId,
 *   );
 *   yield* convService.assertGroupCapacityForCreate(
 *     input.type,
 *     input.agentIds,
 *   );
 *   return { _tag: "PermittedToCreate", ownerByAgentId };
 *
 * Phase 3 prerequisite: promote `existingDmForCreate` from `private` to
 * `@internal` exported (Decision B / Option A).
 *
 * Error channel — propagates `ConversationService` gate failures:
 *   - `NotFoundError` from `loadAgentOwners`
 *   - `InvalidParamsError` from `existingDmForCreate` (DM agent count)
 *   - `NotInContactsError` from `assertContactPolicyForCreate`
 *   - `ConversationFullError` from `assertGroupCapacityForCreate`
 * All three failures are members of `ConversationServiceError`.
 */
export const obtainConversationCreateAuthorization = (
  _input: ObtainConversationCreateAuthorizationInput,
): Effect.Effect<
  ConversationCreateAuthorizationValue,
  ConversationServiceError,
  ConversationServiceTag
> => notImplemented("obtainConversationCreateAuthorization") as never;
