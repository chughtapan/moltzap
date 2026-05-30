/**
 * @file Erased slot — the existential the dispatcher indexes by method string.
 *
 * The dispatcher (`dispatch.ts → makeInboundDispatch`) indexes inbound
 * RPC slots by the runtime `frame.method` string. That lookup is
 * wire-dynamic — a remote can name any string — so the table value must
 * be an existential: the per-method `params`/`result` types are bound at
 * REGISTRATION, not at the dispatch boundary.
 *
 * #705 HALF-2 — every slot is built by `makeMiddlewareSlot`
 * (`middleware-slot.ts`): the slot's `invoke` decodes `params` via the
 * method's OWN validator (`validateParams`, an Effect-`Schema`-backed
 * `d is Schema.Schema.Type&lt;P>` narrowing post-#723, not an assertion) and
 * runs a pre-composed, cast-free gated body whose per-frame
 * capabilities were discharged by a STATIC `provideServiceEffect` chain at
 * the binding site. The slot boundary is honestly typed: `invoke`'s residual
 * `R` is `Env` (the `FullLive` service-tag union the dispatcher's
 * `ManagedRuntime` resolves at request time), NOT `never` — there is no
 * `asNeverR` lie, and there is NO `dischargeCaps` runtime fold / `argsOf`
 * erasure (deleted in HALF-2).
 */
import { type Effect, type Exit, Schema } from "effect";

import { type RpcDefinition } from "./method.js";

/**
 * The dispatcher-boundary `ctx` a slot's `invoke` receives. The live
 * THREE-arm `Connection` union whose unauthenticated arm has no `auth`. The
 * slot narrows `ctx.connection._tag` INSIDE `invoke` (the #720
 * principal-kind gate); it MUST be the 3-arm union because the Connect frame
 * (`agent/connect` / `app/connect`) is dispatched while the arm is still
 * unauthenticated, so the unauth arm reaches `invoke` unnarrowed.
 *
 * Kept structural (not an import of the server type) so the protocol package
 * does not depend on `@moltzap/server-core`. The slot factory is generic over
 * `Conn`, which the server pins to its `Connection` union. The server's
 * `DispatchContext` (`transport/context.ts`) is just `SlotDispatchContext<
 * Connection>` — the SAME type, one name per role (#705 HALF-2 collapsed the
 * former duplicate server-local + argsOf-resolver `DispatchContext`s here).
 */
export interface SlotDispatchContext<Conn> {
  readonly connection: Conn;
}

/**
 * Existential slot the dispatcher indexes by runtime method string.
 *
 * `Env` is the `FullLive` service-tag union the dispatcher's
 * `ManagedRuntime` resolves at request time (the layer service tags
 * MINUS the per-frame capability tags, which are discharged inside
 * `invoke`). `Conn` is the server's three-arm `Connection` union.
 *
 * `invoke` decodes `params` via the method's own validator (the Effect
 * `Schema`-backed `validateParams` guard, post-#723), runs the
 * pre-composed gated body (caps + principal discharged inside), and returns
 * the `Exit`. `R = Env` (NOT `never`). NO double-erasure cast, NO
 * `Context.Tag&lt;unknown, unknown>`.
 */
export interface ErasedSlot<Env, Conn> {
  readonly definition: RpcDefinition<
    string,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext
  >;
  readonly invoke: (
    params: unknown,
    ctx: SlotDispatchContext<Conn>,
  ) => Effect.Effect<Exit.Exit<unknown, unknown>, never, Env>;
}

/**
 * The keyed table the dispatcher indexes by runtime method string. The
 * `| undefined` value type makes the wire-dynamic lookup honest: an
 * unknown method string yields `undefined` → wire `MethodNotFound`
 * -32601.
 */
export type ErasedSlotTable<Env, Conn> = Readonly<
  Record<string, ErasedSlot<Env, Conn> | undefined>
>;
