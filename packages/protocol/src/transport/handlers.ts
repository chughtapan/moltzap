/**
 * @file Per-kind handler-table type aliases — Spec F G3.
 *
 * Three closed catalogs of inbound RPC methods, one per connection
 * kind. Each catalog yields an object type whose keys are the catalog
 * member's `name` and whose values are `HandlerSlot&lt;...&gt;` (a record
 * carrying the per-definition handler effect). REQUIRED slots are
 * structurally required; OPTIONAL slots (those whose definition carries
 * `slotDisposition.optional`) are marked optional via a mapped-type
 * branch.
 *
 * The catalogs are LSP-anchored to the current `rpc-registry.ts`
 * aggregator state (`origin/main` @ `227c398`) — `identityRpcMethods`
 * (11) + `networkRpcMethods` (4) + `taskRpcMethods` (24) +
 * `appRpcMethods` (3) for the Server kind; `taskCallbackMethods` (2)
 * for the TaskMaster kind; the empty set for AgentClient. Any future
 * `rpcMethods` mutation (D1 / D3 additions or deletions) propagates
 * through these type aliases via the `typeof rpcMethods[number]`
 * derivation; no architect re-partitioning needed.
 */
import type { Context, Effect } from "effect";
import type { TSchema } from "@sinclair/typebox";

import type {
  rpcMethods,
  AnyTaskCallbackRpcDefinition,
} from "../rpc-registry.js";

import type { ParamsOf, ResultOf, RpcDefinition } from "./method.js";

import type { CapabilitiesOf } from "./capabilities.js";

import type { IsOptionalSlot } from "./defaults.js";

/**
 * Per-definition handler slot. `Ctx` is the dispatch context the
 * server side hands to every handler. `Caps` is the upper bound on
 * which `Context.Tag`s the handler's R channel may reference; the
 * dispatcher provides exactly these from the `CapabilityProviderTable`.
 *
 * The Caps type-level gate (handler R channel ⊆ `CapabilitiesOf&lt;D&gt;`)
 * lives in `typed-dispatcher.types-check.ts`. The impl-staff PR
 * populates per-definition `capabilities` and the gate becomes
 * exercisable.
 */
export interface HandlerSlot<
  D extends RpcDefinition<string, TSchema, TSchema>,
  Ctx,
  Caps extends Context.Tag<unknown, unknown>,
> {
  readonly definition: D;
  readonly handle: (
    params: ParamsOf<D>,
    ctx: Ctx,
  ) => Effect.Effect<ResultOf<D>, unknown, Caps>;
}

/**
 * Extract the raw `Name` literal from `RpcDefinition&lt;Name, P, R&gt;`,
 * bypassing the brand intersection on `D["name"]` (`JsonRpcMethod&lt;Name&gt;
 * = Name &amp; Brand&lt;"JsonRpcMethod"&gt;`) which would widen the mapped-type
 * key to `string` and erase the per-method required property names.
 */
type NameOf<D> = D extends RpcDefinition<infer N, TSchema, TSchema> ? N : never;

/**
 * Type-level partition: an object whose keys are the REQUIRED slot
 * names (`NameOf&lt;D&gt;` where D's slotDisposition is absent) and whose
 * values are `HandlerSlot&lt;D, Ctx, Caps&gt;`. Stripping members for which
 * `IsOptionalSlot&lt;D&gt;` is `true` is performed by the `as` re-key clause.
 */
type RequiredSlots<
  Defs extends RpcDefinition<string, TSchema, TSchema>,
  Ctx,
  Caps extends Context.Tag<unknown, unknown>,
> = {
  readonly [D in Defs as IsOptionalSlot<D> extends true
    ? never
    : NameOf<D>]: D extends RpcDefinition<string, TSchema, TSchema>
    ? HandlerSlot<D, Ctx, Caps>
    : never;
};

/**
 * Type-level partition counterpart for OPTIONAL slots. Each slot key
 * is suffixed `?` so consumers may omit it. The dispatcher resolves
 * omitted optional slots to the protocol's baked-in fail-CLOSED default
 * at runtime.
 */
type OptionalSlots<
  Defs extends RpcDefinition<string, TSchema, TSchema>,
  Ctx,
  Caps extends Context.Tag<unknown, unknown>,
