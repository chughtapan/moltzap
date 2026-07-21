/**
 * Channel-base lease primitives.
 *
 * Public surface:
 * - `LeaseAlreadyConsumed`: canonical tagged error class. One definition site
 *   across both channels (openclaw, nanoclaw).
 * - `projectLeaseInvalid`: predicate that narrows a `ForbiddenError` to
 *   `LeaseAlreadyConsumed` when the server's wire-error payload matches the
 *   single-use-lease shape (`data.reason === "LeaseInvalid"`).
 * - `catchLeaseInvalid`: Effect-pipe convenience that runs the projection over
 *   a `ForbiddenError` with `Clock.currentTimeMillis` threaded into the
 *   projector as `consumedAt`.
 */

import { Clock, Data, Effect } from "effect";
import { ForbiddenError } from "@moltzap/protocol/rpc";

/**
 * The dispatch lease is already consumed (the server mapped a second
 * `agent/message/send` on the same lease to `ForbiddenError(data.reason:
 * "LeaseInvalid")`).
 *
 * Construction is **only** via `projectLeaseInvalid` (or `catchLeaseInvalid`).
 * `cause` is the verbatim wire error so hosts can inspect the payload without
 * re-fetching; `consumedAt` is `Clock.currentTimeMillis` at projection time;
 * `message` is derived from `cause.message`.
 */
export class LeaseAlreadyConsumed extends Data.TaggedError(
  "LeaseAlreadyConsumed",
)<{
  readonly leaseId: string;
  readonly consumedAt: number;
  readonly cause: ForbiddenError;
  readonly message: string;
}> {}

/**
 * Named alias for the error channel produced by `catchLeaseInvalid` over an
 * effect with residual error `E`. Equivalent to
 * `LeaseAlreadyConsumed | ForbiddenError | E`, named so consumers can
 * reference the union directly.
 */
export type LeaseInvalidProjectionError<E> =
  | LeaseAlreadyConsumed
  | ForbiddenError
  | E;

const LEASE_ID_FALLBACK = "(unknown)";

function isLeaseInvalidData(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const reason = (data as { readonly reason?: unknown }).reason;
  return reason === "LeaseInvalid";
}

/**
 * Project an `ForbiddenError` to `LeaseAlreadyConsumed` if it matches the
 * lease-invalid wire shape; otherwise return the original error unchanged.
 *
 * Predicate: `err.data.reason === "LeaseInvalid"`.
 *
 * The wire code (-32001 / generic Forbidden) is intentionally NOT part of
 * the predicate because the code is too generic to discriminate on alone.
 *
 * `ctx.leaseId` (optional) is the lease the caller just sent. Caller-supplied
 * because the server's `ForbiddenError.data` shape does NOT carry leaseId.
 * Falls back to `"(unknown)"` when omitted.
 *
 * `ctx.consumedAt` (required) is the epoch ms to stamp on the resulting
 * `LeaseAlreadyConsumed.consumedAt`. Required because `LeaseAlreadyConsumed`
 * requires it and this function is synchronous (no Clock access). Callers
 * either pass `Date.now()` directly or use `catchLeaseInvalid` which reads
 * `Clock.currentTimeMillis` inside the Effect.
 */
export function projectLeaseInvalid(
  err: ForbiddenError,
  ctx: { readonly leaseId?: string; readonly consumedAt: number },
): LeaseAlreadyConsumed | ForbiddenError {
  if (!isLeaseInvalidData(err.data)) return err;
  return new LeaseAlreadyConsumed({
    leaseId: ctx.leaseId ?? LEASE_ID_FALLBACK,
    consumedAt: ctx.consumedAt,
    cause: err,
    message: err.message,
  });
}

/**
 * Effect-pipe convenience: catches `ForbiddenError` and runs
 * `projectLeaseInvalid` on each instance. Reads `Clock.currentTimeMillis`
 * inside the catch and passes the result to `projectLeaseInvalid` as
 * `consumedAt`. Matching errors are surfaced as the typed
 * `LeaseAlreadyConsumed` on the failure channel; non-matching errors are
 * re-raised unchanged so downstream `mapError`s see the original
 * `ForbiddenError`.
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
  eff: Effect.Effect<A, ForbiddenError | E2, R>,
) => Effect.Effect<A, LeaseInvalidProjectionError<E2>, R> {
  // `Effect.catchIf` with an `instanceof` refinement handles only the
  // `ForbiddenError` arm; the `E2` residual flows through untouched as
  // `Exclude<ForbiddenError | E2, ForbiddenError>`, so there is no cast on the
  // residual error channel. `catchTag("ForbiddenError", ...)` cannot be used:
  // when `E2` is unconstrained, TS conservatively assumes it could carry
  // `_tag: "ForbiddenError"`, which would widen the matched arm.
  return Effect.catchIf(
    (err): err is ForbiddenError => err instanceof ForbiddenError,
    (err) =>
      Effect.flatMap(Clock.currentTimeMillis, (consumedAt) =>
        Effect.fail(
          projectLeaseInvalid(err, {
            ...(ctx?.leaseId !== undefined ? { leaseId: ctx.leaseId } : {}),
            consumedAt,
          }),
        ),
      ),
  );
}
