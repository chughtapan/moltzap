/** @file Router acquisition, stop reporting, and durable evidence. */

import { Cause, Effect, Exit, Option, Ref, type Scope } from "effect";
import {
  type routerEvents,
  RouterMessageCommitted,
  RouterStartFailed,
  RouterStarted,
  RouterStopFailed,
} from "../events/core.js";
import type { LedgerFailure, LedgerWriter } from "../ledger/live.js";
import {
  RouterProvider,
  type NetworkFailure,
  type Router,
} from "../network/router.js";
import { nonEmptyCause } from "./outcomes.js";

/**
 * Executes the acquire router operation.
 * @param writer Durable router lifecycle evidence writer.
 * @param routerRef Run-owned router publication point used during finalization.
 * @returns The acquire router result.
 */
export function acquireRouter(
  writer: LedgerWriter<typeof routerEvents>,
  routerRef: Ref.Ref<Option.Option<Router>>,
): Effect.Effect<
  Router,
  NetworkFailure | LedgerFailure,
  RouterProvider | Scope.Scope
> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const provider = yield* RouterProvider;
      const attempted = yield* Effect.exit(restore(provider.acquire));
      if (Exit.isFailure(attempted)) {
        if (Cause.isInterruptedOnly(attempted.cause)) {
          return yield* Effect.failCause(attempted.cause);
        }
        const recorded = yield* Effect.exit(
          restore(
            writer.write({
              event: RouterStartFailed.make({
                cause: nonEmptyCause(attempted.cause),
              }),
            }),
          ),
        );
        return yield* Effect.failCause(
          Exit.isFailure(recorded)
            ? Cause.sequential(attempted.cause, recorded.cause)
            : attempted.cause,
        );
      }
      yield* Ref.set(routerRef, Option.some(attempted.value));
      yield* restore(
        writer.write({
          event: RouterStarted.make({
            routerUrl: attempted.value.address,
          }),
        }),
      );
      return attempted.value;
    }),
  ).pipe(Effect.withSpan("Simulator.acquireRouter"));
}

function recordCommits(
  router: Router,
  writer: LedgerWriter<typeof routerEvents>,
) {
  return router.stopped.pipe(
    Effect.flatMap((stopped) =>
      Effect.forEach(
        stopped.committedMessages,
        (message) =>
          writer.write({
            event: RouterMessageCommitted.make(message),
          }),
        { concurrency: 1, discard: true },
      ),
    ),
  );
}

/**
 * Executes the record stopped router operation.
 * @param router Value supplied to the operation.
 * @param writer Value supplied to the operation.
 * @returns The record stopped router result.
 */
export function recordStoppedRouter(
  router: Router,
  writer: LedgerWriter<typeof routerEvents>,
): Effect.Effect<void, NetworkFailure | LedgerFailure> {
  return Effect.exit(recordCommits(router, writer)).pipe(
    Effect.flatMap((stopped) => {
      if (Exit.isSuccess(stopped)) {
        return Effect.void;
      }
      return Effect.exit(
        writer.write({
          event: RouterStopFailed.make({
            cause: nonEmptyCause(stopped.cause),
          }),
        }),
      ).pipe(
        Effect.flatMap((recorded) =>
          Effect.failCause(
            Exit.isFailure(recorded)
              ? Cause.sequential(stopped.cause, recorded.cause)
              : stopped.cause,
          ),
        ),
      );
    }),
  );
}
