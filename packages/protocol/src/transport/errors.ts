/**
 * @file Connection-facade transport-error tagged classes.
 *
 * STUB FILE — architect tier, Spec A (#595), arch sub-issue #603.
 * Public-surface signatures only. Bodies live in impl-staff.
 *
 * Spec sections this file maps to:
 *   - Spec A "Goals" §3 — outbound API error unions
 *   - Spec A "Goals" §2 — inbound pump escaping errors
 *   - Acceptance Criteria #1 — exported tagged-error surface
 *
 * Cite by symbol (PRINCIPLES Part 4 + `feedback_no_line_number_doc_citations`).
 */
import { Data } from "effect";
import type * as Socket from "@effect/platform/Socket";
import type { JsonRpcId, JsonRpcMethod } from "./wire.js";
import type { RegisteredTaggedError } from "../rpc-registry.js";
import type { JsonValue } from "./connection/handler.js";

// ── Outbound (writer) error channel ──────────────────────────────────

/**
 * Underlying transport rejected a write. Wraps
 * `@effect/platform/Socket.SocketError` at the Connection boundary so
 * consumers don't depend on Effect-platform's tagged type.
 *
 * Replaces the legacy ad-hoc `Socket.SocketError` propagation through
 * `ws-client.handleIncoming` and `socket-handler.handleSocketData`.
 */
export class SocketWriteError extends Data.TaggedError("SocketWriteError")<{
  readonly cause: Socket.SocketError;
}> {}

/**
 * The Connection's underlying socket is no longer in the OPEN state
 * (closed, closing, or pre-OPEN failure observed after `runRaw` returned).
 * Distinct from `SocketWriteError` so callers can branch retry policy
 * on "transient write failure" vs "socket gone."
 *
 * Successor to `NotConnectedError` from `./rpc-errors.ts`.
 */
export class ConnectionClosedError extends Data.TaggedError(
  "ConnectionClosedError",
)<{
  readonly reason: string;
}> {}

/**
 * Caller-owned per-call deadline expired without an inbound response
 * frame. Caller controls the deadline via `Effect.timeout` at the call
 * site; Connection does not impose one of its own.
 *
 * Successor to `RpcTimeoutError` from `./rpc-errors.ts`.
 */
export class RequestTimeoutError extends Data.TaggedError(
  "RequestTimeoutError",
)<{
  readonly method: JsonRpcMethod;
  readonly timeoutMs: number;
}> {}

// ── Outbound (call/notify/sendError) — RpcCallError union ────────────

/**
 * The remote returned a JSON-RPC `error` response frame whose `code`
 * was NOT registered with `registerErrorClass`. Carries the raw wire
 * payload so the caller can inspect the unregistered code.
 *
 * Distinct from `RemoteTaggedError` (which surfaces *registered*
 * classes as their typed tag).
 */
export class JsonRpcErrorResponse extends Data.TaggedError(
  "JsonRpcErrorResponse",
)<{
  readonly code: number;
  readonly message: string;
  readonly data?: JsonValue;
}> {}

/**
 * The remote's response frame parsed as JSON but failed schema validation
 * for the declared result of the called definition (`def.validateResult`).
 * Distinct from `JsonRpcErrorResponse` (well-formed error reply) and
 * from `RemoteTaggedError` (well-formed registered failure).
 */
export class DecodeFailure extends Data.TaggedError("DecodeFailure")<{
  readonly method: JsonRpcMethod;
  readonly raw: JsonValue;
}> {}

/**
 * Type alias for the closed union of every wire-coded tagged-error
 * class. `RpcCallError`'s "remote returned a known tag" arm uses this
 * shape directly — caller code pattern-matches on the inner instance's
 * `_tag` (e.g. `Effect.catchTag("Forbidden", ...)`).
 *
 * Architect decision (resolves the §9 "RemoteTaggedError vs
 * RegisteredTaggedError" clarification): final shape is an alias to
 * `RegisteredTaggedError`. The spec's AC1 lists both names; this
 * keeps the wire-decode path unchanged AND avoids introducing a
 * wrapper class whose only contribution is namespacing.
 */
export type RemoteTaggedError = RegisteredTaggedError;

/**
 * The Connection's correlator (response-frame ↔ pending-call routing)
 * encountered an unrecoverable state — e.g. a response frame's id was
 * matched after the pending entry had already been completed by a prior
 * frame. Distinct from `ConnectionClosedError`, which fires when the
 * socket goes away.
 */
export class CorrelatorFailure extends Data.TaggedError("CorrelatorFailure")<{
  readonly id: JsonRpcId;
  readonly reason: string;
}> {}

/**
 * Discriminated union of every error a `Connection.call()` can fail
 * with via Effect's error channel. Each arm is a tagged-error class
 * the caller can `catchTag` against.
 *
 * Spec A "Goals" §3:
 *   `RpcCallError = JsonRpcErrorResponse | DecodeFailure | RemoteTaggedError | CorrelatorFailure`
 */
export type RpcCallError =
  | JsonRpcErrorResponse
  | DecodeFailure
  | RemoteTaggedError
  | CorrelatorFailure;

// ── Inbound pump (runRaw) — ConnectionRunError union ─────────────────

/**
 * The underlying socket's read loop failed. Distinct from
 * `ConnectionClosedError`: a clean close terminates `runRaw` with
 * `Effect.void` (no error), while a read-side fault — connection reset,
 * underlying transport defect — fails with `SocketReadError`.
 *
 * Corrected from the earlier spec draft's `SocketWriteError` (which
 * is reserved for the writer side; runRaw is read-only).
 */
export class SocketReadError extends Data.TaggedError("SocketReadError")<{
  readonly cause: Socket.SocketError;
}> {}

/**
 * The dispatcher encountered an unrecoverable defect during per-frame
 * routing — e.g. a handler-map corruption or a panic in the Match
 * exhaustive-branch absurd arm. Per-frame *recoverable* failures
 * (decode errors, schema rejections, hook-rejected auth) are converted
 * to JSON-RPC error responses and consumed inside the pump; they do
 * NOT escape via this error channel.
 *
 * `cause` is typed as the Effect cause descriptor (string preview of
 * the defect) instead of `unknown`; impl-staff narrows further if a
 * structured cause type is needed.
 */
export class DispatchPanic extends Data.TaggedError("DispatchPanic")<{
  readonly cause: string;
}> {}

/**
 * Discriminated union of every error a `Connection.runRaw()` can fail
 * with via Effect's error channel. Spec A "Goals" §2:
 *   `ConnectionRunError = SocketReadError | DispatchPanic`
 */
export type ConnectionRunError = SocketReadError | DispatchPanic;

// ── Handler-registration error ───────────────────────────────────────

/**
 * `Connection.register(def, handler)` failed because a handler is
 * already registered for `def.name`. Callers must `unregister(def)`
 * first to swap.
 *
 * See "Handler-registration invariants" in the design doc (sub-issue
 * #603 body) for the full duplicate-key / in-flight / snapshot
 * semantics.
 */
export class DuplicateHandlerError extends Data.TaggedError(
  "DuplicateHandlerError",
)<{
  readonly method: JsonRpcMethod;
}> {}
