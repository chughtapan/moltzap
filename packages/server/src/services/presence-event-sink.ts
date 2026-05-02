import { Effect } from "effect";

import { EventNames, eventFrame } from "@moltzap/protocol";

import type { ConnectionManager } from "../ws/connection.js";

export type PresenceStatus = "online" | "offline" | "away";

export interface PresencePublishInput {
  readonly agentId: string;
  readonly status: PresenceStatus;
  readonly subscriberConnIds: ReadonlySet<string>;
  readonly excludeConnId?: string;
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
        eventFrame(EventNames.PresenceChanged, {
          agentId: input.agentId,
          status: input.status,
        }),
      );
      for (const connId of input.subscriberConnIds) {
        if (connId === input.excludeConnId) continue;
        const conn = deps.connections.get(connId);
        if (!conn) continue;
        Effect.runFork(
          conn.write(raw).pipe(Effect.catchAll(() => Effect.void)),
        );
      }
    },
  };
}
