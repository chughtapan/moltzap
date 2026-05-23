import { Effect } from "effect";

import { PresenceChangedNotificationDefinition } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConnectionId } from "@moltzap/protocol/network";

import type { ConnectionManager } from "../../transport/connection.js";

export type PresenceStatus = "online" | "offline" | "away";

export interface PresencePublishInput {
  readonly agentId: AgentId;
  readonly status: PresenceStatus;
  readonly subscriberConnIds: ReadonlySet<ConnectionId>;
  readonly excludeConnId?: ConnectionId;
}

/**
 * Best-effort sink for presence transitions. A failed write to one
 * subscriber MUST NOT propagate to the mutator — disconnect-driven
 * failures are expected.
 */
export interface PresenceEventSink {
  publish(input: PresencePublishInput): void;
}

export function createConnectionFanOutPresenceEventSink(deps: {
  readonly connections: ConnectionManager;
}): PresenceEventSink {
  return {
    publish(input) {
      if (input.subscriberConnIds.size === 0) return;
      const raw = JSON.stringify(
        PresenceChangedNotificationDefinition.encode({
          agentId: input.agentId,
          status: input.status,
        }),
      );
      for (const connId of input.subscriberConnIds) {
        if (connId !== input.excludeConnId) {
          const conn = deps.connections.get(connId);
          if (conn) {
            Effect.runFork(
              conn.write(raw).pipe(Effect.catchAll(() => Effect.void)),
            );
          }
        }
      }
    },
  };
}
