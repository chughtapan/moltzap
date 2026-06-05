/**
 * @file Requirement model for RPC authorization.
 *
 * A descriptor's `requires` tuple contains requirement tags, and every
 * requirement tag is itself the `@effect/rpc` middleware tag the engine stacks.
 */
import type { AgentId } from "./identity/agents.js";
import type { AppId } from "./task/ids.js";
import {
  AgentPrincipal,
  AppPrincipal,
  AuthenticatedPrincipal,
  AgentClaimed,
  type PrincipalRequirement,
} from "./transport/principal.js";
import {
  ConversationInTask,
  ConversationSendAccess,
  TaskReadAccess,
  ContactPolicyAllowsReach,
} from "./task/capabilities/index.js";

export type { PrincipalRequirement } from "./transport/principal.js";

/**
 * The authenticated principal of the in-flight request. The server's
 * `AgentContext` / `AppContext` structurally inhabit this union, so the server
 * can return the live narrowed arm directly from the principal gate.
 */
export type Principal =
  | { readonly _tag: "AgentContext"; readonly agentId: AgentId }
  | { readonly _tag: "AppContext"; readonly appId: AppId };

export type CapabilityRequirement =
  | typeof ConversationInTask
  | typeof ConversationSendAccess
  | typeof TaskReadAccess
  | typeof ContactPolicyAllowsReach;

export type Requirement =
  | PrincipalRequirement
  | typeof AgentClaimed
  | CapabilityRequirement;

/**
 * The middleware stack for a `requires` tuple, de-duplicated by middleware tag.
 * The descriptor order is logical run order. `@effect/rpc` runs the last
 * attached middleware first, so the engine attaches the reverse order.
 */
export const middlewaresForRequirements = (
  requires: ReadonlyArray<Requirement>,
): ReadonlyArray<Requirement> => {
  const stack: Requirement[] = [];
  const seen = new Set<Requirement>();
  for (const requirement of requires) {
    if (!seen.has(requirement)) {
      seen.add(requirement);
      stack.push(requirement);
    }
  }
  return stack.reverse();
};

export type MwStackFor<Requires extends ReadonlyArray<unknown>> = Extract<
  Requires[number],
  Requirement
>;

export const principalRequirementOf = (
  requires: ReadonlyArray<Requirement>,
): PrincipalRequirement | undefined => {
  const head = requires[0];
  return head === AgentPrincipal ||
    head === AppPrincipal ||
    head === AuthenticatedPrincipal
    ? head
    : undefined;
};

export type PrincipalRequirementOf<
  Requires extends ReadonlyArray<Requirement>,
> = Requires extends readonly [infer Head, ...ReadonlyArray<unknown>]
  ? Head extends PrincipalRequirement
    ? Head
    : undefined
  : undefined;

export const requiresClaimed = (
  requires: ReadonlyArray<Requirement>,
): boolean => requires.some((r) => r === AgentClaimed);
