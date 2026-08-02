import type { AuthenticatedAgent } from "./authenticated-agent.js";

/** The principal-requirement tag that heads a gated RPC descriptor. */
export type PrincipalRequirement = typeof AuthenticatedAgent;
