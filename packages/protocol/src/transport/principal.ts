/**
 * @file Principal + refinement middleware requirement tags — the low,
 * domain-free head of a descriptor's `requires` list.
 *
 * A method's `requires` tuple is the ordered list of authority a caller must
 * satisfy before the handler runs. The FIRST element is exactly one principal
 * requirement ({@link AgentPrincipal} | {@link AppPrincipal} |
 * {@link AuthenticatedPrincipal}) — the server's principal gate narrows or
 * admits the live connection. An optional {@link AgentClaimed} refinement
 * (agent-only) follows when the agent must be claimed/active. The rest are
 * capability requirements, defined ABOVE the domains in the engine layer
 * ({@link CapabilityRequirement}).
 *
 * These tags live at the wire layer (the DAG bottom) because the domain
 * descriptors list them in `requires` and must depend on them DOWNWARD. They
 * are `RpcMiddleware.Tag`s, not domain principal services. Decoupling the
 * middleware tag from the domain `Principal` keeps the wire layer free of
 * `../identity` / `../task` edges.
 *
 * Each tag carries its failure schema. The descriptor folds those failures into
 * the method's effective wire error union, and the server supplies each tag's
 * middleware implementation.
 */
import { Schema } from "effect";
import { RpcMiddleware } from "@effect/rpc";
import { ForbiddenError, principalGateErrorClasses } from "./wire-errors.js";

const principalGateFailure = Schema.Union(...principalGateErrorClasses);
const agentClaimedFailure = Schema.Union(ForbiddenError);

/**
 * Principal requirement: narrow the live connection to the agent arm. The first
 * element of an agent-callable method's `requires`. Fails `Unauthorized` /
 * `Forbidden` (the principal-gate errors) on a non-agent arm.
 */
export class AgentPrincipal extends RpcMiddleware.Tag<AgentPrincipal>()(
  "@moltzap/protocol/requirement/AgentPrincipal",
  { failure: principalGateFailure },
) {}

/**
 * Principal requirement: narrow the live connection to the app arm. The first
 * element of an app-callable method's `requires`. Fails `Unauthorized` /
 * `Forbidden` on a non-app arm.
 */
export class AppPrincipal extends RpcMiddleware.Tag<AppPrincipal>()(
  "@moltzap/protocol/requirement/AppPrincipal",
  { failure: principalGateFailure },
) {}

/**
 * Principal requirement: require any authenticated arm. Used by methods that
 * are shared by first-party agent and app clients but still must reject the
 * unauthenticated pre-connect arm.
 */
export class AuthenticatedPrincipal extends RpcMiddleware.Tag<AuthenticatedPrincipal>()(
  "@moltzap/protocol/requirement/AuthenticatedPrincipal",
  { failure: principalGateFailure },
) {}

/**
 * Refinement requirement (agent-only): the agent arm must be claimed/active.
 * Type-paired with {@link AgentPrincipal} — the server reads
 * `connection.auth.agentStatus`; it is meaningless without a preceding agent
 * principal. Fails `Forbidden` on a not-yet-claimed agent.
 */
export class AgentClaimed extends RpcMiddleware.Tag<AgentClaimed>()(
  "@moltzap/protocol/requirement/AgentClaimed",
  { failure: agentClaimedFailure },
) {}

/** The principal-requirement tags — the only valid `requires` heads. */
export type PrincipalRequirement =
  | typeof AgentPrincipal
  | typeof AppPrincipal
  | typeof AuthenticatedPrincipal;
