/**
 * Network-layer RPC handler runtime — restricted Context and handler type.
 *
 * Key redesign vs `./context.ts`: a handler no longer closes over services
 * resolved at startup. Each handler's `Effect` declares its required
 * `Context` tag set; the router provides ONLY the tags permitted by the
 * network layer (`NetworkLayerOutputs` + `NetworkConnIdTag`). A handler that
 * requires `MessageServiceTag`, `AppHostTag`, or any other task-layer tag
 * fails to typecheck at registration time, not at runtime.
 *
 * Stub status — type declarations and signatures; bodies raise "not
 * implemented". The router wiring lives in `./network-router.ts`.
 */

import type { Effect } from "effect";
import type { RpcDefinition, Static, TSchema } from "@moltzap/protocol/network";
import type { RpcFailure } from "../runtime/index.js";
import type {
  NetworkLayerOutputs,
  NetworkConnIdTag,
  AgentId,
  UserId,
} from "../app/network-layer.js";

/* ── Authenticated context (passed by value, not via Context) ───────────── */

/**
 * Per-request authenticated principal. The router populates this from the
 * connection's stored session after a successful `auth/connect`. Passed as
 * a plain value (not a Context tag) because it changes on every request.
 */
export interface AuthenticatedContext {
  readonly agentId: AgentId;
  readonly agentStatus: "active" | "pending" | "suspended";
  readonly ownerUserId: UserId | null;
}

/* ── The permitted Context for network handlers ─────────────────────────── */

/**
 * The EXACT set of Context tags a network-layer handler may require. This
 * is the union type the router will provide. Any tag outside this union
 * causes a compile error at `defineNetworkMethod` because the handler's
 * inferred `R` type won't be assignable to `NetworkRequiredContext`.
 */
export type NetworkRequiredContext = NetworkLayerOutputs | NetworkConnIdTag;

/* ── Handler type ───────────────────────────────────────────────────────── */

/**
 * A network RPC handler. Returns an Effect that may fail with `RpcFailure`
 * (mapped 1:1 to a wire error frame) and requires a subset of
 * `NetworkRequiredContext`. `R extends NetworkRequiredContext` is the
 * compile-time boundary enforcement.
 */
export type NetworkRpcHandler<P = unknown, A = unknown> = (
  params: P,
  ctx: AuthenticatedContext,
) => Effect.Effect<A, RpcFailure, NetworkRequiredContext>;

/* ── Method definition record ───────────────────────────────────────────── */

/**
 * Discriminant-tagged network method record. The `layer: "network"` tag is
 * a runtime witness that mirrors the compile-time restriction on `R`.
 * The router inspects the tag to route dispatch through the network
 * `Layer.provide` path.
 */
export interface NetworkRpcMethodDef {
  readonly layer: "network";
  readonly handler: NetworkRpcHandler;
  readonly validator?: (params: unknown) => boolean;
  readonly requiresActive?: boolean;
}

/** Registry of network methods keyed by wire method string. */
export type NetworkRpcMethodRegistry = Readonly<
  Record<string, NetworkRpcMethodDef>
>;

/* ── Binder — manifest-driven method definition ─────────────────────────── */

/**
 * Type-safe manifest-driven binder for a network RPC method. The generic
 * parameter `R` is *inferred* from the handler's Effect and constrained to
 * `NetworkRequiredContext`. Passing a handler that requires (for example)
 * `MessageServiceTag` yields `R ⊉ NetworkRequiredContext` and a compile error.
 *
 *     defineNetworkMethod(AuthConnect, {
 *       handler: (params, ctx) => Effect.gen(function*() {
 *         const auth = yield* NetworkAuthServiceTag; // allowed
 *         // const msg = yield* MessageServiceTag;    // COMPILE ERROR
 *         ...
 *       }),
 *     })
 */
export function defineNetworkMethod<
  D extends RpcDefinition<string, TSchema, TSchema>,
  R extends NetworkRequiredContext,
>(
  _definition: D,
  _def: {
    readonly handler: (
      params: Static<D["paramsSchema"]>,
      ctx: AuthenticatedContext,
    ) => Effect.Effect<Static<D["resultSchema"]>, RpcFailure, R>;
    readonly requiresActive?: boolean;
  },
): NetworkRpcMethodDef {
  throw new Error("not implemented");
}
