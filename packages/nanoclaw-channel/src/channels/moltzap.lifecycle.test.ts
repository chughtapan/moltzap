import { live as it } from "@effect/vitest";
import { Data, Deferred, Effect, Either, Fiber } from "effect";
import { describe, expect, it as vitestIt } from "vitest";

import { makeMoltZapAdapter, MoltZapAdapter } from "./moltzap.js";
import {
  asJid,
  countedAcquisition,
  createHarness,
  offerTurn,
  setup,
  teardown,
  withTeardown,
} from "./moltzap.test-fixture.js";

const CONV_42 = "conv-42";
const PROFILE_ACQUIRED_ON_SETUP = "profile-acquired-on-setup";
const ACQUISITION_FAILURE_PATTERN = /HarnessAcquisitionTestError/;

class HarnessAcquisitionTestError extends Data.TaggedError(
  "HarnessAcquisitionTestError",
)<Record<never, never>> {}

function productionAdapter(): MoltZapAdapter {
  const adapter = makeMoltZapAdapter({
    profileName: PROFILE_ACQUIRED_ON_SETUP,
    evalMode: false,
  });
  expect(adapter).not.toBeNull();
  return /* Safe because the profile name above is non-null, so the factory returns an adapter. */ adapter!;
}

function expectPromiseFailure(
  effect: Effect.Effect<void, unknown>,
  pattern: RegExp,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const result = yield* Effect.either(effect);
    Either.match(result, {
      onLeft: (error) => {
        expect(String(error)).toMatch(pattern);
      },
      onRight: () => expect.unreachable("expected promise boundary failure"),
    });
  });
}

function constructsWithoutAcquiringItsClient() {
  const adapter = productionAdapter();
  expect(adapter).toBeInstanceOf(MoltZapAdapter);
  expect(adapter.isConnected()).toBe(false);
}

function teardownBeforeSetupResolvesWithoutAClient() {
  return expect(productionAdapter().teardown()).resolves.toBeUndefined();
}

function setupAcquiresTheClientAndConnects() {
  const harness = createHarness();
  return withTeardown(
    harness,
    Effect.gen(function* () {
      expect(harness.adapter.isConnected()).toBe(false);
      yield* setup(harness);
      expect(harness.counts.acquired).toBe(1);
      expect(harness.adapter.isConnected()).toBe(true);
    }),
  );
}

function setupWhileConnectedDoesNotReacquire() {
  const harness = createHarness();
  return withTeardown(
    harness,
    Effect.gen(function* () {
      yield* setup(harness);
      yield* setup(harness);
      expect(harness.counts.acquired).toBe(1);
      expect(harness.adapter.isConnected()).toBe(true);
    }),
  );
}

function concurrentSetupsSharePendingAcquisition() {
  const acquisitionStarted = Effect.runSync(Deferred.make<undefined>());
  const resumeAcquisition = Effect.runSync(Deferred.make<undefined>());
  let acquisitionAttempts = 0;
  const harness = createHarness({
    acquire: (client, counts) =>
      Effect.sync(() => {
        acquisitionAttempts += 1;
      }).pipe(
        Effect.zipRight(Deferred.succeed(acquisitionStarted, undefined)),
        Effect.zipRight(Deferred.await(resumeAcquisition)),
        Effect.zipRight(countedAcquisition(client, counts)),
      ),
  });

  return Effect.gen(function* () {
    const firstSetup = yield* setup(harness).pipe(Effect.fork);
    yield* Deferred.await(acquisitionStarted);
    const secondSetup = yield* setup(harness).pipe(Effect.fork);
    yield* Effect.yieldNow();
    const attemptsWhilePending = acquisitionAttempts;

    yield* Deferred.succeed(resumeAcquisition, undefined);
    yield* Fiber.join(firstSetup);
    yield* Fiber.join(secondSetup);

    expect(attemptsWhilePending).toBe(1);
    expect(harness.counts.acquired).toBe(1);
    expect(harness.adapter.isConnected()).toBe(true);

    yield* teardown(harness);
    expect(harness.counts.released).toBe(1);
  });
}

