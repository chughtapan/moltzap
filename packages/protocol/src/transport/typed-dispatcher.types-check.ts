/**
 * @file Type canaries for the Spec F typed dispatcher (Spec F G3 / I2 / I3 / I5 / AC5).
 *
 * Each canary asserts a compile-time invariant on the LIVE Connection /
 * Handler types this branch introduces. Negative cases use
 * `@ts-expect-error` — `tsc --noEmit` fails with TS2578 ("Unused
 * '@ts-expect-error' directive") if the marked line ever stops
 * erroring. The file is compiled by the package's standard `tsc` pass
 * (no separate script).
 *
 * Canaries on this branch (stub):
 *   1. ServerHandlers requires every catalog member (TS2741 on `{}`).
 *   2. HandlerSlot's `Ctx` generic is invariant in the slot's `handle`
 *      signature (TS2322 on cross-Ctx assignment).
 *   3. The `_assertTaskCallback` helper rejects server-inbound
 *      definitions at the `D extends AnyTaskCallbackRpcDefinition`
 *      constraint site (TS2345).
 *   4. AgentClientHandlers accepts `{}` (positive — empty inbound
 *      catalog).
 *   5. `ServerConnection.call(MessagesSend, ...)` is rejected DIRECTLY
 *      on the method signature (TS2345 on the definition argument).
 *      Companion to Canary 3: if the call signature's `OutCall` upper
 *      bound were ever widened to `AnyRpcDefinition`, Canary 3's
 *      helper-form check would still fire (it tests the union directly)
 *      but the live `.call(...)` signature would silently accept
 *      server-inbound definitions. Canary 5 closes that gap.
 *
 * Activated at impl-staff time (Spec F #617 PR):
 *   - Canary 6: TM `{ handlers: {} }` is well-typed once both TM
 *     callback slots carry `slotDisposition: optionalForbidden`.
 *     Asserts `TaskMasterHandlers` resolves the empty literal as
 *     legal (the runtime fail-CLOSED default fires per slot).
 *
 * Deferred (require Spec E primitives to land):
 *   - "Capability provider missing for a referenced tag" + "handler
 *     R channel ⊃ definition.capabilities" (needs
 *     `definition.capabilities` populated with Spec E `Context.Tag`s
 *     in the catalog; Spec E hasn't landed at F's branch base).
 *
 * Per `feedback_canaries_focus_on_live_code`: NO canaries that prove
 * a deleted thing is unreachable. `Connection.register` does not
 * exist in this stub because the types defined here never had it; an
 * assertion of "`.register` is missing" would be tautological.
 */

import { MessagesSend } from "../task/messages.js";
import { DispatchAuthorize, MessagesAuthorize } from "../app/methods.js";

import type { AnyTaskCallbackRpcDefinition } from "../rpc-registry.js";
import type { ParamsOf } from "./method.js";

import type {
  ServerConnection as _ServerConnection,
  AgentClientConnection as _AgentClientConnection,
  TaskMasterConnection as _TaskMasterConnection,
} from "./connection.js";
import type {
  ServerHandlers,
  AgentClientHandlers,
  TaskMasterHandlers,
  HandlerSlot,
} from "./handlers.js";

// ───────────────────────────────────────────────────────────────────────
// Canary 1: ServerHandlers requires every catalog member.
// Empty literal is missing 42 required slots (e.g. 'task/messages/send').
// ───────────────────────────────────────────────────────────────────────

// @ts-expect-error — empty literal missing required slots (Spec F I2).
const _shouldFailEmptyServer: ServerHandlers<unknown, never> = {};

// ───────────────────────────────────────────────────────────────────────
// Canary 2: HandlerSlot's `Ctx` generic is invariant.
// Cross-Ctx assignment fails TS2322.
// ───────────────────────────────────────────────────────────────────────

interface CtxA {
  readonly auth: { agentId: string };
}
interface CtxB {
  readonly auth: { userId: string };
}

declare const _ctxBSlot: HandlerSlot<typeof MessagesSend, CtxB, never>;
// @ts-expect-error — Ctx mismatch: CtxB-shaped slot not assignable to CtxA-shaped slot (Spec F I3).
const _shouldFailCtx: HandlerSlot<typeof MessagesSend, CtxA, never> = _ctxBSlot;

