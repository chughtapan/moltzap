/** @file Regression coverage for in-process link-policy interpretation. */

import { assert, effect as test } from "@effect/vitest";
import {
  AgentCardDigest,
  AgentId,
  type AgentId as AgentIdValue,
  MessageId,
  type SignedMessage,
} from "@moltzap/identity";
import {
  Chunk,
  Deferred,
  Duration,
  Effect,
  Encoding,
  Exit,
  Fiber,
  Schema,
  Scope,
  TestClock,
} from "effect";
import {
  linkPolicy,
  linkVerdict,
  NetworkError,
  type NetworkOperation,
} from "../network/index.js";
import { makeLinkFabric } from "./link-fabric.js";

const identifierPayload = (seed: number, bytes = 16): string =>
  Encoding.encodeBase64Url(new Uint8Array(bytes).fill(seed));

const agentId = (seed: number): AgentIdValue =>
  Schema.decodeUnknownSync(AgentId)(`agt_${identifierPayload(seed)}`);

const aliceId = agentId(1);
const bobId = agentId(2);
const carolId = agentId(3);
const digest = Schema.decodeUnknownSync(AgentCardDigest)(
  `acd_${identifierPayload(9, 32)}`,
);
const SHAPE_LINK_OPERATION: NetworkOperation = "shape-link";
const DISABLE_LINK_OPERATION: NetworkOperation = "disable-link";
const RECEIVE_OPERATION: NetworkOperation = "receive";
const ENABLE_LINK_OPERATION: NetworkOperation = "enable-link";

function message(senderAgentId: AgentIdValue, suffix: number): SignedMessage {
  return Object.freeze({
    senderAgentId,
    agentCardDigest: digest,
    recipientAgentIds: Object.freeze([bobId]),
    messageId: Schema.decodeUnknownSync(MessageId)(
      `msg_${identifierPayload(20 + suffix)}`,
    ),
    body: Uint8Array.of(suffix),
  });
}

function makeAttachedFabric() {
  return Effect.gen(function* () {
    const fabric = yield* makeLinkFabric();
    yield* fabric.interceptor.attach(bobId);
    return fabric;
  });
}

function awaitSleepers(count: number): Effect.Effect<void> {
  return TestClock.sleeps().pipe(
    Effect.flatMap((sleeps) =>
      Chunk.size(sleeps) >= count
        ? Effect.void
        : Effect.yieldNow().pipe(
            Effect.zipRight(Effect.suspend(() => awaitSleepers(count))),
          ),
    ),
  );
}

function expectInterrupted(exit: Exit.Exit<unknown, unknown>): void {
  assert.isTrue(Exit.isInterrupted(exit));
}

function close(scope: Scope.CloseableScope) {
  return Scope.close(scope, Exit.void);
}

// @agent-code-guard/regression-only: deterministic scopes and TestClock expose exact policy, ordering, and release semantics
test("drop policy affects only its directed pair and clear restores delivery", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fabric = yield* makeAttachedFabric();
      const lease = yield* fabric.driver.apply(
        aliceId,
        bobId,
        linkPolicy.dropAll("partition"),
        "partition",
      );
      const dropped = message(aliceId, 1);
      const passing = message(carolId, 2);
      const routed = yield* fabric.route(bobId, [
        { message: dropped },
        { message: passing },
      ]);
      assert.deepStrictEqual(
        routed.map((item) => item.message.messageId),
        [passing.messageId],
      );

      yield* lease.clear;
      const restored = message(aliceId, 3);
      const delivered = yield* fabric.route(bobId, [{ message: restored }]);
      assert.deepStrictEqual(
        delivered.map((item) => item.message.messageId),
        [restored.messageId],
      );
    }),
  ));

