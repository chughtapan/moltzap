/* eslint-disable agent-code-guard/no-example-only-tests -- Regression-only suite: each case pins one ordering, evidence, or cleanup guarantee across a full run lifecycle, so the cases are timelines rather than an input domain and each keeps its setup beside its assertions. */

import { assert, effect as test } from "@effect/vitest";
import {
  Cause,
  Chunk,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Ref,
  Stream,
  TestClock,
} from "effect";
import {
  AgentProcessExited,
  AgentProcessSignaled,
  AgentRuntimeCompleted,
  AgentRuntimeFailed,
  AgentRuntimeReady,
  AgentRuntimeStartFailed,
  EndpointMessageReceived,
  EndpointMessageSent,
  LinkDown,
  LinkMessageDelayed,
  LinkMessageDropped,
  LinkPolicyCleared,
  LinkPolicySet,
  LinkUp,
  RouterMessageCommitted,
  RouterStarted,
  RunStarted,
} from "../events/core.js";
import {
  LedgerStorage,
  LedgerStorageError,
  type LedgerStorageService,
} from "../ledger/storage.js";
import {
  LinkController,
  linkPolicy,
  Network,
  NetworkError,
  RouterProvider,
  type ReceivedMessage,
  type Router,
} from "../network.js";
import {
  CompletedLedgerReceipt,
  IncompleteLedgerReceipt,
  ProgramFinished,
  ClusterLost,
} from "./execute.js";
import { RuntimeCompleted, RuntimeExited } from "../agents/agent.js";
import { defineFakeRuntime } from "../cluster/fake.js";

import {
  OBSERVED_EXIT_CODE,
  Observation,
  PRIMARY_AGENT_NAME,
  REF,
  ROUTER_URL,
  assertDefaultProvenance,
  configuration,
  fakeRouterProvider,
  kernelHarness,
  memoryStorage,
  observeCompletions,
  ongoingRoster,
  type testRuntimeConfiguration,
} from "../test-utils/index.js";

// eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- One mixed-roster lifetime: splitting it would separate the ordering assertions from the timeline they pin.
test("runs mixed runtimes until customer policy completes", () =>
  // eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- the generator is the same ordered lifecycle regression as its enclosing test callback.
  Effect.gen(function* () {
    const codeTermination = yield* Deferred.make<RuntimeCompleted>();
    const processTermination = yield* Deferred.make<RuntimeExited>();
    const roster = kernelHarness.agents({
      alice: defineFakeRuntime({
        name: "effect",
        configuration: configuration("in-process"),
        acquire: () =>
          Effect.succeed({
            gateway: undefined,
            termination: Deferred.await(codeTermination),
          }),
      }),
      bob: defineFakeRuntime({
        name: "process",
        configuration: configuration("external-process"),
        acquire: () =>
          Effect.succeed({
            gateway: undefined,
            termination: Deferred.await(processTermination),
          }),
      }),
    });
    const program = Effect.gen(function* () {
      const agents = yield* roster.startedAgents;
      const ledger = yield* kernelHarness.ledger;
      const events = yield* kernelHarness.events;
      yield* Network;
      yield* Deferred.succeed(codeTermination, RuntimeCompleted.make({}));
      yield* Deferred.succeed(
        processTermination,
        RuntimeExited.make({ code: 0 }),
      );
      yield* ledger
        .events(AgentRuntimeCompleted)
        .pipe(Stream.take(1), Stream.runDrain);
      yield* Effect.yieldNow();
      yield* events.emit(Observation.make({ value: "done" }));
      return [agents.alice.agent.name, agents.bob.agent.name] as const;
    });
    const result = yield* kernelHarness.run(roster, program);
    assert.instanceOf(result, ProgramFinished);
    if (!(result instanceof ProgramFinished)) {
      return;
    }
    assert.isTrue(Exit.isSuccess(result.exit));
    if (Exit.isFailure(result.exit)) {
      return;
    }
    assert.deepStrictEqual(result.exit.value, ["alice", "bob"]);

    const ledger = yield* kernelHarness.openLedger(result.receipt.ledger);
    assertDefaultProvenance(ledger.manifest);
    assert.lengthOf(
      yield* Stream.runCollect(ledger.events(AgentRuntimeReady)),
      2,
    );
    assert.lengthOf(yield* Stream.runCollect(ledger.events(Observation)), 1);
    assert.lengthOf(
      yield* Stream.runCollect(ledger.events(RouterMessageCommitted)),
      0,
    );
  }).pipe(
    Effect.provideService(LedgerStorage, memoryStorage()),
    Effect.provideService(RouterProvider, fakeRouterProvider()),
  ));

