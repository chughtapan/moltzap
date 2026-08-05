import { assert, effect as test } from "@effect/vitest";
import type { AgentId } from "@moltzap/protocol/identity";
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
import type { EventOf } from "../events/catalog.js";
import {
  LinkDown,
  linkEvents,
  LinkPolicyCleared,
  LinkPolicySet,
  LinkUp,
} from "../events/core.js";
import type { LedgerWriter } from "../ledger/append.js";
import { LedgerStorageError } from "../ledger/storage.js";
import {
  LinkDriver,
  linkPolicy,
  makeParticipantHandle,
  NetworkError,
  networkError,
  type LinkDriverService,
  type LinkPolicy,
  type NetworkOperation,
} from "../network.js";
import { makeLinkController } from "./links.js";

type LinkEventWriter = LedgerWriter<typeof linkEvents>;
const aliceId = agentId("00000000-0000-4000-8000-000000000001");
const bobId = agentId("00000000-0000-4000-8000-000000000002");
const alice = makeParticipantHandle("alice", aliceId);
const bob = makeParticipantHandle("bob", bobId);
const DISABLE_LINK_OPERATION: NetworkOperation = "disable-link";
const ENABLE_LINK_OPERATION: NetworkOperation = "enable-link";
const SHAPE_LINK_OPERATION: NetworkOperation = "shape-link";
const LEDGER_UNAVAILABLE = "ledger unavailable";
const SHAPE_DESCRIPTION = "drop everything";
const ROLLBACK_UNAVAILABLE = "rollback unavailable";

const unusedApply: LinkDriverService["apply"] = () =>
  Effect.dieMessage("apply is not under test");

function eventWriter(
  events: Array<EventOf<typeof linkEvents>>,
): LinkEventWriter {
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

function driver(actions: string[]): LinkDriverService {
  return {
    disable: (from, to) =>
      Effect.sync(() => {
        actions.push(`down:${from}->${to}`);
      }),
    enable: (from, to) =>
      Effect.sync(() => {
        actions.push(`up:${from}->${to}`);
      }),
    apply: unusedApply,
  };
}

interface PolicyApplication {
  readonly from: AgentId;
  readonly to: AgentId;
  readonly policy: LinkPolicy;
  readonly description: string;
}

function policyDriver(
  applications: PolicyApplication[],
  cleared: string[],
  clearFailure?: NetworkError,
): LinkDriverService {
  return {
    disable: () => Effect.dieMessage("disable is not under test"),
    enable: () => Effect.dieMessage("enable is not under test"),
    apply: (from, to, policy, description) =>
      Effect.sync(() => {
        applications.push({ from, to, policy, description });
        return {
          clear:
            clearFailure === undefined
              ? Effect.sync(() => {
                  cleared.push(description);
                })
              : Effect.fail(clearFailure),
        };
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
      Effect.fail(networkError(ENABLE_LINK_OPERATION, ROLLBACK_UNAVAILABLE)),
    apply: unusedApply,
  };
}

function close(scope: Scope.CloseableScope) {
  return Scope.close(scope, Exit.void);
}

// @agent-code-guard/regression-only: controlled scopes and deferred router operations expose exact link transition, interruption, and cleanup order
test("shares one physical transition across overlapping disable scopes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const actions: string[] = [];
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
      assert.isTrue(linkEvents.hasEvent(events[0]));
    }),
  ));

test("releases an overlapping link through the driver that disabled it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const firstDriverActions: string[] = [];
      const secondDriverActions: string[] = [];
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
      const started = yield* Deferred.make<undefined>();
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
        apply: unusedApply,
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
      const actions: string[] = [];
      const events: Array<LinkDown | LinkUp> = [];
      const writeStarted = yield* Deferred.make<undefined>();
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
        assert.instanceOf(failures[0], NetworkError);
        assert.strictEqual(failures[0]?.operation, ENABLE_LINK_OPERATION);
        assert.strictEqual(failures[0]?.detail, ROLLBACK_UNAVAILABLE);
      }
      yield* close(scope);
    }),
  ));

test("rolls back ledger evidence failure without fabricating a network failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const actions: string[] = [];
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
      const actions: string[] = [];
      const events: Array<LinkDown | LinkUp> = [];
      const enableStarted = yield* Deferred.make<undefined>();
      const allowEnable = yield* Deferred.make<undefined>();
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
        apply: unusedApply,
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
          Effect.fail(networkError("enable-link", "router unavailable")),
        apply: unusedApply,
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
        assert.instanceOf(defects[0], NetworkError);
      }
      assert.lengthOf(events, 1);
      assert.instanceOf(events[0], LinkDown);
    }),
  ));

test("rejects a self-link before consulting the platform driver", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const actions: string[] = [];
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
            networkError(DISABLE_LINK_OPERATION, "unsupported topology"),
          ),
        enable: () => Effect.void,
        apply: unusedApply,
      };
      const failure = yield* controller
        .disable(alice, bob)
        .pipe(Effect.provideService(LinkDriver, unavailable), Effect.flip);

      assert.strictEqual(failure.operation, DISABLE_LINK_OPERATION);
      assert.lengthOf(events, 0);
    }),
  ));

