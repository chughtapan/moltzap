/** @file Router discontinuity recovery polling and generation fencing. */

import type { SignedMessage } from "@moltzap/identity";
import type { RouterInstanceId, RouterPollResult } from "@moltzap/router";
import { Effect, Fiber, Ref, Schedule } from "effect";
import {
  pollRouterTail,
  routerWorkerRetrySchedule,
  transmitOuter,
} from "./router-worker-transport.js";
import {
  type RouterWorkerAuthenticationError,
  RouterWorkerDiscontinuityError,
  type RouterWorkerPersistenceError,
  type RouterWorkerPollError,
  RouterWorkerProtocolError,
  type RouterWorkerRecoveringState,
  routerWorkerRetryAttempts,
  type RouterWorkerRuntime,
  type RouterWorkerSendError,
  type RouterWorkerState,
  RouterWorkerTransportError,
  RouterWorkerUnavailableError,
  type RouterWorkerVerifiedIngress,
} from "./router-worker-types.js";

type AnchoredRecoveringState = RouterWorkerRecoveringState & {
  readonly anchor: NonNullable<RouterWorkerRecoveringState["anchor"]>;
};

interface RecoveryOperations {
  readonly verifyBatch: (
    messages: readonly SignedMessage[],
  ) => Effect.Effect<
    readonly RouterWorkerVerifiedIngress[],
    RouterWorkerAuthenticationError | RouterWorkerPersistenceError
  >;
  readonly acceptRecovery: (
    ingress: RouterWorkerVerifiedIngress,
  ) => Effect.Effect<void, RouterWorkerPersistenceError>;
}

interface RecoveryBatch {
  readonly result: Extract<RouterPollResult, { readonly kind: "batch" }>;
  readonly verified: readonly RouterWorkerVerifiedIngress[];
}

const mapTransportError = () => new RouterWorkerTransportError();

const matchesRecovery = (
  state: RouterWorkerState,
  generation: number,
  routerInstanceId: RouterInstanceId,
): state is AnchoredRecoveringState =>
  state.kind === "recovering" &&
  state.generation === generation &&
  state.anchor?.routerInstanceId === routerInstanceId;

const snapshotRecovery = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  generation: number,
): Effect.Effect<AnchoredRecoveringState, RouterWorkerDiscontinuityError> =>
  Ref.get(runtime.state).pipe(
    Effect.flatMap((state) =>
      state.kind === "recovering" &&
      state.generation === generation &&
      state.anchor !== undefined
        ? Effect.succeed({ ...state, anchor: state.anchor })
        : Effect.fail(new RouterWorkerDiscontinuityError()),
    ),
  );

const commitRecoveryBatch = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  operations: RecoveryOperations,
  snapshot: AnchoredRecoveringState,
  batch: RecoveryBatch,
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  runtime.stateGate.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(runtime.state);
      if (
        !matchesRecovery(
          current,
          snapshot.generation,
          batch.result.routerInstanceId,
        )
      ) {
        return;
      }
      yield* Effect.forEach(batch.verified, operations.acceptRecovery, {
        concurrency: 1,
      });
      yield* Ref.set(runtime.state, {
        ...current,
        anchor: { ...current.anchor, pollCursor: batch.result.pollCursor },
      });
    }),
  );

const recoverySend = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  message: SignedMessage,
): Effect.Effect<void, RouterWorkerSendError> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(runtime.state);
    if (state.kind !== "recovering" || state.anchor === undefined) {
      return yield* Effect.fail(new RouterWorkerUnavailableError());
    }
    if (message.senderAgentId !== runtime.input.callerAgentId) {
      return yield* Effect.fail(new RouterWorkerProtocolError());
    }
    const outcome = yield* transmitOuter(runtime, {
      message,
      instance: state.anchor.routerInstanceId,
      mode: "initial",
      attemptsRemaining: routerWorkerRetryAttempts,
    });
    if (outcome.kind === "restarted") {
      return yield* Effect.fail(new RouterWorkerDiscontinuityError());
    }
  });

const pollRecoveringOnce = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  operations: RecoveryOperations,
  generation: number,
): Effect.Effect<void, RouterWorkerPollError> =>
  Effect.gen(function* () {
    const snapshot = yield* snapshotRecovery(runtime, generation);
    const result = yield* runtime.router
      .poll({
        request: { pollCursor: snapshot.anchor.pollCursor },
        callerAgentId: runtime.input.callerAgentId,
        signingAuthority: runtime.input.signingAuthority,
      })
      .pipe(Effect.mapError(mapTransportError));
    switch (result.kind) {
      case "batch": {
        if (result.routerInstanceId !== snapshot.anchor.routerInstanceId) {
          return yield* Effect.fail(new RouterWorkerDiscontinuityError());
        }
        const verified = yield* operations.verifyBatch(result.signedMessages);
        yield* commitRecoveryBatch(runtime, operations, snapshot, {
          result,
          verified,
        });
        return;
      }
      case "feed_gap":
      case "cursor_invalid":
        return yield* Effect.fail(new RouterWorkerDiscontinuityError());
      default:
        return yield* Effect.fail(new RouterWorkerProtocolError());
    }
  }).pipe(Effect.interruptible);

const pumpRecovery = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  operations: RecoveryOperations,
  recovering: RouterWorkerRecoveringState,
): Effect.Effect<never, RouterWorkerPollError> =>
  pollRecoveringOnce(runtime, operations, recovering.generation).pipe(
    Effect.retry(
      routerWorkerRetrySchedule.pipe(
        Schedule.whileInput(
          (error: RouterWorkerPollError) =>
            error._tag === "RouterWorkerTransportError",
        ),
      ),
    ),
    Effect.forever,
    Effect.interruptible,
  );

/**
 * Reconcile certified history while only recovery traffic advances the cursor.
 * @param runtime Worker runtime whose generation is being recovered.
 * @param operations Verification and persistence operations for recovery.
 * @param recovering Generation-scoped state to reconcile.
 * @returns An effect that completes after the worker becomes active.
 */
export const finishRouterRecovery = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  operations: RecoveryOperations,
  recovering: RouterWorkerRecoveringState,
): Effect.Effect<void, RouterWorkerPollError> =>
  Effect.gen(function* () {
    const anchor = yield* pollRouterTail(runtime, runtime.input);
    yield* runtime.stateGate.withPermits(1)(
      Ref.set(runtime.state, { ...recovering, anchor }),
    );
    yield* Effect.raceWith(
      runtime.input.callbacks.recoverCertifiedHistory({
        reason: recovering.reason,
        anchor,
        send: (message) => recoverySend(runtime, message),
      }),
      pumpRecovery(runtime, operations, recovering),
      {
        onSelfDone: (exit, pump) =>
          Fiber.interrupt(pump).pipe(Effect.zipRight(exit)),
        onOtherDone: (exit, recover) =>
          Fiber.interrupt(recover).pipe(Effect.zipRight(exit)),
      },
    );
    yield* runtime.stateGate.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(runtime.state);
        if (
          !matchesRecovery(
            current,
            recovering.generation,
            anchor.routerInstanceId,
          )
        ) {
          return yield* Effect.fail(new RouterWorkerDiscontinuityError());
        }
        yield* Ref.set(runtime.state, {
          kind: "active",
          generation: recovering.generation,
          anchor: current.anchor,
        });
      }),
    );
  }).pipe(Effect.withSpan("finishRouterRecovery"));
