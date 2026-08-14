/** @file Regression coverage for scoped link-control lifecycle and evidence. */

import { assert, effect as test } from "@effect/vitest";
import { AgentId, type AgentId as AgentIdValue } from "@moltzap/identity";
import { Deferred, Effect, Encoding, Exit, Fiber, Schema, Scope } from "effect";
import type { EventOf } from "../events/catalog.js";
import type { LedgerWriter } from "../ledger/append.js";
import {
  LinkDown,
  type linkEvents,
  LinkPolicyCleared,
  LinkPolicySet,
  LinkUp,
} from "../events/core.js";
import {
  LinkDriver,
  type LinkDriverService,
  linkPolicy,
  type LinkPolicy,
  makeParticipantHandle,
} from "../network/index.js";
import { makeLinkController } from "./links.js";

type LinkEventWriter = LedgerWriter<typeof linkEvents>;

const agentId = (seed: number): AgentIdValue =>
  Schema.decodeUnknownSync(AgentId)(
    `agt_${Encoding.encodeBase64Url(new Uint8Array(16).fill(seed))}`,
  );

const aliceId = agentId(1);
const bobId = agentId(2);
const alice = makeParticipantHandle("alice", aliceId);
const bob = makeParticipantHandle("bob", bobId);
const DISABLE_LINK_OPERATION = "disable-link";
const SHAPE_LINK_OPERATION = "shape-link";

function pausingEventWriter(
  events: Array<EventOf<typeof linkEvents>>,
  pauseWhen: (event: EventOf<typeof linkEvents>) => boolean,
  started: Deferred.Deferred<undefined>,
): LinkEventWriter {
  const writer = eventWriter(events);
  return {
    write: (input) =>
      writer
        .write(input)
        .pipe(
          Effect.tap(() =>
            pauseWhen(input.event)
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.zipRight(Effect.never),
                )
              : Effect.void,
          ),
        ),
  };
}

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

const unusedApply: LinkDriverService["apply"] = () =>
  Effect.dieMessage("apply is not under test");

function transitionDriver(actions: string[]): LinkDriverService {
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
  readonly from: AgentIdValue;
  readonly to: AgentIdValue;
  readonly policy: LinkPolicy;
  readonly description: string;
}

function policyDriver(
  applications: PolicyApplication[],
  cleared: string[],
): LinkDriverService {
  return {
    disable: () => Effect.dieMessage("disable is not under test"),
    enable: () => Effect.dieMessage("enable is not under test"),
    apply: (from, to, policy, description) =>
      Effect.sync(() => {
        applications.push({ from, to, policy, description });
        return {
          clear: Effect.sync(() => {
            cleared.push(description);
          }),
        };
      }),
  };
}

function close(scope: Scope.CloseableScope) {
  return Scope.close(scope, Exit.void);
}

function expectInterrupted(exit: Exit.Exit<unknown, unknown>): void {
  assert.isTrue(Exit.isInterrupted(exit));
}

// @agent-code-guard/regression-only: controlled scopes expose exact link transitions, overlap, and cleanup evidence
test("overlapping disable scopes share one physical transition", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const actions: string[] = [];
      const events: Array<EventOf<typeof linkEvents>> = [];
      const controller = yield* makeLinkController(eventWriter(events));
      const first = yield* Scope.make();
      const second = yield* Scope.make();
      const driver = transitionDriver(actions);

      yield* controller
        .disable(alice, bob)
        .pipe(Scope.extend(first), Effect.provideService(LinkDriver, driver));
      yield* controller
        .disable(alice, bob)
        .pipe(Scope.extend(second), Effect.provideService(LinkDriver, driver));
      assert.deepStrictEqual(actions, [`down:${aliceId}->${bobId}`]);
      assert.lengthOf(events, 1);
      assert.instanceOf(events[0], LinkDown);

      yield* close(first);
      assert.lengthOf(actions, 1);
      yield* close(second);
      assert.deepStrictEqual(actions, [
        `down:${aliceId}->${bobId}`,
        `up:${aliceId}->${bobId}`,
      ]);
      assert.lengthOf(events, 2);
      assert.instanceOf(events[1], LinkUp);
    }),
  ));

