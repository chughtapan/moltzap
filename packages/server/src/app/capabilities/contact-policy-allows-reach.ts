import { Context, Effect } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import { ConversationServiceTag } from "../layers.js";
import type { ConversationServiceError } from "../../task/services/conversation.service.js";
import { catchSqlErrorAsDefect } from "../../db/effect-kysely-toolkit.js";

/**
 * Tier 3 capability — caller-side contact policy permits creator →
 * targets reach. Single capability covering the family of policy checks
 * (`requireContactPolicyForCreate`, `requireAddParticipantContactPolicy`,
 * `requireCreatorContactsAll`, `checkContactEdge`).
 *
 * The composite is intentional (Spec E §Non-goals #6): four legacy
 * helpers survive as `@internal` implementation details of two `obtain`
 * smart constructors.
 *
 * Value payload carries the resolved `(creatorAgentId, targetAgentIds)`
 * tuple so service methods don't re-derive who the policy was checked
 * against.
 */
export interface ContactPolicyAllowsReachValue {
  readonly creatorAgentId: AgentId;
  readonly targetAgentIds: readonly AgentId[];
}

export class ContactPolicyAllowsReach extends Context.Tag(
  "@moltzap/server/ContactPolicyAllowsReach",
)<ContactPolicyAllowsReach, ContactPolicyAllowsReachValue>() {}

/**
 * Smart constructor for `TaskCreate` / `ConversationCreate` flows.
 *
 * Wraps (does not re-implement) the existing named service gate
 * `ConversationService.requireContactPolicyForCreate` — Phase 1
 * narrows the gate's signature to `(creatorAgentId, targetAgentIds,
 * pathType, ownerByAgentId)` so the obtain helper delegates without a
 * `mintTask: Effect.never as never` synthesis shim. Single source of
 * truth for the create-side contact-policy fan-out: the service caller
 * inside `createConversationEffect` and the obtain helper both call
 * this method.
 *
 * Error channel propagates the underlying helpers' failure modes:
 *   - `NotInContactsError` — caller's contact policy rejects a target
 *   - `NotFoundError` — a referenced `agents` row is missing
 *   - `ForbiddenError` — generic policy denial
 *   - `InvalidParamsError` — DM-arity / shape mismatch
 *
 * `SqlError` from the underlying contact-edge lookups is caught
 * defectively inside the service helpers.
 */
export const obtainContactPolicyForCreate = (
  creatorAgentId: AgentId,
  targetAgentIds: readonly AgentId[],
  type: "dm" | "group" = "group",
): Effect.Effect<
  ContactPolicyAllowsReachValue,
  ConversationServiceError,
  ConversationServiceTag
> =>
  catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const conversations = yield* ConversationServiceTag;
      const ownerByAgentId =
        yield* conversations.requireAgentsExist(targetAgentIds);
      yield* conversations.requireContactPolicyForCreate(
        creatorAgentId,
        targetAgentIds,
        type,
        ownerByAgentId,
      );
      return { creatorAgentId, targetAgentIds };
    }),
  ).pipe(Effect.withSpan("obtainContactPolicyForCreate"));

/**
 * Smart constructor for `TaskConversationAddParticipant` (D1) /
 * `ConversationAddParticipant` flows.
 *
 * Wraps the existing named service gate
 * `ConversationService.requireAddParticipantContactPolicy` — Phase 1
 * narrows the gate's signature to `(requesterAgentId, targetAgentId,
 * targetOwnerUserId)` so the obtain helper delegates without
 * synthesizing an `AddParticipantOptions` shim with a placeholder
 * `conversationId`. Single source of truth: the service caller inside
 * `addParticipantEffect` and the obtain helper both call this method.
 *
 * Error channel matches `obtainContactPolicyForCreate` (same underlying
 * fan-out).
 */
export const obtainContactPolicyForAdd = (
  creatorAgentId: AgentId,
  targetAgentId: AgentId,
): Effect.Effect<
  ContactPolicyAllowsReachValue,
  ConversationServiceError,
  ConversationServiceTag
> =>
  catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const conversations = yield* ConversationServiceTag;
      const ownerByAgentId = yield* conversations.requireAgentsExist([
        targetAgentId,
      ]);
      const targetOwnerUserId = ownerByAgentId.get(targetAgentId) ?? null;
      yield* conversations.requireAddParticipantContactPolicy(
        creatorAgentId,
        targetAgentId,
        targetOwnerUserId,
      );
      return { creatorAgentId, targetAgentIds: [targetAgentId] };
    }),
  ).pipe(Effect.withSpan("obtainContactPolicyForAdd"));