test("delay keeps sender FIFO without blocking another sender", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fabric = yield* makeAttachedFabric();
      yield* fabric.driver.apply(
        aliceId,
        bobId,
        linkPolicy.delay(Duration.millis(100)),
        "delay alice",
      );
      const first = message(aliceId, 1);
      const second = message(aliceId, 2);
      const passing = message(carolId, 3);
      const immediate = yield* fabric.route(bobId, [
        { message: first },
        { message: second },
        { message: passing },
      ]);
      yield* awaitSleepers(1);
      assert.deepStrictEqual(
        immediate.map((item) => item.message.messageId),
        [passing.messageId],
      );

      yield* TestClock.adjust(Duration.millis(100));
      yield* awaitSleepers(1);
      const firstReady = yield* fabric.drain(bobId);
      assert.deepStrictEqual(
        firstReady.map((item) => item.message.messageId),
        [first.messageId],
      );
      yield* TestClock.adjust(Duration.millis(100));
      yield* Effect.yieldNow();
      const secondReady = yield* fabric.drain(bobId);
      assert.deepStrictEqual(
        secondReady.map((item) => item.message.messageId),
        [second.messageId],
      );
    }),
  ));

test("released holds re-evaluate the active chain", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fabric = yield* makeAttachedFabric();
      const held = yield* Deferred.make<undefined>();
      const hold = yield* fabric.driver.apply(
        aliceId,
        bobId,
        () =>
          Deferred.succeed(held, undefined).pipe(Effect.as(linkVerdict.hold())),
        "hold",
      );
      const pending = message(aliceId, 1);
      assert.deepStrictEqual(
        yield* fabric.route(bobId, [{ message: pending }]),
        [],
      );
      yield* Deferred.await(held);
      const dropped = yield* Deferred.make<undefined>();
      const drop = yield* fabric.driver.apply(
        aliceId,
        bobId,
        () =>
          Deferred.succeed(dropped, undefined).pipe(
            Effect.as(linkVerdict.drop({ reason: "drop after hold" })),
          ),
        "drop",
      );
      yield* hold.clear;
      yield* Deferred.await(dropped);
      assert.deepStrictEqual(yield* fabric.drain(bobId), []);

      yield* drop.clear;
      const restored = message(aliceId, 2);
      const delivered = yield* fabric.route(bobId, [{ message: restored }]);
      assert.deepStrictEqual(
        delivered.map((item) => item.message.messageId),
        [restored.messageId],
      );
    }),
  ));

test("shaping an unattached receiver fails fast", () =>
  Effect.gen(function* () {
    const fabric = yield* makeLinkFabric();
    const failure = yield* Effect.flip(
      fabric.driver.apply(aliceId, bobId, linkPolicy.passthrough, "unattached"),
    );
    assert.strictEqual(failure.operation, SHAPE_LINK_OPERATION);
    assert.include(failure.detail, bobId);
  }));

test("disable installs a clearable drop and enable restores delivery", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fabric = yield* makeAttachedFabric();
      const inspected = yield* Deferred.make<undefined>();
      const inspection = yield* fabric.driver.apply(
        aliceId,
        bobId,
        () =>
          Deferred.succeed(inspected, undefined).pipe(
            Effect.as(linkVerdict.deliver()),
          ),
        "delivery inspection",
      );
      yield* fabric.driver.disable(aliceId, bobId);
      assert.deepStrictEqual(
        yield* fabric.route(bobId, [{ message: message(aliceId, 1) }]),
        [],
      );
      yield* Deferred.await(inspected);

      const duplicate = yield* Effect.flip(
        fabric.driver.disable(aliceId, bobId),
      );
      assert.strictEqual(duplicate.operation, DISABLE_LINK_OPERATION);

      yield* fabric.driver.enable(aliceId, bobId);
      const restored = message(aliceId, 2);
      const delivered = yield* fabric.route(bobId, [{ message: restored }]);
      assert.deepStrictEqual(
        delivered.map((item) => item.message.messageId),
        [restored.messageId],
      );
      yield* inspection.clear;
    }),
  ));

test("interrupted policy cleanup cannot leave a hidden permanent fault", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fabric = yield* makeAttachedFabric();
      const lease = yield* fabric.driver.apply(
        aliceId,
        bobId,
        linkPolicy.dropAll("temporary fault"),
        "temporary fault",
      );
      const clearing = yield* Effect.fork(lease.clear);
      yield* Effect.yieldNow();
      yield* Fiber.interrupt(clearing);

      const restored = message(aliceId, 12);
      const delivered = yield* fabric.route(bobId, [{ message: restored }]);
      assert.deepStrictEqual(
        delivered.map((item) => item.message.messageId),
        [restored.messageId],
      );
    }),
  ));

