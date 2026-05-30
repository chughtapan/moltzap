/**
 * @file app-callback handler-table type aliases.
 *
 * The server-side inbound surface flipped to the cast-free
 * {@link ErasedSlotTable} at #705 HALF-1 (`ServerHandlers` /
 * `HandlerTable` / `CapsUnionOf` / `AgentClientHandlers` retired). What
 * REMAINS here is the app-callback authoring surface: clients acting as
 * an app (and the conformance harness) write an
 * {@link AppCallbackHandlers} literal — a `{ definition, handle }` slot
 * per `appCallbackMethods` member — which the WS client converts to an
 * `ErasedSlotTable` (cap-less) at connection time via
 * {@link makeMiddlewareSlot}. Every slot is REQUIRED (Spec D3 R14b retired
 * the `forbidden` / `noOpNotification` sentinels); omitting any key fails
 * TS2741 at the factory call.
 */
import type { Context, Effect, Schema } from "effect";

import type { AnyAppCallbackRpcDefinition } from "../rpc-registry.js";

import type { ParamsOf, ResultOf, RpcDefinition } from "./method.js";

/**
 * Per-definition handler slot (app-callback authoring shape). `Ctx` is
 * the per-frame context the client hands every handler. `Caps` is the
 * upper bound on which `Context.Tag`s the handler's R channel may
 * reference; the app-callback catalog declares no capabilities, so
 * callers bind `Caps = never`.
 *
 * The WS client wraps each authored slot into an `ErasedSlot` (cap-less)
 * at connection time via {@link makeMiddlewareSlot}; the slot's `invoke`
 * decodes params and runs `handle`. The cross-package handler-R / cap
 * totality lockstep that the server side enforces lives on the
 * `defineXMiddlewareMethod` `weaveCaps` bound
 * (`server-core` `middleware-slot.types-check.ts`).
 */
export interface HandlerSlot<
  D extends RpcDefinition<
    string,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext
  >,
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
type NameOf<D> =
  D extends RpcDefinition<
    infer N,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext
  >
    ? N
    : never;

/**
 * Per-slot value type. Every slot is a real `HandlerSlot&lt;D, Ctx, Caps>`;
 * Spec D3 R14b removed the sentinel widening.
 */
type SlotValue<D, Ctx, Caps extends Context.Tag<any, any>> =
  D extends RpcDefinition<
    string,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext
  >
    ? HandlerSlot<D, Ctx, Caps>
    : never;

/**
 * Closed handler-table type generated from a definition union. Every
 * catalog member appears as a structurally-required key whose value is
 * a real `HandlerSlot&lt;D, Ctx, Caps&gt;` (Spec D3 R14b retired the
 * sentinel widening — no slot is optional).
 */
type HandlerTable<
  Defs extends RpcDefinition<
    string,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext
  >,
  Ctx,
  Caps extends Context.Tag<any, any>,
> = {
  readonly [D in Defs as NameOf<D>]: SlotValue<D, Ctx, Caps>;
};

/**
 * `AppCallbackHandlers` — handler table for an app moderating one or
 * more tasks. Catalog: `appCallbackMethods` —
 * `DispatchAuthorize`, `MessagesAuthorize`, `TaskCreate`. All three
 * REQUIRED (R14b); vacuous-deny moderators must write the handler
 * explicitly. `TaskCreate` is the server-initiated callback fired
 * after `task/request` lands the task in `waiting`; the app's typed
 * verdict drives the lifecycle transition.
 */
export type AppCallbackInboundRpcDefinition = AnyAppCallbackRpcDefinition;

export type AppCallbackHandlers<
  Ctx,
  Caps extends Context.Tag<any, any> = never,
> = HandlerTable<AppCallbackInboundRpcDefinition, Ctx, Caps>;
