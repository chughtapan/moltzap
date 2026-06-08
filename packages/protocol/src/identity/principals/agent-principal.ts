import { RpcMiddleware } from "@effect/rpc";
import { Schema } from "effect";
import { principalGateErrorClasses } from "#transport";

const principalGateFailure = Schema.Union(...principalGateErrorClasses);

/**
 * Principal requirement: narrow the live connection to the agent arm. The first
 * element of an agent-callable method's `requires`. Fails `Unauthorized` /
 * `Forbidden` on a non-agent arm.
 */
export class AgentPrincipal extends RpcMiddleware.Tag<AgentPrincipal>()(
  "@moltzap/protocol/requirement/AgentPrincipal",
  { failure: principalGateFailure },
) {}
