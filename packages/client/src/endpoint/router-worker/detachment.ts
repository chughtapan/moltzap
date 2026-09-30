/** @file Router worker detachment: transitions, reattachment, and warnings. */

import { Clock, Effect, Option, Ref, Stream } from "effect";
import {
  routerWorkerDetachedReportInterval,
  type RouterWorkerDetachedState,
  type RouterWorkerRuntime,
  type RouterWorkerState,
} from "./types.js";

const secondsSince = (since: number): Effect.Effect<number> =>
  Clock.currentTimeMillis.pipe(
    Effect.map((now) => Math.round((now - since) / 1000)),
  );

const logDetached = (state: RouterWorkerDetachedState): Effect.Effect<void> =>
  Effect.logWarning(
    "Router unreachable: worker detached; sends wait until it answers",
  ).pipe(
    Effect.annotateLogs({
      generation: state.generation,
      routerInstanceId: state.anchor.routerInstanceId,
    }),
  );

const logStillDetached = (
  state: RouterWorkerDetachedState,
): Effect.Effect<void> =>
  secondsSince(state.detachedAt).pipe(
    Effect.flatMap((seconds) =>
      Effect.logWarning(
        `Router still unreachable: worker detached for ${String(seconds)} s`,
      ).pipe(
        Effect.annotateLogs({
          generation: state.generation,
          routerInstanceId: state.anchor.routerInstanceId,
          detachedSeconds: seconds,
        }),
      ),
    ),
  );

const logReattached = (state: RouterWorkerDetachedState): Effect.Effect<void> =>
  secondsSince(state.detachedAt).pipe(
    Effect.flatMap((seconds) =>
      Effect.logInfo(
        `Router answered: worker reattached after ${String(seconds)} s`,
      ).pipe(
        Effect.annotateLogs({
          generation: state.generation,
          routerInstanceId: state.anchor.routerInstanceId,
          detachedSeconds: seconds,
        }),
      ),
    ),
  );

/**
 * Mark the worker detached after a poll issued at `generation` lost the
 * Router through its quick retries, so sends and the outbound drain wait for
 * the next answered poll instead of transmitting. A generation that recovery
 * has since replaced stays as it is.
 * @param runtime Worker whose poll lost the Router.
 * @param generation Generation the failed poll was issued from.
 * @returns Completion once a matching active state is detached.
 */
export const detach = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  generation: number,
): Effect.Effect<void> =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((detachedAt) =>
      runtime.stateGate.withPermits(1)(
        Ref.modify(
          runtime.state,
          (
            state,
          ): readonly [
            Option.Option<RouterWorkerDetachedState>,
            RouterWorkerState,
          ] => {
            if (state.kind !== "active" || state.generation !== generation) {
              return [Option.none(), state];
            }
            const detached: RouterWorkerDetachedState = {
              ...state,
              kind: "detached",
              detachedAt,
            };
            return [Option.some(detached), detached];
          },
        ),
      ),
    ),
    Effect.flatMap(
      Option.match({ onNone: () => Effect.void, onSome: logDetached }),
    ),
  );

const detachedState = (
  state: RouterWorkerState,
): Option.Option<RouterWorkerDetachedState> =>
  state.kind === "detached" ? Option.some(state) : Option.none();

const sameDetachment = Option.getEquivalence(
  (left: RouterWorkerDetachedState, right: RouterWorkerDetachedState) =>
    left.generation === right.generation &&
    left.detachedAt === right.detachedAt,
);

/**
 * Repeat a warning every `routerWorkerDetachedReportInterval` for as long as
 * one detachment lasts, so a Router that stays down is never silent.
 * @param runtime Worker whose attachment state is watched.
 * @returns A watcher that runs for the worker's lifetime.
 */
export const reportDetachment = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
): Effect.Effect<void> =>
  runtime.state.changes.pipe(
    Stream.map(detachedState),
    Stream.changesWith(sameDetachment),
    Stream.flatMap(
      Option.match({
        onNone: () => Stream.empty,
        onSome: (state) =>
          Stream.tick(routerWorkerDetachedReportInterval).pipe(
            Stream.drop(1),
            Stream.mapEffect(() => logStillDetached(state)),
          ),
      }),
      { switch: true },
    ),
    Stream.runDrain,
  );

/**
 * Mark a detached worker active again at its retained anchor, unless another
 * generation replaced it meanwhile.
 * @param runtime Worker whose probe the Router answered.
 * @param snapshot Detached state the probe was issued from.
 * @returns Completion once the worker is active or left as it was.
 */
export const reattach = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  snapshot: RouterWorkerDetachedState,
): Effect.Effect<void> =>
  runtime.stateGate.withPermits(1)(
    Ref.get(runtime.state).pipe(
      Effect.flatMap((current) =>
        current.kind === "detached" &&
        current.generation === snapshot.generation
          ? Ref.set(runtime.state, {
              kind: "active",
              generation: current.generation,
              anchor: current.anchor,
            }).pipe(Effect.zipRight(logReattached(current)))
          : Effect.void,
      ),
    ),
  );
