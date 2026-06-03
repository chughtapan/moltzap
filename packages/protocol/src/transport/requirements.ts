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
 * (`requirementMiddlewareByKey`). The protocol declares the tag + its errors;
 * the server provides the runtime that resolves it (one-way protocol→server
 * edge).
 */
import { Context } from "effect";
import { ForbiddenError, principalGateErrorClasses } from "./wire-errors.js";
import type { Principal } from "./current-principal.js";

/**
 * Principal requirement: narrow the live connection to the agent arm. The first
 * element of an agent-callable method's `requires`. Fails `Unauthorized` /
 * `Forbidden` (the principal-gate errors) on a non-agent arm.
 */
export class AgentPrincipal extends Context.Tag(
  "@moltzap/protocol/requirement/AgentPrincipal",
)<AgentPrincipal, Principal>() {
  static readonly requirementKind = "agent-principal" as const;
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
  static readonly requirementKind = "app-principal" as const;
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
  static readonly requirementKind = "agent-claimed" as const;
  static get errors() {
    return [ForbiddenError] as const;
  }
}

/**
 * A requirement tag: a `Context.Tag` whose `Identifier`/`Service` are not pinned
 * (a method's `requires` mixes principal, refinement, and capability tags of
 * differing service types). `any` — not `unknown` — keeps the descriptor's
 * heterogeneous `requires` tuple assignable here without a per-call cast.
 */
type RequirementTag = Context.Tag<any, any>;

/** The two principal-requirement tags — the only valid `requires` heads. */
export type PrincipalRequirement = typeof AgentPrincipal | typeof AppPrincipal;

/** A requirement tag's static `requirementKind` marker, or undefined (a cap). */
export const requirementKindOf = (
  requirement: RequirementTag,
): string | undefined =>
  (requirement as { readonly requirementKind?: string }).requirementKind;

/**
 * The principal requirement that heads a `requires` list, or `undefined` when
 * `requires` is empty (only `network/connect`, dispatched pre-auth). A READ of
 * `requires`, not a separate field — the client groups partition on this head
 * tag and the server gate narrows to it.
 */
export const principalRequirementOf = (
  requires: ReadonlyArray<RequirementTag>,
): PrincipalRequirement | undefined => {
  const head = requires[0];
  if (head === undefined) return undefined;
  const kind = requirementKindOf(head);
  if (kind === "agent-principal") return AgentPrincipal;
  if (kind === "app-principal") return AppPrincipal;
  return undefined;
};

/**
 * The type-level principal requirement that heads a `requires` tuple, or
 * `undefined` when empty. The type mirror of {@link principalRequirementOf},
 * discriminated on the head requirement's static `requirementKind` literal.
 */
export type PrincipalRequirementOf<
  Requires extends ReadonlyArray<Context.Tag<any, any>>,
> = Requires extends readonly [infer Head, ...ReadonlyArray<unknown>]
  ? Head extends { readonly requirementKind: "agent-principal" }
    ? typeof AgentPrincipal
    : Head extends { readonly requirementKind: "app-principal" }
      ? typeof AppPrincipal
      : undefined
  : undefined;

/** Whether a `requires` list carries the agent-only `AgentClaimed` refinement. */
export const requiresClaimed = (
  requires: ReadonlyArray<RequirementTag>,
): boolean => requires.some((r) => requirementKindOf(r) === "agent-claimed");

/**
 * The capability tags in a `requires` list — every entry that is NOT a principal
 * requirement or the `AgentClaimed` refinement, in declared order.
 */
export const capRequirementsOf = (
  requires: ReadonlyArray<RequirementTag>,
): ReadonlyArray<RequirementTag> =>
  requires.filter((r) => requirementKindOf(r) === undefined);
