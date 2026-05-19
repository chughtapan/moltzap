import { Context, Effect } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/task";
import type { ConversationServiceError } from "../../task/services/conversation.service.js";
import { ConversationServiceTag, ParticipantServiceTag } from "../layers.js";
import { notImplemented } from "./not-implemented.js";

/**
 * Composite capability for `ConversationService.addParticipant` — the
 * load-bearing outcome of **Architect Decision D** in plan #606 (r3
 * amendment).
 *
 * ## Why a composite?
 *
 * Today's `addParticipantEffect` runs three sequential gates:
 *
 * ```
 * yield* assertAddParticipantAuthority(input);        // admin OR TM
 * const targetOwnerUserId =
 *   yield* participants.assertAgentExists(input.agentId);
 * yield* assertAddParticipantContactPolicy(
 *   input.requesterAgentId, input.agentId, targetOwnerUserId);
 * yield* assertParticipantCapacity(input.conversationId);
 * ```
 *
 * Three sibling R-channel tags would work, but the handler would emit
 * three `provideServiceEffect` blocks. The composite reduces that to
 * ONE handler-tier obtain call AND carries `targetOwnerUserId` so the
 * service body's downstream `participants.assertAgentExists` re-fetch
 * is skipped (payload reuse, parallel to `MessageSendPermission`
 * carrying `task` + `replyTarget`).
 *
 * Single-arm composite: no dedup short-circuit and no TM-bypass
 * branching (TM bypass for addParticipant lives inside
 * `assertAddParticipantAuthority` via the existing
 * `assertConversationAdminAuthority` helper; the resulting authority
 * proof is the same shape either way, so the composite stays flat).
 */
export interface AddParticipantPermissionValue {
  readonly conversationId: ConversationId;
  readonly requesterAgentId: AgentId;
  readonly targetAgentId: AgentId;
  readonly targetOwnerUserId: string | null;
}

export class AddParticipantPermission extends Context.Tag(
  "@moltzap/server/AddParticipantPermission",
)<AddParticipantPermission, AddParticipantPermissionValue>() {}

/**
 * Input shape consumed by the dispatch-time smart constructor.
 */
export interface ObtainAddParticipantPermissionInput {
  readonly conversationId: ConversationId;
  readonly requesterAgentId: AgentId;
  readonly targetAgentId: AgentId;
}

/**
 * Architect-stub. Body shape (Phase 3 implements):
 *
 *   const convService = yield* ConversationServiceTag;
 *   const participants = yield* ParticipantServiceTag;
 *   yield* convService.assertAddParticipantAuthority({
 *     conversationId: input.conversationId,
 *     requesterAgentId: input.requesterAgentId,
 *     agentId: input.targetAgentId,
 *   });
 *   const targetOwnerUserId = yield* participants.assertAgentExists(
 *     input.targetAgentId);
 *   yield* convService.assertAddParticipantContactPolicy(
 *     input.requesterAgentId,
 *     input.targetAgentId,
 *     targetOwnerUserId,
 *   );
 *   yield* convService.assertParticipantCapacity(input.conversationId);
 *   return {
 *     conversationId: input.conversationId,
 *     requesterAgentId: input.requesterAgentId,
 *     targetAgentId: input.targetAgentId,
 *     targetOwnerUserId,
 *   };
 *
 * Error channel — every gate failure is a member of
 * `ConversationServiceError`:
 *   - `ForbiddenError` / `NotFoundError` from
 *     `assertAddParticipantAuthority`
 *   - `NotFoundError` from `participants.assertAgentExists`
 *   - `NotInContactsError` from `assertAddParticipantContactPolicy`
 *   - `ConversationFullError` from `assertParticipantCapacity`
 *   - `InvalidParamsError` if the target conversation is a DM
 *     (`assertAddParticipantAuthority`).
 */
export const obtainAddParticipantPermission = (
  _input: ObtainAddParticipantPermissionInput,
): Effect.Effect<
  AddParticipantPermissionValue,
  ConversationServiceError,
  ConversationServiceTag | ParticipantServiceTag
> => notImplemented("obtainAddParticipantPermission") as never;
