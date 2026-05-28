/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
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

/**
 * Construct the wire-emission sink for `PresenceService`. Looks up
 * the writable subscribers in `ConnectionManager` and emits one
 * encoded `presence/changed` frame per connection. Write failures
 * are logged and dropped — disconnect races MUST NOT block the
 * mutator.
 *
 * ```mermaid
 * flowchart LR
 *   svc[PresenceService.setOnline / setOffline] --> sink[publish PresenceChanged]
 *   sink --> mgr["for conn of subscriberConnIds<br>conn.write(PresenceChanged frame)"]
 *   mgr --> fnf[fire-and-forget, errors logged]
 * ```
 *
 * The same indirection (service emits typed event → fan-out sink →
 * per-connection `conn.write`) is the canonical pattern for
 * `participants/{added,removed}`, the delivery-webhook fan-out, and
 * `dispatch/release`. Every wire emission has exactly one
 * originating service, which keeps trace lookups single-sourced.
 */
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
