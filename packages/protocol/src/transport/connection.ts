/**
 * @file `Connection&lt;...&gt;` types + 3 specialized factories — Spec F G2.
 *
 * Each factory accepts an immutable handler table (server / TM) and
 * produces a `Connection` whose inbound surface is reified by that
 * table and whose outbound surface is constrained by the kind's
 * `OutCall` / `OutNotify` generics.
 *
 * No `register` / `unregister` method exists on any Connection shape
 * (Spec F I1). The handler table is value-passed at construction time
 * and immutable thereafter.
 */
import { Effect, type Context, type Scope } from "effect";
import type { TSchema } from "@sinclair/typebox";

import type {
  AnyAgentClientRpcDefinition,
  AnyTaskMasterRpcDefinition,
  AnyTaskCallbackRpcDefinition,
  AnyNotificationDefinition,
} from "../rpc-registry.js";
import type {
  NotificationDefinition,
  NotificationParamsOf,
  ParamsOf,
  ResultOf,
  RpcDefinition,
} from "./method.js";
import type { RpcCallError } from "./originator.js";
import type { NotConnectedError } from "./rpc-errors.js";
import type {
  ServerHandlers,
  AgentClientHandlers,
  TaskMasterHandlers,
  CapsUnionOf,
} from "./handlers.js";
import type { CapabilityProviderTable } from "./capabilities.js";
import type { RequestFrame, ResponseFrame } from "./wire.js";
import {
  buildAgentClientDispatcher,
  buildServerDispatcher,
  buildTaskMasterDispatcher,
} from "./dispatch.js";

/**
 * Base shape shared by all three connection kinds. The outbound surface
 * (`call` + `notify`) is constrained per-kind via the `Out*` generics;
 * the inbound surface is reified by the handler-table the factory
 * received at construction.
 */
interface OutboundCall<
  OutCall extends RpcDefinition<string, TSchema, TSchema>,
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
    N extends OutNotify extends NotificationDefinition<string, TSchema>
      ? OutNotify
      : never,
  >(
    definition: N,
    params: N extends NotificationDefinition<string, TSchema>
      ? NotificationParamsOf<N>
      : never,
  ) => Effect.Effect<void>;
}

/**
 * Inbound RPC dispatch — drives one inbound `RequestFrame` through the
 * kind's static handler table. The surrounding transport (socket reader
 * fiber, mock harness, etc.) calls `handle(frame, ctx)` per inbound
 * client-request frame; the dispatcher resolves the slot by
 * `frame.method`, runs the handler (or synthesizes the fail-CLOSED
 * default), and returns the `ResponseFrame` ready for the wire.
 */
