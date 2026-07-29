import { assert, effect as test } from "@effect/vitest";
import { agentId } from "@moltzap/protocol/testing";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Ref,
  Scope,
} from "effect";
import { LinkDown, LinkEvents, LinkUp } from "../events/core.js";
import type { LedgerWriter } from "../ledger/live.js";
import { LedgerStorageError } from "../ledger/storage.js";
import {
  LinkDriver,
  makeParticipantHandle,
  NetworkFailure,
  networkFailure,
  type LinkDriverService,
  type NetworkOperation,
} from "../network.js";
import { makeLinkController } from "./links.js";

type LinkEventWriter = LedgerWriter<typeof LinkEvents>;
const aliceId = agentId("00000000-0000-4000-8000-000000000001");
const bobId = agentId("00000000-0000-4000-8000-000000000002");
const alice = makeParticipantHandle("alice", aliceId);
const bob = makeParticipantHandle("bob", bobId);
const DISABLE_LINK_OPERATION: NetworkOperation = "disable-link";
const ENABLE_LINK_OPERATION: NetworkOperation = "enable-link";
const LEDGER_UNAVAILABLE = "ledger unavailable";
const ROLLBACK_UNAVAILABLE = "rollback unavailable";

function eventWriter(events: Array<LinkDown | LinkUp>): LinkEventWriter {
  return {
    write: ({ event }) =>
      Effect.sync(() => {
        events.push(event);
        return {
          runId: "link-test",
          eventId: `event-${String(events.length)}`,
          logicalSequence: events.length - 1,
          elapsedNanos: 0n,
          observedAt: 0,
          producer: "kernel.link",
          event,
        };
      }),
  };
}

function driver(actions: Array<string>): LinkDriverService {
  return {
    disable: (from, to) =>
      Effect.sync(() => {
        actions.push(`down:${from}->${to}`);
      }),
    enable: (from, to) =>
      Effect.sync(() => {
        actions.push(`up:${from}->${to}`);
      }),
  };
}

function unavailableEventWriter(): LinkEventWriter {
  return {
    write: () =>
      Effect.fail(
        LedgerStorageError.make({
          operation: "append",
          detail: LEDGER_UNAVAILABLE,
        }),
      ),
  };
}

function unavailableRollbackDriver(): LinkDriverService {
  return {
    disable: () => Effect.void,
    enable: () =>
      Effect.fail(networkFailure(ENABLE_LINK_OPERATION, ROLLBACK_UNAVAILABLE)),
  };
}

function close(scope: Scope.CloseableScope) {
  return Scope.close(scope, Exit.void);
}

// @agent-code-guard/regression-only: controlled scopes and deferred router operations expose exact link transition, interruption, and cleanup order
test("shares one physical transition across overlapping disable scopes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const actions: Array<string> = [];
      const events: Array<LinkDown | LinkUp> = [];
      const controller = yield* makeLinkController(eventWriter(events));
      const first = yield* Scope.make();
      const second = yield* Scope.make();
      const layer = driver(actions);

      yield* controller
        .disable(alice, bob)
        .pipe(Scope.extend(first), Effect.provideService(LinkDriver, layer));
      yield* controller
        .disable(alice, bob)
        .pipe(Scope.extend(second), Effect.provideService(LinkDriver, layer));

      assert.lengthOf(actions, 1);
      assert.lengthOf(events, 1);
      assert.instanceOf(events[0], LinkDown);

      yield* close(first);
      assert.lengthOf(actions, 1);
      assert.lengthOf(events, 1);

      yield* close(second);
      assert.lengthOf(actions, 2);
      assert.lengthOf(events, 2);
      assert.instanceOf(events[1], LinkUp);
      assert.deepStrictEqual(
        events.map((event) => [event.from, event.to]),
        [
          [aliceId, bobId],
          [aliceId, bobId],
        ],
      );
      assert.isTrue(LinkEvents.hasEvent(events[0]));
    }),
  ));

