import { Data, Effect } from "effect";
import type { AgentId, UserId } from "@moltzap/protocol/identity";

/**
 * Closed agent lifecycle states. Mirrors
 * `core-schema.sql → CREATE TYPE agent_status AS ENUM (...)`. The closed
 * union makes the active-agent check exhaustive — adding a state forces every
 * consumer switch to handle it.
 */
export type AgentStatus = "active" | "suspended";

/**
 * The principal context stored on an authenticated socket connection. Every
 * gated method's `requires` head selects this arm.
 */
export class AgentContext extends Data.TaggedClass("AgentContext")<{
  readonly agentId: AgentId;
  readonly agentStatus: AgentStatus;
  readonly ownerUserId: UserId;
}> {}

/**
 * Mint an {@link AgentContext} from authenticator fields. The `agent_status`
 * SQL enum constrains stored values to {@link AgentStatus}, but the DB driver
 * types it as `string`, so any other value is an impossible-state defect.
 * @param parts Value supplied to the operation.
 * @param parts.agentId Value supplied to the operation.
 * @param parts.agentStatus Value supplied to the operation.
 * @param parts.ownerUserId Value supplied to the operation.
 * @returns The agent context from result.
 */
export function agentContextFrom(parts: {
  readonly agentId: AgentId;
  readonly agentStatus: string;
  readonly ownerUserId: UserId;
}): Effect.Effect<AgentContext> {
  switch (parts.agentStatus) {
    case "active":
    case "suspended":
      return Effect.succeed(
        new AgentContext({
          agentId: parts.agentId,
          agentStatus: parts.agentStatus,
          ownerUserId: parts.ownerUserId,
        }),
      );
    default:
      return Effect.die(
        new Error(
          `agentContextFrom: agent_status outside closed union: ${parts.agentStatus}`,
        ),
      );
  }
}
