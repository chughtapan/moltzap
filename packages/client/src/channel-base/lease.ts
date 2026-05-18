/**
 * Channel-base lease primitives.
 *
 * Public surface for spec C (#597):
 * - `LeaseAlreadyConsumed`: canonical tagged error class. One definition site
 *   across all three channels post-refactor (claude-code, openclaw, nanoclaw).
 * - `projectLeaseInvalid`: predicate that narrows a `RpcServerError` to
 *   `LeaseAlreadyConsumed` when the server's wire-error payload matches the
 *   single-use-lease shape.
 * - `catchLeaseInvalid`: Effect-pipe convenience that runs the projection
 *   inside `Effect.catchTag("RpcServerError", ...)`.
 *
 * Implementation is impl-staff scope (see arch sub-issue #605 §10
 * "Sequencing for impl-staff"). Stubs throw to keep the typechecker green
 * and to make missing wiring obvious in test runs.
 */

import { Data, type Effect } from "effect";
import type { RpcServerError } from "@moltzap/protocol";

/**
 * The dispatch lease was already consumed (server returned the typed
 * single-use-lease failure on a second `messages/send` for the same lease).
 *
 * Construction is **only** via `projectLeaseInvalid` (or `catchLeaseInvalid`).
 * The original `RpcServerError` is preserved on `cause` so hosts can inspect
 * the wire payload without re-fetching.
 *
 * See arch sub-issue #605 §3.1 for the shape rationale (cause field is the
 * verbatim wire error; consumedAt is `Clock.currentTimeMillis` at projection
 * time; message is derived from cause.message).
 */
export class LeaseAlreadyConsumed extends Data.TaggedError(
  "LeaseAlreadyConsumed",
)<{
  readonly leaseId: string;
  readonly consumedAt: number;
  readonly cause: RpcServerError;
  readonly message: string;
}> {}

/**
 * Named alias for the error channel produced by `catchLeaseInvalid` over an
 * effect with residual error `E`. Equivalent to
 * `LeaseAlreadyConsumed | RpcServerError | E`, but referencable from external
 * consumers (per arch sub-issue #605 §5.1 named-error-union commitment).
 */
export type LeaseInvalidProjectionError<E> =
  | LeaseAlreadyConsumed
  | RpcServerError
  | E;

/**
 * Project an `RpcServerError` to `LeaseAlreadyConsumed` if it matches the
 * lease-invalid wire shape; otherwise return the original error unchanged.
 *
 * Predicate (architect-corrected per arch sub-issue #605 §3.2):
 *   `err.data.reason === "LeaseInvalid"` OR
 *   `err.data._tag === "LeaseAlreadyConsumed"` (forward-compat for a future
 *   server that emits the canonical tag in data).
 *
 * The wire code (-32001 / generic Forbidden) is intentionally NOT part of
 * the predicate because the code is too generic to discriminate on alone.
 *
 * `ctx.leaseId` (optional) is the lease the caller just sent. Caller-supplied
 * because the server's `ForbiddenError.data` shape does NOT carry leaseId.
 * Falls back to `"(unknown)"` when omitted (matches current claude-code).
 *
 * `ctx.consumedAt` (required) is the epoch ms to stamp on the resulting
 * `LeaseAlreadyConsumed.consumedAt`. Required because `LeaseAlreadyConsumed`
 * requires it and this function is synchronous (no Clock access). Callers
 * either pass `Date.now()` directly or use `catchLeaseInvalid` which reads
 * `Clock.currentTimeMillis` inside the Effect.
 */
export function projectLeaseInvalid(
  _err: RpcServerError,
  _ctx: { readonly leaseId?: string; readonly consumedAt: number },
): LeaseAlreadyConsumed | RpcServerError {
  throw new Error("not implemented (arch stub; impl-staff scope)");
}

/**
 * Effect-pipe convenience: catches `RpcServerError` and runs
 * `projectLeaseInvalid` on each instance. Reads `Clock.currentTimeMillis`
 * inside the catch and passes the result to `projectLeaseInvalid` as
 * `consumedAt`.
 *
 * Use at every channel's outbound `core.sendReply(...)` boundary:
 *
 * ```ts
 * core.sendReply(conv, text, { dispatchLeaseId: leaseId }).pipe(
 *   catchLeaseInvalid({ leaseId }),
 *   // ... per-channel surfacing
 * )
 * ```
 */
export function catchLeaseInvalid<A, E2, R>(
  _ctx?: { readonly leaseId?: string },
): (
  eff: Effect.Effect<A, RpcServerError | E2, R>,
) => Effect.Effect<A, LeaseInvalidProjectionError<E2>, R> {
  throw new Error("not implemented (arch stub; impl-staff scope)");
}
