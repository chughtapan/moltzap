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
 * entry. Re-exports the canonical tag classes so this module's "same tag
 * identity" promise (at the file-level docstring above) actually holds:
 * `Effect.Context` uses class-reference identity, so two separately-declared
 * placeholder interfaces would resolve against the real service tags as
 * different keys. Round-2 codex review flagged the earlier placeholder form.
 *
 *   - `DbTag` / `EncryptionTag` — canonical source `../app/layers.js`
 *     (existing arch-A-era layers file; implement-* will migrate both to
 *     dedicated modules under `../db/` and `../crypto/` respectively,
 *     preserving identity via re-export).
 *   - `LoggerTag` — canonical source `../logger.js`
 *     (`Context.Tag("moltzap/Logger")`; survives the refactor unchanged).
 */
export { DbTag, EncryptionTag } from "../app/layers.js";
export { LoggerTag } from "../logger.js";
import type { DbTag, EncryptionTag } from "../app/layers.js";
import type { LoggerTag } from "../logger.js";

export type BaseTierInputs = DbTag | LoggerTag | EncryptionTag;

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
 *
 * `TaskConnIdTag` is intentionally NOT in this union. It is request-scoped
 * (each incoming RPC gets a fresh conn id), so it's provided per-request
 * via `Effect.provideService(TaskConnIdTag, connId)` at the task-handler
 * dispatcher (see `provideTaskLayer` below) — symmetric with how
 * `NetworkConnIdTag` is handled by arch-A's `provideNetworkLayer`. Round-2
 * codex review flagged the earlier inclusion as a scope asymmetry.
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
  | TaskManagerRegistryTag;

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
 * task surface. Applies `Effect.provide(TaskLayerLive)` + per-request
 * `Effect.provideService(TaskConnIdTag, connId)` — the conn-id tag is NOT
 * in `TaskLayerOutputs` (it's request-scoped, not process-scoped), so the
 * handler's `R` lists it explicitly.
 */
export declare const provideTaskLayer: <A, E>(
  handler: import("effect").Effect.Effect<
    A,
    E,
    TaskLayerOutputs | TaskConnIdTag
  >,
  connId: TaskConnectionId,
) => import("effect").Effect.Effect<A, E, never>;

/* ── Not-implemented stub bodies ───────────────────────────────────────── */

/**
 * Implementation helper stub. Arch-G does not ship Layer bodies; every
 * `declare const` above becomes a `Layer.effect` at implement-* time.
 */
export declare const __archGNotImplemented: never;
