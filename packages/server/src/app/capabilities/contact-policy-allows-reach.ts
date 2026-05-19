import { Effect } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import {
  ContactPolicyAllowsReach,
  type ContactPolicyAllowsReachValue,
} from "@moltzap/protocol/task";
import { ConversationServiceTag } from "../layers.js";
import type { ConversationServiceError } from "../../task/services/conversation.service.js";
import { catchSqlErrorAsDefect } from "../../db/effect-kysely-toolkit.js";

export { ContactPolicyAllowsReach, type ContactPolicyAllowsReachValue };

/**
 * Smart constructor for `TaskCreate` / `ConversationCreate` flows.
 *
 * Wraps (does not re-implement) the existing named service gate
 * `ConversationService.assertContactPolicyForCreate` — Phase 1
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
        yield* conversations.loadAgentOwners(targetAgentIds);
      yield* conversations.assertContactPolicyForCreate(
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
 * `ConversationService.assertAddParticipantContactPolicy` — Phase 1
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
      const ownerByAgentId = yield* conversations.loadAgentOwners([
        targetAgentId,
      ]);
      const targetOwnerUserId = ownerByAgentId.get(targetAgentId) ?? null;
      yield* conversations.assertAddParticipantContactPolicy(
        creatorAgentId,
        targetAgentId,
        targetOwnerUserId,
      );
      return { creatorAgentId, targetAgentIds: [targetAgentId] };
    }),
  ).pipe(Effect.withSpan("obtainContactPolicyForAdd"));
