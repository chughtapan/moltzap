/**
 * @file The genuine `Requirement` union + classifiers — the engine layer's
 * concrete model of a descriptor's `requires` list.
 *
 * The wire layer (`transport/principal.ts`) owns the low principal tags that
 * domains depend on downward. THIS module, above the domains, owns the
 * capability half: {@link CapabilityRequirement} (the union of the actual cap
 * tags, which live in `task/capabilities/`) and the genuine {@link Requirement}
 * union. Because the cap tags are task-layer, this model genuinely sits ABOVE
 * the domains — and so do its only consumers (the engine groups + cap
 * middlewares, which also consume the full `rpc-registry` catalog).
 *
 * {@link Requirement} is the genuine closed union of the actual tag classes
 * (principal | agent-claimed | capability), so the classifiers narrow it by tag
 * IDENTITY and the engine binding reads `.key` / `.errors` off it directly — no
 * structural cast. The compile-error-on-unregistered-cap guarantee lives here:
 * a descriptor listing a cap with no registered middleware is not a
 * `CapabilityRequirement`, so it is not a `Requirement`, so the engine member
 * binding (`server-engine-group.ts`) fails to compile.
 */
import {
  AgentPrincipal,
  AppPrincipal,
  AgentClaimed,
  type PrincipalRequirement,
} from "../transport/principal.js";
import {
  ConversationInTask,
  ConversationSendAccess,
  TaskReadAccess,
  ContactPolicyAllowsReach,
} from "../task/capabilities/index.js";

export type { PrincipalRequirement } from "../transport/principal.js";

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