// ───────────────────────────────────────────────────────────────────────
// Canary 3: ServerConnection.call rejects definitions outside the
// task-callback outbound surface (Spec F I5).
//
// Mirror the `<D extends OutCall>` constraint check at the inference
// site via a helper. A single-statement call() expression keeps the
// suppression directive attached to one line under oxfmt.
// ───────────────────────────────────────────────────────────────────────

declare function _assertTaskCallback<D extends AnyTaskCallbackRpcDefinition>(
  def: D,
): D;

// @ts-expect-error — MessagesSend does NOT extend AnyTaskCallbackRpcDefinition (Spec F I5).
const _serverOutboundReject = _assertTaskCallback(MessagesSend);

// Positive controls — DispatchAuthorize + MessagesAuthorize DO extend
// AnyTaskCallbackRpcDefinition; the same call must NOT error.
const _serverOutboundOk1 = _assertTaskCallback(DispatchAuthorize);
const _serverOutboundOk2 = _assertTaskCallback(MessagesAuthorize);

// ───────────────────────────────────────────────────────────────────────
// Canary 4: AgentClientHandlers accepts `{}` (empty inbound catalog
// today). A future spec adding AgentClient-inbound RPCs extends the
// catalog; this canary then begins firing (the now-required slot
// missing) and impl-staff for that spec must populate the slot.
// ───────────────────────────────────────────────────────────────────────

const _agentClientEmpty: AgentClientHandlers<unknown, never> = {};

// Stub-branch positive sanity: a TaskMasterHandlers literal is shape-typed.
declare const _tmHandlers: TaskMasterHandlers<unknown, never>;
const _tmHandlersSink: TaskMasterHandlers<unknown, never> = _tmHandlers;

// ───────────────────────────────────────────────────────────────────────
// Canary 6: TaskMasterHandlers accepts `{}` (both TM-callback slots
// OPTIONAL with fail-CLOSED `ForbiddenError` defaults per Spec F R2).
// If a future spec promotes either `DispatchAuthorize` /
// `MessagesAuthorize` to REQUIRED, this canary starts erroring and
// every TM construction site that omits handlers must be revisited.
// ───────────────────────────────────────────────────────────────────────

const _tmEmpty: TaskMasterHandlers<unknown, never> = {};

// ───────────────────────────────────────────────────────────────────────
// Canary 5: ServerConnection.call rejects non-task-callback definitions
// DIRECTLY on the live `.call(...)` method signature (Spec F I5 direct).
//
// Companion to Canary 3. Canary 3 tests the
// `<D extends AnyTaskCallbackRpcDefinition>` constraint via a local
// `_assertTaskCallback` helper. If `OutboundCall<OutCall>.call`'s upper
// bound were ever widened on `ServerConnection` (e.g. losing the
// `AnyTaskCallbackRpcDefinition` bound on the kind-shape), Canary 3 would
// still fire (it tests the union directly) — but real consumer code
// calling `.call(...)` on a `ServerConnection` value would silently
// accept any RPC. Canary 5 closes that gap by invoking `.call` on a live
// `ServerConnection` value with a server-inbound definition; widening
// extinguishes the error here and the `@ts-expect-error` becomes unused
// (TS2578). Params are typed via `ParamsOf<typeof MessagesSend>` so the
// param-arg cannot mask the constraint error on the definition arg.
// ───────────────────────────────────────────────────────────────────────

declare const _serverConnI5: _ServerConnection;
declare const _msgsSendParams: ParamsOf<typeof MessagesSend>;

// @ts-expect-error — MessagesSend isn't AnyTaskCallbackRpcDefinition (Spec F I5 direct).
const _directReject = _serverConnI5.call(MessagesSend, _msgsSendParams);

// Export each canary local as a discriminated union so the unused-vars
// rule (which is otherwise satisfied by leading `_`) cannot trim them
// in a future refactor.
export type _TypedDispatcherCanarySink =
  | typeof _shouldFailEmptyServer
  | typeof _shouldFailCtx
  | typeof _ctxBSlot
  | typeof _serverOutboundReject
  | typeof _serverOutboundOk1
  | typeof _serverOutboundOk2
  | typeof _agentClientEmpty
  | typeof _tmHandlersSink
  | typeof _tmEmpty
  | typeof _directReject
  | _ServerConnection
  | _AgentClientConnection
  | _TaskMasterConnection;
