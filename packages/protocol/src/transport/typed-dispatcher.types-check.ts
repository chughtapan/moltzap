/**
 * @file Type canaries for the cast-free typed dispatcher (#705 HALF-1).
 *
 * Each canary asserts a compile-time invariant on the LIVE Connection /
 * slot types this branch introduces. Negative cases use
 * `@ts-expect-error` — `tsc --noEmit` fails with TS2578 ("Unused
 * '@ts-expect-error' directive") if the marked line ever stops
 * erroring. The file is compiled by the package's standard `tsc` pass
 * (no separate script).
 *
 * The handler-R ⊆ declared-capabilities lockstep is exercised on the LIVE
 * cap-as-middleware path (#705 HALF-2) by `server-core`'s
 * `middleware-slot.types-check.ts` (Canary M1/M2/M3 — the `weaveCaps`
 * totality bound). This file covers the SURROUNDING invariants:
 *
 * Live canaries:
 *   1. `ErasedSlotTable` totality: an `ErasedSlotTable` keyed over the
 *      `serverRpcMethods` catalog accepts a complete table and indexes
 *      every catalog method by name (the wire-dynamic lookup is
 *      `| undefined`, so totality is asserted structurally below).
 *   2. `HandlerSlot`'s `Ctx` generic is invariant in the slot's `handle`
 *      signature (TS2322 on cross-Ctx assignment) — the app-callback
 *      authoring shape.
 *   3. The `_assertTaskCallback` helper rejects server-inbound
 *      definitions at the `D extends AnyAppCallbackRpcDefinition`
 *      constraint site (TS2345).
 *   4. The AgentClient inbound surface is the empty slot table `{}`
 *      (positive — empty inbound catalog).
 *   5. `ServerConnection.call(MessagesSend, ...)` is rejected DIRECTLY
 *      on the method signature (TS2345 on the definition argument).
 *      Companion to Canary 3.
 *   6. `AppCallbackHandlers` REJECTS `{ }` (TS2741 on the empty literal):
 *      Spec D3 R14b made every app-callback slot a REQUIRED real handler;
 *      vacuous-deny moderators must bind an explicit
 *      `ForbiddenError`-returning handler per catalog method.
 *
 * Per `feedback_canaries_focus_on_live_code`: NO canaries that prove
 * a deleted thing is unreachable.
 */

import { Context, type Effect, type Exit } from "effect";

import { MessagesSend } from "../task/messages.js";
import { DispatchAuthorize, MessagesAuthorize } from "../app/methods.js";
import { serverRpcMethods } from "../rpc-registry.js";

import type { AnyAppCallbackRpcDefinition } from "../rpc-registry.js";
import type { ParamsOf } from "./method.js";

import type {
  ServerConnection as _ServerConnection,
  AgentClientConnection as _AgentClientConnection,
  AppClientConnection as _AppClientConnection,
} from "./connection.js";
import type { AppCallbackHandlers, HandlerSlot } from "./handlers.js";
import type { ErasedSlot, ErasedSlotTable } from "./erased-slot.js";

// ───────────────────────────────────────────────────────────────────────
// Fixtures: a stand-in service-tag `Env` (a `Context.Tag` class, the
// production shape) + connection `Conn` for the slot table the server
// builds.
// ───────────────────────────────────────────────────────────────────────

class Env extends Context.Tag("@moltzap/test/SlotEnv")<Env, "env">() {}
interface Conn {
  readonly _tag: "Stub";
}

// ───────────────────────────────────────────────────────────────────────
// Canary 1: `ErasedSlotTable` totality over the `serverRpcMethods`
// catalog. The slot table is keyed by the runtime method string; the
// production builder must register a slot for every catalog method.
// Indexing any catalog `definition.name` yields `ErasedSlot | undefined`
// (the wire-dynamic `| undefined`), and a complete table assigns to the
// `ErasedSlotTable` shape. A table MISSING a method is NOT rejected at
// the table type (the table is an open `Record`), so totality is owned
// by the server-side builder (`makeCoreRpcMethods`); here we assert the
// slot-table SHAPE round-trips the catalog method names.
// ───────────────────────────────────────────────────────────────────────

declare const _serverSlots: ErasedSlotTable<Env, Conn>;
type _CatalogName = (typeof serverRpcMethods)[number]["name"];
declare const _someCatalogName: _CatalogName;
const _slotByName: ErasedSlot<Env, Conn> | undefined =
  _serverSlots[_someCatalogName];

// ───────────────────────────────────────────────────────────────────────
// Canary 2: HandlerSlot's `Ctx` generic is invariant (app-callback
// authoring shape). Cross-Ctx assignment fails TS2322.
// ───────────────────────────────────────────────────────────────────────

