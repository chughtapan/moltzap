/**
 * Handler-runtime contract — per-surface Effect `Context` constraints +
 * manifest-driven binders for the two handler surfaces (arch-G).
 *
 * Arch-A established `defineNetworkMethod<D, R>` and `NetworkRequiredContext`
 * for the network surface (`packages/server/src/rpc/network-context.ts`).
 * Arch-G adds the task-surface twin (`defineTaskMethod<D, R>`,
 * `TaskRequiredContext`) AND the router-facing discriminated union that a
 * per-process dispatcher uses to route a frame to the correct surface.
 *
 * Boundary enforcement (spec Invariants 16–18): a task handler may NOT
 * yield a network-only tag not listed in `TaskRequiredContext`; a network
 * handler may NOT yield `TaskServiceTag`, `AppHostTag`, `MessageStoreTag`,
 * `HumanContactTag` (already enforced by arch-A). Both rules are compile-
 * time: `R extends <Surface>RequiredContext` on the binder generic.
 *
 * The negative type-test snippet that asserts a forbidden tag fails
 * `tsc --build` lives at `handler-runtime.type-test.ts` (sibling file,
 * placeholder `it.todo(...)` entries filled by implement-*).
 *
 * Stub status — type declarations and signatures only. Binder bodies raise
 * "not implemented".
 */

import type { Effect, Context } from "effect";
import type { RpcDefinition, Static, TSchema } from "@moltzap/protocol/network";
import type { RpcFailure } from "../runtime/index.js";
import type {
  NetworkRequiredContext,
  NetworkRpcMethodDef,
  AuthenticatedContext,
} from "./network-context.js";

/* ── Task-surface required context ─────────────────────────────────────── */

/**
 * The EXACT set of Context tags a task-layer RPC handler may yield. The
 * task layer may reach INTO the network layer for delivery (spec
 * Invariant 6: fan-out is `Effect.forEach(participants, send)`), so the
 * network outputs are included here as a subset.
 *
 * Declared as an abstract union; the concrete tag unions are imported from
 * `../app/network-layer.js` (arch-A) and `../runtime/layers.js` (arch-G
 * module 5). This file does not import the task-layer service modules
 * directly — only their tag types — so the handler runtime can sit at the
 * `rpc/` tier without pulling service implementations into its transitive
 * closure.
 */
export type TaskRequiredContext =
  | NetworkRequiredContext
  | TaskServiceTag
  | AppHostTag
  | MessageStoreTag
  | HumanContactTag
  | TaskManagerRegistryTag
  | TaskConnIdTag;

/* ── Task-surface tag forward declarations ─────────────────────────────── */
/*
 * These tag types are materialized in `../runtime/layers.js` (module 5).
 * Forward-declared here so the handler-runtime module does not depend on
 * the service-implementation modules.
 */

export interface TaskServiceTag {
  readonly _: unique symbol;
}
export declare const TaskServiceTag: Context.Tag<
  TaskServiceTag,
  TaskServiceSurface
>;

export interface AppHostTag {
  readonly _: unique symbol;
}
export declare const AppHostTag: Context.Tag<AppHostTag, AppHostSurface>;

export interface MessageStoreTag {
  readonly _: unique symbol;
}
export declare const MessageStoreTag: Context.Tag<
  MessageStoreTag,
  MessageStoreSurface
>;

export interface HumanContactTag {
  readonly _: unique symbol;
}
export declare const HumanContactTag: Context.Tag<
  HumanContactTag,
  HumanContactSurface
>;

export interface TaskManagerRegistryTag {
  readonly _: unique symbol;
}
export declare const TaskManagerRegistryTag: Context.Tag<
  TaskManagerRegistryTag,
  TaskManagerRegistrySurface
>;

/** Request-scoped connection id for the task surface. Branded — same shape as
 *  the network-layer `ConnectionId` brand. Raw `string` here was a review
 *  finding (codex #5); branding prevents cross-use of arbitrary strings as
 *  conn ids. */
export type TaskConnectionId = string & {
  readonly __brand: "TaskConnectionId";
};

export interface TaskConnIdTag {
  readonly _: unique symbol;
}
export declare const TaskConnIdTag: Context.Tag<
  TaskConnIdTag,
  TaskConnectionId
>;

/* ── Placeholder surfaces (materialized by arch-G module 5) ────────────── */

/** Concrete shape defined in `../runtime/layers.js`. Opaque here. */
export interface TaskServiceSurface {
  readonly _: unique symbol;
}
export interface AppHostSurface {
  readonly _: unique symbol;
}
export interface MessageStoreSurface {
  readonly _: unique symbol;
}
export interface HumanContactSurface {
  readonly _: unique symbol;
}
export interface TaskManagerRegistrySurface {
  readonly _: unique symbol;
}