test("installs and clears a described policy with evidence", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events: Array<EventOf<typeof linkEvents>> = [];
      const applications: PolicyApplication[] = [];
      const cleared: string[] = [];
      const controller = yield* makeLinkController(eventWriter(events));
      const scope = yield* Scope.make();
      const policy = linkPolicy.dropAll("partition");

      yield* controller
        .shape(alice, bob, policy, SHAPE_DESCRIPTION)
        .pipe(
          Scope.extend(scope),
          Effect.provideService(
            LinkDriver,
            policyDriver(applications, cleared),
          ),
        );

      assert.lengthOf(applications, 1);
      assert.strictEqual(applications[0]?.from, aliceId);
      assert.strictEqual(applications[0]?.to, bobId);
      assert.strictEqual(applications[0]?.policy, policy);
      assert.strictEqual(applications[0]?.description, SHAPE_DESCRIPTION);
      assert.lengthOf(cleared, 0);
      assert.lengthOf(events, 1);
      assert.instanceOf(events[0], LinkPolicySet);

      yield* close(scope);
      assert.deepStrictEqual(cleared, [SHAPE_DESCRIPTION]);
      assert.lengthOf(events, 2);
      assert.instanceOf(events[1], LinkPolicyCleared);
      assert.deepStrictEqual(
        events.map((event) =>
          event instanceof LinkPolicySet || event instanceof LinkPolicyCleared
            ? [event.from, event.to, event.policy]
            : [],
        ),
        [
          [aliceId, bobId, SHAPE_DESCRIPTION],
          [aliceId, bobId, SHAPE_DESCRIPTION],
        ],
      );
    }),
  ));

test("derives delay and hold descriptions for their canonical policies", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events: Array<EventOf<typeof linkEvents>> = [];
      const applications: PolicyApplication[] = [];
      const cleared: string[] = [];
      const controller = yield* makeLinkController(eventWriter(events));
      const layer = policyDriver(applications, cleared);
      const scope = yield* Scope.make();

      yield* controller
        .delay(alice, bob, "100 millis")
        .pipe(Scope.extend(scope), Effect.provideService(LinkDriver, layer));
      yield* controller
        .hold(alice, bob)
        .pipe(Scope.extend(scope), Effect.provideService(LinkDriver, layer));
      yield* close(scope);

      assert.deepStrictEqual(
        applications.map((application) => application.description),
        ["delay 100ms", "hold"],
      );
      assert.deepStrictEqual(cleared, ["hold", "delay 100ms"]);
      const setEvents = events.filter(
        (event) => event instanceof LinkPolicySet,
      );
      assert.deepStrictEqual(
        setEvents.map((event) => event.policy),
        ["delay 100ms", "hold"],
      );
    }),
  ));

test("rolls back a policy lease when evidence storage fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const applications: PolicyApplication[] = [];
      const cleared: string[] = [];
      const controller = yield* makeLinkController(unavailableEventWriter());
      const scope = yield* Scope.make();
      const exit = yield* controller
        .shape(alice, bob, linkPolicy.hold, "hold")
        .pipe(
          Scope.extend(scope),
          Effect.provideService(
            LinkDriver,
            policyDriver(applications, cleared),
          ),
          Effect.exit,
        );

      assert.isTrue(Exit.isInterrupted(exit));
      assert.lengthOf(applications, 1);
      assert.deepStrictEqual(cleared, ["hold"]);
      yield* close(scope);
    }),
  ));

test("returns only the real rollback failure after policy evidence fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const applications: PolicyApplication[] = [];
      const controller = yield* makeLinkController(unavailableEventWriter());
      const scope = yield* Scope.make();
      const exit = yield* controller
        .shape(alice, bob, linkPolicy.hold, "hold")
        .pipe(
          Scope.extend(scope),
          Effect.provideService(
            LinkDriver,
            policyDriver(
              applications,
              [],
              networkError(SHAPE_LINK_OPERATION, ROLLBACK_UNAVAILABLE),
            ),
          ),
          Effect.exit,
        );

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const failures = Array.from(Cause.failures(exit.cause));
        assert.lengthOf(failures, 1);
        assert.instanceOf(failures[0], NetworkError);
        assert.strictEqual(failures[0]?.operation, SHAPE_LINK_OPERATION);
        assert.strictEqual(failures[0]?.detail, ROLLBACK_UNAVAILABLE);
      }
      yield* close(scope);
    }),
  ));

test("rejects a self-link policy before consulting the platform driver", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const applications: PolicyApplication[] = [];
      const controller = yield* makeLinkController(eventWriter([]));
      const failure = yield* controller
        .shape(alice, alice, linkPolicy.passthrough, "noop")
        .pipe(
          Effect.provideService(LinkDriver, policyDriver(applications, [])),
          Effect.flip,
        );

      assert.strictEqual(failure.operation, SHAPE_LINK_OPERATION);
      assert.lengthOf(applications, 0);
    }),
  ));

test("rejects an empty policy description before consulting the driver", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const applications: PolicyApplication[] = [];
      const controller = yield* makeLinkController(eventWriter([]));
      const failure = yield* controller
        .shape(alice, bob, linkPolicy.passthrough, "")
        .pipe(
          Effect.provideService(LinkDriver, policyDriver(applications, [])),
          Effect.flip,
        );

      assert.strictEqual(failure.operation, SHAPE_LINK_OPERATION);
      assert.lengthOf(applications, 0);
    }),
  ));
