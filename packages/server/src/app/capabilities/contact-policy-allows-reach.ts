import { Context, Effect } from "effect";
import type {
  ForbiddenError,
  InvalidParamsError,
  NotFoundError,
} from "@moltzap/protocol";
import type { AgentId, NotInContactsError } from "@moltzap/protocol/identity";
import { ConversationServiceTag } from "../layers.js";
import { notImplemented } from "./not-implemented.js";

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
 * Architect-stub. Body shape:
 *   const conv = yield* ConversationServiceTag;
 *   yield* conv.requireContactPolicyForCreate(...);
 *   return { creatorAgentId, targetAgentIds };
 *
 * Phase 3 promotes `requireContactPolicyForCreate`,
 * `requireAddParticipantContactPolicy`, `requireCreatorContactsAll`,
 * `checkContactEdge` from `private` to `@internal` exported per
 * Decision B (Option A) so this obtain helper can call them through the
 * service Tag.
 */

/**
 * Error channel — `ConversationService.requireContactPolicyForCreate`
 * fans out to `requireCreatorContactsAll` / `checkContactEdge` which
 * fail with:
 *   - `NotInContactsError` — caller's contact policy rejects a target
 *   - `NotFoundError` — a referenced `agents` row is missing
 *   - `ForbiddenError` — generic policy denial
 *   - `InvalidParamsError` — DM-arity / shape mismatch
 *
 * `SqlError` from the underlying contact-edge lookups is caught
 * defectively inside the service helper.
 */
export const obtainContactPolicyForCreate = (
  _creatorAgentId: AgentId,
  _targetAgentIds: readonly AgentId[],
): Effect.Effect<
  ContactPolicyAllowsReachValue,
  ForbiddenError | NotFoundError | NotInContactsError | InvalidParamsError,
  ConversationServiceTag
> => notImplemented("obtainContactPolicyForCreate") as never;

/**
 * Variant used by `TaskConversationAddParticipant`. Error channel
 * matches `obtainContactPolicyForCreate` (same underlying fan-out).
 */
export const obtainContactPolicyForAdd = (
  _creatorAgentId: AgentId,
  _targetAgentId: AgentId,
): Effect.Effect<
  ContactPolicyAllowsReachValue,
  ForbiddenError | NotFoundError | NotInContactsError | InvalidParamsError,
  ConversationServiceTag
> => notImplemented("obtainContactPolicyForAdd") as never;
