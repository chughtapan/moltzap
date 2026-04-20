/**
 * Layer composition for the refactored server stack (arch-G module 5).
 *
 * Names `NetworkLayerLive`, `TaskLayerLive`, and `AppRuntimeLive`; wires
 * the service-tag graph that every handler resolves through. The router
 * provides `NetworkLayerLive` to network-surface handlers and
 * `TaskLayerLive` to task-surface handlers — forbidden tag access is a
 * compile-time error because the tag is simply not in the Layer's output
 * union.
 *
 * Replaces `packages/server/src/app/layers.ts` at implement-* time. Listed
 * under "files to remove at implement-* time" in the arch-G design doc —
 * every export migrated here is available with the same tag identity so
 * call sites only change their import path. The old file is deleted in the
 * same PR (spec clean-break).
 *
 * Stub status — every `Layer` is `declare const … : Layer.Layer<…>`. The
 * implement-* pass replaces each `declare` with a `Layer.effect(TAG, …)`.
 */

import type { Layer } from "effect";

import type {
  NetworkLayerOutputs,
  NetworkConnIdTag,
} from "../app/network-layer.js";
import type {
  ConnectionManagerTag,
  AgentEndpointResolverTag,
} from "../network/connection-manager.js";
import type { DeliveryServiceTag } from "../network/delivery-service.js";
import type {
  TaskServiceTag,
  AppHostTag,
  MessageStoreTag,
  HumanContactTag,
  TaskManagerRegistryTag,
  TaskConnIdTag,
  TaskConnectionId,
} from "../rpc/handler-runtime.js";

/* ── Base tier (Db + Logger) ──────────────────────────────────────────── */

/**
 * Base-tier tag union — supplied at process startup from the standalone
 * entry. `DbTag` and `LoggerTag` survive unchanged from the existing
 * `app/layers.ts`; canonical definitions migrate with the implement-* move.
 */
export type BaseTierInputs = DbTag | LoggerTag | EncryptionTag;

/** Placeholder tag forwards. Canonical: `../db/client.ts`, `../logger.ts`,
 *  `../crypto/envelope.ts`. Not duplicated here. */
export interface DbTag {
  readonly _: unique symbol;
}
export interface LoggerTag {
  readonly _: unique symbol;
}
export interface EncryptionTag {
  readonly _: unique symbol;
}

/* ── NetworkLayerLive ─────────────────────────────────────────────────── */

/**
 * Outputs of `NetworkLayerLive`. Superset of arch-A's `NetworkLayerOutputs`
 * (which published the four narrow service tags) extended with the arch-G
 * concrete tags:
 *
 *   - `ConnectionManagerTag`      — endpoint registry (module 1)
 *   - `DeliveryServiceTag`        — `send(to, payload)` primitive (module 2)
 *   - `AgentEndpointResolverTag`  — AgentId → EndpointAddress (module 1)
 *
 * The four arch-A tags (`NetworkConnectionManagerTag`,
 * `NetworkDeliveryServiceTag`, `NetworkAuthServiceTag`,
 * `ContactCheckServiceTag`) remain — the arch-G `ConnectionManager` impl
 * satisfies the arch-A read-surface interface; the two delivery tags name
 * the SAME runtime instance (the concrete instance provides both
 * interfaces — one narrow, one full). Implement-* wires the single instance
 * through both tags.
 */
export type NetworkLayerFullOutputs =
  | NetworkLayerOutputs
  | ConnectionManagerTag
  | DeliveryServiceTag
  | AgentEndpointResolverTag;

/**
 * Provides every network-layer service tag. Requires `BaseTierInputs`
 * (Db + Logger + Encryption). Provides NO task-layer tag — that is the
 * structural guarantee behind spec Invariant 16.
 *
 * `Layer.mergeAll(ConnectionManagerLive, DeliveryServiceLive,
 * AgentEndpointResolverLive, NetworkAuthServiceLive, ContactCheckServiceLive)`
 * at implement-* time; each Layer's inputs resolve against `BaseTierInputs`
 * + sibling network outputs (ConnectionManager is the only cross-sibling
 * dep — DeliveryService and AgentEndpointResolver both consume it).
 */
