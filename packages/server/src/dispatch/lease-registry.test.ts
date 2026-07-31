import { it as effectIt } from "@effect/vitest";
import { RpcSerialization } from "@effect/rpc";
import type { LeaseId } from "@moltzap/protocol/message/dispatch";
import {
  agentId,
  appId,
  connectionId,
  conversationId,
  messageId,
  taskId,
} from "@moltzap/protocol/testing";
import { Deferred, Effect, Either, Fiber, Option, TestClock } from "effect";
import { describe, expect } from "vitest";
import {
  ConnectionManager,
  type Originator,
  type WebSocketRef,
} from "../socket/connection.js";
import {
  makeLeaseRegistry,
  type LeaseRegistry,
  type ModeratorBoundLeaseBinding,
} from "./lease-registry.js";

const TEST_TTL_MS = 1_000;
const OLD_TTL_ELAPSED_MS = 900;
const OLD_TTL_REMAINING_MS = TEST_TTL_MS - OLD_TTL_ELAPSED_MS;
const STATE_CLAIMED = "CLAIMED";
const STATE_CONSUMED = "CONSUMED";
const STATE_DENIED = "DENIED";
const STATE_EXPIRED = "EXPIRED";
const STATE_GRANTED = "GRANTED";
const MESSAGE_ID = messageId("00000000-0000-4000-8000-00000000b737");

const BINDING = {
  _tag: "ModeratorBound",
  recipientAgentId: agentId("00000000-0000-4000-8000-00000000a737"),
  recipientConnectionId: connectionId("00000000-0000-4000-8000-00000000c737"),
  moderatorConnectionId: connectionId("00000000-0000-4000-8000-00000000c738"),
  conversationId: conversationId("00000000-0000-4000-8000-00000000d737"),
  taskId: taskId("00000000-0000-4000-8000-00000000e737"),
  appId: appId("00000000-0000-4000-8000-00000000f737"),
} satisfies ModeratorBoundLeaseBinding;

const it = effectIt.effect;

function withRegistry<A, E>(
  use: (registry: LeaseRegistry) => Effect.Effect<A, E>,
  connections?: ConnectionManager,
): Effect.Effect<A, E> {
  return Effect.gen(function* () {
    const registry = yield* makeLeaseRegistry({
      connections: connections ?? new ConnectionManager(),
      leaseRetentionMs: TEST_TTL_MS,
    });
    return yield* use(registry).pipe(Effect.ensuring(registry.shutdown()));
  });
}

const unusedOriginatorOperation = () =>
  Effect.dieMessage("unused test originator operation");

function hangingOriginator(
  notifyStarted: Deferred.Deferred<undefined>,
  notifyStopped: Deferred.Deferred<undefined>,
): Originator {
  return {
    call: unusedOriginatorOperation,
    callback: unusedOriginatorOperation,
    notify: () =>
      Deferred.succeed(notifyStarted, void 0).pipe(
        Effect.zipRight(Effect.never),
        Effect.ensuring(Deferred.succeed(notifyStopped, void 0)),
      ),
    sink: {
      parser: RpcSerialization.jsonRpc().unsafeMake(),
      inject: unusedOriginatorOperation,
    },
  };
}

const UNUSED_SOCKET: WebSocketRef = {
  write: () => Effect.void,
  shutdown: Effect.void,
};

function mintLease(registry: LeaseRegistry): Effect.Effect<LeaseId> {
  return registry.mint(BINDING).pipe(Effect.map(({ leaseId }) => leaseId));
}

function grantLease(registry: LeaseRegistry, leaseId: LeaseId) {
  return registry.resolve(leaseId, {
    _tag: "grant",
    leaseTimeoutMs: TEST_TTL_MS,
  });
}

function expectSingleWinner(
  outcomes: ReadonlyArray<Either.Either<unknown, unknown>>,
): void {
  expect(outcomes.filter(Either.isRight)).toHaveLength(1);
  const failures = outcomes.filter(Either.isLeft);
  expect(failures).toHaveLength(1);
  expect(failures[0]?.left).toMatchObject({ _tag: "LeaseInvalidError" });
}

function expectLeaseNotFound(result: Either.Either<unknown, unknown>): void {
  Either.match(result, {
    onLeft: (error) => {
      expect(error).toMatchObject({ _tag: "LeaseNotFoundError" });
    },
    onRight: () => expect.fail("expected retained lease to be removed"),
  });
}

function concurrentClaimsAreSingleUse() {
  return withRegistry((registry) =>
    Effect.gen(function* () {
      const leaseId = yield* mintLease(registry);
      yield* grantLease(registry, leaseId);
      const outcomes = yield* Effect.all(
        [
          registry.claim(leaseId).pipe(Effect.either),
          registry.claim(leaseId).pipe(Effect.either),
        ],
        { concurrency: 2 },
      );
      expectSingleWinner(outcomes);
      expect(
        (yield* registry.read({ _tag: "leaseId", value: leaseId })).state,
      ).toBe(STATE_CLAIMED);
    }),
  );
}

function concurrentResolutionsAreSingleUse() {
  return withRegistry((registry) =>
    Effect.gen(function* () {
      const leaseId = yield* mintLease(registry);
      const outcomes = yield* Effect.all(
        [
          registry.resolve(leaseId, { _tag: "grant" }).pipe(Effect.either),
          registry.resolve(leaseId, { _tag: "deny" }).pipe(Effect.either),
        ],
        { concurrency: 2 },
      );
      expectSingleWinner(outcomes);
      const expectedState = Either.match(outcomes[0], {
        onLeft: () => STATE_DENIED,
        onRight: () => STATE_GRANTED,
      });
      expect(
        (yield* registry.read({ _tag: "leaseId", value: leaseId })).state,
      ).toBe(expectedState);
    }),
  );
}

