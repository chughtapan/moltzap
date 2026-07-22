import { it as effectIt } from "@effect/vitest";
import type { RpcSerialization } from "@effect/rpc";
import type { LeaseId } from "@moltzap/protocol/message/dispatch";
import {
  agentId,
  appId,
  connectionId,
  conversationId,
  messageId,
  taskId,
} from "@moltzap/protocol/testing";
import {
  Deferred,
  Effect,
  Either,
  Exit,
  Fiber,
  Option,
  TestClock,
} from "effect";
import { describe, expect } from "vitest";
import type { LeaseTransitionObserver } from "../network/presence/presence-types.js";
import { noopLeaseTransitionObserver } from "../network/presence/presence-types.js";
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
  use: (registry: LeaseRegistry) => Effect.Effect<A, E, never>,
  transitionObserver = noopLeaseTransitionObserver,
  connections = new ConnectionManager(),
): Effect.Effect<A, E, never> {
  return Effect.gen(function* () {
    const registry = yield* makeLeaseRegistry({
      connections,
      leaseRetentionMs: TEST_TTL_MS,
      transitionObserver,
    });
    return yield* use(registry).pipe(Effect.ensuring(registry.shutdown()));
  });
}

const unusedOriginatorOperation = () =>
  Effect.dieMessage("unused test originator operation");

function makeUnusedParser(): RpcSerialization.Parser {
  const fail = () =>
    Effect.runSync(Effect.dieMessage("unused test originator parser"));
  return { decode: fail, encode: fail };
}

function hangingOriginator(notifyStarted: Deferred.Deferred<void>): Originator {
  return {
    call: unusedOriginatorOperation,
    callback: unusedOriginatorOperation,
    notify: () =>
      Deferred.succeed(notifyStarted, void 0).pipe(
        Effect.zipRight(Effect.never),
      ),
    sink: {
      parser: makeUnusedParser(),
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
  expect(outcomes.filter(Either.isLeft)).toHaveLength(1);
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
    const beginEntered = yield* Deferred.make<void>();
    const releaseBegin = yield* Deferred.make<void>();
    const observer: LeaseTransitionObserver = {
      onLeaseActiveBegin: () =>
        Deferred.succeed(beginEntered, void 0).pipe(
          Effect.zipRight(Deferred.await(releaseBegin)),
        ),
      onLeaseActiveEnd: () => Effect.void,
    };
    return yield* withRegistry(
      (registry) =>
        asyncObserverScenario(registry, { beginEntered, releaseBegin }).pipe(
          Effect.ensuring(Deferred.succeed(releaseBegin, void 0)),
        ),
      observer,
    );
  });
}

interface BeginGate {
  readonly beginEntered: Deferred.Deferred<void>;
  readonly releaseBegin: Deferred.Deferred<void>;
}

function asyncObserverScenario(registry: LeaseRegistry, gate: BeginGate) {
  return Effect.gen(function* () {
    const leaseId = yield* mintLease(registry);
    const resolveFiber = yield* Effect.fork(grantLease(registry, leaseId));
    yield* Deferred.await(gate.beginEntered);
    yield* registry.attachRoundTripFiber(leaseId, resolveFiber);
    const claimFiber = yield* Effect.fork(registry.claim(leaseId));
    expect(Option.isNone(yield* Fiber.poll(claimFiber))).toBe(true);
    yield* Deferred.succeed(gate.releaseBegin, void 0);
    expect(Exit.isSuccess(yield* Fiber.await(resolveFiber))).toBe(true);
    expect(Exit.isSuccess(yield* Fiber.await(claimFiber))).toBe(true);
  });
}

function rollbackStartsANewTtlEpoch() {
  return withRegistry((registry) =>
    Effect.gen(function* () {
      const leaseId = yield* mintLease(registry);
      yield* grantLease(registry, leaseId);
      yield* TestClock.adjust(OLD_TTL_ELAPSED_MS);
      const claim = yield* registry.claim(leaseId);
      yield* claim.rollback;
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

function shutdownReleasesPendingNotifications() {
  return Effect.gen(function* () {
    const notifyStarted = yield* Deferred.make<void>();
    const connections = new ConnectionManager();
    yield* connections.addUnauthenticated(
      BINDING.moderatorConnectionId,
      UNUSED_SOCKET,
      hangingOriginator(notifyStarted),
    );
    return yield* withRegistry(
      (registry) =>
        Effect.gen(function* () {
          const leaseId = yield* mintLease(registry);
          yield* grantLease(registry, leaseId);
          const claim = yield* registry.claim(leaseId);
          const finalizeFiber = yield* Effect.fork(claim.finalize(MESSAGE_ID));
          yield* Deferred.await(notifyStarted);
          yield* registry.shutdown();
          const completed = yield* Fiber.await(finalizeFiber);
          expect(Exit.isSuccess(completed)).toBe(true);
        }),
      noopLeaseTransitionObserver,
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
  it(
    "keeps a fast resolver alive and orders activation",
    resolveBeforeAttachStaysAlive,
  );
  it("starts a fresh TTL after rollback", rollbackStartsANewTtlEpoch);
  it(
    "releases pending notifications at shutdown",
    shutdownReleasesPendingNotifications,
  );
});