test("scope teardown interrupts an unfinished runtime observation", () =>
  Effect.gen(function* () {
    const result = yield* kernelHarness.run(
      ongoingRoster,
      Effect.succeed("policy-complete"),
    );
    assert.instanceOf(result, ProgramFinished);
    if (!(result instanceof ProgramFinished)) {
      return;
    }
    assert.deepStrictEqual(result.exit, Exit.succeed("policy-complete"));

    const ledger = yield* kernelHarness.openLedger(result.receipt.ledger);
    assert.lengthOf(
      yield* Stream.runCollect(ledger.events(AgentRuntimeCompleted)),
      0,
    );
    assert.lengthOf(
      yield* Stream.runCollect(ledger.events(AgentRuntimeFailed)),
      0,
    );
    assert.lengthOf(
      yield* Stream.runCollect(ledger.events(AgentProcessExited)),
      0,
    );
    assert.lengthOf(
      yield* Stream.runCollect(ledger.events(AgentProcessSignaled)),
      0,
    );
  }).pipe(
    Effect.provideService(LedgerStorage, memoryStorage()),
    Effect.provideService(RouterProvider, fakeRouterProvider()),
  ));

test("records the roster as the manifest's complete run description", () =>
  Effect.gen(function* () {
    const result = yield* kernelHarness.run(
      ongoingRoster,
      Effect.succeed("policy-complete"),
    );
    assert.instanceOf(result, ProgramFinished);
    if (!(result instanceof ProgramFinished)) {
      return;
    }
    const ledger = yield* kernelHarness.openLedger(result.receipt.ledger);

    assert.deepStrictEqual(ledger.manifest.provenance, {
      agents: [
        {
          name: "alice",
          runtime: "ongoing",
          configuration: { kind: "ongoing" },
        },
      ],
    });
    assert.deepStrictEqual(ledger.manifest.metadata, {});
  }).pipe(
    Effect.provideService(LedgerStorage, memoryStorage()),
    Effect.provideService(RouterProvider, fakeRouterProvider()),
  ));

test("records genuine runtime termination while policy remains active", () =>
  Effect.gen(function* () {
    const termination = yield* Deferred.make<RuntimeExited>();
    const observedRuntime = defineFakeRuntime({
      name: "observed-process",
      configuration: configuration("observed-process"),
      acquire: () =>
        Effect.succeed({
          gateway: undefined,
          termination: Deferred.await(termination),
        }),
    });
    const observedRoster = kernelHarness.agents({
      alice: observedRuntime,
    });
    const program = Effect.gen(function* () {
      const ledger = yield* kernelHarness.ledger;
      yield* Deferred.succeed(
        termination,
        RuntimeExited.make({ code: OBSERVED_EXIT_CODE }),
      );
      yield* ledger
        .events(AgentProcessExited)
        .pipe(Stream.take(1), Stream.runDrain);
      return "observed";
    });

    const result = yield* kernelHarness.run(observedRoster, program);
    assert.instanceOf(result, ProgramFinished);
    if (!(result instanceof ProgramFinished)) {
      return;
    }
    assert.deepStrictEqual(result.exit, Exit.succeed("observed"));
    const ledger = yield* kernelHarness.openLedger(result.receipt.ledger);
    const exits = yield* Stream.runCollect(ledger.events(AgentProcessExited));
    assert.strictEqual(exits.length, 1);
    assert.strictEqual(Chunk.unsafeGet(exits, 0).code, OBSERVED_EXIT_CODE);
  }).pipe(
    Effect.provideService(LedgerStorage, memoryStorage()),
    Effect.provideService(RouterProvider, fakeRouterProvider()),
  ));

