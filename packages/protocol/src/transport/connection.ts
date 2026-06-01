/**
 * @file `Connection&lt;...&gt;` types + 3 specialized factories — Spec F G2,
 * cast-free slot cutover (#705 HALF-1).
 *
 * Each factory accepts an immutable {@link ErasedSlotTable} (server /
 * app client) and produces a `Connection` whose inbound surface is reified by
 * that slot table and whose outbound surface is constrained by the
 * kind's `OutCall` / `OutNotify` generics. Each slot is built by
 * {@link makeMiddlewareSlot}: the per-method capability discharge happens
 * INSIDE the slot (a STATIC `provideServiceEffect` chain, #705 HALF-2), so
 * the factory no longer threads a separate provider table.
 *
 * No `register` / `unregister` method exists on any Connection shape
 * (Spec F I1). The slot table is value-passed at construction time
 * and immutable thereafter.
 */
import { Effect, type Scope, Schema } from "effect";

import type {
  AnyAgentClientRpcDefinition,
  AnyAppCallableRpcDefinition,
  AnyAppCallbackRpcDefinition,
  AnyNotificationDefinition,
} from "../rpc-registry.js";
import type {
  NotificationDefinition,
  NotificationParamsOf,
  ParamsOf,
  ResultOf,
  RpcDefinition,
} from "./method.js";
import type { RpcCallError } from "./rpc-errors.js";
import type { NotConnectedError } from "./rpc-errors.js";
import type { ErasedSlotTable, SlotDispatchContext } from "./erased-slot.js";
import type { RequestFrame, ResponseFrame } from "./wire.js";
import {
  buildAgentClientDispatcher,
  buildServerDispatcher,
  buildAppClientDispatcher,
} from "./dispatch.js";

/**
 * Base shape shared by all three connection kinds. The outbound surface
 * (`call` + `notify`) is constrained per-kind via the `Out*` generics;
 * the inbound surface is reified by the handler-table the factory
 * received at construction.
 */
interface OutboundCall<
  OutCall extends RpcDefinition<
    string,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext
  >,
> {
  /**
   * Outbound RPC call. Constrained by the kind's outbound surface
   * (Spec F I5): the `definition` parameter must be a member of the
   * kind's `OutCall` union.
   */
  readonly call: <D extends OutCall>(
    definition: D,
    params: ParamsOf<D>,
  ) => Effect.Effect<ResultOf<D>, RpcCallError>;

  /**
   * Fail every in-flight outbound RPC with `error`. The originator's
   * scope finalizer drains pending on scope close with a generic
   * `NotConnectedError`; this method lets the surrounding transport
   * raise pending early with a transport-specific message (e.g. when
   * the WS reader exits before the consumer closes the scope).
   *
   * Idempotent: once drained, subsequent calls are no-ops.
   */
  readonly failAllPending: (error: NotConnectedError) => Effect.Effect<void>;
}

interface OutboundNotify<OutNotify> {
  /**
   * Outbound notification. The kind-constraint on `OutNotify` is
   * `NotificationDefinition&lt;string, TSchema&gt;` or `never`; the `notify`
   * method is `never`-typed for kinds that originate no notifications,
   * which surfaces a compile-time error at any call site.
   */
  readonly notify: <
    N extends OutNotify extends NotificationDefinition<
      string,
      Schema.Schema.AnyNoContext
    >
      ? OutNotify
      : never,
  >(
    definition: N,
    params: N extends NotificationDefinition<string, Schema.Schema.AnyNoContext>
      ? NotificationParamsOf<N>
      : never,
  ) => Effect.Effect<void>;
}

/**
 * Inbound RPC dispatch — drives one inbound `RequestFrame` through the
 * kind's {@link ErasedSlotTable}. The surrounding transport (socket
 * reader fiber, mock harness, etc.) calls `handle(frame, ctx)` per
 * inbound client-request frame; the dispatcher resolves the slot by
 * `frame.method`, calls `slot.invoke` (which decodes params + discharges
 * the method's declared capabilities INSIDE), and returns the
 * `ResponseFrame` ready for the wire. Every catalog slot is a real
 * handler post-R14b; the only dispatcher-synthesized response is
 * `MethodNotFound -32601` for an out-of-catalog `frame.method`.
 *
 * `Env` is the slot table's residual service-tag union (the `FullLive`
 * tags the surrounding `ManagedRuntime` resolves at request time, MINUS
 * the per-frame capability tags discharged inside each slot); `Conn` is
 * the kind's connection-ctx shape carried by `SlotDispatchContext`.
 */