/* ── Task handler type + method def ────────────────────────────────────── */

/**
 * A task-layer RPC handler. Fails with `RpcFailure` (mapped 1:1 to a wire
 * error frame) and requires a subset of `TaskRequiredContext`.
 *
 *   R extends TaskRequiredContext
 *
 * is the compile-time boundary: a handler that yields a tag outside that
 * union fails at `defineTaskMethod` registration.
 */
export type TaskRpcHandler<P = unknown, A = unknown> = (
  params: P,
  ctx: AuthenticatedContext,
) => Effect.Effect<A, RpcFailure, TaskRequiredContext>;

/** Discriminant-tagged task method record. Mirrors `NetworkRpcMethodDef`. */
export interface TaskRpcMethodDef {
  readonly layer: "task";
  readonly handler: TaskRpcHandler;
  readonly validator?: (params: unknown) => boolean;
  readonly requiresActive?: boolean;
}

/** Registry of task methods keyed by wire method string. */
export type TaskRpcMethodRegistry = Readonly<Record<string, TaskRpcMethodDef>>;

/* ── Task binder ──────────────────────────────────────────────────────── */

/**
 * Manifest-driven binder for a task-layer RPC method. Mirrors
 * `defineNetworkMethod`. The generic `R` is inferred from the handler's
 * Effect and constrained to `TaskRequiredContext`.
 *
 *     defineTaskMethod(MessagesSend, {
 *       handler: (params, ctx) => Effect.gen(function*() {
 *         const svc = yield* TaskServiceTag;        // allowed
 *         const del = yield* NetworkDeliveryServiceTag; // allowed (network subset)
 *         ...
 *       }),
 *     })
 *
 * Forbidden tag access (for example an agent ID being pulled from an
 * identity-layer tag that's not in `TaskRequiredContext`) fails at this
 * generic constraint — not at runtime.
 */
export function defineTaskMethod<
  D extends RpcDefinition<string, TSchema, TSchema>,
  R extends TaskRequiredContext,
>(
  _definition: D,
  _def: {
    readonly handler: (
      params: Static<D["paramsSchema"]>,
      ctx: AuthenticatedContext,
    ) => Effect.Effect<Static<D["resultSchema"]>, RpcFailure, R>;
    readonly requiresActive?: boolean;
  },
): TaskRpcMethodDef {
  throw new Error("not implemented");
}

/* ── Cross-surface dispatcher record ───────────────────────────────────── */

/**
 * The server hosts two logical routers side-by-side. The process-level
 * router reads the method name from an incoming frame, looks it up in the
 * combined registry, and routes based on `layer` to the correct surface's
 * `Effect.provide(<layer>LayerLive)` call.
 *
 * Closed on `layer` so `switch (m.layer) { default: absurd(m.layer) }`
 * stays exhaustive as future surfaces are added only through this file.
 */
export type AnyRpcMethodDef = NetworkRpcMethodDef | TaskRpcMethodDef;

/** Combined registry. Method names must not collide across surfaces — the
 *  router asserts disjointness at construction. Kept as two maps rather than
 *  a flattened `Record<string, AnyRpcMethodDef>` so the router preserves the
 *  per-surface type discriminant at the dispatch site (see `AnyRpcMethodDef`
 *  comment above). The flat shape was considered and rejected: flattening
 *  loses the `layer` tag at the type level, which the exhaustive-match
 *  dispatcher relies on. */
export interface CombinedRegistry {
  readonly network: Readonly<Record<string, NetworkRpcMethodDef>>;
  readonly task: TaskRpcMethodRegistry;
}

/** Caller supplied overlapping method names across the two surfaces. Defect —
 *  the router cannot route a name that is claimed by both surfaces. */
export class RegistryCollision {
  readonly _tag = "RegistryCollision" as const;
  constructor(readonly methods: ReadonlyArray<string>) {
    throw new Error("not implemented");
  }
}

/**
 * Build the combined registry from two surface-specific registries. Fails
 * with `RegistryCollision` naming every offending method. Total — the
 * error is on the Effect channel, not a thrown exception (spec Invariant:
 * typed errors, not thrown).
 */
export declare const combineRegistries: (
  network: Readonly<Record<string, NetworkRpcMethodDef>>,
  task: TaskRpcMethodRegistry,
) => Effect.Effect<CombinedRegistry, RegistryCollision, never>;