test("records a defective termination observer as runtime failure", () =>
  Effect.gen(function* () {
    const triggerDefect = yield* Deferred.make<undefined>();
    const defectiveRuntime = defineFakeRuntime({
      name: "defective-termination-observer",
      configuration: configuration("defective-observer"),
      acquire: () =>
        Effect.succeed({
          gateway: undefined,
          termination: Deferred.await(triggerDefect).pipe(
            Effect.zipRight(Effect.dieMessage("termination observer defect")),
          ),
        }),
    });
    const defectiveRoster = kernelHarness.agents({
      alice: defectiveRuntime,
    });
    const program = Effect.gen(function* () {
      const ledger = yield* kernelHarness.ledger;
      yield* Deferred.succeed(triggerDefect, undefined);
      yield* ledger
        .events(AgentRuntimeFailed)
        .pipe(Stream.take(1), Stream.runDrain);
      return "observed";
    });

    const result = yield* kernelHarness.run(defectiveRoster, program);
    assert.instanceOf(result, ProgramFinished);
    if (!(result instanceof ProgramFinished)) {
      return;
    }
    assert.deepStrictEqual(result.exit, Exit.succeed("observed"));
    const ledger = yield* kernelHarness.openLedger(result.receipt.ledger);
    const failures = yield* Stream.runCollect(
      ledger.events(AgentRuntimeFailed),
    );
    assert.strictEqual(failures.length, 1);
    assert.include(
      Chunk.unsafeGet(failures, 0).cause,
      "termination observer defect",
    );
  }).pipe(
    Effect.provideService(LedgerStorage, memoryStorage()),
    Effect.provideService(RouterProvider, fakeRouterProvider()),
  ));

test("fails the run ledger without making a committed endpoint send retryable", () =>
  Effect.gen(function* () {
    const committedSends = yield* Ref.make(0);
    const program = Effect.gen(function* () {
      const agents = yield* ongoingRoster.startedAgents;
      const network = yield* Network;
      const probe = yield* network.endpoint("probe");
      const socket = yield* probe.open(agents.alice.agent);
      yield* socket.send("request");
      return "sent";
    });

    const outcome = yield* kernelHarness
      .run(ongoingRoster, program)
      .pipe(
        Effect.provideService(
          LedgerStorage,
          memoryStorage(EndpointMessageSent._tag),
        ),
        Effect.provideService(
          RouterProvider,
          fakeRouterProvider(committedSends),
        ),
      );

    assert.instanceOf(outcome, ClusterLost);
    if (outcome instanceof ClusterLost) {
      assert.isTrue(
        Array.from(Cause.failures(outcome.cause)).some(
          (failure) =>
            failure instanceof LedgerStorageError &&
            failure.detail.includes(EndpointMessageSent._tag),
        ),
      );
      assert.instanceOf(outcome.receipt, IncompleteLedgerReceipt);
    }
    assert.strictEqual(yield* Ref.get(committedSends), 1);
  }));

test("returns an incomplete receipt when the first post-allocation append fails", () =>
  Effect.gen(function* () {
    const outcome = yield* kernelHarness.run(ongoingRoster, Effect.void);

    assert.instanceOf(outcome, ClusterLost);
    if (outcome instanceof ClusterLost) {
      assert.instanceOf(outcome.receipt, IncompleteLedgerReceipt);
      assert.strictEqual(outcome.receipt.ledger, REF);
      assert.isTrue(
        Array.from(Cause.failures(outcome.cause)).some(
          (failure) =>
            failure instanceof LedgerStorageError &&
            failure.detail.includes(RunStarted._tag),
        ),
      );
    }
  }).pipe(
    Effect.provideService(LedgerStorage, memoryStorage(RunStarted._tag)),
    Effect.provideService(RouterProvider, fakeRouterProvider()),
  ));