export declare const NetworkLayerLive: Layer.Layer<
  NetworkLayerFullOutputs,
  never,
  BaseTierInputs
>;

/* ── TaskLayerLive ─────────────────────────────────────────────────────── */

/**
 * Outputs of `TaskLayerLive`. Includes every network output (the task
 * layer is built ON TOP of the network layer — spec Invariant 6) plus the
 * task-surface service tags.
 *
 *   - `TaskServiceTag`           — the 12-method CRUD surface (spec Invariant 7).
 *   - `AppHostTag`               — app runtime; survives the refactor.
 *   - `MessageStoreTag`          — message persistence; yields Effect + typed errors.
 *   - `HumanContactTag`          — unified human-contact abstraction (spec Invariant 12).
 *   - `TaskManagerRegistryTag`   — taskId → TaskManager resolver.
 *   - `TaskConnIdTag`            — request-scoped conn id for task handlers.
 *
 * `TaskServiceTag` is abstract here (its concrete surface is defined by
 * arch-C; arch-G names it so the Layer shape is frozen).
 *
 * Forbidden: appending an identity-layer tag that is NOT in the union
 * above would widen `TaskLayerOutputs` and silently admit identity tags
 * into task handlers. The union is closed here and in
 * `handler-runtime.TaskRequiredContext`; adding a new task-surface
 * capability means editing BOTH locations intentionally.
 */
export type TaskLayerOutputs =
  | NetworkLayerFullOutputs
  | TaskServiceTag
  | AppHostTag
  | MessageStoreTag
  | HumanContactTag
  | TaskManagerRegistryTag
  | TaskConnIdTag;

/**
 * Provides every task-layer service tag (plus every network tag, since the
 * task layer consumes `DeliveryService.send` for participant fan-out).
 * Requires `BaseTierInputs`.
 */
export declare const TaskLayerLive: Layer.Layer<
  TaskLayerOutputs,
  never,
  BaseTierInputs
>;

/* ── AppRuntimeLive ────────────────────────────────────────────────────── */

/**
 * Per-process top-level runtime. Composes `TaskLayerLive` (which transitively
 * provides `NetworkLayerLive`) with the base tier. `server.ts` /
 * `standalone.ts` build their `Runtime` from this. Nothing above this
 * layer is in arch-G scope — process bootstrap (env parsing, migration
 * runner, HTTP server start) remains unchanged.
 */
export declare const AppRuntimeLive: Layer.Layer<
  TaskLayerOutputs,
  never,
  never
>;

/* ── Router wiring ─────────────────────────────────────────────────────── */

/**
 * Network-handler dispatcher adapter. Applies `Effect.provide(NetworkLayerLive)`
 * + `Effect.provideService(NetworkConnIdTag, connId)` to each handler
 * Effect before running.
 *
 * The router's network path resolves ONLY `NetworkLayerFullOutputs` — a
 * network handler whose inferred `R` includes (for example) `TaskServiceTag`
 * fails to typecheck at `defineNetworkMethod` (arch-A). This Layer is the
 * RUNTIME-side witness of that same constraint: providing it satisfies
 * exactly the tags the compile-time constraint permitted.
 */
export declare const provideNetworkLayer: <A, E>(
  handler: import("effect").Effect.Effect<
    A,
    E,
    NetworkLayerFullOutputs | NetworkConnIdTag
  >,
  connId: import("../app/network-layer.js").ConnectionId,
) => import("effect").Effect.Effect<A, E, never>;

/**
 * Task-handler dispatcher adapter. Mirror of `provideNetworkLayer` for the
 * task surface.
 */
export declare const provideTaskLayer: <A, E>(
  handler: import("effect").Effect.Effect<A, E, TaskLayerOutputs>,
  connId: TaskConnectionId,
) => import("effect").Effect.Effect<A, E, never>;

/* ── Not-implemented stub bodies ───────────────────────────────────────── */

/**
 * Implementation helper stub. Arch-G does not ship Layer bodies; every
 * `declare const` above becomes a `Layer.effect` at implement-* time.
 */
export declare const __archGNotImplemented: never;
