/**
 * Channel-base lease primitives.
 *
 * Public surface for spec C (#597):
 * - `LeaseAlreadyConsumed`: canonical tagged error class. One definition site
 *   across all three channels (claude-code, openclaw, nanoclaw).
 * - `projectLeaseInvalid`: predicate that narrows a `RpcServerError` to
 *   `LeaseAlreadyConsumed` when the server's wire-error payload matches the
 *   single-use-lease shape.
 * - `catchLeaseInvalid`: Effect-pipe convenience that runs the projection
 *   inside `Effect.catchTag("RpcServerError", ...)` with
 *   `Clock.currentTimeMillis` threaded into the projector as `consumedAt`.
 */

import { Clock, Data, Effect } from "effect";
import { RpcServerError } from "@moltzap/protocol";

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

const LEASE_ID_FALLBACK = "(unknown)";

function isLeaseInvalidData(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const reason = (data as { readonly reason?: unknown }).reason;
  const tag = (data as { readonly _tag?: unknown })._tag;
  // Today's wire shape: `ForbiddenError.data.reason === "LeaseInvalid"`
  // (arch sub-issue #605 §3.2). The `_tag` arm is forward-compat for a
  // future server that emits the canonical tag in `data` directly.
  return reason === "LeaseInvalid" || tag === "LeaseAlreadyConsumed";
}

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
 * Falls back to `"(unknown)"` when omitted (matches the pre-refactor
 * claude-code behavior).
 *
 * `ctx.consumedAt` (required) is the epoch ms to stamp on the resulting
 * `LeaseAlreadyConsumed.consumedAt`. Required because `LeaseAlreadyConsumed`
 * requires it and this function is synchronous (no Clock access). Callers
 * either pass `Date.now()` directly or use `catchLeaseInvalid` which reads
 * `Clock.currentTimeMillis` inside the Effect.
 */
export function projectLeaseInvalid(
  err: RpcServerError,
  ctx: { readonly leaseId?: string; readonly consumedAt: number },
): LeaseAlreadyConsumed | RpcServerError {
  if (!isLeaseInvalidData(err.data)) return err;
  return new LeaseAlreadyConsumed({
    leaseId: ctx.leaseId ?? LEASE_ID_FALLBACK,
    consumedAt: ctx.consumedAt,
    cause: err,
    message: err.message,
  });
}

/**
 * Effect-pipe convenience: catches `RpcServerError` and runs
 * `projectLeaseInvalid` on each instance. Reads `Clock.currentTimeMillis`
 * inside the catch and passes the result to `projectLeaseInvalid` as
 * `consumedAt`. Matching errors are surfaced as the typed
 * `LeaseAlreadyConsumed` on the failure channel; non-matching errors are
 * re-raised unchanged so downstream `mapError`s see the original
 * `RpcServerError`.
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
export function catchLeaseInvalid<A, E2, R>(ctx?: {
  readonly leaseId?: string;
}): (
  eff: Effect.Effect<A, RpcServerError | E2, R>,
) => Effect.Effect<A, LeaseInvalidProjectionError<E2>, R> {
  // `Effect.catchAll` over the union (rather than `catchTag("RpcServerError",
  // ...)`) keeps the typechecker happy when `E2` is unconstrained — without
  // narrowing on the runtime instance, TS conservatively infers that `E2`
  // could itself carry `_tag: "RpcServerError"`. The `instanceof` branch
  // partitions cleanly.
  return (eff) =>
    Effect.catchAll(
      eff,
      (err): Effect.Effect<A, LeaseInvalidProjectionError<E2>, R> => {
        if (err instanceof RpcServerError) {
          return Effect.flatMap(Clock.currentTimeMillis, (consumedAt) =>
            Effect.fail(
              projectLeaseInvalid(err, {
                ...(ctx?.leaseId !== undefined ? { leaseId: ctx.leaseId } : {}),
                consumedAt,
              }),
            ),
          );
        }
        // Non-RpcServerError residual (E2). Re-raise unchanged so downstream
        // `mapError`s see it without coupling to channel-base.
        return Effect.fail(err as E2);
      },
    );
}
