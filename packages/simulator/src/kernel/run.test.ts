import { assert, effect as test } from "@effect/vitest";
import { serverBaseUrlSchema } from "@moltzap/protocol/network";
import {
  conversationId,
  agentId as protocolAgentId,
  messageId,
  redactedAgentKey,
} from "@moltzap/protocol/testing";
import {
  Cause,
  Chunk,
  DateTime,
  Deferred,
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
  RouterStarted,
  RunStarted,
} from "../events/core.js";
import { EventCatalog } from "../events/catalog.js";
import { makeDefinitionEventServices } from "./event-services.js";
import {
  LedgerCompletion,
  ledgerDigest,
  LedgerManifest,
  ledgerRef,
} from "../ledger/model.js";
import { openLedger } from "../ledger/open.js";
import {
  LedgerStorage,
  LedgerStorageError,
  type LedgerArtifact,
  type LedgerStorageService,
} from "../ledger/storage.js";
import {
  Network,
  NetworkFailure,
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
  runSociety,
  type SimulatorRunOptions,
} from "./run.js";
import {
  RuntimeCompleted,
  RuntimeExited,
  type AgentRuntimeLike,
} from "../runtime/runtime.js";
import {
  defineFakeRuntime,
  makeFakeSocietyPlatform,
} from "../platform/fake.js";
import { SocietyPlatform } from "../platform/platform.js";
import { makeAgentRosterBinding, type AgentRoster } from "../runtime/roster.js";

class Observation extends Schema.TaggedClass<Observation>()(
  "acme.kernel-observation/v1",
  { value: Schema.String },
) {}

const customerEvents = EventCatalog.make(Observation);
const DEFINITION_ID = "acme.kernel-test/v1";
const eventServices = makeDefinitionEventServices(
  DEFINITION_ID,
  customerEvents,
);
const rosterBinding = makeAgentRosterBinding(DEFINITION_ID);
const runKernel = <
  const Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
>(
  roster: AgentRoster<typeof DEFINITION_ID, Definitions>,
  program: Effect.Effect<A, E, R>,
  options: SimulatorRunOptions = {},
) =>
  runSociety({
    definitionId: DEFINITION_ID,
    eventServices,
    roster,
    program,
    options,
  }).pipe(Effect.provideService(SocietyPlatform, makeFakeSocietyPlatform()));
const kernelHarness = Object.freeze({
  agents: rosterBinding.agents,
  ledger: eventServices.ledger,
  events: eventServices.events,
  run: runKernel,
  openLedger: (ref: typeof ledgerRef.Type) =>
    openLedger(eventServices.catalog, ref, DEFINITION_ID),
});
const DIGEST = Schema.decodeSync(ledgerDigest)("a".repeat(64));
const REF = Schema.decodeSync(ledgerRef)("kernel-test-ledger");
const ROUTER_URL = Schema.decodeSync(serverBaseUrlSchema)(
  "http://127.0.0.1:43100",
);
const OBSERVED_EXIT_CODE = 7;
const PRIMARY_AGENT_NAME = "alice";
const testRuntimeConfiguration = Schema.Struct({
  kind: Schema.String,
});

function configuration(kind: string) {
  return {
    schema: testRuntimeConfiguration,
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
          failOnEventTag !== undefined && record.includes(failOnEventTag)
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
          conversationId: conversationId(
            "00000000-0000-4000-8000-000000000102",
          ),
        }),
      send: (currentConversationId, parts) =>
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

const ongoingRuntime = defineFakeRuntime({
  name: "ongoing",
  configuration: configuration("ongoing"),
  acquire: () =>
    Effect.succeed({ gateway: undefined, termination: Effect.never }),
});

const ongoingRoster = kernelHarness.agents({
  alice: ongoingRuntime,
});

// @agent-code-guard/regression-only: controlled scopes and deferred termination expose exact lifecycle evidence and cancellation order
// eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- the lifecycle regression keeps post-dispatch termination, evidence, and final outcome in one ordered effect.
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
    const run = kernelHarness.run(
      ongoingRoster,
      Effect.succeed("policy-complete"),
      {
        provenance,
        metadata,
      },
    );

    provenance.suite = "mutated-suite";
    provenance.environment.region = "east";
    metadata.case = "mutated-case";
    metadata.labels.push("mutated");

    const result = yield* run;
    assert.instanceOf(result, ProgramFinished);
    if (!(result instanceof ProgramFinished)) {
      return;
    }
    const ledger = yield* kernelHarness.openLedger(result.receipt.ledger);

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
    const outcome = yield* kernelHarness.run(ongoingRoster, Effect.void);

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

test("retains router stop failure when started-event storage fails", () => {
  const stopFailure = NetworkFailure.make({
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

    assert.instanceOf(outcome, RunInfrastructureFailed);
    if (outcome instanceof RunInfrastructureFailed) {
      const failures = Array.from(Cause.failures(outcome.cause));
      assert.isTrue(
        failures.some(
          (failure) =>
            failure instanceof NetworkFailure &&
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
    assert.instanceOf(result, RunInfrastructureFailed);
    if (result instanceof RunInfrastructureFailed) {
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
      assert.instanceOf(result, RunInfrastructureFailed);
      if (result instanceof RunInfrastructureFailed) {
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
