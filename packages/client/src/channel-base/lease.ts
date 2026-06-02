/**
 * Channel-base lease primitives.
 *
 * Public surface:
 * - `LeaseAlreadyConsumed`: canonical tagged error class. One definition site
 *   across all three channels (claude-code, openclaw, nanoclaw).
 * - `projectLeaseInvalid`: predicate that narrows a `ForbiddenError` to
 *   `LeaseAlreadyConsumed` when the server's wire-error payload matches the
 *   single-use-lease shape (`data.reason === "LeaseInvalid"`).
 * - `catchLeaseInvalid`: Effect-pipe convenience that runs the projection over
 *   a `ForbiddenError` with `Clock.currentTimeMillis` threaded into the
 *   projector as `consumedAt`.
 */

import { Clock, Data, Effect } from "effect";
import { ForbiddenError } from "@moltzap/protocol";

/**
 * The dispatch lease was already consumed (the server mapped a second
 * `messages/send` on the same lease to `ForbiddenError(data.reason:
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
  const tag = (data as { readonly _tag?: unknown })._tag;
  // Current wire shape: `ForbiddenError.data.reason === "LeaseInvalid"`. The
  // `_tag` arm matches a server that emits the canonical tag in `data`
  // directly.
  return reason === "LeaseInvalid" || tag === "LeaseAlreadyConsumed";
}

/**
 * Project an `ForbiddenError` to `LeaseAlreadyConsumed` if it matches the
 * lease-invalid wire shape; otherwise return the original error unchanged.
 *
 * Predicate:
 *   `err.data.reason === "LeaseInvalid"` OR
 *   `err.data._tag === "LeaseAlreadyConsumed"` (matches a server that emits
 *   the canonical tag in data).
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
  // `Effect.catchAll` over the union (rather than `catchTag("ForbiddenError",
  // ...)`) keeps the typechecker happy when `E2` is unconstrained — without
  // narrowing on the runtime instance, TS conservatively infers that `E2`
  // could itself carry `_tag: "ForbiddenError"`. The `instanceof` branch
  // partitions cleanly.
  return (eff) =>
    Effect.catchAll(
      eff,
      (err): Effect.Effect<A, LeaseInvalidProjectionError<E2>, R> => {
        if (err instanceof ForbiddenError) {
          return Effect.flatMap(Clock.currentTimeMillis, (consumedAt) =>
            Effect.fail(
              projectLeaseInvalid(err, {
                ...(ctx?.leaseId !== undefined ? { leaseId: ctx.leaseId } : {}),
                consumedAt,
              }),
            ),
          );
        }
        // Non-ForbiddenError residual (E2). Re-raise unchanged so downstream
        // `mapError`s see it without coupling to channel-base.
        return Effect.fail(err as E2);
      },
    );
}