test("interrupted receiver scope release leaves no reserved attachment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fabric = yield* makeLinkFabric();
      const attached = yield* Deferred.make<undefined>();
      const receiver = yield* Effect.scoped(
        fabric.interceptor.attach(bobId).pipe(
          Effect.tap(() => Deferred.succeed(attached, undefined)),
          Effect.zipRight(Effect.never),
        ),
      ).pipe(Effect.fork);
      yield* Deferred.await(attached);
      yield* Fiber.interrupt(receiver);

      yield* Effect.scoped(fabric.interceptor.attach(bobId));
    }),
  ));

test("interruption while waiting for the serializer leaves driver state unchanged", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serialization = yield* Effect.makeSemaphore(1);
      const fabric = yield* makeLinkFabric(serialization);
      yield* fabric.interceptor.attach(bobId);
      yield* serialization.take(1);
      const attempting = yield* Deferred.make<undefined>();
      const waiting = yield* Deferred.succeed(attempting, undefined).pipe(
        Effect.zipRight(fabric.driver.disable(aliceId, bobId)),
        Effect.fork,
      );
      yield* Deferred.await(attempting);
      const interrupted = yield* Fiber.interrupt(waiting);
      yield* serialization.release(1);

      expectInterrupted(interrupted);
      assert.isFalse(yield* fabric.needsInterception(bobId));
      yield* fabric.driver.disable(aliceId, bobId);
      yield* fabric.driver.enable(aliceId, bobId);
    }),
  ));

test("post-commit driver interruption preserves the committed state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fabric = yield* makeLinkFabric();
      yield* fabric.interceptor.attach(bobId);
      const committed = yield* Deferred.make<undefined>();
      const release = yield* Deferred.make<undefined>();
      const disabling = yield* fabric.driver
        .disable(aliceId, bobId)
        .pipe(
          Effect.ensuring(
            Deferred.succeed(committed, undefined).pipe(
              Effect.zipRight(Deferred.await(release)),
            ),
          ),
          Effect.fork,
        );

      yield* Deferred.await(committed);
      yield* Fiber.interruptFork(disabling);
      yield* Deferred.succeed(release, undefined);
      expectInterrupted(yield* Fiber.await(disabling));
      assert.isTrue(yield* fabric.needsInterception(bobId));

      yield* fabric.driver.enable(aliceId, bobId);
      assert.isFalse(yield* fabric.needsInterception(bobId));
    }),
  ));

test("an attached route is ready before publication and preserves inactive bytes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fabric = yield* makeLinkFabric();
      yield* fabric.interceptor.attach(bobId);
      const first = message(aliceId, 1);
      const second = message(aliceId, 2);

      const routed = yield* fabric.route(bobId, [
        { message: first },
        { message: second },
      ]);

      assert.strictEqual(routed[0]?.message, first);
      assert.strictEqual(routed[1]?.message, second);
      assert.deepStrictEqual(
        routed.map((item) => item.message.body),
        [first.body, second.body],
      );
    }),
  ));

test("closing a route blocked at acceptance fails and permits reattachment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fabric = yield* makeLinkFabric();
      const receiverScope = yield* Scope.make();
      yield* fabric.interceptor.attach(bobId).pipe(Scope.extend(receiverScope));
      const evaluating = yield* Deferred.make<undefined>();
      const lease = yield* fabric.driver.apply(
        aliceId,
        bobId,
        () =>
          Deferred.succeed(evaluating, undefined).pipe(
            Effect.zipRight(Effect.never),
          ),
        "blocked evaluation",
      );
      const routing = yield* fabric
        .route(bobId, [{ message: message(aliceId, 8) }])
        .pipe(Effect.fork);
      yield* Deferred.await(evaluating);

      yield* close(receiverScope);
      const failure = yield* Effect.flip(Fiber.join(routing));
      assert.instanceOf(failure, NetworkError);
      assert.strictEqual(failure.operation, RECEIVE_OPERATION);
      assert.include(failure.detail, "stopped accepting deliveries");

      const reattachedScope = yield* Scope.make();
      yield* fabric.interceptor
        .attach(bobId)
        .pipe(Scope.extend(reattachedScope));
      yield* lease.clear;
      const restored = message(aliceId, 9);
      const routed = yield* fabric.route(bobId, [{ message: restored }]);
      assert.strictEqual(routed[0]?.message, restored);
      yield* close(reattachedScope);
    }),
  ));