test("self-link disable fails before consulting the driver", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const actions: string[] = [];
      const controller = yield* makeLinkController(eventWriter([]));
      const failure = yield* Effect.flip(
        controller
          .disable(alice, alice)
          .pipe(Effect.provideService(LinkDriver, transitionDriver(actions))),
      );
      assert.strictEqual(failure.operation, DISABLE_LINK_OPERATION);
      assert.deepStrictEqual(actions, []);
    }),
  ));

test("custom policy records set and cleared lifecycle events", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const applications: PolicyApplication[] = [];
      const cleared: string[] = [];
      const events: Array<EventOf<typeof linkEvents>> = [];
      const controller = yield* makeLinkController(eventWriter(events));
      const scope = yield* Scope.make();
      const description = "drop everything";

      yield* controller
        .shape(alice, bob, linkPolicy.dropAll("partition"), description)
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
      assert.strictEqual(applications[0]?.description, description);
      assert.instanceOf(events[0], LinkPolicySet);

      yield* close(scope);
      assert.deepStrictEqual(cleared, [description]);
      assert.lengthOf(events, 2);
      assert.instanceOf(events[1], LinkPolicyCleared);
    }),
  ));

test("delay and hold install canonical policy descriptions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const applications: PolicyApplication[] = [];
      const controller = yield* makeLinkController(eventWriter([]));
      const delayScope = yield* Scope.make();
      const holdScope = yield* Scope.make();
      const driver = policyDriver(applications, []);

      yield* controller
        .delay(alice, bob, "100 millis")
        .pipe(
          Scope.extend(delayScope),
          Effect.provideService(LinkDriver, driver),
        );
      yield* controller
        .hold(alice, bob)
        .pipe(
          Scope.extend(holdScope),
          Effect.provideService(LinkDriver, driver),
        );
      assert.deepStrictEqual(
        applications.map(({ description }) => description),
        ["delay 100ms", "hold"],
      );

      yield* close(delayScope);
      yield* close(holdScope);
    }),
  ));

test("empty custom policy descriptions fail before driver application", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const applications: PolicyApplication[] = [];
      const controller = yield* makeLinkController(eventWriter([]));
      const failure = yield* Effect.flip(
        controller
          .shape(alice, bob, linkPolicy.passthrough, "")
          .pipe(
            Effect.provideService(LinkDriver, policyDriver(applications, [])),
          ),
      );
      assert.strictEqual(failure.operation, SHAPE_LINK_OPERATION);
      assert.deepStrictEqual(applications, []);
    }),
  ));

test("disable compensates interruption after the driver commits", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const actions: string[] = [];
      const events: Array<EventOf<typeof linkEvents>> = [];
      const controller = yield* makeLinkController(eventWriter(events));
      const committed = yield* Deferred.make<undefined>();
      const release = yield* Deferred.make<undefined>();
      const base = transitionDriver(actions);
      const driver: LinkDriverService = {
        ...base,
        disable: (from, to) =>
          base
            .disable(from, to)
            .pipe(
              Effect.ensuring(
                Deferred.succeed(committed, undefined).pipe(
                  Effect.zipRight(Deferred.await(release)),
                ),
              ),
            ),
      };
      const acquiring = yield* Effect.scoped(
        controller
          .disable(alice, bob)
          .pipe(Effect.provideService(LinkDriver, driver)),
      ).pipe(Effect.fork);

      yield* Deferred.await(committed);
      yield* Fiber.interruptFork(acquiring);
      yield* Deferred.succeed(release, undefined);
      expectInterrupted(yield* Fiber.await(acquiring));
      assert.deepStrictEqual(actions, [
        `down:${aliceId}->${bobId}`,
        `up:${aliceId}->${bobId}`,
      ]);
      assert.deepStrictEqual(events, []);
    }),
  ));

test("shape compensates interruption after the driver commits", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const applications: PolicyApplication[] = [];
      const cleared: string[] = [];
      const events: Array<EventOf<typeof linkEvents>> = [];
      const controller = yield* makeLinkController(eventWriter(events));
      const committed = yield* Deferred.make<undefined>();
      const release = yield* Deferred.make<undefined>();
      const base = policyDriver(applications, cleared);
      const driver: LinkDriverService = {
        ...base,
        apply: (from, to, policy, description) =>
          base
            .apply(from, to, policy, description)
            .pipe(
              Effect.ensuring(
                Deferred.succeed(committed, undefined).pipe(
                  Effect.zipRight(Deferred.await(release)),
                ),
              ),
            ),
      };
      const acquiring = yield* Effect.scoped(
        controller
          .shape(alice, bob, linkPolicy.passthrough, "temporary")
          .pipe(Effect.provideService(LinkDriver, driver)),
      ).pipe(Effect.fork);

      yield* Deferred.await(committed);
      yield* Fiber.interruptFork(acquiring);
      yield* Deferred.succeed(release, undefined);
      expectInterrupted(yield* Fiber.await(acquiring));
      assert.lengthOf(applications, 1);
      assert.deepStrictEqual(cleared, ["temporary"]);
      assert.deepStrictEqual(events, []);
    }),
  ));

