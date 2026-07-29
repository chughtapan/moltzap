import { assert, effect as test } from "@effect/vitest";
import { serverBaseUrlSchema } from "@moltzap/protocol/network";
import {
  conversationId,
  agentId as protocolAgentId,
  messageId,
  redactedAgentKey,
  taskId,
} from "@moltzap/protocol/testing";
import {
  Cause,
  Chunk,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Ref,
  Schema,
  Stream,
} from "effect";
import {
  AgentProcessExited,
  AgentProcessSignaled,
  AgentRuntimeCompleted,
  AgentRuntimeFailed,
  AgentRuntimeReady,
  AgentRuntimeStartFailed,
  EndpointMessageSent,
  RouterMessageCommitted,
  RunStarted,
} from "../events/core.js";
import { EventCatalog } from "../events/catalog.js";
import {
  LedgerCompletion,
  ledgerDigest,
  LedgerManifest,
  ledgerRef,
} from "../ledger/model.js";
import {
  LedgerStorage,
  LedgerStorageError,
  type LedgerArtifact,
  type LedgerStorageService,
} from "../ledger/storage.js";
import {
  Network,
  RouterProvider,
  type RouterStopped,
  makeAgentHandle,
  makeParticipantHandle,
  makeRouterStopReport,
  type AttachedEndpoint,
  type Router,
  type RouterProviderService,
} from "../network.js";
import {
  CompletedLedgerReceipt,
  IncompleteLedgerReceipt,
  ProgramFinished,
  RunInfrastructureFailed,
} from "./run.js";
import {
  RuntimeCompleted,
  RuntimeExited,
  defineRuntime,
} from "../runtime/runtime.js";
import { simulator } from "../definition.js";

class Observation extends Schema.TaggedClass<Observation>()(
  "acme.kernel-observation/v1",
  { value: Schema.String },
) {}

const customerEvents = EventCatalog.make(Observation);
const society = simulator.define("acme.kernel-test/v1", customerEvents);
const DIGEST = Schema.decodeSync(ledgerDigest)("a".repeat(64));
const REF = Schema.decodeSync(ledgerRef)("kernel-test-ledger");
const ROUTER_URL = Schema.decodeSync(serverBaseUrlSchema)(
  "http://127.0.0.1:43100",
);
const OBSERVED_EXIT_CODE = 7;
const PRIMARY_AGENT_NAME = "alice";
const READY = () => Effect.void;
const TestRuntimeConfiguration = Schema.Struct({
  kind: Schema.String,
});

function configuration(kind: string) {
  return {
    schema: TestRuntimeConfiguration,
    value: { kind },
  };
}