test("a defecting policy closes its worker route and releases every caller", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fabric = yield* makeLinkFabric();
      const failedScope = yield* Scope.make();
      yield* fabric.interceptor.attach(bobId).pipe(Scope.extend(failedScope));
      const evaluating = yield* Deferred.make<undefined>();
      const lease = yield* fabric.driver.apply(
        aliceId,
        bobId,
        () =>
          Deferred.succeed(evaluating, undefined).pipe(
            Effect.zipRight(Effect.dieMessage("policy exploded")),
          ),
        "defecting policy",
      );
      const pending = yield* fabric
        .route(bobId, [{ message: message(aliceId, 10) }])
        .pipe(Effect.fork);
      yield* Deferred.await(evaluating);

      const pendingFailure = yield* Effect.flip(Fiber.join(pending));
      assert.instanceOf(pendingFailure, NetworkError);
      assert.strictEqual(pendingFailure.operation, RECEIVE_OPERATION);
      assert.include(pendingFailure.detail, "route worker failed");
      assert.include(pendingFailure.detail, "policy exploded");

      const newFailure = yield* Effect.flip(
        fabric.route(bobId, [{ message: message(carolId, 11) }]),
      );
      assert.instanceOf(newFailure, NetworkError);
      assert.strictEqual(newFailure.operation, RECEIVE_OPERATION);
      assert.include(newFailure.detail, "is not attached");

      yield* lease.clear;
      const replacementScope = yield* Scope.make();
      yield* fabric.interceptor
        .attach(bobId)
        .pipe(Scope.extend(replacementScope));
      yield* close(failedScope);
      const restored = message(aliceId, 12);
      const routed = yield* fabric.route(bobId, [{ message: restored }]);
      assert.strictEqual(routed[0]?.message, restored);
      yield* close(replacementScope);
    }),
  ));

test("interrupted apply cleanup leaves no retained policy", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fabric = yield* makeLinkFabric();
      yield* fabric.interceptor.attach(bobId);
      const lease = yield* fabric.driver.apply(
        aliceId,
        bobId,
        linkPolicy.dropAll("temporary"),
        "temporary",
      );
      const committed = yield* Deferred.make<undefined>();
      const release = yield* Deferred.make<undefined>();
      const clearing = yield* lease.clear.pipe(
        Effect.ensuring(
          Deferred.succeed(committed, undefined).pipe(
            Effect.zipRight(Deferred.await(release)),
          ),
        ),
        Effect.fork,
      );
      yield* Deferred.await(committed);
      yield* Fiber.interruptFork(clearing);
      yield* Deferred.succeed(release, undefined);
      expectInterrupted(yield* Fiber.await(clearing));

      assert.isFalse(yield* fabric.needsInterception(bobId));
      const restored = yield* fabric.route(bobId, [
        { message: message(aliceId, 9) },
      ]);
      assert.lengthOf(restored, 1);
    }),
  ));

test("interrupted enable preserves its committed post-state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fabric = yield* makeLinkFabric();
      yield* fabric.interceptor.attach(bobId);
      yield* fabric.driver.disable(aliceId, bobId);
      const committed = yield* Deferred.make<undefined>();
      const release = yield* Deferred.make<undefined>();
      const enabling = yield* fabric.driver
        .enable(aliceId, bobId)
        .pipe(
          Effect.ensuring(
            Deferred.succeed(committed, undefined).pipe(
              Effect.zipRight(Deferred.await(release)),
            ),
          ),
          Effect.fork,
        );

      yield* Deferred.await(committed);
      yield* Fiber.interruptFork(enabling);
      yield* Deferred.succeed(release, undefined);
      expectInterrupted(yield* Fiber.await(enabling));
      assert.isFalse(yield* fabric.needsInterception(bobId));
      const failure = yield* Effect.flip(fabric.driver.enable(aliceId, bobId));
      assert.strictEqual(failure.operation, ENABLE_LINK_OPERATION);
    }),
  ));