test("retains router stop failure when started-event storage fails", () => {
  const stopFailure = NetworkError.make({
    operation: "stop-router",
    detail: "router shutdown failed",
  });
  const router: Router = {
    address: ROUTER_URL,
    stopped: Effect.fail(stopFailure),
    attachAgent: () => Effect.dieMessage("unused"),
    attachEndpoint: () => Effect.dieMessage("unused"),
  };
  return Effect.gen(function* () {
    const outcome = yield* kernelHarness.run(
      kernelHarness.agents({}),
      Effect.void,
    );

    assert.instanceOf(outcome, ClusterLost);
    if (outcome instanceof ClusterLost) {
      const failures = Array.from(Cause.failures(outcome.cause));
      assert.isTrue(
        failures.some(
          (failure) =>
            failure instanceof NetworkError &&
            failure.operation === "stop-router" &&
            failure.detail === stopFailure.detail,
        ),
      );
    }
  }).pipe(
    Effect.provideService(LedgerStorage, memoryStorage(RouterStarted._tag)),
    Effect.provideService(RouterProvider, {
      acquire: Effect.succeed(router),
    }),
  );
});

test("keeps allocation failure in the Effect error channel", () =>
  Effect.gen(function* () {
    const allocationFailure = LedgerStorageError.make({
      operation: "allocate",
      detail: "allocation unavailable",
    });
    const storage: LedgerStorageService = {
      ...memoryStorage(),
      allocate: () => Effect.fail(allocationFailure),
    };
    const failure = yield* kernelHarness
      .run(ongoingRoster, Effect.void)
      .pipe(
        Effect.provideService(LedgerStorage, storage),
        Effect.provideService(RouterProvider, fakeRouterProvider()),
        Effect.flip,
      );

    assert.instanceOf(failure, LedgerStorageError);
    assert.strictEqual(failure.operation, allocationFailure.operation);
    assert.strictEqual(failure.detail, allocationFailure.detail);
  }));

test("completes the ledger before preserving caller interruption", () =>
  Effect.gen(function* () {
    const programStarted = yield* Deferred.make<undefined>();
    const completions = yield* Ref.make(0);
    const storage = observeCompletions(memoryStorage(), completions);
    const program = Deferred.succeed(programStarted, undefined).pipe(
      Effect.zipRight(Effect.never),
    );
    const run = yield* kernelHarness
      .run(ongoingRoster, program)
      .pipe(
        Effect.provideService(LedgerStorage, storage),
        Effect.provideService(RouterProvider, fakeRouterProvider()),
        Effect.fork,
      );

    yield* Deferred.await(programStarted);
    const exit = yield* Fiber.interrupt(run);

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.isTrue(Cause.isInterruptedOnly(exit.cause));
    }
    assert.strictEqual(yield* Ref.get(completions), 1);
    const ledger = yield* kernelHarness
      .openLedger(REF)
      .pipe(Effect.provideService(LedgerStorage, storage));
    assert.strictEqual(ledger.ref, REF);
  }));

test("preserves caller interruption composed with cleanup failure", () =>
  Effect.gen(function* () {
    const programStarted = yield* Deferred.make<undefined>();
    const cleanupRan = yield* Ref.make(false);
    const completions = yield* Ref.make(0);
    const storage = observeCompletions(memoryStorage(), completions);
    const program = Effect.scoped(
      Effect.acquireRelease(Deferred.succeed(programStarted, undefined), () =>
        Ref.set(cleanupRan, true).pipe(
          Effect.zipRight(Effect.dieMessage("cleanup failed")),
        ),
      ).pipe(Effect.zipRight(Effect.never)),
    );
    const run = yield* kernelHarness
      .run(ongoingRoster, program)
      .pipe(
        Effect.provideService(LedgerStorage, storage),
        Effect.provideService(RouterProvider, fakeRouterProvider()),
        Effect.fork,
      );

    yield* Deferred.await(programStarted);
    const exit = yield* Fiber.interrupt(run);

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.isTrue(Cause.isInterruptedOnly(exit.cause));
    }
    assert.isTrue(yield* Ref.get(cleanupRan));
    assert.strictEqual(yield* Ref.get(completions), 1);
    const ledger = yield* kernelHarness
      .openLedger(REF)
      .pipe(Effect.provideService(LedgerStorage, storage));
    assert.strictEqual(ledger.ref, REF);
  }));