test("releases an overlapping link through the driver that disabled it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const firstDriverActions: Array<string> = [];
      const secondDriverActions: Array<string> = [];
      const controller = yield* makeLinkController(eventWriter([]));
      const first = yield* Scope.make();
      const second = yield* Scope.make();

      yield* controller
        .disable(alice, bob)
        .pipe(
          Scope.extend(first),
          Effect.provideService(LinkDriver, driver(firstDriverActions)),
        );
      yield* controller
        .disable(alice, bob)
        .pipe(
          Scope.extend(second),
          Effect.provideService(LinkDriver, driver(secondDriverActions)),
        );

      yield* close(first);
      yield* close(second);

      assert.deepStrictEqual(firstDriverActions, [
        `down:${aliceId}->${bobId}`,
        `up:${aliceId}->${bobId}`,
      ]);
      assert.lengthOf(secondDriverActions, 0);
    }),
  ));

test("interrupts a pending platform disable without installing a lease", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events: Array<LinkDown | LinkUp> = [];
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Ref.make(false);
      const controller = yield* makeLinkController(eventWriter(events));
      const scope = yield* Scope.make();
      const pending: LinkDriverService = {
        disable: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.zipRight(Effect.never),
            Effect.onInterrupt(() => Ref.set(interrupted, true)),
          ),
        enable: () => Effect.void,
      };
      const fiber = yield* controller
        .disable(alice, bob)
        .pipe(
          Scope.extend(scope),
          Effect.provideService(LinkDriver, pending),
          Effect.fork,
        );

      yield* Deferred.await(started);
      const exit = yield* Fiber.interrupt(fiber);

      assert.isTrue(Exit.isInterrupted(exit));
      assert.isTrue(yield* Ref.get(interrupted));
      assert.lengthOf(events, 0);
      yield* close(scope);
    }),
  ));

test("rolls back when link-down evidence is interrupted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const actions: Array<string> = [];
      const events: Array<LinkDown | LinkUp> = [];
      const writeStarted = yield* Deferred.make<void>();
      const writeInterrupted = yield* Ref.make(false);
      const writer: LinkEventWriter = {
        write: () =>
          Deferred.succeed(writeStarted, undefined).pipe(
            Effect.zipRight(Effect.never),
            Effect.onInterrupt(() => Ref.set(writeInterrupted, true)),
          ),
      };
      const controller = yield* makeLinkController(writer);
      const scope = yield* Scope.make();
      const fiber = yield* controller
        .disable(alice, bob)
        .pipe(
          Scope.extend(scope),
          Effect.provideService(LinkDriver, driver(actions)),
          Effect.fork,
        );

      yield* Deferred.await(writeStarted);
      const exit = yield* Fiber.interrupt(fiber);

      assert.isTrue(Exit.isInterrupted(exit));
      assert.isTrue(yield* Ref.get(writeInterrupted));
      assert.deepStrictEqual(actions, [
        `down:${aliceId}->${bobId}`,
        `up:${aliceId}->${bobId}`,
      ]);
      assert.lengthOf(events, 0);
      yield* close(scope);
    }),
  ));

test("returns only the real rollback failure after ledger evidence fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const controller = yield* makeLinkController(unavailableEventWriter());
      const scope = yield* Scope.make();
      const exit = yield* controller
        .disable(alice, bob)
        .pipe(
          Scope.extend(scope),
          Effect.provideService(LinkDriver, unavailableRollbackDriver()),
          Effect.exit,
        );

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const failures = Array.from(Cause.failures(exit.cause));
        assert.lengthOf(failures, 1);
        assert.instanceOf(failures[0], NetworkFailure);
        assert.strictEqual(failures[0]?.operation, ENABLE_LINK_OPERATION);
        assert.strictEqual(failures[0]?.detail, ROLLBACK_UNAVAILABLE);
      }
      yield* close(scope);
    }),
  ));

