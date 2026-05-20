/**
 * @file Per-kind handler-table type aliases.
 *
 * Three closed catalogs of inbound RPC methods, one per connection
 * kind. Each catalog yields an object type whose keys are the catalog
 * member's `name` and whose values are either `HandlerSlot&lt;...>` (a
 * real implementation) OR a sentinel value (`forbidden`,
 * `noOpNotification`) for OPTIONAL slots that the caller is explicitly
 * declining to implement.
 *
 * Every protocol slot MUST appear in every handler-table literal —
 * there is no `?:` field-level optionality. An optional slot is one
 * whose definition carries `optional: FailClosedDefault`; its value
 * type widens to `HandlerSlot | Forbidden` (or `NoOpNotification`),
 * forcing the caller to pick explicitly.
 */
import type { Context, Effect } from "effect";
import type { TSchema } from "@sinclair/typebox";

import type {
  serverRpcMethods,
  AnyTaskCallbackRpcDefinition,
} from "../rpc-registry.js";

import type { ParamsOf, ResultOf, RpcDefinition } from "./method.js";

import type { CapabilitiesOf } from "./capabilities.js";

import type { Forbidden, NoOpNotification } from "./defaults.js";

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
  Caps extends Context.Tag<any, any>,
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
 * Per-slot value type. REQUIRED slots resolve to plain
 * `HandlerSlot&lt;D, Ctx, Caps>`. OPTIONAL slots widen to a union with
 * the matching sentinel — `HandlerSlot | Forbidden` for slots whose
 * descriptor carries `optional: forbidden`; `HandlerSlot |
 * NoOpNotification` for the notification variant.
 *
 * The caller passes the sentinel value at the handler-table literal
 * site (`makeServerConnection({ handlers: { "messages/authorize":
 * forbidden, ... } })`). The dispatcher reads the value at runtime;
 * sentinel ⇒ synthesize fail-CLOSED, handler ⇒ invoke.
 */
type SlotValue<D, Ctx, Caps extends Context.Tag<any, any>> = D extends {
  readonly optional: { readonly _tag: "Forbidden" };
}
  ? D extends RpcDefinition<string, TSchema, TSchema>
    ? HandlerSlot<D, Ctx, Caps> | Forbidden
    : never
  : D extends { readonly optional: { readonly _tag: "NoOpNotification" } }
    ? D extends RpcDefinition<string, TSchema, TSchema>
      ? HandlerSlot<D, Ctx, Caps> | NoOpNotification
      : never
    : D extends RpcDefinition<string, TSchema, TSchema>
      ? HandlerSlot<D, Ctx, Caps>
      : never;

/**
 * Closed handler-table type generated from a definition union. Every
 * catalog member appears as a structurally-required key; OPTIONAL
 * slots widen their value type to include the matching sentinel.
 *
 * Type-parameter erasure note: `RpcDefinition` is variant across `Name`
 * — the catalog `typeof serverRpcMethods[number]` resolves to a union of the
 * concrete `RpcDefinition&lt;"identity/register", ...>` etc. arms; the
 * mapped type preserves each arm's `name` literal so the resulting
 * table has named keys.
 */
export type HandlerTable<
  Defs extends RpcDefinition<string, TSchema, TSchema>,
  Ctx,
  Caps extends Context.Tag<any, any>,
> = {
  readonly [D in Defs as NameOf<D>]: SlotValue<D, Ctx, Caps>;
};

/**
 * Server-side inbound RPC catalog — every method an agent client may
 * call into the server. LSP-anchored: the catalog is `serverRpcMethods` from
 * `rpc-registry.ts`, which composes `identityRpcMethods`,
 * `networkRpcMethods`, `taskRpcMethods`, and `appRpcMethods`. 42
 * members at `227c398`.
 */
export type ServerInboundRpcDefinition = (typeof serverRpcMethods)[number] &
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
  Caps extends Context.Tag<any, any> = never,
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
  Caps extends Context.Tag<any, any> = never,
> = HandlerTable<never, Ctx, Caps>;

/**
 * `TaskMasterHandlers` — handler table for an agent acting as TM for
 * one or more tasks. Catalog: `taskCallbackMethods` —
 * `DispatchAuthorize`, `MessagesAuthorize`. Both descriptors carry
 * `optional: forbidden`, so handler-table literals must name each key
 * but may supply the `forbidden` sentinel; the dispatcher synthesizes
 * `-32001 ForbiddenError` for those.
 */
export type TaskMasterInboundRpcDefinition = AnyTaskCallbackRpcDefinition;

export type TaskMasterHandlers<
  Ctx,
  Caps extends Context.Tag<any, any> = never,
> = HandlerTable<TaskMasterInboundRpcDefinition, Ctx, Caps>;

/**
 * Per-slot capability extractor. Distributes over the slot's value
 * union (`HandlerSlot | Forbidden` / `HandlerSlot | NoOpNotification` /
 * plain `HandlerSlot`) so sentinel arms contribute `never` and real
 * `HandlerSlot` arms contribute `CapabilitiesOf&lt;D>`.
 */
type SlotCaps<V> = V extends { readonly definition: infer D }
  ? CapabilitiesOf<D>
  : never;

/**
 * Capability-union extractor: union of every capability tag referenced
 * across all real `HandlerSlot` arms in the table. The factory's
 * signature uses this to demand a `CapabilityProviderTable&lt;CapsUnionOf&lt;T>>`.
 */
export type CapsUnionOf<T> = {
  [K in keyof T]: SlotCaps<T[K]>;
}[keyof T];