test("preserves caller interruption during roster acquisition", () =>
  Effect.gen(function* () {
    const acquisitionStarted = yield* Deferred.make<undefined>();
    const completions = yield* Ref.make(0);
    const storage = observeCompletions(memoryStorage(), completions);
    const acquiringRuntime = defineFakeRuntime({
      name: "acquiring",
      configuration: configuration("acquiring"),
      acquire: () =>
        Deferred.succeed(acquisitionStarted, undefined).pipe(
          Effect.zipRight(Effect.never),
        ),
    });
    const acquiringRoster = kernelHarness.agents({
      alice: acquiringRuntime,
    });
    const run = yield* kernelHarness
      .run(acquiringRoster, Effect.void)
      .pipe(
        Effect.provideService(LedgerStorage, storage),
        Effect.provideService(RouterProvider, fakeRouterProvider()),
        Effect.fork,
      );

    yield* Deferred.await(acquisitionStarted);
    const exit = yield* Fiber.interrupt(run);

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.isTrue(Cause.isInterruptedOnly(exit.cause));
    }
    assert.strictEqual(yield* Ref.get(completions), 1);
    const ledger = yield* kernelHarness
      .openLedger(REF)
      .pipe(Effect.provideService(LedgerStorage, storage));
    assert.strictEqual(ledger.ref, REF);
  }));

test("masks physical allocation through the kernel ownership handoff", () =>
  Effect.gen(function* () {
    const physicallyAllocated = yield* Deferred.make<undefined>();
    const releaseAllocation = yield* Deferred.make<undefined>();
    const completions = yield* Ref.make(0);
    const observed = observeCompletions(memoryStorage(), completions);
    const storage: LedgerStorageService = {
      ...observed,
      allocate: (input) =>
        observed.allocate(input).pipe(
          Effect.tap(() => Deferred.succeed(physicallyAllocated, undefined)),
          Effect.tap(() => Deferred.await(releaseAllocation)),
        ),
    };
    const run = yield* kernelHarness
      .run(ongoingRoster, Effect.never)
      .pipe(
        Effect.provideService(LedgerStorage, storage),
        Effect.provideService(RouterProvider, fakeRouterProvider()),
        Effect.fork,
      );

    yield* Deferred.await(physicallyAllocated);
    yield* Fiber.interruptFork(run);
    yield* Effect.yieldNow();
    yield* Deferred.succeed(releaseAllocation, undefined);
    const exit = yield* Fiber.await(run);

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.isTrue(Cause.isInterruptedOnly(exit.cause));
    }
    assert.strictEqual(yield* Ref.get(completions), 1);
    const ledger = yield* kernelHarness
      .openLedger(REF)
      .pipe(Effect.provideService(LedgerStorage, storage));
    assert.strictEqual(ledger.ref, REF);
  }));

