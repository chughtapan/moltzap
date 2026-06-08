import { Data, Effect } from "effect";
import type { AppId } from "@moltzap/protocol/task";
import type { AgentId, UserId } from "#core";

/**
 * Closed agent lifecycle states. Mirrors
 * `core-schema.sql → CREATE TYPE agent_status AS ENUM (...)`. The closed
 * union makes the active-agent check exhaustive — adding a state forces every
 * consumer switch to handle it.
 */
export type AgentStatus = "active" | "suspended";

/**
 * The two tagged principal arms. These are the only "context" classes; a
 * connection's principal is reached via `conn.auth`
 * off the three-arm `Connection` union (`transport/connection.ts`). No
 * `AuthenticatedContext`-style wrapper sits above them — the bare union
 * `AgentContext | AppContext` is the principal type, minted directly on the
 * Connect path. Handlers receive their NARROWED arm
 * ({@link AgentContext} for agent-callable RPCs, {@link AppContext} for
 * app-callable), keyed by each method's `requires` head.
 */
export class AgentContext extends Data.TaggedClass("AgentContext")<{
  readonly agentId: AgentId;
  readonly agentStatus: AgentStatus;
  readonly ownerUserId: UserId;
}> {}

export class AppContext extends Data.TaggedClass("AppContext")<{
  readonly appId: AppId;
}> {}

/**
 * Mint the closed-union {@link AgentContext} arm DIRECTLY from the
 * raw fields an authenticator resolves (the Connect path's sole minting site;
 * there is no `AuthenticatedContext` intermediary). The `agent_status` SQL
 * enum (`core-schema.sql → CREATE TYPE agent_status`) constrains the stored
 * value to exactly the {@link AgentStatus} members, but the DB driver types it
 * as `string`, so a value outside the union is an impossible-state defect
 * (`Effect.die`), not a caller-actionable error.
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
