/**
 * @file Principal + refinement requirements — the descriptor `requires` list
 * head.
 *
 * A method's `requires` tuple is the ordered list of authority a caller must
 * satisfy before the handler runs. The FIRST element is exactly one principal
 * requirement ({@link AgentPrincipal} | {@link AppPrincipal}) — it narrows the
 * live connection to that arm. An optional {@link AgentClaimed} refinement
 * (agent-only) follows when the agent must be claimed/active. The rest are
 * capability requirements (`task/capabilities/`). The public `network/connect`
 * is the lone method with an EMPTY `requires` (no principal exists pre-auth).
 *
 * Each requirement is a `Context.Tag` carrying its `static errors` tuple — the
 * tagged-error classes its proof can fail with — exactly like a capability tag.
 * `defineRpc` folds every requirement's `errors` into the method's effective
 * wire error union, and the server stacks each requirement's `RpcMiddleware`
 * (`requirementMiddleware`). The protocol declares the tag + its errors; the
 * server provides the runtime that resolves it (one-way protocol→server edge).
 *
 * {@link Requirement} is the genuine closed union of the actual tag classes
 * (principal | agent-claimed | capability), so the classifiers narrow it by tag
 * IDENTITY and every consumer reads `.errors` / `.key` off it directly — no
 * variance-erased `Context.Tag` escape hatch, no structural cast.
 */
import { Context } from "effect";
import { ForbiddenError, principalGateErrorClasses } from "./wire-errors.js";
import type { Principal } from "./current-principal.js";
// Type-only: `CapabilityRequirement` references these tags solely in `typeof`
// position. A VALUE import would drag the `task/` schema graph into this module's
// init and close a cycle (`task/conversations.ts` reads `AgentId`, whose module
// imports the principal tags from here), so the cap tags stay erased.
import type {
  ConversationInTask,
  ConversationSendAccess,
  TaskReadAccess,
  ContactPolicyAllowsReach,
} from "../task/capabilities/index.js";

/**
 * Principal requirement: narrow the live connection to the agent arm. The first
 * element of an agent-callable method's `requires`. Fails `Unauthorized` /
 * `Forbidden` (the principal-gate errors) on a non-agent arm.
 */
export class AgentPrincipal extends Context.Tag(
  "@moltzap/protocol/requirement/AgentPrincipal",
)<AgentPrincipal, Principal>() {
  static get errors() {
    return principalGateErrorClasses;
  }
}

/**
 * Principal requirement: narrow the live connection to the app arm. The first
 * element of an app-callable method's `requires`. Fails `Unauthorized` /
 * `Forbidden` on a non-app arm.
 */
export class AppPrincipal extends Context.Tag(
  "@moltzap/protocol/requirement/AppPrincipal",
)<AppPrincipal, Principal>() {
  static get errors() {
    return principalGateErrorClasses;
  }
}

/**
 * Refinement requirement (agent-only): the agent arm must be claimed/active.
 * Type-paired with {@link AgentPrincipal} — it reads `connection.auth.agentStatus`
 * and is meaningless without a preceding agent principal. Fails `Forbidden` on a
 * not-yet-claimed agent.
 */
export class AgentClaimed extends Context.Tag(
  "@moltzap/protocol/requirement/AgentClaimed",
)<AgentClaimed, Principal>() {
  static get errors() {
    return [ForbiddenError] as const;
  }
}

/** The two principal-requirement tags — the only valid `requires` heads. */
export type PrincipalRequirement = typeof AgentPrincipal | typeof AppPrincipal;

/**
 * A capability requirement: one of the capability tags the server gates with a
 * cap middleware. Its `.key` is a `MiddlewareRequirementKey` by construction, so
 * the engine binding's `requirementMiddleware[cap.key]` lookup is total with no
 * cast — and a descriptor listing a cap with no registered middleware is a
 * COMPILE error (the cap is not in this union).
 */
export type CapabilityRequirement =
  | typeof ConversationInTask
  | typeof ConversationSendAccess
  | typeof TaskReadAccess
  | typeof ContactPolicyAllowsReach;

/**
 * One entry in a method's `requires` list: a principal requirement, the
 * agent-only `AgentClaimed` refinement, or a capability requirement. The genuine
 * closed union of the actual requirement tag classes — every classifier below
 * narrows it by tag-class IDENTITY, and every consumer reads `.errors` / `.key`
 * off it directly (no structural cast, no variance-erased `Context.Tag` escape
 * hatch).
 */
export type Requirement =
  | PrincipalRequirement
  | typeof AgentClaimed
  | CapabilityRequirement;

/**
 * The principal requirement that heads a `requires` list, or `undefined` when
 * `requires` is empty (only `network/connect`, dispatched pre-auth). A READ of
 * `requires`, not a separate field — the client groups partition on this head
 * tag and the server gate narrows to it. Matches the head by tag-class identity.
 */
export const principalRequirementOf = (
  requires: ReadonlyArray<Requirement>,
): PrincipalRequirement | undefined => {
  const head = requires[0];
  return head === AgentPrincipal || head === AppPrincipal ? head : undefined;
};

/**
 * The type-level principal requirement that heads a `requires` tuple, or
 * `undefined` when empty or non-principal-headed. The type mirror of
 * {@link principalRequirementOf}, discriminated on the head tag's identity.
 */
export type PrincipalRequirementOf<
  Requires extends ReadonlyArray<Requirement>,
> = Requires extends readonly [infer Head, ...ReadonlyArray<unknown>]
  ? Head extends PrincipalRequirement
    ? Head
    : undefined
  : undefined;

/** Whether a `requires` list carries the agent-only `AgentClaimed` refinement. */
export const requiresClaimed = (
  requires: ReadonlyArray<Requirement>,
): boolean => requires.some((r) => r === AgentClaimed);

/**
 * The capability requirements in a `requires` list — every entry that is NOT a
 * principal requirement or the `AgentClaimed` refinement, in declared order. The
 * type guard narrows `Requirement` → {@link CapabilityRequirement} by identity,
 * so each result's `.key` is a `MiddlewareRequirementKey` (the total-map lookup
 * needs no cast).
 */
export const capRequirementsOf = (
  requires: ReadonlyArray<Requirement>,
): ReadonlyArray<CapabilityRequirement> =>
  requires.filter(
    (r): r is CapabilityRequirement =>
      r !== AgentPrincipal && r !== AppPrincipal && r !== AgentClaimed,
  );
