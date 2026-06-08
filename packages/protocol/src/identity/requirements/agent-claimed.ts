import { RpcMiddleware } from "@effect/rpc";
import { Schema } from "effect";
import { ForbiddenError } from "#transport";

const agentClaimedFailure = Schema.Union(ForbiddenError);

/**
 * Refinement requirement: the agent arm must be claimed/active. Type-paired
 * with `AgentPrincipal`; the server reads the live agent connection status.
 */
export class AgentClaimed extends RpcMiddleware.Tag<AgentClaimed>()(
  "@moltzap/protocol/requirement/AgentClaimed",
  { failure: agentClaimedFailure },
) {}