function finalizeAndRollbackAreSingleUse() {
  return withRegistry((registry) =>
    Effect.gen(function* () {
      const leaseId = yield* mintLease(registry);
      yield* grantLease(registry, leaseId);
      const claim = yield* registry.claim(leaseId);
      const outcomes = yield* Effect.all(
        [
          claim.finalize(MESSAGE_ID).pipe(Effect.either),
          claim.rollback.pipe(Effect.either),
        ],
        { concurrency: 2 },
      );
      expectSingleWinner(outcomes);
      const expectedState = Either.match(outcomes[0], {
        onLeft: () => STATE_GRANTED,
        onRight: () => STATE_CONSUMED,
      });
      expect(
        (yield* registry.read({ _tag: "leaseId", value: leaseId })).state,
      ).toBe(expectedState);
    }),
  );
}

function resolveBeforeAttachStaysAlive() {
  return Effect.gen(function* () {
    const granted = yield* Deferred.make<undefined>();
    const finishRoundTrip = yield* Deferred.make<undefined>();
    return yield* withRegistry((registry) =>
      fastResolverScenario(registry, { granted, finishRoundTrip }).pipe(
        Effect.ensuring(Deferred.succeed(finishRoundTrip, void 0)),
      ),
    );
  });
}

interface RoundTripGate {
  readonly granted: Deferred.Deferred<undefined>;
  readonly finishRoundTrip: Deferred.Deferred<undefined>;
}

/**
 * A round-trip child that resolves its lease before the parent attaches the
 * handle keeps running: attachment must leave the winning child alive to
 * finish its post-commit work.
 * @param registry Value supplied to the operation.
 * @param gate Value supplied to the operation.
 * @returns The fast resolver scenario result.
 */
function fastResolverScenario(registry: LeaseRegistry, gate: RoundTripGate) {
  return Effect.gen(function* () {
    const leaseId = yield* mintLease(registry);
    const resolveFiber = yield* Effect.fork(
      grantLease(registry, leaseId).pipe(
        Effect.zipRight(Deferred.succeed(gate.granted, void 0)),
        Effect.zipRight(Deferred.await(gate.finishRoundTrip)),
      ),
    );
    yield* Deferred.await(gate.granted);
    yield* registry.attachRoundTripFiber(leaseId, resolveFiber);
    expect(Option.isNone(yield* Fiber.poll(resolveFiber))).toBe(true);
    yield* Deferred.succeed(gate.finishRoundTrip, void 0);
    yield* Fiber.join(resolveFiber);
  });
}

function rollbackStartsANewTtlEpoch() {
  return withRegistry((registry) =>
    Effect.gen(function* () {
      const leaseId = yield* mintLease(registry);
      yield* grantLease(registry, leaseId);
      yield* TestClock.adjust(OLD_TTL_ELAPSED_MS);
      const claim = yield* registry.claim(leaseId);
      yield* claim.rollback.pipe(Effect.uninterruptible);
      yield* TestClock.adjust(OLD_TTL_REMAINING_MS);
      expect(
        (yield* registry.read({ _tag: "leaseId", value: leaseId })).state,
      ).toBe(STATE_GRANTED);
      yield* TestClock.adjust(OLD_TTL_ELAPSED_MS);
      expect(
        (yield* registry.read({ _tag: "leaseId", value: leaseId })).state,
      ).toBe(STATE_EXPIRED);
    }),
  );
}

function hangingNotificationDoesNotBlockFinalizeOrRetention() {
  return Effect.gen(function* () {
    const notifyStarted = yield* Deferred.make<undefined>();
    const notifyStopped = yield* Deferred.make<undefined>();
    const connections = new ConnectionManager();
    yield* connections.addUnauthenticated(
      BINDING.moderatorConnectionId,
      UNUSED_SOCKET,
      hangingOriginator(notifyStarted, notifyStopped),
    );
    return yield* withRegistry(
      (registry) =>
        Effect.gen(function* () {
          const leaseId = yield* mintLease(registry);
          yield* grantLease(registry, leaseId);
          const claim = yield* registry.claim(leaseId);
          const finalizeFiber = yield* Effect.fork(
            claim.finalize(MESSAGE_ID).pipe(Effect.uninterruptible),
          );
          yield* Deferred.await(notifyStarted);
          yield* Fiber.join(finalizeFiber);
          yield* TestClock.adjust(TEST_TTL_MS);
          const retained = yield* registry
            .read({ _tag: "leaseId", value: leaseId })
            .pipe(Effect.either);
          expectLeaseNotFound(retained);
          yield* registry.shutdown();
          yield* Deferred.await(notifyStopped);
        }),
      connections,
    );
  });
}

describe("LeaseRegistry", () => {
  it("allows exactly one concurrent claim", concurrentClaimsAreSingleUse);
  it(
    "allows exactly one concurrent resolution",
    concurrentResolutionsAreSingleUse,
  );
  it(
    "allows exactly one finalize or rollback",
    finalizeAndRollbackAreSingleUse,
  );
  it("keeps a fast resolver alive", resolveBeforeAttachStaysAlive);
  it("starts a fresh TTL after rollback", rollbackStartsANewTtlEpoch);
  it(
    "does not let a hanging notification block finalize or retention",
    hangingNotificationDoesNotBlockFinalizeOrRetention,
  );
});