interface InboundDispatch<Env, Conn> {
  /**
   * Dispatch one inbound request frame. Returns the wire-ready
   * `ResponseFrame` (success, registered tagged error, `InvalidParams`
   * when params fail schema decode, `InternalError` for an unmapped
   * defect, or `MethodNotFound` when `frame.method` is not in the
   * kind's catalog). The Effect's `R` channel is `Env` — the residual
   * service tags the surrounding `ManagedRuntime` resolves; per-frame
   * capabilities are already discharged inside the slot.
   */
  readonly handle: (
    frame: RequestFrame,
    ctx: SlotDispatchContext<Conn>,
  ) => Effect.Effect<ResponseFrame, never, Env>;

  /**
   * Resolve one inbound response frame against the originator's
   * pending deferreds. Returns `true` if a pending entry was
   * completed, `false` otherwise (late / unknown id). The surrounding
   * transport reader calls this for every inbound `ResponseFrame`.
   */
  readonly resolve: (frame: ResponseFrame) => Effect.Effect<boolean>;
}

/**
 * Stable identifier the surrounding transport assigns at acquisition.
 * Mirrors the server-side `Connection` arm's `connId`
 * (`packages/server/src/transport/connection.ts → Connection`) at the
 * id-reading sites.
 */
interface ConnectionIdentity {
  readonly id: string;
}

/**
 * `ServerConnection` — server side. Outbound surface is the
 * `AnyAppCallbackRpcDefinition` union: the server may call INTO an app
 * for `DispatchAuthorize` and `MessagesAuthorize`. Outbound notifications
 * are the full `AnyNotificationDefinition` set (the server originates
 * delivery + lifecycle notifications). Inbound surface is the closed
 * `serverRpcMethods` catalog, dispatched via the kind's
 * {@link ErasedSlotTable}.
 */
export interface ServerConnection<Env = unknown, Conn = unknown>
  extends ConnectionIdentity,
    InboundDispatch<Env, Conn>,
    OutboundCall<AnyAppCallbackRpcDefinition>,
    OutboundNotify<AnyNotificationDefinition> {}

/**
 * `AgentClientConnection` — plain agent client. Outbound surface is
 * the full `serverRpcMethods` catalog. Outbound notifications: none
 * (clients consume notifications; they do not originate them) — the
 * `notify` method is typed `never`, which fails any call site. No
 * inbound surface (the AgentClient kind's inbound catalog is empty).
 */
export interface AgentClientConnection
  extends ConnectionIdentity,
    OutboundCall<AnyAgentClientRpcDefinition>,
    OutboundNotify<never> {
  /**
   * Resolve one inbound response frame against the originator's
   * pending deferreds. The AgentClient originates outbound RPCs but
   * has no inbound RPC dispatch — only response correlation.
   */
  readonly resolve: (frame: ResponseFrame) => Effect.Effect<boolean>;
}

/**
 * `AppClientConnection` — the CLIENT-facing outbound connection a
 * moderating app drives (distinct from the SERVER-side `AppConnection`
 * arm in `packages/server/src/transport/connection.ts → AppConnection`,
 * which is the inbound app-authenticated socket state the server stores).
 * Outbound surface is the full `serverRpcMethods` catalog (an app client
 * is a superset of an AgentClient at the type level). Outbound
 * notifications: none. Inbound surface is the `appCallbackMethods`
 * catalog, dispatched via the kind's {@link ErasedSlotTable}; every slot
 * is a REQUIRED real handler (Spec D3 R14b retired the optional
 * `forbidden` / `noOpNotification` sentinels), so vacuous-deny moderators
 * must bind an explicit `ForbiddenError`-returning handler per catalog
 * method.
 */
export interface AppClientConnection<Env = unknown, Conn = unknown>
  extends ConnectionIdentity,
    InboundDispatch<Env, Conn>,
    OutboundCall<AnyAppCallableRpcDefinition>,
    OutboundNotify<never> {}

