/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
/* eslint-disable sonarjs/void-use -- stubs `void X;` parameter to keep the public signature stable until impl-staff fills the body. */
import { type Effect, type Option } from "effect";

import type { AgentId } from "@moltzap/protocol/identity";
import type { ConnectionId } from "@moltzap/protocol/network";

import type { ConnectionManager } from "../../../transport/connection.js";
import type {
  DerivedPresenceStatus,
  PresenceSubscriberRegistry,
} from "../presence-projection-types.js";

/**
 * Module-private emit layer for the presence projection (architect plan
 * #706 v6, codex r5 P2 #2).
 *
 * **What lives here and why.** v5's `presence-projection.ts` co-located
 * (a) the sealed sink type + fan-out factory and (b) the
 * `createEmitIfChanged` curry under the same naming convention
 * (`Internal*` + `Create*`-unexported). The TS-module canaries assert
 * external imports of those symbols fail. Codex r5 P2 #2 pointed out
 * that the v5 split was only structural at the module BOUNDARY:
 * in-module code in `presence-projection.ts` (a future helper, a
 * refactor) can still grab the sink in scope and bypass
 * {@link emitPresenceTransition}. The compiler does not enforce
 * "function-scoped privacy" within a TS module.
 *
 * v6 closes that hole by moving the raw sink + factory + emit-if-changed
 * curry into THIS file (`_internal/presence-emit.ts`), which exports
 * ONLY `EmitIfChanged` (the curried capability type) and
 * {@link createEmitIfChanged} (the factory). The raw sink type +
 * fan-out factory are unexported here; nothing about them is reachable
 * from `presence-projection.ts`. The projection module imports
 * `createEmitIfChanged`, calls it once inside `makePresenceProjection`'s
 * factory, and receives back an `EmitIfChanged` value. There is no
 * other path inside the projection module that can construct or hold
 * the raw sink.
 *
 * **Naming convention: `_internal/`.** Mirrors the Effect library's
 * own convention for "do not import from outside this directory."
 * `presence-projection.ts` is the only consumer of this module; the
 * type-canary file
 * (`packages/server/src/network/services/presence-projection.types-check.ts`)
 * asserts the internal seal via three `@ts-expect-error` lines:
 * `InternalPresenceEventSink`, `createInternalFanOutEventSink`, and
 * the *pure* `emitPresenceTransition` ALL fail to import from THIS
 * file. The projection module re-exports `emitPresenceTransition`
 * (for the architect contract surface) but the raw sink + factory are
 * not reachable from anywhere outside this directory.
 *
 * **Co-located pure dedup function.** `emitPresenceTransition` lives
 * here too so the `createEmitIfChanged` body can call it without
 * importing from a sibling module — and so the type-canary can assert
 * that an external module attempting to bypass the projection's
 * re-export (`import { emitPresenceTransition } from
 * "./_internal/presence-emit.js"`) also fails. Exposing only the
 * projection's re-export (`presence-projection.ts → emitPresenceTransition`)
 * keeps the public surface in one place.
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
  void deps;
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- architect stub body per SKILL.md "every stub body is exactly `throw new Error("not implemented")`"
  throw new Error("not implemented");
}

/**
 * Pure algebraic dedup rule (architect plan §3 / §5).
 *
 * Lives in this `_internal/` module so the {@link createEmitIfChanged}
 * curry can call it without a cross-file import. Re-exported from
 * `presence-projection.ts → emitPresenceTransition` as the architect
 * contract surface.
 *
 * Truth table:
 *
 * | previous | next    | emit             |
 * |----------|---------|------------------|
 * | online   | online  | `none`           |
 * | online   | working | `some(working)`  |
 * | working  | working | `none` (dedup)   |
 * | working  | online  | `some(online)`   |
 * | online   | offline | `some(offline)`  |
 * | working  | offline | `some(offline)`  |
 * | offline  | *       | (call site never produces; offline is terminal until reconnect) |
 *
 * The two-arg discipline forces the projection to NAME the previous
 * status at the emission site, which is how concurrent GRANTED leases
 * stop producing duplicate `working` notifications: the second GRANT
 * sees `previous = working` and elides the emission.
 *
 * Note: this function is the algebraic dedup rule. The structural
 * gate is the in-module + cross-module sealing of the emission sink
 * — see {@link InternalPresenceEventSink}. Both layers are
 * load-bearing.
 */
export function emitPresenceTransition(
  previous: DerivedPresenceStatus,
  next: DerivedPresenceStatus,
): Option.Option<DerivedPresenceStatus> {
  void previous;
  void next;
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- architect stub body per SKILL.md "every stub body is exactly `throw new Error("not implemented")`"
  throw new Error("not implemented");
}

/**
 * In-module-curried emit capability the projection's transition
 * methods receive INSTEAD of raw access to
 * {@link InternalPresenceEventSink} (architect plan #706 v5; v6 moves
 * the type into this `_internal/` module so even `presence-projection.ts`
 * cannot reach the raw sink).
 *
 * `(previous, next, agentId) => Effect<void, never, never>` — the
 * helper consults {@link emitPresenceTransition} for the dedup
 * decision, snapshots the subscriber set, and publishes through the
 * sink iff the decision is `Some`. The transition methods
 * (`onAgentConnect`, `onAgentDisconnect`, `onLeaseActiveBegin`,
 * `onLeaseActiveEnd`) NEVER receive or close over the raw
 * `sink.publish` — they only receive a value of THIS shape,
 * constructed once inside {@link createEmitIfChanged}'s closure and
 * passed in by `makePresenceProjection`.
 *
 * Why this design (v6 / codex r5 P2 #2): the v3-v5 evolution closed
 * the EXTERNAL-import seal (no other module can import
 * `InternalPresenceEventSink`), but v5's in-module seal was
 * documentation, not structure — TypeScript's module-boundary
 * privacy didn't enforce "no in-module helper can grab the sink
 * directly." v6 uses physical module separation: the sink + factory
 * + dedup helper all live in this `_internal/` module; the
 * projection module imports only `EmitIfChanged` +
 * `createEmitIfChanged`, so the raw sink is structurally
 * unreachable from `presence-projection.ts`.
 *
 * Combined with the external seal (three `@ts-expect-error` canary
 * lines at `presence-projection.types-check.ts`), the dedup rule is
 * structurally enforced across BOTH axes:
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
 * Recipe (impl-staff fills the body):
 *
 *     const sink = createInternalFanOutEventSink({ connections: deps.connections });
 *     return (previous, next, agentId) =>
 *       Effect.sync(() => {
 *         const decision = emitPresenceTransition(previous, next);
 *         Option.match(decision, {
 *           onNone: () => undefined,
 *           onSome: (status) => {
 *             const subscriberConnIds = new Set(
 *               deps.subscribers.getSubscribers(agentId),
 *             );
 *             sink.publish({ agentId, status, subscriberConnIds });
 *           },
 *         });
 *       });
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
  // Both `connections` (for sink construction) and `subscribers`
  // (for snapshot at publish time) are load-bearing here; naming each
  // individually distinguishes this stub from the sibling
  // `createInternalFanOutEventSink` stub for sonarjs/no-identical-functions.
  void deps.connections;
  void deps.subscribers;
  void createInternalFanOutEventSink;
  void emitPresenceTransition;
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- architect stub body per SKILL.md "every stub body is exactly `throw new Error("not implemented")`"
  throw new Error("not implemented");
}