function teardownClosesTheAdapterOwnedScope() {
  const harness = createHarness();
  return Effect.gen(function* () {
    yield* setup(harness);
    expect(harness.counts.released).toBe(0);
    yield* teardown(harness);
    expect(harness.counts.released).toBe(1);
    expect(harness.adapter.isConnected()).toBe(false);
  });
}

function teardownWaitsForPendingAcquisition() {
  const acquisitionStarted = Effect.runSync(Deferred.make<undefined>());
  const resumeAcquisition = Effect.runSync(Deferred.make<undefined>());
  const teardownReturned = Effect.runSync(Deferred.make<undefined>());
  const harness = createHarness({
    acquire: (client, counts) =>
      Deferred.succeed(acquisitionStarted, undefined).pipe(
        Effect.zipRight(Deferred.await(resumeAcquisition)),
        Effect.zipRight(countedAcquisition(client, counts)),
      ),
  });
  return Effect.gen(function* () {
    const setupFiber = yield* setup(harness).pipe(Effect.fork);
    yield* Deferred.await(acquisitionStarted);
    const teardownFiber = yield* teardown(harness).pipe(
      Effect.ensuring(Deferred.succeed(teardownReturned, undefined)),
      Effect.fork,
    );

    yield* Effect.yieldNow();
    const returnedWhileAcquiring = yield* Deferred.isDone(teardownReturned);

    yield* Deferred.succeed(resumeAcquisition, undefined);
    yield* Fiber.join(setupFiber);
    yield* Fiber.join(teardownFiber);

    expect(returnedWhileAcquiring).toBe(false);
    expect(harness.counts.acquired).toBe(1);
    expect(harness.counts.released).toBe(1);
    expect(harness.adapter.isConnected()).toBe(false);
  });
}

function setupAfterTeardownAcquiresAgain() {
  const harness = createHarness();
  return withTeardown(
    harness,
    Effect.gen(function* () {
      yield* setup(harness);
      yield* teardown(harness);
      yield* setup(harness);
      expect(harness.counts.acquired).toBe(2);
      expect(harness.counts.released).toBe(1);

      expect(yield* offerTurn(harness, { conversationId: CONV_42 })).toBe(
        asJid(CONV_42),
      );
    }),
  );
}

function failedAcquisitionLeavesNoScopeBehind() {
  let attempts = 0;
  // The first attempt fails inside the adapter-owned scope; the second
  // succeeds, so a rejected setup leaves nothing half-open behind it.
  const harness = createHarness({
    acquire: (client, counts) =>
      Effect.suspend(() => {
        attempts += 1;
        return attempts === 1
          ? Effect.fail(new HarnessAcquisitionTestError())
          : countedAcquisition(client, counts);
      }),
  });
  return withTeardown(
    harness,
    Effect.gen(function* () {
      yield* expectPromiseFailure(setup(harness), ACQUISITION_FAILURE_PATTERN);
      expect(harness.adapter.isConnected()).toBe(false);

      yield* setup(harness);
      expect(harness.counts.acquired).toBe(1);
      expect(harness.adapter.isConnected()).toBe(true);
    }),
  );
}

describe("MoltZapAdapter lifecycle", () => {
  vitestIt(
    "constructs without acquiring its client",
    constructsWithoutAcquiringItsClient,
  );
  vitestIt(
    "teardown before setup resolves without a client",
    teardownBeforeSetupResolvesWithoutAClient,
  );
  it(
    "setup acquires the client and marks connected",
    setupAcquiresTheClientAndConnects,
  );
  it(
    "setup while connected does not reacquire the client",
    setupWhileConnectedDoesNotReacquire,
  );
  it(
    "concurrent setup calls share a pending client acquisition",
    concurrentSetupsSharePendingAcquisition,
  );
  it(
    "teardown closes the adapter-owned client scope",
    teardownClosesTheAdapterOwnedScope,
  );
  it(
    "teardown waits for a pending acquisition and closes it",
    teardownWaitsForPendingAcquisition,
  );
  it(
    "setup after teardown acquires a fresh client and drains it",
    setupAfterTeardownAcquiresAgain,
  );
  it(
    "a failed acquisition leaves no scope behind for the next setup",
    failedAcquisitionLeavesNoScopeBehind,
  );
});