function agentId(suffix: number) {
  return protocolAgentId(
    `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
  );
}

function agentKey(suffix: number) {
  return redactedAgentKey(
    `moltzap_agent_${String(suffix).padStart(16, "0")}_${String(suffix).padStart(48, "0")}`,
  );
}

function completion(manifest: LedgerManifest, count: number): LedgerCompletion {
  return LedgerCompletion.make({
    ledgerFormatVersion: 1,
    runId: manifest.runId,
    recordCount: count,
    artifacts: { manifest: DIGEST, records: DIGEST },
  });
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

function assertDefaultProvenance(manifest: LedgerManifest): void {
  assert.deepStrictEqual(manifest.provenance, {
    agents: [
      {
        name: "alice",
        runtime: "effect",
        configuration: { kind: "in-process" },
      },
      {
        name: "bob",
        runtime: "process",
        configuration: { kind: "external-process" },
      },
    ],
  });
}

function memoryStorage(failOnEventTag?: string): LedgerStorageService {
  const files = new Map<LedgerArtifact, string>();
  return {
    allocate: (input) => {
      const manifest = LedgerManifest.make({
        ledgerFormatVersion: 1,
        definitionId: input.definitionId,
        runId: "kernel-test-run",
        catalogTags: [...input.catalogTags].sort(compareText),
        createdAt: DateTime.unsafeMake(0),
        provenance: input.provenance,
        metadata: input.metadata,
      });
      const records: string[] = [];
      files.set(
        "manifest",
        JSON.stringify(Schema.encodeSync(LedgerManifest)(manifest)),
      );
      files.set("records", "");
      return Effect.succeed({
        ref: REF,
        runId: manifest.runId,
        manifest,
        append: (record: string) =>
          failOnEventTag !== undefined &&
          record.includes(`"_tag":"${failOnEventTag}"`)
            ? Effect.fail(
                LedgerStorageError.make({
                  operation: "append",
                  detail: `failed ${failOnEventTag}`,
                }),
              )
            : Effect.sync(() => {
                records.push(record);
                files.set("records", `${records.join("\n")}\n`);
              }),
        complete: (count: number) => {
          const done = completion(manifest, count);
          files.set(
            "completion",
            JSON.stringify(Schema.encodeSync(LedgerCompletion)(done)),
          );
          return Effect.succeed(done);
        },
      });
    },
    read: (...[, artifact]) => Effect.succeed(files.get(artifact) ?? ""),
    digest: () => Effect.succeed(DIGEST),
  };
}

function increment(current: number): number {
  return current + 1;
}

function observeCompletions(
  storage: LedgerStorageService,
  completions: Ref.Ref<number>,
): LedgerStorageService {
  return {
    ...storage,
    allocate: (input) =>
      storage.allocate(input).pipe(
        Effect.map((allocation) => ({
          ...allocation,
          complete: (count: number) =>
            allocation
              .complete(count)
              .pipe(Effect.zipLeft(Ref.update(completions, increment))),
        })),
      ),
  };
}

function attachFakeEndpoint<const Name extends string>(
  name: Name,
  committedSends?: Ref.Ref<number>,
): Effect.Effect<AttachedEndpoint<Name>> {
  const endpointId = agentId(100);
  return Effect.succeed({
    participant: makeParticipantHandle(name, endpointId),
    transport: {
      received: Stream.never,
      openConversation: () =>
        Effect.succeed({
          taskId: taskId("00000000-0000-4000-8000-000000000101"),
          conversationId: conversationId(
            "00000000-0000-4000-8000-000000000102",
          ),
        }),
      send: (...[, currentConversationId, parts]) =>
        (committedSends === undefined
          ? Effect.void
          : Ref.update(committedSends, (count) => count + 1)
        ).pipe(
          Effect.as({
            id: messageId("00000000-0000-4000-8000-000000000103"),
            conversationId: currentConversationId,
            senderId: endpointId,
            parts,
            createdAt: "2026-07-28T00:00:00.000Z",
          }),
        ),
    },
  });
}

function fakeRouterProvider(
  committedSends?: Ref.Ref<number>,
): RouterProviderService {
  return {
    acquire: Effect.gen(function* () {
      const stopped = yield* Deferred.make<RouterStopped>();
      let nextIdentity = 0;
      const router: Router = {
        address: ROUTER_URL,
        stopped: Deferred.await(stopped),
        attachAgent: (name) =>
          Effect.sync(() => {
            nextIdentity += 1;
            return {
              agent: makeAgentHandle(name, agentId(nextIdentity)),
              key: agentKey(nextIdentity),
              routerUrl: ROUTER_URL,
              awaitReady: READY,
            };
          }),
        attachEndpoint: (name) => attachFakeEndpoint(name, committedSends),
      };
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(stopped, makeRouterStopReport([])).pipe(Effect.asVoid),
      );
      return router;
    }),
  };
}

const codeRuntime = defineRuntime({
  name: "effect",
  configuration: configuration("in-process"),
  acquire: (input) =>
    input.connection.awaitReady(Duration.seconds(1)).pipe(
      Effect.as({
        termination: Effect.succeed(RuntimeCompleted.make({})),
      }),
    ),
});

const processRuntime = defineRuntime({
  name: "process",
  configuration: configuration("external-process"),
  acquire: (input) =>
    input.connection.awaitReady(Duration.seconds(1)).pipe(
      Effect.as({
        termination: Effect.succeed(RuntimeExited.make({ code: 0 })),
      }),
    ),
});

const roster = society.agents({
  alice: codeRuntime,
  bob: processRuntime,
});

const ongoingRuntime = defineRuntime({
  name: "ongoing",
  configuration: configuration("ongoing"),
  acquire: (input) =>
    input.connection
      .awaitReady(Duration.seconds(1))
      .pipe(Effect.as({ termination: Effect.never })),
});

const ongoingRoster = society.agents({
  alice: ongoingRuntime,
});

// @agent-code-guard/regression-only: controlled scopes and deferred termination expose exact lifecycle evidence and cancellation order
test("runs mixed runtimes until customer policy completes", () => {
  const program = Effect.gen(function* () {
    const agents = yield* roster.startedAgents;
    const ledger = yield* society.ledger;
    const events = yield* society.events;
    yield* Network;
    yield* ledger
      .events(AgentRuntimeCompleted)
      .pipe(Stream.take(1), Stream.runDrain);
    yield* Effect.yieldNow();
    yield* events.emit(Observation.make({ value: "done" }));
    return [agents.alice.name, agents.bob.name] as const;
  });
  return Effect.gen(function* () {
    const result = yield* society.run(roster, program);
    assert.instanceOf(result, ProgramFinished);
    if (!(result instanceof ProgramFinished)) {
      return;
    }
    assert.isTrue(Exit.isSuccess(result.exit));
    if (Exit.isFailure(result.exit)) {
      return;
    }
    assert.deepStrictEqual(result.exit.value, ["alice", "bob"]);

    const ledger = yield* society.openLedger(result.receipt.ledger);
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
  );
});

test("scope teardown interrupts an unfinished runtime observation", () =>
  Effect.gen(function* () {
    const result = yield* society.run(
      ongoingRoster,
      Effect.succeed("policy-complete"),
    );
    assert.instanceOf(result, ProgramFinished);
    if (!(result instanceof ProgramFinished)) {
      return;
    }
    assert.deepStrictEqual(result.exit, Exit.succeed("policy-complete"));

    const ledger = yield* society.openLedger(result.receipt.ledger);
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

test("captures run description values before the lazy Effect executes", () =>
  Effect.gen(function* () {
    const provenance = {
      suite: "captured-suite",
      environment: { region: "west" },
      agents: ["caller-supplied"],
    };
    const metadata = {
      case: "captured-case",
      labels: ["original"],
    };
    const run = society.run(ongoingRoster, Effect.succeed("policy-complete"), {
      provenance,
      metadata,
    });

    provenance.suite = "mutated-suite";
    provenance.environment.region = "east";
    metadata.case = "mutated-case";
    metadata.labels.push("mutated");

    const result = yield* run;
    assert.instanceOf(result, ProgramFinished);
    if (!(result instanceof ProgramFinished)) {
      return;
    }
    const ledger = yield* society.openLedger(result.receipt.ledger);

    assert.deepStrictEqual(ledger.manifest.provenance, {
      suite: "captured-suite",
      environment: { region: "west" },
      agents: [
        {
          name: "alice",
          runtime: "ongoing",
          configuration: { kind: "ongoing" },
        },
      ],
    });
    assert.deepStrictEqual(ledger.manifest.metadata, {
      case: "captured-case",
      labels: ["original"],
    });
  }).pipe(
    Effect.provideService(LedgerStorage, memoryStorage()),
    Effect.provideService(RouterProvider, fakeRouterProvider()),
  ));

test("records genuine runtime termination while policy remains active", () =>
  Effect.gen(function* () {
    const termination = yield* Deferred.make<RuntimeExited>();
    const observedRuntime = defineRuntime({
      name: "observed-process",
      configuration: configuration("observed-process"),
      acquire: (input) =>
        input.connection
          .awaitReady(Duration.seconds(1))
          .pipe(Effect.as({ termination: Deferred.await(termination) })),
    });
    const observedRoster = society.agents({
      alice: observedRuntime,
    });
    const program = Effect.gen(function* () {
      const ledger = yield* society.ledger;
      yield* Deferred.succeed(
        termination,
        RuntimeExited.make({ code: OBSERVED_EXIT_CODE }),
      );
      yield* ledger
        .events(AgentProcessExited)
        .pipe(Stream.take(1), Stream.runDrain);
      return "observed";
    });

    const result = yield* society.run(observedRoster, program);
    assert.instanceOf(result, ProgramFinished);
    if (!(result instanceof ProgramFinished)) {
      return;
    }
    assert.deepStrictEqual(result.exit, Exit.succeed("observed"));
    const ledger = yield* society.openLedger(result.receipt.ledger);
    const exits = yield* Stream.runCollect(ledger.events(AgentProcessExited));
    assert.strictEqual(exits.length, 1);
    assert.strictEqual(Chunk.unsafeGet(exits, 0).code, OBSERVED_EXIT_CODE);
  }).pipe(
    Effect.provideService(LedgerStorage, memoryStorage()),
    Effect.provideService(RouterProvider, fakeRouterProvider()),
  ));

test("records a defective termination observer as runtime failure", () =>
  Effect.gen(function* () {
    const defectiveRuntime = defineRuntime({
      name: "defective-termination-observer",
      configuration: configuration("defective-observer"),
      acquire: (input) =>
        input.connection.awaitReady(Duration.seconds(1)).pipe(
          Effect.as({
            termination: Effect.dieMessage("termination observer defect"),
          }),
        ),
    });
    const defectiveRoster = society.agents({
      alice: defectiveRuntime,
    });
    const program = Effect.gen(function* () {
      const ledger = yield* society.ledger;
      yield* ledger
        .events(AgentRuntimeFailed)
        .pipe(Stream.take(1), Stream.runDrain);
      return "observed";
    });

    const result = yield* society.run(defectiveRoster, program);
    assert.instanceOf(result, ProgramFinished);
    if (!(result instanceof ProgramFinished)) {
      return;
    }
    assert.deepStrictEqual(result.exit, Exit.succeed("observed"));
    const ledger = yield* society.openLedger(result.receipt.ledger);
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
      const socket = yield* probe.open(agents.alice);
      yield* socket.send("request");
      return "sent";
    });

    const outcome = yield* society
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

    assert.instanceOf(outcome, RunInfrastructureFailed);
    if (outcome instanceof RunInfrastructureFailed) {
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
    const outcome = yield* society.run(ongoingRoster, Effect.void);

    assert.instanceOf(outcome, RunInfrastructureFailed);
    if (outcome instanceof RunInfrastructureFailed) {
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
    const failure = yield* society
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
    const run = yield* society
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
    const ledger = yield* society
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
    const run = yield* society
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
    const ledger = yield* society
      .openLedger(REF)
      .pipe(Effect.provideService(LedgerStorage, storage));
    assert.strictEqual(ledger.ref, REF);
  }));

test("preserves caller interruption during roster acquisition", () =>
  Effect.gen(function* () {
    const acquisitionStarted = yield* Deferred.make<undefined>();
    const completions = yield* Ref.make(0);
    const storage = observeCompletions(memoryStorage(), completions);
    const acquiringRuntime = defineRuntime({
      name: "acquiring",
      configuration: configuration("acquiring"),
      acquire: () =>
        Deferred.succeed(acquisitionStarted, undefined).pipe(
          Effect.zipRight(Effect.never),
        ),
    });
    const acquiringRoster = society.agents({
      alice: acquiringRuntime,
    });
    const run = yield* society
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
    const ledger = yield* society
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
    const run = yield* society
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
    const ledger = yield* society
      .openLedger(REF)
      .pipe(Effect.provideService(LedgerStorage, storage));
    assert.strictEqual(ledger.ref, REF);
  }));

test("peer acquisition cancellation is not a startup failure", () =>
  Effect.gen(function* () {
    const siblingStarted = yield* Deferred.make<undefined>();
    const primary = defineRuntime<
      string,
      never,
      typeof TestRuntimeConfiguration
    >({
      name: "primary-failure",
      configuration: configuration("primary-failure"),
      acquire: () =>
        Deferred.await(siblingStarted).pipe(
          Effect.zipRight(Effect.fail("primary failed")),
        ),
    });
    const interruptedPeer = defineRuntime({
      name: "interrupted-peer",
      configuration: configuration("interrupted-peer"),
      acquire: () =>
        Deferred.succeed(siblingStarted, undefined).pipe(
          Effect.zipRight(Effect.never),
        ),
    });
    const failingRoster = society.agents({
      [PRIMARY_AGENT_NAME]: primary,
      bob: interruptedPeer,
    });

    const result = yield* society.run(failingRoster, Effect.void);
    assert.instanceOf(result, RunInfrastructureFailed);
    if (result instanceof RunInfrastructureFailed) {
      assert.instanceOf(result.receipt, CompletedLedgerReceipt);
      assert.isFalse(Cause.isInterrupted(result.cause));
    }

    const ledger = yield* society.openLedger(REF);
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
      const primary = defineRuntime({
        name: "primary-failure",
        configuration: configuration("primary-failure"),
        acquire: () =>
          Deferred.await(peerAcquired).pipe(
            Effect.zipRight(Effect.fail("primary failed")),
          ),
      });
      const acquiredPeer = defineRuntime({
        name: "acquired-peer",
        configuration: configuration("acquired-peer"),
        acquire: () =>
          Effect.acquireRelease(
            Deferred.succeed(peerAcquired, undefined).pipe(
              Effect.as({ termination: Effect.never }),
            ),
            () => Ref.set(peerReleased, true),
          ),
      });
      const failingRoster = society.agents({
        [PRIMARY_AGENT_NAME]: primary,
        bob: acquiredPeer,
      });
      const result = yield* society.run(failingRoster, Effect.void);
      assert.instanceOf(result, RunInfrastructureFailed);
      if (result instanceof RunInfrastructureFailed) {
        assert.instanceOf(result.receipt, CompletedLedgerReceipt);
      }
      assert.isTrue(yield* Ref.get(peerReleased));
      const ledger = yield* society.openLedger(REF);
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