test("scoped disable interruption runs the registered finalizer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const actions: string[] = [];
      const events: Array<EventOf<typeof linkEvents>> = [];
      const acquired = yield* Deferred.make<undefined>();
      const controller = yield* makeLinkController(eventWriter(events));
      const running = yield* Effect.scoped(
        controller.disable(alice, bob).pipe(
          Effect.provideService(LinkDriver, transitionDriver(actions)),
          Effect.tap(() => Deferred.succeed(acquired, undefined)),
          Effect.zipRight(Effect.never),
        ),
      ).pipe(Effect.fork);

      yield* Deferred.await(acquired);
      expectInterrupted(yield* Fiber.interrupt(running));
      assert.deepStrictEqual(actions, [
        `down:${aliceId}->${bobId}`,
        `up:${aliceId}->${bobId}`,
      ]);
      assert.instanceOf(events[0], LinkDown);
      assert.instanceOf(events[1], LinkUp);
    }),
  ));

test("scoped shape interruption runs the registered lease finalizer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const applications: PolicyApplication[] = [];
      const cleared: string[] = [];
      const events: Array<EventOf<typeof linkEvents>> = [];
      const acquired = yield* Deferred.make<undefined>();
      const controller = yield* makeLinkController(eventWriter(events));
      const running = yield* Effect.scoped(
        controller.shape(alice, bob, linkPolicy.passthrough, "temporary").pipe(
          Effect.provideService(
            LinkDriver,
            policyDriver(applications, cleared),
          ),
          Effect.tap(() => Deferred.succeed(acquired, undefined)),
          Effect.zipRight(Effect.never),
        ),
      ).pipe(Effect.fork);

      yield* Deferred.await(acquired);
      expectInterrupted(yield* Fiber.interrupt(running));
      assert.lengthOf(applications, 1);
      assert.deepStrictEqual(cleared, ["temporary"]);
      assert.instanceOf(events[0], LinkPolicySet);
      assert.instanceOf(events[1], LinkPolicyCleared);
    }),
  ));

test("interrupted down evidence compensates the committed transition", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const actions: string[] = [];
      const events: Array<EventOf<typeof linkEvents>> = [];
      const recording = yield* Deferred.make<undefined>();
      const writer = pausingEventWriter(
        events,
        (event) => event instanceof LinkDown,
        recording,
      );
      const controller = yield* makeLinkController(writer);
      const acquiring = yield* Effect.scoped(
        controller
          .disable(alice, bob)
          .pipe(Effect.provideService(LinkDriver, transitionDriver(actions))),
      ).pipe(Effect.fork);

      yield* Deferred.await(recording);
      expectInterrupted(yield* Fiber.interrupt(acquiring));
      assert.deepStrictEqual(actions, [
        `down:${aliceId}->${bobId}`,
        `up:${aliceId}->${bobId}`,
      ]);
    }),
  ));

test("interrupted policy evidence clears the committed policy", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const applications: PolicyApplication[] = [];
      const cleared: string[] = [];
      const events: Array<EventOf<typeof linkEvents>> = [];
      const recording = yield* Deferred.make<undefined>();
      const writer = pausingEventWriter(
        events,
        (event) => event instanceof LinkPolicySet,
        recording,
      );
      const controller = yield* makeLinkController(writer);
      const acquiring = yield* Effect.scoped(
        controller
          .shape(alice, bob, linkPolicy.passthrough, "temporary")
          .pipe(
            Effect.provideService(
              LinkDriver,
              policyDriver(applications, cleared),
            ),
          ),
      ).pipe(Effect.fork);

      yield* Deferred.await(recording);
      expectInterrupted(yield* Fiber.interrupt(acquiring));
      assert.lengthOf(applications, 1);
      assert.deepStrictEqual(cleared, ["temporary"]);
    }),
  ));