test("peer acquisition cancellation is not a startup failure", () =>
  Effect.gen(function* () {
    const siblingStarted = yield* Deferred.make<undefined>();
    const primary = defineFakeRuntime<
      never,
      string,
      typeof testRuntimeConfiguration
    >({
      name: "primary-failure",
      configuration: configuration("primary-failure"),
      acquire: () =>
        Deferred.await(siblingStarted).pipe(
          Effect.zipRight(Effect.fail("primary failed")),
        ),
    });
    const interruptedPeer = defineFakeRuntime({
      name: "interrupted-peer",
      configuration: configuration("interrupted-peer"),
      acquire: () =>
        Deferred.succeed(siblingStarted, undefined).pipe(
          Effect.zipRight(Effect.never),
        ),
    });
    const failingRoster = kernelHarness.agents({
      [PRIMARY_AGENT_NAME]: primary,
      bob: interruptedPeer,
    });

    const result = yield* kernelHarness.run(failingRoster, Effect.void);
    assert.instanceOf(result, ClusterLost);
    if (result instanceof ClusterLost) {
      assert.instanceOf(result.receipt, CompletedLedgerReceipt);
      assert.isFalse(Cause.isInterrupted(result.cause));
    }

    const ledger = yield* kernelHarness.openLedger(REF);
    const failures = yield* Stream.runCollect(
      ledger.events(AgentRuntimeStartFailed),
    );
    assert.strictEqual(failures.length, 1);
    assert.strictEqual(
      Chunk.unsafeGet(failures, 0).agentName,
      PRIMARY_AGENT_NAME,
    );
  }).pipe(
    Effect.provideService(LedgerStorage, memoryStorage()),
    Effect.provideService(RouterProvider, fakeRouterProvider()),
  ));

test("releases an acquired peer when parallel roster acquisition fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peerAcquired = yield* Deferred.make<undefined>();
      const peerReleased = yield* Ref.make(false);
      const primary = defineFakeRuntime({
        name: "primary-failure",
        configuration: configuration("primary-failure"),
        acquire: () =>
          Deferred.await(peerAcquired).pipe(
            Effect.zipRight(Effect.fail("primary failed")),
          ),
      });
      const acquiredPeer = defineFakeRuntime({
        name: "acquired-peer",
        configuration: configuration("acquired-peer"),
        acquire: () =>
          Effect.acquireRelease(
            Deferred.succeed(peerAcquired, undefined).pipe(
              Effect.as({ gateway: undefined, termination: Effect.never }),
            ),
            () => Ref.set(peerReleased, true),
          ),
      });
      const failingRoster = kernelHarness.agents({
        [PRIMARY_AGENT_NAME]: primary,
        bob: acquiredPeer,
      });
      const result = yield* kernelHarness.run(failingRoster, Effect.void);
      assert.instanceOf(result, ClusterLost);
      if (result instanceof ClusterLost) {
        assert.instanceOf(result.receipt, CompletedLedgerReceipt);
      }
      assert.isTrue(yield* Ref.get(peerReleased));
      const ledger = yield* kernelHarness.openLedger(REF);
      const failures = yield* Stream.runCollect(
        ledger.events(AgentRuntimeStartFailed),
      );
      assert.strictEqual(failures.length, 1);
      assert.strictEqual(
        Chunk.unsafeGet(failures, 0).agentName,
        PRIMARY_AGENT_NAME,
      );
    }).pipe(
      Effect.provideService(LedgerStorage, memoryStorage()),
      Effect.provideService(RouterProvider, fakeRouterProvider()),
    ),
  ));

const SHAPE_DESCRIPTION = "delay under shape";
const SHAPED_DELAY = Duration.millis(100);
const SHAPED_DELAY_MILLIS = 100;

function textOf(received: ReceivedMessage): string {
  return received.message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
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

function openPair() {
  return Effect.gen(function* () {
    const network = yield* Network;
    const sender = yield* network.endpoint("sender");
    const receiver = yield* network.endpoint("receiver");
    const socket = yield* sender.open(receiver.participant);
    return { sender, receiver, socket };
  });
}

function disableRoundTripProgram() {
  return Effect.gen(function* () {
    const links = yield* LinkController;
    const ledger = yield* kernelHarness.ledger;
    const { sender, receiver, socket } = yield* openPair();
    const received = yield* receiver
      .messages()
      .pipe(Stream.take(2), Stream.runCollect, Effect.fork);
    yield* Effect.yieldNow();
    yield* socket.send("baseline");
    yield* ledger
      .events(EndpointMessageReceived)
      .pipe(Stream.take(1), Stream.runDrain);
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* links.disable(sender.participant, receiver.participant);
        yield* socket.send("blocked");
        yield* ledger
          .events(LinkMessageDropped)
          .pipe(Stream.take(1), Stream.runDrain);
      }),
    );
    yield* socket.send("after");
    const messages = yield* Fiber.join(received);
    return Chunk.toReadonlyArray(messages).map(textOf);
  });
}