> = {
  readonly [D in Defs as IsOptionalSlot<D> extends true
    ? NameOf<D>
    : never]?: D extends RpcDefinition<string, TSchema, TSchema>
    ? HandlerSlot<D, Ctx, Caps>
    : never;
};

/**
 * Closed handler-table type generated from a definition union. Required
 * keys must be present (TS2741 if omitted); optional keys may be absent.
 *
 * Type-parameter erasure note: `RpcDefinition` is variant across `Name`
 * — the catalog `typeof rpcMethods[number]` resolves to a union of the
 * concrete `RpcDefinition&lt;"identity/register", ...&gt;` etc. arms; the
 * mapped types preserve each arm's `name` literal so the resulting
 * table has named keys.
 */
export type HandlerTable<
  Defs extends RpcDefinition<string, TSchema, TSchema>,
  Ctx,
  Caps extends Context.Tag<unknown, unknown>,
> = RequiredSlots<Defs, Ctx, Caps> & OptionalSlots<Defs, Ctx, Caps>;

/**
 * Server-side inbound RPC catalog — every method an agent client may
 * call into the server. LSP-anchored: the catalog is `rpcMethods` from
 * `rpc-registry.ts`, which composes `identityRpcMethods`,
 * `networkRpcMethods`, `taskRpcMethods`, and `appRpcMethods`. 42
 * members at `227c398`.
 */
export type ServerInboundRpcDefinition = (typeof rpcMethods)[number] &
  RpcDefinition<string, TSchema, TSchema>;

/**
 * `ServerHandlers` — handler table for the server side. `Ctx` defaults
 * to the dispatch context the server's `defineMethod` wrapper exposes
 * (see `packages/server/src/transport/context.ts → DispatchContext`).
 * `Caps` is the union of `Context.Tag` instances the table's slots
 * declare; the factory infers it from the literal.
 */
export type ServerHandlers<
  Ctx,
  Caps extends Context.Tag<unknown, unknown> = never,
> = HandlerTable<ServerInboundRpcDefinition, Ctx, Caps>;

/**
 * `AgentClientHandlers` — handler table for a plain agent client. The
 * inbound catalog is empty (an AgentClient receives notifications + RPC
 * responses; server-initiated RPCs go to a TM, not a generic client).
 * Resolves to `{}` so the literal `{}` is always well-typed; future
 * AgentClient-inbound RPC additions extend the catalog and propagate
 * through this alias.
 *
 * The `Ctx` / `Caps` generics are retained so future
 * AgentClient-inbound RPC additions get the same Ctx/Caps threading
 * as Server and TM. The mapped type evaluates to `{}` when the
 * catalog union is `never`, satisfying both knip and the type's intent.
 */
export type AgentClientHandlers<
  Ctx,
  Caps extends Context.Tag<unknown, unknown> = never,
> = HandlerTable<never, Ctx, Caps>;

/**
 * `TaskMasterHandlers` — handler table for an agent acting as TM for
 * one or more tasks. LSP-anchored: the catalog is `taskCallbackMethods`
 * — `DispatchAuthorize`, `MessagesAuthorize`. Both slots' impl-staff
 * `defineRpc` calls carry `slotDisposition: optionalForbidden`, which
 * makes both slots OPTIONAL with fail-CLOSED `ForbiddenError` (-32001)
 * defaults. The stub branch leaves them REQUIRED (no slotDisposition
 * yet); impl-staff relaxes.
 */
export type TaskMasterInboundRpcDefinition = AnyTaskCallbackRpcDefinition;

export type TaskMasterHandlers<
  Ctx,
  Caps extends Context.Tag<unknown, unknown> = never,
> = HandlerTable<TaskMasterInboundRpcDefinition, Ctx, Caps>;

/**
 * Capability-union extractor: union of every capability tag referenced
 * across all slots in the handler table. The factory's signature uses
 * this to demand a `CapabilityProviderTable&lt;CapsUnionOf&lt;T&gt;&gt;`.
 */
export type CapsUnionOf<T> = {
  [K in keyof T]: T[K] extends { readonly definition: infer D }
    ? CapabilitiesOf<D>
    : never;
}[keyof T];