/**
 * Config record consumed by `makeServerConnection`. `slots` is the
 * kind's {@link ErasedSlotTable}: a `Record&lt;methodName, ErasedSlot&gt;`
 * each owning its typed `(definition, handler, providers)` triple. The
 * per-method capability discharge lives INSIDE each slot, so there is
 * no separate provider table on the config (the pre-HALF-1
 * `handlers` + `capabilities` pair).
 *
 * `Env` is the residual service-tag union each slot's `invoke` requires
 * (resolved by the surrounding `ManagedRuntime` at request time); `Conn`
 * is the dispatcher's connection-ctx shape (`SlotDispatchContext&lt;Conn&gt;`).
 *
 * `write` is the wire-level write effect the surrounding transport
 * supplies; `idPrefix` mirrors `makeOriginator`'s idPrefix convention
 * for the outbound app-callback path.
 */
export interface ServerConnectionConfig<Env, Conn> {
  readonly id: string;
  readonly slots: ErasedSlotTable<Env, Conn>;
  readonly write: (raw: string) => Effect.Effect<void, unknown>;
  readonly idPrefix: string;
}

/**
 * Equivalent config for the AgentClient factory. `slots` is the empty
 * table (the AgentClient kind's inbound catalog is empty); the factory
 * accepts it for forward compatibility (if a future spec adds
 * AgentClient-inbound RPCs, the slot table demands coverage).
 */
export interface AgentClientConnectionConfig<Env, Conn> {
  readonly id: string;
  readonly slots: ErasedSlotTable<Env, Conn>;
  readonly write: (raw: string) => Effect.Effect<void, unknown>;
  readonly idPrefix: string;
}

/**
 * Config for the app-client factory. The app owns the `appCallbackMethods`
 * catalog inbound; its outbound surface is the full `serverRpcMethods` catalog.
 */
export interface AppClientConnectionConfig<Env, Conn> {
  readonly id: string;
  readonly slots: ErasedSlotTable<Env, Conn>;
  readonly write: (raw: string) => Effect.Effect<void, unknown>;
  readonly idPrefix: string;
}

/**
 * Factory — server side. Delegates to `buildServerDispatcher`
 * (`dispatch.ts`) which wires:
 *   - inbound: per-frame dispatch via the kind's {@link ErasedSlotTable};
 *     each slot decodes params via its own validator + discharges the
 *     method's declared capabilities from its own positional providers
 *     tuple INSIDE `invoke`, so the dispatcher just routes and projects
 *     the slot's `Exit` to a wire response.
 *   - outbound: an internalized originator (formerly the body of
 *     `makeOriginator`) that mints `${idPrefix}-N` ids and tracks
 *     pending Deferreds. Scope finalizer drains pending Deferreds with
 *     `NotConnectedError`.
 */
export function makeServerConnection<Env, Conn>(
  config: ServerConnectionConfig<Env, Conn>,
): Effect.Effect<ServerConnection<Env, Conn>, never, Scope.Scope> {
  return buildServerDispatcher(config);
}

/**
 * Factory — agent client. Delegates to `buildAgentClientDispatcher`
 * which wires the originator only (no inbound dispatch — the AgentClient
 * kind's inbound catalog is empty, so `config.slots` is `{}`).
 */
export function makeAgentClientConnection<Env, Conn>(
  config: AgentClientConnectionConfig<Env, Conn>,
): Effect.Effect<AgentClientConnection, never, Scope.Scope> {
  return buildAgentClientDispatcher(config);
}

/**
 * Factory — app client. Delegates to `buildAppClientDispatcher` which
 * wires both the inbound dispatch loop (against `appCallbackMethods`)
 * and the outbound originator (against the full `serverRpcMethods` catalog).
 * Every app-inbound slot is REQUIRED. Spec D3 R14b retired the optional
 * sentinel defaults the prior shape carried; callers build the slot
 * table via `makeErasedSlot` per catalog method. Vacuous-deny
 * moderators bind an explicit `ForbiddenError`-returning handler for
 * each catalog method.
 */
export function makeAppClientConnection<Env, Conn>(
  config: AppClientConnectionConfig<Env, Conn>,
): Effect.Effect<AppClientConnection<Env, Conn>, never, Scope.Scope> {
  return buildAppClientDispatcher(config);
}