test("rolls back ledger evidence failure without fabricating a network failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const actions: Array<string> = [];
      const controller = yield* makeLinkController(unavailableEventWriter());
      const scope = yield* Scope.make();
      const exit = yield* controller
        .disable(alice, bob)
        .pipe(
          Scope.extend(scope),
          Effect.provideService(LinkDriver, driver(actions)),
          Effect.exit,
        );

      assert.isTrue(Exit.isInterrupted(exit));
      assert.deepStrictEqual(actions, [
        `down:${aliceId}->${bobId}`,
        `up:${aliceId}->${bobId}`,
      ]);
      yield* close(scope);
    }),
  ));

test("awaits the platform enable before a disable scope closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const actions: Array<string> = [];
      const events: Array<LinkDown | LinkUp> = [];
      const enableStarted = yield* Deferred.make<void>();
      const allowEnable = yield* Deferred.make<void>();
      const controller = yield* makeLinkController(eventWriter(events));
      const scope = yield* Scope.make();
      const delayedEnable: LinkDriverService = {
        disable: (from, to) =>
          Effect.sync(() => {
            actions.push(`down:${from}->${to}`);
          }),
        enable: (from, to) =>
          Deferred.succeed(enableStarted, undefined).pipe(
            Effect.zipRight(Deferred.await(allowEnable)),
            Effect.zipRight(
              Effect.sync(() => {
                actions.push(`up:${from}->${to}`);
              }),
            ),
          ),
      };

      yield* controller
        .disable(alice, bob)
        .pipe(
          Scope.extend(scope),
          Effect.provideService(LinkDriver, delayedEnable),
        );
      const closing = yield* close(scope).pipe(Effect.fork);
      yield* Deferred.await(enableStarted);

      assert.isTrue(Option.isNone(yield* Fiber.poll(closing)));

      yield* Deferred.succeed(allowEnable, undefined);
      yield* Fiber.join(closing);

      assert.deepStrictEqual(actions, [
        `down:${aliceId}->${bobId}`,
        `up:${aliceId}->${bobId}`,
      ]);
      assert.lengthOf(events, 2);
      assert.instanceOf(events[1], LinkUp);
    }),
  ));

test("surfaces a platform enable failure from scoped cleanup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events: Array<LinkDown | LinkUp> = [];
      const controller = yield* makeLinkController(eventWriter(events));
      const scope = yield* Scope.make();
      const enableFails: LinkDriverService = {
        disable: () => Effect.void,
        enable: () =>
          Effect.fail(networkFailure("enable-link", "router unavailable")),
      };

      yield* controller
        .disable(alice, bob)
        .pipe(
          Scope.extend(scope),
          Effect.provideService(LinkDriver, enableFails),
        );
      const exit = yield* close(scope).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const defects = Array.from(Cause.defects(exit.cause));
        assert.lengthOf(defects, 1);
        assert.instanceOf(defects[0], NetworkFailure);
      }
      assert.lengthOf(events, 1);
      assert.instanceOf(events[0], LinkDown);
    }),
  ));

test("rejects a self-link before consulting the platform driver", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const actions: Array<string> = [];
      const controller = yield* makeLinkController(eventWriter([]));
      const failure = yield* controller
        .disable(alice, alice)
        .pipe(Effect.provideService(LinkDriver, driver(actions)), Effect.flip);

      assert.strictEqual(failure.operation, DISABLE_LINK_OPERATION);
      assert.lengthOf(actions, 0);
    }),
  ));

test("does not publish link-down evidence when the driver rejects it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events: Array<LinkDown | LinkUp> = [];
      const controller = yield* makeLinkController(eventWriter(events));
      const unavailable: LinkDriverService = {
        disable: () =>
          Effect.fail(
            networkFailure(DISABLE_LINK_OPERATION, "unsupported topology"),
          ),
        enable: () => Effect.void,
      };
      const failure = yield* controller
        .disable(alice, bob)
        .pipe(Effect.provideService(LinkDriver, unavailable), Effect.flip);

      assert.strictEqual(failure.operation, DISABLE_LINK_OPERATION);
      assert.lengthOf(events, 0);
    }),
  ));
