import { Context, Effect } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import { NotFoundError } from "@moltzap/protocol";
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
 * Delegates to the `@internal`-exported `requireAgentsExist` +
 * `requireCreatorContactsAll` helpers on `ConversationService` so the
 * runtime check is unchanged from pre-Spec-E.
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
      const policy = conversations.resolveContactPolicyForCapabilities();
      if (policy !== null && targetAgentIds.length !== 0) {
        yield* conversations.requireCreatorContactsAll({
          creatorAgentId,
          targetAgentIds,
          ownerByAgentId,
          policy,
          pathLabel: type,
        });
      }
      return { creatorAgentId, targetAgentIds };
    }),
  ).pipe(Effect.withSpan("obtainContactPolicyForCreate"));

/**
 * Smart constructor for `TaskConversationAddParticipant` (D1) /
 * `ConversationAddParticipant` flows. Inlines the add-participant
 * contact-policy fan-out by composing the `@internal`-exported
 * `requireAgentsExist`, `participantServiceForCapabilities`, and
 * `checkContactEdge` helpers on `ConversationService`.
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
      const targetExists = yield* conversations.requireAgentsExist([
        targetAgentId,
      ]);
      const policy = conversations.resolveContactPolicyForCapabilities();
      if (policy === null) {
        return { creatorAgentId, targetAgentIds: [targetAgentId] };
      }
      const requester =
        yield* conversations.participantServiceForCapabilities.resolve(
          creatorAgentId,
        );
      if (!requester.exists) {
        return yield* Effect.fail(
          new NotFoundError({
            message: `Agent ${creatorAgentId} not found`,
          }),
        );
      }
      yield* conversations.checkContactEdge({
        requesterAgentId: creatorAgentId,
        requesterOwnerUserId: requester.ownerUserId,
        targetAgentId,
        targetOwnerUserId: targetExists.get(targetAgentId) ?? null,
        policy,
        pathLabel: "addParticipant",
      });
      return { creatorAgentId, targetAgentIds: [targetAgentId] };
    }),
  ).pipe(Effect.withSpan("obtainContactPolicyForAdd"));