interface InboundDispatch<Ctx, R = never> {
  /**
   * Dispatch one inbound request frame. Returns the wire-ready
   * `ResponseFrame` (success, registered tagged error, fail-CLOSED
   * default, or MethodNotFound). The Effect's `R` channel surfaces
   * any unresolved capability tags the handler's body still requires
   * (with full Spec F Shape-B metadata threaded, this collapses to
   * `never`; stub state retains `R` for ergonomic generic propagation).
   */
  readonly handle: (
    frame: RequestFrame,
    ctx: Ctx,
  ) => Effect.Effect<ResponseFrame, never, R>;

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
 * Mirrors `MoltZapConnection.id` from `packages/server/src/transport/
 * connection.ts → MoltZapConnection` so impl-staff can replace that
 * shape with the new typed Connection without consumer churn at the
 * id-reading sites.
 */
interface ConnectionIdentity {
  readonly id: string;
}

/**
 * `ServerConnection` — server side. Outbound surface is the
 * `AnyTaskCallbackRpcDefinition` union: the server may call INTO a TM
 * for `DispatchAuthorize` and `MessagesAuthorize`. Outbound notifications
 * are the full `AnyNotificationDefinition` set (the server originates
 * delivery + lifecycle notifications). Inbound surface is the closed
 * `serverRpcMethods` catalog, dispatched via the static `ServerHandlers` table.
 */
export interface ServerConnection<Ctx = unknown, R = never>
  extends ConnectionIdentity,
    InboundDispatch<Ctx, R>,
    OutboundCall<AnyTaskCallbackRpcDefinition>,
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
 * `TaskMasterConnection` — agent acting as TM. Outbound surface is the
 * full `serverRpcMethods` catalog (a TM is a superset of an AgentClient at the
 * type level). Outbound notifications: none. Inbound surface is the
 * `taskCallbackMethods` catalog, dispatched via the static
 * `TaskMasterHandlers` table (both slots optional with fail-CLOSED
 * `ForbiddenError` defaults per Spec F R2).
 */
export interface TaskMasterConnection<Ctx = unknown, R = never>
  extends ConnectionIdentity,
    InboundDispatch<Ctx, R>,
    OutboundCall<AnyTaskMasterRpcDefinition>,
    OutboundNotify<never> {}

/**
 * Helper: narrow `CapsUnionOf&lt;...&gt;` back to the
 * `Context.Tag&lt;unknown, unknown&gt;` upper bound so it satisfies the
 * `CapabilityProviderTable` parameter constraint. When no slot
 * declares capabilities, the union evaluates to `never` and the
 * provider-table type resolves to `Record&lt;never, ...&gt;` (i.e. `{}`),
 * which the empty literal `{}` satisfies.
 */
type CapsArg<T> = Extract<CapsUnionOf<T>, Context.Tag<unknown, unknown>>;

/**
 * Config record consumed by `makeServerConnection`. `Caps` is inferred
 * by TypeScript from the handler-table literal — callers normally
 * write `makeServerConnection({ handlers: { ... }, capabilities: { ... } })`
 * and TypeScript reconstructs `Caps` from the slots' definitions.
 *
 * `write` is the wire-level write effect the surrounding transport
 * supplies; `idPrefix` mirrors `makeOriginator`'s idPrefix convention
 * for the outbound TM-callback path.
 */
export interface ServerConnectionConfig<
  Ctx,
  Caps extends Context.Tag<any, any>,
> {
  readonly id: string;
  readonly handlers: ServerHandlers<Ctx, Caps>;
  readonly capabilities: CapabilityProviderTable<
    CapsArg<ServerHandlers<Ctx, Caps>>
  >;
  readonly write: (raw: string) => Effect.Effect<void, unknown>;
  readonly idPrefix: string;
}

/**
 * Equivalent config for the AgentClient factory. `handlers` is the
 * empty table; the factory accepts it for forward compatibility (if a
 * future spec adds AgentClient-inbound RPCs, the type system demands
 * coverage).
 */
export interface AgentClientConnectionConfig<
  Ctx,
  Caps extends Context.Tag<any, any>,
> {
  readonly id: string;
  readonly handlers: AgentClientHandlers<Ctx, Caps>;
  readonly write: (raw: string) => Effect.Effect<void, unknown>;
  readonly idPrefix: string;
}

/**
 * Config for the TaskMaster factory. The TM owns the `taskCallbackMethods`
 * catalog inbound; its outbound surface is the full `serverRpcMethods` catalog.
 */
export interface TaskMasterConnectionConfig<
  Ctx,
  Caps extends Context.Tag<any, any>,
> {
  readonly id: string;
  readonly handlers: TaskMasterHandlers<Ctx, Caps>;
  readonly capabilities: CapabilityProviderTable<
    CapsArg<TaskMasterHandlers<Ctx, Caps>>
  >;
  readonly write: (raw: string) => Effect.Effect<void, unknown>;
  readonly idPrefix: string;
}

/**
 * Factory — server side. Delegates to `buildServerDispatcher`
 * (`dispatch.ts`) which wires:
 *   - inbound: per-frame dispatch via the static handler table; for
 *     each frame, the dispatcher reads the handler's
 *     `definition.capabilities` (Shape B), invokes the provider table's
 *     entry for each tag with the dispatcher-derived args, and threads
 *     `Effect.provideServiceEffect` over the handler effect.
 *   - outbound: an internalized originator (formerly the body of
 *     `makeOriginator`) that mints `${idPrefix}-N` ids and tracks
 *     pending Deferreds. Scope finalizer drains pending Deferreds with
 *     `NotConnectedError`.
 */
export function makeServerConnection<Ctx, Caps extends Context.Tag<any, any>>(
  config: ServerConnectionConfig<Ctx, Caps>,
): Effect.Effect<ServerConnection<Ctx>, never, Scope.Scope> {
  return buildServerDispatcher(config);
}

/**
 * Factory — agent client. Delegates to `buildAgentClientDispatcher`
 * which wires the originator only (no inbound dispatch — the AgentClient
 * kind's inbound catalog is empty).
 */
export function makeAgentClientConnection<
  Ctx,
  Caps extends Context.Tag<any, any>,
>(
  config: AgentClientConnectionConfig<Ctx, Caps>,
): Effect.Effect<AgentClientConnection, never, Scope.Scope> {
  return buildAgentClientDispatcher(config);
}

/**
 * Factory — TaskMaster. Delegates to `buildTaskMasterDispatcher` which
 * wires both the inbound dispatch loop (against `taskCallbackMethods`)
 * and the outbound originator (against the full `serverRpcMethods` catalog).
 * Both inbound slots are OPTIONAL (fail-CLOSED `ForbiddenError` -32001
 * defaults per Spec F R2); the empty literal `{ handlers: {} }` is
 * well-typed and produces a TM that responds to every inbound auth
 * check with `Forbidden`.
 */
export function makeTaskMasterConnection<
  Ctx,
  Caps extends Context.Tag<any, any>,
>(
  config: TaskMasterConnectionConfig<Ctx, Caps>,
): Effect.Effect<TaskMasterConnection<Ctx>, never, Scope.Scope> {
  return buildTaskMasterDispatcher(config);
}
