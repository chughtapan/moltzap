import type { HarnessClientService } from "@moltzap/client/harness-client";
import { live as it } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber } from "effect";
import { describe, expect } from "vitest";
import { HarnessGatewayLifecycle } from "./openclaw-gateway-lifecycle.js";
import { createHarnessFixture } from "./test-utils/harness-fixture.js";

const ACCOUNT_ID = "lifecycle-account";

const acquireWithBlockedRelease = (
  client: HarnessClientService,
  releaseStarted: Deferred.Deferred<undefined>,
  allowRelease: Deferred.Deferred<undefined>,
) =>
  Effect.acquireRelease(Effect.succeed(client), () =>
    Deferred.succeed(releaseStarted, undefined).pipe(
      Effect.zipRight(Deferred.await(allowRelease)),
    ),
  );

const awaitStop = <A>(fiber: Fiber.Fiber<A>) =>
  Fiber.join(fiber).pipe(
    Effect.timeoutFail({
      duration: Duration.seconds(1),
      onTimeout: () =>
        new Error("stop did not cancel the replacement acquisition"),
    }),
  );

const stopCancelsBlockedAcquisition = () =>
  Effect.gen(function* () {
    const lifecycle = new HarnessGatewayLifecycle();
    const acquisitionStarted = yield* Deferred.make<undefined>();
    const startFiber = yield* lifecycle
      .run({
        accountId: ACCOUNT_ID,
        acquireClient: Deferred.succeed(acquisitionStarted, undefined).pipe(
          Effect.zipRight(Effect.never),
        ),
        isCancelled: () => false,
        waitForCancellation: Effect.never,
        runClient: () => Effect.never,
      })
      .pipe(Effect.fork);

    yield* Deferred.await(acquisitionStarted);
    yield* lifecycle.stop(ACCOUNT_ID);
    yield* Fiber.join(startFiber);

    expect(lifecycle.hasGeneration(ACCOUNT_ID)).toBe(false);
    expect(lifecycle.outboundClients.has(ACCOUNT_ID)).toBe(false);
  });

const replacementCancelsBlockedAcquisition = () =>
  Effect.gen(function* () {
    const lifecycle = new HarnessGatewayLifecycle();
    const firstAcquisitionStarted = yield* Deferred.make<undefined>();
    const secondGenerationRunning = yield* Deferred.make<undefined>();
    const fixture = createHarnessFixture();
    const firstFiber = yield* lifecycle
      .run({
        accountId: ACCOUNT_ID,
        acquireClient: Deferred.succeed(
          firstAcquisitionStarted,
          undefined,
        ).pipe(Effect.zipRight(Effect.never)),
        isCancelled: () => false,
        waitForCancellation: Effect.never,
        runClient: () => Effect.never,
      })
      .pipe(Effect.fork);

    yield* Deferred.await(firstAcquisitionStarted);
    const secondFiber = yield* lifecycle
      .run({
        accountId: ACCOUNT_ID,
        acquireClient: Effect.succeed(fixture.client),
        isCancelled: () => false,
        waitForCancellation: Effect.never,
        runClient: ({ generation }) =>
          Deferred.succeed(secondGenerationRunning, undefined).pipe(
            Effect.zipRight(Deferred.await(generation.stopSignal)),
          ),
      })
      .pipe(Effect.fork);

    yield* Deferred.await(secondGenerationRunning);
    yield* Fiber.join(firstFiber);
    expect(lifecycle.outboundClients.get(ACCOUNT_ID)?.client).toBe(
      fixture.client,
    );

    yield* lifecycle.stop(ACCOUNT_ID);
    yield* Fiber.join(secondFiber);
  });

const stopDuringReplacementHandoff = () =>
  Effect.scoped(
    Effect.gen(function* () {
      const lifecycle = new HarnessGatewayLifecycle();
      const fixture = createHarnessFixture();
      const firstRunning = yield* Deferred.make<undefined>();
      const firstReleaseStarted = yield* Deferred.make<undefined>();
      const allowFirstRelease = yield* Deferred.make<undefined>();

      const firstFiber = yield* lifecycle
        .run({
          accountId: ACCOUNT_ID,
          acquireClient: acquireWithBlockedRelease(
            fixture.client,
            firstReleaseStarted,
            allowFirstRelease,
          ),
          isCancelled: () => false,
          waitForCancellation: Effect.never,
          runClient: ({ generation }) =>
            Deferred.succeed(firstRunning, undefined).pipe(
              Effect.zipRight(Deferred.await(generation.stopSignal)),
            ),
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(firstRunning);

      const secondFiber = yield* lifecycle
        .run({
          accountId: ACCOUNT_ID,
          acquireClient: Effect.never,
          isCancelled: () => false,
          waitForCancellation: Effect.never,
          runClient: () => Effect.never,
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(firstReleaseStarted);

      const stopFiber = yield* lifecycle
        .stop(ACCOUNT_ID)
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow();
      yield* Deferred.succeed(allowFirstRelease, undefined);

      yield* awaitStop(stopFiber);
      yield* Fiber.join(firstFiber);
      yield* Fiber.join(secondFiber);
      expect(lifecycle.hasGeneration(ACCOUNT_ID)).toBe(false);
      expect(lifecycle.outboundClients.has(ACCOUNT_ID)).toBe(false);
    }),
  );

const cancellationInterruptsBlockedAcquisition = () =>
  Effect.gen(function* () {
    const lifecycle = new HarnessGatewayLifecycle();
    const acquisitionStarted = yield* Deferred.make<undefined>();
    const cancelled = yield* Deferred.make<undefined>();
    let isCancelled = false;
    const startFiber = yield* lifecycle
      .run({
        accountId: ACCOUNT_ID,
        acquireClient: Deferred.succeed(acquisitionStarted, undefined).pipe(
          Effect.zipRight(Effect.never),
        ),
        isCancelled: () => isCancelled,
        waitForCancellation: Deferred.await(cancelled),
        runClient: () => Effect.never,
      })
      .pipe(Effect.fork);

    yield* Deferred.await(acquisitionStarted);
    isCancelled = true;
    yield* Deferred.succeed(cancelled, undefined);
    yield* Fiber.join(startFiber);

    expect(lifecycle.hasGeneration(ACCOUNT_ID)).toBe(false);
    expect(lifecycle.outboundClients.has(ACCOUNT_ID)).toBe(false);
  });

// @agent-code-guard/regression-only: these examples pin stop and cancellation while a scoped client is still acquiring.
describe("HarnessGatewayLifecycle", () => {
  it(
    "stops an account whose client acquisition is blocked",
    stopCancelsBlockedAcquisition,
  );
  it(
    "replaces an account whose client acquisition is blocked",
    replacementCancelsBlockedAcquisition,
  );
  it(
    "stops a replacement waiting for the prior release",
    stopDuringReplacementHandoff,
  );
  it(
    "cancels an account whose client acquisition is blocked",
    cancellationInterruptsBlockedAcquisition,
  );
});
