import { assert, effect as test } from "@effect/vitest";
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { AgentId } from "@moltzap/protocol/identity";
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
  Duration,
  Effect,
  Exit,
  Fiber,
  Mailbox,
  Ref,
  Schema,
  type Scope,
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
  LinkController,
  linkPolicy,
  Network,
  NetworkFailure,
  RouterProvider,
  type RouterStopped,
  makeAgentHandle,
  makeParticipantHandle,
  makeRouterStopReport,
  type AttachedEndpoint,
  type EndpointTransport,
  type MessageParts,
  type ReceivedMessage,
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

function hubMessage(
  endpointId: AgentId,
  currentConversationId: ConversationId,
  parts: MessageParts,
  sequence: number,
) {
  return {
    id: messageId(
      `00000000-0000-4000-8000-${String(400 + sequence).padStart(12, "0")}`,
    ),
    conversationId: currentConversationId,
    senderId: endpointId,
    parts,
    createdAt: "2026-07-28T00:00:00.000Z",
  };
}

interface Counter {
  value: number;
}

// In-memory loopback hub: every endpoint send fans out into every other
// attachment's received stream, so kernel tests observe real deliveries.
interface FakeHubState {
  readonly inboxes: Map<AgentId, Mailbox.Mailbox<ReceivedMessage>>;
  readonly endpoints: Counter;
  readonly messages: Counter;
  readonly committedSends?: Ref.Ref<number>;
}

function hubSend(
  hub: FakeHubState,
  endpointId: AgentId,
): EndpointTransport["send"] {
  return (currentConversationId, parts) =>
    Effect.gen(function* () {
      if (hub.committedSends !== undefined) {
        yield* Ref.update(hub.committedSends, increment);
      }
      hub.messages.value += 1;
      const message = hubMessage(
        endpointId,
        currentConversationId,
        parts,
        hub.messages.value,
      );
      yield* Effect.forEach(
        hub.inboxes,
        ([id, inbox]) =>
          id === endpointId ? Effect.void : inbox.offer({ message }),
        { concurrency: 1, discard: true },
      );
      return message;
    });
}

function hubAttachment<const Name extends string>(
  name: Name,
  endpointId: AgentId,
  mailbox: Mailbox.Mailbox<ReceivedMessage>,
  send: EndpointTransport["send"],
): AttachedEndpoint<Name> {
  return {
    participant: makeParticipantHandle(name, endpointId),
    transport: {
      received: Mailbox.toStream(mailbox),
      openConversation: () =>
        Effect.succeed({
          conversationId: conversationId(
            "00000000-0000-4000-8000-000000000102",
          ),
        }),
      send,
    },
  };
}

function hubAttach<const Name extends string>(
  hub: FakeHubState,
  name: Name,
): Effect.Effect<AttachedEndpoint<Name>, never, Scope.Scope> {
  return Effect.gen(function* () {
    hub.endpoints.value += 1;
    const endpointId = agentId(100 + hub.endpoints.value);
    const mailbox = yield* Mailbox.make<ReceivedMessage>();
    hub.inboxes.set(endpointId, mailbox);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => hub.inboxes.delete(endpointId)),
    );
    return hubAttachment(name, endpointId, mailbox, hubSend(hub, endpointId));
  });
}

function fakeRouterProvider(
  committedSends?: Ref.Ref<number>,
): RouterProviderService {
  return {
    acquire: Effect.gen(function* () {
      const stopped = yield* Deferred.make<RouterStopped>();
      const hub: FakeHubState = {
        inboxes: new Map(),
        endpoints: { value: 0 },
        messages: { value: 0 },
        committedSends,
      };
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
        attachEndpoint: (name) => hubAttach(hub, name),
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
  acquire: () =>
    Effect.succeed({
      gateway: undefined,
      termination: Effect.succeed(RuntimeCompleted.make({})),
    }),
});

const processRuntime = defineRuntime({
  name: "process",
  configuration: configuration("external-process"),
  acquire: () =>
    Effect.succeed({
      gateway: undefined,
      termination: Effect.succeed(RuntimeExited.make({ code: 0 })),
    }),
});

const roster = society.agents({
  alice: codeRuntime,
  bob: processRuntime,
});

const ongoingRuntime = defineRuntime({
  name: "ongoing",
  configuration: configuration("ongoing"),
  acquire: () =>
    Effect.succeed({ gateway: undefined, termination: Effect.never }),
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
    return [agents.alice.agent.name, agents.bob.agent.name] as const;
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
      acquire: () =>
        Effect.succeed({
          gateway: undefined,
          termination: Deferred.await(termination),
        }),
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
      acquire: () =>
        Effect.succeed({
          gateway: undefined,
          termination: Effect.dieMessage("termination observer defect"),
        }),
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
      const socket = yield* probe.open(agents.alice.agent);
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
    const outcome = yield* society.run(society.agents({}), Effect.void);

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
      never,
      string,
      never,
      typeof testRuntimeConfiguration
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
              Effect.as({ gateway: undefined, termination: Effect.never }),
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
    const ledger = yield* society.ledger;
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
    const result = yield* society.run(
      society.agents({}),
      disableRoundTripProgram(),
    );
    assert.instanceOf(result, ProgramFinished);
    if (!(result instanceof ProgramFinished)) {
      return;
    }
    assert.deepStrictEqual(result.exit, Exit.succeed(["baseline", "after"]));

    const ledger = yield* society.openLedger(result.receipt.ledger);
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
    const ledger = yield* society.ledger;
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
    const result = yield* society.run(
      society.agents({}),
      delayUnderShapeProgram(),
    );
    assert.instanceOf(result, ProgramFinished);
    if (!(result instanceof ProgramFinished)) {
      return;
    }
    assert.deepStrictEqual(result.exit, Exit.succeed(["delayed"]));

    const ledger = yield* society.openLedger(result.receipt.ledger);
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
