/**
 * @file `Connection&lt;...&gt;` types + 3 specialized factories — Spec F G2.
 *
 * The factories REPLACE the legacy `makeJsonRpcServer` / `makeJsonRpcClient`
 * pair. Impl-staff PR migrates every consumer (LSP list at
 * `packages/protocol/docs/architecture/11-typed-dispatcher.md → §5
 * Facade Replacement Invariant`).
 *
 * Stubs return `Effect.dieMessage(...)`; types are real so the canary
 * file (`typed-dispatcher.types-check.ts`) compiles + tests the
 * compile-time invariants.
 *
 * No `register` / `unregister` method exists on any Connection shape
 * (Spec F I1). The handler table is value-passed at construction time
 * and immutable thereafter.
 */
import { Effect, type Context, type Scope } from "effect";
import type { TSchema } from "@sinclair/typebox";

import type {
  AnyRpcDefinition,
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
import type { RpcCallError } from "./json-rpc-client.js";
import type {
  ServerHandlers,
  AgentClientHandlers,
  TaskMasterHandlers,
  CapsUnionOf,
} from "./handlers.js";
import type { CapabilityProviderTable } from "./capabilities.js";

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
 * delivery + lifecycle notifications).
 */
export interface ServerConnection
  extends ConnectionIdentity,
    OutboundCall<AnyTaskCallbackRpcDefinition>,
    OutboundNotify<AnyNotificationDefinition> {}

/**
 * `AgentClientConnection` — plain agent client. Outbound surface is
 * the full `rpcMethods` catalog. Outbound notifications: none
 * (clients consume notifications; they do not originate them) — the
 * `notify` method is typed `never`, which fails any call site.
 */
export interface AgentClientConnection
  extends ConnectionIdentity,
    OutboundCall<AnyRpcDefinition>,
    OutboundNotify<never> {}

/**
 * `TaskMasterConnection` — agent acting as TM. Outbound surface is the
 * full `rpcMethods` catalog (a TM is a superset of an AgentClient at the
 * type level). Outbound notifications: none.
 */
export interface TaskMasterConnection
  extends ConnectionIdentity,
    OutboundCall<AnyRpcDefinition>,
    OutboundNotify<never> {}

/**
 * Config record consumed by `makeServerConnection`. `Caps` is inferred
 * by TypeScript from the handler-table literal — callers normally
 * write `makeServerConnection({ handlers: { ... }, capabilities: { ... } })`
 * and TypeScript reconstructs `Caps` from the slots' definitions.
 *
 * `write` is the wire-level write effect the surrounding transport
 * supplies; `idPrefix` mirrors `makeJsonRpcClient`'s idPrefix convention
 * for the outbound TM-callback path.
 */

/**
 * Helper: narrow `CapsUnionOf&lt;...&gt;` back to the
 * `Context.Tag&lt;unknown, unknown&gt;` upper bound so it satisfies the
 * `CapabilityProviderTable` parameter constraint. When no slot
 * declares capabilities, the union evaluates to `never` and the
 * provider-table type resolves to `Record&lt;never, ...&gt;` (i.e. `{}`),
 * which the empty literal `{}` satisfies.
 */
type CapsArg<T> = Extract<CapsUnionOf<T>, Context.Tag<unknown, unknown>>;

export interface ServerConnectionConfig<
  Ctx,
  Caps extends Context.Tag<unknown, unknown>,
> {
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
  Caps extends Context.Tag<unknown, unknown>,
> {
  readonly handlers: AgentClientHandlers<Ctx, Caps>;
  readonly write: (raw: string) => Effect.Effect<void, unknown>;
  readonly idPrefix: string;
}

/**
 * Config for the TaskMaster factory. The TM owns the `taskCallbackMethods`
 * catalog inbound; its outbound surface is the full `rpcMethods` catalog.
 */
export interface TaskMasterConnectionConfig<
  Ctx,
  Caps extends Context.Tag<unknown, unknown>,
> {
  readonly handlers: TaskMasterHandlers<Ctx, Caps>;
  readonly capabilities: CapabilityProviderTable<
    CapsArg<TaskMasterHandlers<Ctx, Caps>>
  >;
  readonly write: (raw: string) => Effect.Effect<void, unknown>;
  readonly idPrefix: string;
}

/**
 * Factory — server side. STUB: returns `Effect.dieMessage`; impl-staff
 * PR fills the body per `packages/protocol/docs/architecture/
 * 11-typed-dispatcher.md → §5 Dispatcher implementation`.
 *
 * The body wires:
 *   - inbound: per-frame dispatch via the static handler table; for
 *     each frame, the dispatcher reads the handler's
 *     `definition.capabilities` (Shape B), invokes the provider table's
 *     entry for each tag with the dispatcher-derived args, and threads
 *     `Effect.provideServiceEffect` over the handler effect.
 *   - outbound: an internalized originator (the body of the deleted
 *     `makeJsonRpcClient` becomes a private helper consumed here) that
 *     mints `${idPrefix}-N` ids and tracks pending Deferreds.
 */
export function makeServerConnection<
  Ctx,
  Caps extends Context.Tag<unknown, unknown>,
>(
  config: ServerConnectionConfig<Ctx, Caps>,
): Effect.Effect<ServerConnection, never, Scope.Scope> {
  return Effect.dieMessage(
    `makeServerConnection(idPrefix=${config.idPrefix}): stub — Spec F impl-staff body pending`,
  );
}

/**
 * Factory — agent client. STUB: returns `Effect.dieMessage`. Impl-staff
 * fills with the originator (no inbound handler dispatcher needed; the
 * AgentClient's inbound catalog is empty).
 */
export function makeAgentClientConnection<
  Ctx,
  Caps extends Context.Tag<unknown, unknown>,
>(
  config: AgentClientConnectionConfig<Ctx, Caps>,
): Effect.Effect<AgentClientConnection, never, Scope.Scope> {
  return Effect.dieMessage(
    `makeAgentClientConnection(idPrefix=${config.idPrefix}): stub — Spec F impl-staff body pending`,
  );
}

/**
 * Factory — TaskMaster. STUB: returns `Effect.dieMessage`. Impl-staff
 * fills with both the inbound dispatcher (against `taskCallbackMethods`)
 * and the outbound originator (against the full `rpcMethods` catalog).
 */
export function makeTaskMasterConnection<
  Ctx,
  Caps extends Context.Tag<unknown, unknown>,
>(
  config: TaskMasterConnectionConfig<Ctx, Caps>,
): Effect.Effect<TaskMasterConnection, never, Scope.Scope> {
  return Effect.dieMessage(
    `makeTaskMasterConnection(idPrefix=${config.idPrefix}): stub — Spec F impl-staff body pending`,
  );
}
