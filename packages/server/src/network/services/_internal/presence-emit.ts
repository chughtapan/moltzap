/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import { Effect, Option } from "effect";

import { PresenceChangedNotificationDefinition } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConnectionId } from "@moltzap/protocol/network";

import type { ConnectionManager } from "../../../transport/connection.js";
import {
  type DerivedPresenceStatus,
  emitPresenceTransition,
  type PresenceSubscriberRegistry,
} from "../presence-projection-types.js";

/**
 * Module-private emit layer for the presence projection (architect plan
 * #706 v6+).
 *
 * **What lives here and why.** The TS-module canaries assert external
 * imports of THIS file's symbols fail. Codex r5 P2 #2 identified that
 * v5's "in-module seal" was structural only at the module BOUNDARY:
 * in-module code in `presence-projection.ts` could still grab the
 * sink in scope. v6 closed that hole by moving the raw sink + factory
 * + curry into THIS file, which exports ONLY `EmitIfChanged` (the
 * curried capability type) and {@link createEmitIfChanged} (the
 * factory). The raw sink type + fan-out factory are unexported here;
 * nothing about them is reachable from `presence-projection.ts`. The
 * projection module imports `createEmitIfChanged`, calls it once
 * inside `makePresenceProjection`'s factory, and receives back an
 * `EmitIfChanged` value.
 *
 * **Naming convention: `_internal/`.** Mirrors the Effect library's
 * own convention for "do not import from outside this directory."
 * `presence-projection.ts` is the only consumer of this module; the
 * type-canary file
 * (`packages/server/src/network/services/presence-projection.types-check.ts`)
 * asserts the internal seal via THREE `@ts-expect-error` lines:
 * `InternalPresenceEventSink`, `createInternalFanOutEventSink`, and
 * `emitPresenceTransition` ALL fail to import from THIS file.
 *
 * **v7 (codex r6 P2 #4 — three-canary seal made real).** v6 exported
 * `emitPresenceTransition` from this file, making the third canary a
 * re-export-probe rather than a TS2305 seal. v7 moves
 * `emitPresenceTransition` to `presence-projection-types.ts` so both
 * `_internal/presence-emit.ts` (for the `EmitIfChanged` curry) and
 * `presence-projection.ts` (for the architect contract re-export)
 * import it from a non-`_internal/` path. The third canary at
 * `presence-projection.types-check.ts` now asserts a genuine TS2305
 * seal: `emitPresenceTransition` is NOT importable from THIS file.
 */

/**
 * Module-private sealed sink type. Lives ONLY in this file's scope.
 * No other module in the tree imports it (the canary at
 * `presence-projection.types-check.ts` asserts this empirically via
 * `@ts-expect-error` on the import).
 */
interface InternalPresenceEventSink {
  publish(input: {
    readonly agentId: AgentId;
    readonly status: DerivedPresenceStatus;
    readonly subscriberConnIds: ReadonlySet<ConnectionId>;
    readonly excludeConnId?: ConnectionId;
  }): void;
}

/**
 * Construct the per-connection `presence/changed` fan-out sink that
 * {@link createEmitIfChanged} wraps. Module-private to this file; no
 * other module in the tree imports this factory (the canary at
 * `presence-projection.types-check.ts` asserts the seal). Replaces
 * the v2-era `createConnectionFanOutPresenceEventSink` exported from
 * `presence-event-sink.ts` (deleted in §8 cutover); unlike v5 (which
 * lived inside `presence-projection.ts`), v6 keeps the factory in
 * this `_internal/` module so the projection module cannot reach
 * it. Body recipe — impl-staff fills the body: for each subscriber
 * connId in `subscriberConnIds`, skip if it matches `excludeConnId`,
 * resolve the `Connection` via `deps.connections.get(connId)`, and
 * send a `presence/changed` notification with `{ agentId, status }`.
 */
function createInternalFanOutEventSink(deps: {
  readonly connections: ConnectionManager;
}): InternalPresenceEventSink {
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
        if (connId === input.excludeConnId) continue;
        const conn = deps.connections.get(connId);
        if (conn) {
          Effect.runFork(
            conn.write(raw).pipe(Effect.catchAll(() => Effect.void)),
          );
        }
      }
    },
  };
}

/**
 * In-module-curried emit capability the projection's transition
 * methods receive INSTEAD of raw access to
 * {@link InternalPresenceEventSink} (architect plan #706 v5; v6 moves
 * the type into this `_internal/` module so even `presence-projection.ts`
 * cannot reach the raw sink).
 *
 * `(previous, next, agentId) => Effect<void, never, never>` — the
 * helper consults `emitPresenceTransition` (imported from
 * `presence-projection-types.ts`) for the dedup decision, snapshots
 * the subscriber set, and publishes through the sink iff the
 * decision is `Some`. The transition methods (`onAgentConnect`,
 * `onAgentDisconnect`, `onLeaseActiveBegin`, `onLeaseActiveEnd`)
 * NEVER receive or close over the raw `sink.publish` — they only
 * receive a value of THIS shape, constructed once inside
 * {@link createEmitIfChanged}'s closure and passed in by
 * `makePresenceProjection`.
 *
 * Combined with the external seal (three `@ts-expect-error` canary
 * lines at `presence-projection.types-check.ts`), the dedup rule is
 * structurally enforced across BOTH axes:
 *
 * - **External:** no module outside `_internal/` can construct or
 *   hold a sink.
 * - **In-module (projection):** the projection module cannot
 *   construct or hold a sink either; it can only call
 *   `createEmitIfChanged` and receive back the curried
 *   `EmitIfChanged` capability.
 */
export type EmitIfChanged = (
  previous: DerivedPresenceStatus,
  next: DerivedPresenceStatus,
  agentId: AgentId,
) => Effect.Effect<void, never, never>;

/**
 * Construct the curried {@link EmitIfChanged} capability for a
 * specific presence projection. Closes over the raw sink + subscriber
 * registry so the only access path to wire-level emission is the
 * dedup-gated function returned from here.
 *
 * Recipe (impl-staff fills the body): construct the internal sink
 * via `createInternalFanOutEventSink({ connections: deps.connections })`;
 * return an effectful closure `(previous, next, agentId) =>
 * Effect.sync(...)` that calls `emitPresenceTransition(previous,
 * next)`, matches the `Option` result, snapshots the subscriber set
 * via `new Set(deps.subscribers.getSubscribers(agentId))` on the
 * `Some` arm, and calls `sink.publish({ agentId, status,
 * subscriberConnIds })`.
 *
 * **Visibility from `presence-projection.ts`.** This is the SOLE
 * exported factory from `_internal/presence-emit.ts`. The projection
 * module imports it, calls it once inside `makePresenceProjection`'s
 * factory, and receives an `EmitIfChanged` value. The raw sink is
 * not reachable from the projection module under any in-module
 * refactor.
 */
export function createEmitIfChanged(deps: {
  readonly connections: ConnectionManager;
  readonly subscribers: PresenceSubscriberRegistry;
}): EmitIfChanged {
  const sink = createInternalFanOutEventSink({ connections: deps.connections });
  return (previous, next, agentId) =>
    Effect.sync(() => {
      const decision = emitPresenceTransition(previous, next);
      if (Option.isNone(decision)) return;
      const subscriberConnIds = new Set(
        deps.subscribers.getSubscribers(agentId),
      );
      if (subscriberConnIds.size === 0) return;
      sink.publish({
        agentId,
        status: decision.value,
        subscriberConnIds,
      });
    });
}
