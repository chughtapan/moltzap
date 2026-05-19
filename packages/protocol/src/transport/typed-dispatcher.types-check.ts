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
 *   3. ServerConnection.call rejects definitions outside the
 *      task-callback catalog (TS2345).
 *   4. AgentClientHandlers accepts `{}` (positive — empty inbound
 *      catalog).
 *
 * Deferred to Spec F impl-staff (the invariant exists; the canary
 * needs per-definition metadata that the stub doesn't yet populate):
 *   - TM `{ handlers: {} }` resolves to the fail-CLOSED Forbidden
 *     default (needs `slotDisposition: optionalForbidden` on the TM
 *     callback definitions).
 *   - "Capability provider missing for a referenced tag" + "handler
 *     R channel ⊃ definition.capabilities" (needs
 *     `definition.capabilities` reaching the catalog).
 *
 * Per `feedback_canaries_focus_on_live_code`: NO canaries that prove
 * a deleted thing is unreachable. `Connection.register` does not
 * exist in this stub because the types defined here never had it; an
 * assertion of "`.register` is missing" would be tautological.
 */

import { MessagesSend } from "../task/messages.js";
import { DispatchAuthorize, MessagesAuthorize } from "../app/methods.js";

import type { AnyTaskCallbackRpcDefinition } from "../rpc-registry.js";

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
  | _ServerConnection
  | _AgentClientConnection
  | _TaskMasterConnection;