test("scoped link disable drops deliveries with evidence and restores delivery", () =>
  Effect.gen(function* () {
    const result = yield* kernelHarness.run(
      kernelHarness.agents({}),
      disableRoundTripProgram(),
    );
    assert.instanceOf(result, ProgramFinished);
    if (!(result instanceof ProgramFinished)) {
      return;
    }
    assert.deepStrictEqual(result.exit, Exit.succeed(["baseline", "after"]));

    const ledger = yield* kernelHarness.openLedger(result.receipt.ledger);
    assert.lengthOf(yield* Stream.runCollect(ledger.events(LinkDown)), 1);
    assert.lengthOf(yield* Stream.runCollect(ledger.events(LinkUp)), 1);
    const dropped = yield* Stream.runCollect(ledger.events(LinkMessageDropped));
    assert.strictEqual(dropped.length, 1);
  }).pipe(
    Effect.provideService(LedgerStorage, memoryStorage()),
    Effect.provideService(RouterProvider, fakeRouterProvider()),
  ));

function delayUnderShapeProgram() {
  return Effect.gen(function* () {
    const links = yield* LinkController;
    const ledger = yield* kernelHarness.ledger;
    const { sender, receiver, socket } = yield* openPair();
    const received = yield* receiver
      .messages()
      .pipe(Stream.take(1), Stream.runCollect, Effect.fork);
    yield* Effect.yieldNow();
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* links.shape(
          sender.participant,
          receiver.participant,
          linkPolicy.delay(SHAPED_DELAY),
          SHAPE_DESCRIPTION,
        );
        yield* socket.send("delayed");
        yield* ledger
          .events(LinkMessageDelayed)
          .pipe(Stream.take(1), Stream.runDrain);
        yield* awaitSleepers(1);
        yield* TestClock.adjust(SHAPED_DELAY);
      }),
    );
    const messages = yield* Fiber.join(received);
    return Chunk.toReadonlyArray(messages).map(textOf);
  });
}

test("a shaped delay defers delivery until the ambient clock advances", () =>
  Effect.gen(function* () {
    const result = yield* kernelHarness.run(
      kernelHarness.agents({}),
      delayUnderShapeProgram(),
    );
    assert.instanceOf(result, ProgramFinished);
    if (!(result instanceof ProgramFinished)) {
      return;
    }
    assert.deepStrictEqual(result.exit, Exit.succeed(["delayed"]));

    const ledger = yield* kernelHarness.openLedger(result.receipt.ledger);
    const set = yield* Stream.runCollect(ledger.events(LinkPolicySet));
    assert.strictEqual(Chunk.unsafeGet(set, 0).policy, SHAPE_DESCRIPTION);
    const cleared = yield* Stream.runCollect(ledger.events(LinkPolicyCleared));
    assert.strictEqual(Chunk.unsafeGet(cleared, 0).policy, SHAPE_DESCRIPTION);
    const delayed = yield* Stream.runCollect(ledger.events(LinkMessageDelayed));
    assert.strictEqual(
      Chunk.unsafeGet(delayed, 0).delayMillis,
      SHAPED_DELAY_MILLIS,
    );
  }).pipe(
    Effect.provideService(LedgerStorage, memoryStorage()),
    Effect.provideService(RouterProvider, fakeRouterProvider()),
  ));

/* eslint-enable agent-code-guard/no-example-only-tests -- Restore the project default after the run-lifecycle regressions. */
