/**
 * @file Principal + refinement requirement tags — the low, domain-free head of
 * a descriptor's `requires` list.
 *
 * A method's `requires` tuple is the ordered list of authority a caller must
 * satisfy before the handler runs. The FIRST element is exactly one principal
 * requirement ({@link AgentPrincipal} | {@link AppPrincipal}) — the server's
 * principal gate narrows the live connection to that arm. An optional
 * {@link AgentClaimed} refinement (agent-only) follows when the agent must be
 * claimed/active. The rest are capability requirements, defined ABOVE the
 * domains in the engine layer ({@link CapabilityRequirement}).
 *
 * These three tags live at the wire layer (the DAG bottom) because the domain
 * descriptors list them in `requires` and must depend on them DOWNWARD. They
 * carry NO domain type: their `Context.Tag` service type is a vestigial marker
 * ({@link PrincipalMarker}) — nothing provides or reads a value through them
 * (the gate provides nothing; the request principal rides the separate
 * `CurrentPrincipal` tag in the engine layer). Decoupling the service type from
 * the domain `Principal` is what keeps the wire layer free of `../identity` /
 * `../task` edges.
 *
 * Each tag carries its `static errors` tuple — the tagged-error classes its
 * proof can fail with. The descriptor folds these into the method's effective
 * wire error union, and the server stacks each tag's `RpcMiddleware`.
 */
import { Context } from "effect";
import { ForbiddenError, principalGateErrorClasses } from "./wire-errors.js";

/**
 * Vestigial service type for the principal requirement tags. The tags are pure
 * markers in a `requires` list — nothing provides or reads a value through their
 * `Context.Tag` slot (the principal gate has no `provides`; the request
 * principal rides `CurrentPrincipal`). A dedicated empty marker keeps the wire
 * layer free of the domain `Principal` type without weakening the tag identity
 * the classifiers discriminate on.
 */
export interface PrincipalMarker {
  readonly _principalMarker: never;
}

/**
 * Principal requirement: narrow the live connection to the agent arm. The first
 * element of an agent-callable method's `requires`. Fails `Unauthorized` /
 * `Forbidden` (the principal-gate errors) on a non-agent arm.
 */
export class AgentPrincipal extends Context.Tag(
  "@moltzap/protocol/requirement/AgentPrincipal",
)<AgentPrincipal, PrincipalMarker>() {
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
)<AppPrincipal, PrincipalMarker>() {
  static get errors() {
    return principalGateErrorClasses;
  }
}

/**
 * Refinement requirement (agent-only): the agent arm must be claimed/active.
 * Type-paired with {@link AgentPrincipal} — the server reads
 * `connection.auth.agentStatus`; it is meaningless without a preceding agent
 * principal. Fails `Forbidden` on a not-yet-claimed agent.
 */
export class AgentClaimed extends Context.Tag(
  "@moltzap/protocol/requirement/AgentClaimed",
)<AgentClaimed, PrincipalMarker>() {
  static get errors() {
    return [ForbiddenError] as const;
  }
}

/** The two principal-requirement tags — the only valid `requires` heads. */
export type PrincipalRequirement = typeof AgentPrincipal | typeof AppPrincipal;