interface CtxA {
  readonly auth: { agentId: string };
}
interface CtxB {
  readonly auth: { userId: string };
}

declare const _ctxBSlot: HandlerSlot<typeof DispatchAuthorize, CtxB, never>;
// @ts-expect-error — Ctx mismatch: CtxB-shaped slot not assignable to CtxA-shaped slot (Spec F I3).
const _shouldFailCtx: HandlerSlot<typeof DispatchAuthorize, CtxA, never> =
  _ctxBSlot;

// ───────────────────────────────────────────────────────────────────────
// Canary 3: ServerConnection.call rejects definitions outside the
// task-callback outbound surface (Spec F I5).
// ───────────────────────────────────────────────────────────────────────

declare function _assertTaskCallback<D extends AnyAppCallbackRpcDefinition>(
  def: D,
): D;

// @ts-expect-error — MessagesSend does NOT extend AnyAppCallbackRpcDefinition (Spec F I5).
const _serverOutboundReject = _assertTaskCallback(MessagesSend);

// Positive controls — DispatchAuthorize + MessagesAuthorize DO extend
// AnyAppCallbackRpcDefinition; the same call must NOT error.
const _serverOutboundOk1 = _assertTaskCallback(DispatchAuthorize);
const _serverOutboundOk2 = _assertTaskCallback(MessagesAuthorize);

// ───────────────────────────────────────────────────────────────────────
// Canary 4: the AgentClient inbound surface is the empty slot table.
// The AgentClient kind's inbound catalog is empty, so its config `slots`
// is the empty `ErasedSlotTable` literal `{}`. A future spec adding
// AgentClient-inbound RPCs registers slots; this canary then begins
// firing in the builder, not here.
// ───────────────────────────────────────────────────────────────────────

const _agentClientEmptySlots: ErasedSlotTable<Env, Conn> = {};

// Positive sanity: an AppCallbackHandlers literal is shape-typed.
declare const _appCallbackHandlers: AppCallbackHandlers<unknown, never>;
const _appCallbackHandlersSink: AppCallbackHandlers<unknown, never> =
  _appCallbackHandlers;

// ───────────────────────────────────────────────────────────────────────
// Canary 6 (Spec D3 R14b): AppCallbackHandlers REJECTS `{}` — every key
// is a REQUIRED real handler. Vacuous-deny moderators must write the
// handler explicitly.
// ───────────────────────────────────────────────────────────────────────

// @ts-expect-error — every key required; omitting fails TS2741.
const _appCallbackEmpty: AppCallbackHandlers<unknown, never> = {};

// ───────────────────────────────────────────────────────────────────────
// Canary 5: ServerConnection.call rejects non-task-callback definitions
// DIRECTLY on the live `.call(...)` method signature (Spec F I5 direct).
// Companion to Canary 3.
// ───────────────────────────────────────────────────────────────────────

declare const _serverConnI5: _ServerConnection;
declare const _msgsSendParams: ParamsOf<typeof MessagesSend>;

// @ts-expect-error — MessagesSend isn't AnyAppCallbackRpcDefinition (Spec F I5 direct).
const _directReject = _serverConnI5.call(MessagesSend, _msgsSendParams);

// ───────────────────────────────────────────────────────────────────────
// Slot-boundary R sanity: a slot's `invoke` residual R is `Env` (NOT
// `never`, NOT a cap union) — capabilities are discharged inside. (The
// full cap-totality lockstep lives on the `weaveCaps` bound in
// `server-core` `middleware-slot.types-check.ts`.)
// ───────────────────────────────────────────────────────────────────────

declare const _someSlot: ErasedSlot<Env, Conn>;
declare const _slotCtx: { readonly connection: Conn };
const _slotInvokeR: Effect.Effect<
  Exit.Exit<unknown, unknown>,
  never,
  Env
> = _someSlot.invoke(undefined, _slotCtx);

// Export each canary local as a discriminated union so the unused-vars
// rule (which is otherwise satisfied by leading `_`) cannot trim them
// in a future refactor.
export type _TypedDispatcherCanarySink =
  | typeof _slotByName
  | typeof _shouldFailCtx
  | typeof _ctxBSlot
  | typeof _serverOutboundReject
  | typeof _serverOutboundOk1
  | typeof _serverOutboundOk2
  | typeof _agentClientEmptySlots
  | typeof _appCallbackHandlersSink
  | typeof _appCallbackEmpty
  | typeof _directReject
  | typeof _slotInvokeR
  | _ServerConnection
  | _AgentClientConnection
  | _AppClientConnection;
