import type { AgentPrincipal } from "./agent-principal.js";
import type { AppPrincipal } from "./app-principal.js";
import type { AuthenticatedPrincipal } from "./authenticated-principal.js";

/** The principal-requirement tags that can head a gated RPC descriptor. */
export type PrincipalRequirement =
  | typeof AgentPrincipal
  | typeof AppPrincipal
  | typeof AuthenticatedPrincipal;
