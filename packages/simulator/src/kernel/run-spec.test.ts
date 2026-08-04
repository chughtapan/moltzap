/* eslint-disable max-lines-per-function, max-statements, sonarjs/max-lines-per-function -- lifecycle regressions keep their ordered gates, invocation count, evidence, and cleanup assertions together. */

import { assert, effect as test } from "@effect/vitest";
import { serverBaseUrlSchema } from "@moltzap/protocol/network";
import {
  agentId as protocolAgentId,
  conversationId,
  messageId,
  redactedAgentKey,
} from "@moltzap/protocol/testing";
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Ref,
  Schema,
  Stream,
} from "effect";
import { Run, RunSpec } from "../definition.js";
import { EventCatalog } from "../events/catalog.js";
import {
  AgentProcessExited,
  AgentRuntimeReady,
  coreEvents,
  EndpointMessageSent,
} from "../events/core.js";
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
  makeAgentHandle,
  makeParticipantHandle,
  makeRouterStopReport,
  RouterProvider,
  type AttachedEndpoint,
  type Router,
  type RouterProviderService,
  type RouterStopped,
} from "../network.js";
import {
  SocietyPlatform,
  type SocietyPlatformService,
} from "../platform/platform.js";
import {
  defineFakeRuntime,
  makeFakeSocietyPlatform,
} from "../platform/fake.js";
import { SimulatorInfrastructureFailure } from "../platform/failure.js";
import { RuntimeExited } from "../runtime/runtime.js";
import {
  CompletedLedgerReceipt,
  ProgramFinished,
  RunInfrastructureFailed,
} from "./run.js";

class Observation extends Schema.TaggedClass<Observation>()(
  "acme.run-spec-observation/v1",
  { value: Schema.String },
) {}

const customerEvents = EventCatalog.make(Observation);
const DIGEST = Schema.decodeSync(ledgerDigest)("a".repeat(64));
const REF = Schema.decodeSync(ledgerRef)("run-spec-test-ledger");
const ROUTER_URL = Schema.decodeSync(serverBaseUrlSchema)(
  "http://127.0.0.1:43100",
);
const OBSERVED_EXIT_CODE = 7;
const runtimeConfiguration = Schema.Struct({ kind: Schema.String });

function configuration(kind: string) {
  return { schema: runtimeConfiguration, value: { kind } };
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

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

function ledgerCompletion(
  manifest: LedgerManifest,
  count: number,
): LedgerCompletion {
  return LedgerCompletion.make({
    ledgerFormatVersion: 1,
    runId: manifest.runId,
    recordCount: count,
    artifacts: { manifest: DIGEST, records: DIGEST },
  });
}

function memoryStorage(failOnEventTag?: string): LedgerStorageService {
  const files = new Map<LedgerArtifact, string>();
  return {
    allocate: (input) => {
      const manifest = LedgerManifest.make({
        ledgerFormatVersion: 1,
        definitionId: input.definitionId,
        runId: "run-spec-test-run",
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
        complete: (count: number) =>
          Effect.sync(() => {
            const completion = ledgerCompletion(manifest, count);
            files.set(
              "completion",
              JSON.stringify(Schema.encodeSync(LedgerCompletion)(completion)),
            );
            return completion;
          }),
      });
    },
    read: (...[, artifact]) => Effect.succeed(files.get(artifact) ?? ""),
    digest: () => Effect.succeed(DIGEST),
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

function fakeInfrastructure(
  storage?: LedgerStorageService,
  router?: RouterProviderService,
) {
  return Layer.merge(
    Layer.succeed(LedgerStorage, storage ?? memoryStorage()),
    Layer.succeed(RouterProvider, router ?? fakeRouterProvider()),
  );
}

function fakePlatformInfrastructure(
  platform: SocietyPlatformService,
  storage?: LedgerStorageService,
  router?: RouterProviderService,
) {
  const resolvedStorage = storage ?? memoryStorage();
  const resolvedRouter = router ?? fakeRouterProvider();
  return Layer.merge(
    fakeInfrastructure(resolvedStorage, resolvedRouter),
    Layer.succeed(SocietyPlatform, platform),
  );
}

interface GatedRuntimeInput<Gateway> {
  readonly name: string;
  readonly waiting: Deferred.Deferred<undefined>;
  readonly allowed: Deferred.Deferred<undefined>;
  readonly releases: Ref.Ref<number>;
  readonly gateway: Gateway;
}

function makeGatedRuntime<const Gateway>(input: GatedRuntimeInput<Gateway>) {
  return defineFakeRuntime({
    name: input.name,
    configuration: configuration(input.name),
    acquire: () =>
      Effect.acquireRelease(
        Deferred.succeed(input.waiting, undefined).pipe(
          Effect.zipRight(Deferred.await(input.allowed)),
          Effect.as({ gateway: input.gateway, termination: Effect.never }),
        ),
        () => Ref.update(input.releases, (count) => count + 1),
      ),
  });
}

function assertCohortLedger(storage: LedgerStorageService) {
  return Effect.gen(function* () {
    const ledger = yield* openLedger(
      EventCatalog.merge(coreEvents, customerEvents),
      REF,
      "acme.run-spec-cohort/v1",
    ).pipe(Effect.provideService(LedgerStorage, storage));
    const records = Array.from(yield* Stream.runCollect(ledger.records));
    const tags = records.map((record) => record.event._tag);
    assert.lengthOf(
      records.filter((record) => record.event._tag === AgentRuntimeReady._tag),
      2,
    );
    assert.isAbove(
      tags.indexOf(Observation._tag),
      tags.lastIndexOf(AgentRuntimeReady._tag),
    );
  });
}

function cohortGateCase() {
  return Effect.scoped(
    Effect.gen(function* () {
      const aliceWaiting = yield* Deferred.make<undefined>();
      const bobWaiting = yield* Deferred.make<undefined>();
      const cohortWaiting = yield* Deferred.make<undefined>();
      const allowAlice = yield* Deferred.make<undefined>();
      const allowBob = yield* Deferred.make<undefined>();
      const allowCohort = yield* Deferred.make<undefined>();
      const executions = yield* Ref.make(0);
      const releases = yield* Ref.make(0);
      const platformReleased = yield* Ref.make(false);
      const acquiredNames = yield* Ref.make<readonly string[]>([]);
      const storage = memoryStorage();
      const alice = makeGatedRuntime({
        name: "run-spec-alice",
        waiting: aliceWaiting,
        allowed: allowAlice,
        releases,
        gateway: Object.freeze({ runtime: "alice" as const }),
      });
      const bob = makeGatedRuntime({
        name: "run-spec-bob",
        waiting: bobWaiting,
        allowed: allowBob,
        releases,
        gateway: Object.freeze({ runtime: "bob" as const }),
      });
      const platform = makeFakeSocietyPlatform({
        cohortReady: Deferred.succeed(cohortWaiting, undefined).pipe(
          Effect.zipRight(Deferred.await(allowCohort)),
        ),
        failure: Effect.never,
        onAcquire: (name) =>
          Ref.update(acquiredNames, (names) => [...names, name]),
        onRelease: Ref.set(platformReleased, true),
      });
      const spec = RunSpec.define({
        id: "acme.run-spec-cohort/v1",
        events: [customerEvents],
        agents: { alice, bob },
        infrastructure: fakePlatformInfrastructure(platform, storage),
        execute: ({ agents, events }) =>
          Ref.update(executions, (count) => count + 1).pipe(
            Effect.zipRight(
              events.emit(Observation.make({ value: "cohort-ready" })),
            ),
            Effect.as([
              agents.alice.gateway.runtime,
              agents.bob.gateway.runtime,
            ] as const),
          ),
      });
      const fiber = yield* Run.execute(spec).pipe(Effect.fork);
      yield* Deferred.await(aliceWaiting);
      yield* Deferred.await(bobWaiting);
      yield* Deferred.succeed(allowAlice, undefined);
      assert.strictEqual(yield* Ref.get(executions), 0);
      yield* Deferred.succeed(allowBob, undefined);
      yield* Deferred.await(cohortWaiting);
      assert.deepStrictEqual(
        [...(yield* Ref.get(acquiredNames))].sort(compareText),
        ["alice", "bob"],
      );
      assert.strictEqual(yield* Ref.get(executions), 0);
      yield* Deferred.succeed(allowCohort, undefined);
      const result = yield* Fiber.join(fiber);
      assert.instanceOf(result, ProgramFinished);
      assert.strictEqual(yield* Ref.get(executions), 1);
      assert.strictEqual(yield* Ref.get(releases), 2);
      assert.isTrue(yield* Ref.get(platformReleased));
      yield* assertCohortLedger(storage);
    }),
  );
}

// @agent-code-guard/regression-only: deterministic platform gates prove exact dispatch, failure, evidence, and cleanup ordering
test(
  "Run.execute waits for the complete platform cohort and cleans up",
  cohortGateCase,
);

test("Run.execute never dispatches an incomplete roster", () =>
  Effect.gen(function* () {
    const peerAcquired = yield* Deferred.make<undefined>();
    const peerReleased = yield* Ref.make(false);
    const platformReleased = yield* Ref.make(false);
    const executions = yield* Ref.make(0);
    const primary = defineFakeRuntime<
      never,
      string,
      typeof runtimeConfiguration
    >({
      name: "run-spec-primary-failure",
      configuration: configuration("run-spec-primary-failure"),
      acquire: () =>
        Deferred.await(peerAcquired).pipe(
          Effect.zipRight(Effect.fail("primary failed")),
        ),
    });
    const peer = defineFakeRuntime({
      name: "run-spec-acquired-peer",
      configuration: configuration("run-spec-acquired-peer"),
      acquire: () =>
        Effect.acquireRelease(
          Deferred.succeed(peerAcquired, undefined).pipe(
            Effect.as({ gateway: undefined, termination: Effect.never }),
          ),
          () => Ref.set(peerReleased, true),
        ),
    });
    const platform = makeFakeSocietyPlatform({
      cohortReady: Effect.void,
      failure: Effect.never,
      onRelease: Ref.set(platformReleased, true),
    });
    const spec = RunSpec.define({
      id: "acme.run-spec-acquisition-failure/v1",
      events: [],
      agents: { primary, peer },
      infrastructure: fakePlatformInfrastructure(platform),
      execute: () =>
        Ref.update(executions, (count) => count + 1).pipe(
          Effect.as("dispatched"),
        ),
    });
    const result = yield* Run.execute(spec);
    assert.instanceOf(result, RunInfrastructureFailed);
    assert.strictEqual(yield* Ref.get(executions), 0);
    assert.isTrue(yield* Ref.get(peerReleased));
    assert.isTrue(yield* Ref.get(platformReleased));
  }));

test("Run.execute cancels a peer acquisition when a ready runtime terminates", () =>
  Effect.gen(function* () {
    const observerStarted = yield* Deferred.make<undefined>();
    const peerWaiting = yield* Deferred.make<undefined>();
    const termination = yield* Deferred.make<RuntimeExited>();
    const executions = yield* Ref.make(0);
    const cohortChecks = yield* Ref.make(0);
    const readyReleased = yield* Ref.make(false);
    const peerReleased = yield* Ref.make(false);
    const platformReleased = yield* Ref.make(false);
    const storage = memoryStorage();
    const ready = defineFakeRuntime({
      name: "run-spec-ready-before-peer",
      configuration: configuration("run-spec-ready-before-peer"),
      acquire: () =>
        Effect.acquireRelease(
          Effect.succeed({
            gateway: undefined,
            termination: Deferred.succeed(observerStarted, undefined).pipe(
              Effect.zipRight(Deferred.await(termination)),
            ),
          }),
          () => Ref.set(readyReleased, true),
        ),
    });
    const peer = defineFakeRuntime({
      name: "run-spec-blocked-peer",
      configuration: configuration("run-spec-blocked-peer"),
      acquire: () =>
        Effect.acquireRelease(Effect.void, () =>
          Ref.set(peerReleased, true),
        ).pipe(
          Effect.zipRight(Deferred.succeed(peerWaiting, undefined)),
          Effect.zipRight(Effect.never),
        ),
    });
    const platform = makeFakeSocietyPlatform({
      cohortReady: Ref.update(cohortChecks, (count) => count + 1),
      failure: Effect.never,
      onRelease: Ref.set(platformReleased, true),
    });
    const spec = RunSpec.define({
      id: "acme.run-spec-loss-during-acquisition/v1",
      events: [],
      agents: { ready, peer },
      infrastructure: fakePlatformInfrastructure(platform, storage),
      execute: () =>
        Ref.update(executions, (count) => count + 1).pipe(
          Effect.as("dispatched"),
        ),
    });
    const fiber = yield* Run.execute(spec).pipe(Effect.fork);
    yield* Deferred.await(observerStarted);
    yield* Deferred.await(peerWaiting);
    yield* Deferred.succeed(
      termination,
      RuntimeExited.make({ code: OBSERVED_EXIT_CODE }),
    );
    const result = yield* Fiber.join(fiber);

    assert.instanceOf(result, RunInfrastructureFailed);
    assert.strictEqual(yield* Ref.get(executions), 0);
    assert.strictEqual(yield* Ref.get(cohortChecks), 0);
    assert.isTrue(yield* Ref.get(readyReleased));
    assert.isTrue(yield* Ref.get(peerReleased));
    assert.isTrue(yield* Ref.get(platformReleased));

    const ledger = yield* openLedger(
      coreEvents,
      REF,
      "acme.run-spec-loss-during-acquisition/v1",
    ).pipe(Effect.provideService(LedgerStorage, storage));
    const exits = Array.from(
      yield* Stream.runCollect(ledger.events(AgentProcessExited)),
    );
    assert.strictEqual(exits.length, 1);
    assert.strictEqual(exits[0]?.code, OBSERVED_EXIT_CODE);
  }));

test("Run.execute invalidates a blocked cohort when a ready runtime terminates", () =>
  Effect.gen(function* () {
    const gateEntered = yield* Deferred.make<undefined>();
    const termination = yield* Deferred.make<RuntimeExited>();
    const executions = yield* Ref.make(0);
    const runtimeReleased = yield* Ref.make(false);
    const platformReleased = yield* Ref.make(false);
    const runtime = defineFakeRuntime({
      name: "run-spec-pre-dispatch-loss",
      configuration: configuration("run-spec-pre-dispatch-loss"),
      acquire: () =>
        Effect.acquireRelease(
          Effect.succeed({
            gateway: undefined,
            termination: Deferred.await(termination),
          }),
          () => Ref.set(runtimeReleased, true),
        ),
    });
    const platform = makeFakeSocietyPlatform({
      cohortReady: Deferred.succeed(gateEntered, undefined).pipe(
        Effect.zipRight(Effect.never),
      ),
      failure: Effect.never,
      onRelease: Ref.set(platformReleased, true),
    });
    const spec = RunSpec.define({
      id: "acme.run-spec-pre-dispatch-loss/v1",
      events: [],
      agents: { alice: runtime },
      infrastructure: fakePlatformInfrastructure(platform),
      execute: () =>
        Ref.update(executions, (count) => count + 1).pipe(
          Effect.as("dispatched"),
        ),
    });
    const fiber = yield* Run.execute(spec).pipe(Effect.fork);
    yield* Deferred.await(gateEntered);
    yield* Deferred.succeed(
      termination,
      RuntimeExited.make({ code: OBSERVED_EXIT_CODE }),
    );
    const result = yield* Fiber.join(fiber);

    assert.instanceOf(result, RunInfrastructureFailed);
    if (result instanceof RunInfrastructureFailed) {
      assert.isTrue(
        Array.from(Cause.failures(result.cause)).some(
          (cause) => cause instanceof SimulatorInfrastructureFailure,
        ),
      );
    }
    assert.strictEqual(yield* Ref.get(executions), 0);
    assert.isTrue(yield* Ref.get(runtimeReleased));
    assert.isTrue(yield* Ref.get(platformReleased));
  }));

test("Run.execute does not retry after a post-dispatch ledger failure", () =>
  Effect.gen(function* () {
    const executions = yield* Ref.make(0);
    const released = yield* Ref.make(false);
    const committedSends = yield* Ref.make(0);
    const runtime = defineFakeRuntime({
      name: "run-spec-post-dispatch-failure",
      configuration: configuration("run-spec-post-dispatch-failure"),
      acquire: () =>
        Effect.acquireRelease(
          Effect.succeed({ gateway: undefined, termination: Effect.never }),
          () => Ref.set(released, true),
        ),
    });
    const platform = makeFakeSocietyPlatform({
      cohortReady: Effect.void,
      failure: Effect.never,
    });
    const spec = RunSpec.define({
      id: "acme.run-spec-post-dispatch-failure/v1",
      events: [],
      agents: { alice: runtime },
      infrastructure: fakePlatformInfrastructure(
        platform,
        memoryStorage(EndpointMessageSent._tag),
        fakeRouterProvider(committedSends),
      ),
      execute: ({ agents, network }) =>
        Ref.update(executions, (count) => count + 1).pipe(
          Effect.zipRight(network.endpoint("probe")),
          Effect.flatMap((probe) => probe.open(agents.alice.agent)),
          Effect.flatMap((socket) => socket.send("request")),
          Effect.as("sent"),
        ),
    });
    const result = yield* Run.execute(spec);
    assert.instanceOf(result, RunInfrastructureFailed);
    assert.strictEqual(yield* Ref.get(executions), 1);
    assert.strictEqual(yield* Ref.get(committedSends), 1);
    assert.isTrue(yield* Ref.get(released));
  }));

test("Run.execute fails on post-dispatch platform loss without replay", () =>
  Effect.gen(function* () {
    const programStarted = yield* Deferred.make<undefined>();
    const platformLost = yield* Deferred.make<
      never,
      SimulatorInfrastructureFailure
    >();
    const executions = yield* Ref.make(0);
    const runtimeReleased = yield* Ref.make(false);
    const platformReleased = yield* Ref.make(false);
    const runtime = defineFakeRuntime({
      name: "run-spec-platform-loss",
      configuration: configuration("run-spec-platform-loss"),
      acquire: () =>
        Effect.acquireRelease(
          Effect.succeed({ gateway: undefined, termination: Effect.never }),
          () => Ref.set(runtimeReleased, true),
        ),
    });
    const platform = makeFakeSocietyPlatform({
      cohortReady: Effect.void,
      failure: Deferred.await(platformLost),
      onRelease: Ref.set(platformReleased, true),
    });
    const spec = RunSpec.define({
      id: "acme.run-spec-platform-loss/v1",
      events: [],
      agents: { alice: runtime },
      infrastructure: fakePlatformInfrastructure(platform),
      execute: () =>
        Ref.update(executions, (count) => count + 1).pipe(
          Effect.zipRight(Deferred.succeed(programStarted, undefined)),
          Effect.zipRight(Effect.never),
        ),
    });
    const fiber = yield* Run.execute(spec).pipe(Effect.fork);
    yield* Deferred.await(programStarted);
    const failure = new SimulatorInfrastructureFailure({
      detail: "controller ownership lost",
    });
    yield* Deferred.fail(platformLost, failure);
    const result = yield* Fiber.join(fiber);
    assert.instanceOf(result, RunInfrastructureFailed);
    if (result instanceof RunInfrastructureFailed) {
      assert.instanceOf(result.receipt, CompletedLedgerReceipt);
      assert.isTrue(
        Array.from(Cause.failures(result.cause)).some(
          (cause) =>
            cause instanceof SimulatorInfrastructureFailure &&
            cause.detail === failure.detail,
        ),
      );
    }
    assert.strictEqual(yield* Ref.get(executions), 1);
    assert.isTrue(yield* Ref.get(runtimeReleased));
    assert.isTrue(yield* Ref.get(platformReleased));
  }));

function readTerminationEvidence(storage: LedgerStorageService) {
  return Effect.gen(function* () {
    const ledger = yield* openLedger(
      coreEvents,
      REF,
      "acme.run-spec-runtime-termination/v1",
    ).pipe(Effect.provideService(LedgerStorage, storage));
    return Array.from(
      yield* Stream.runCollect(ledger.events(AgentProcessExited)),
    );
  });
}

test("Run.execute leaves post-dispatch runtime termination to customer policy", () =>
  Effect.gen(function* () {
    const termination = yield* Deferred.make<RuntimeExited>();
    const executions = yield* Ref.make(0);
    const platformReleased = yield* Ref.make(false);
    const storage = memoryStorage();
    const runtime = defineFakeRuntime({
      name: "run-spec-runtime-termination",
      configuration: configuration("run-spec-runtime-termination"),
      acquire: () =>
        Effect.succeed({
          gateway: undefined,
          termination: Deferred.await(termination),
        }),
    });
    const platform = makeFakeSocietyPlatform({
      cohortReady: Effect.void,
      failure: Effect.never,
      onRelease: Ref.set(platformReleased, true),
    });
    const spec = RunSpec.define({
      id: "acme.run-spec-runtime-termination/v1",
      events: [],
      agents: { alice: runtime },
      infrastructure: fakePlatformInfrastructure(platform, storage),
      execute: ({ ledger }) =>
        Ref.update(executions, (count) => count + 1).pipe(
          Effect.zipRight(
            Deferred.succeed(
              termination,
              RuntimeExited.make({ code: OBSERVED_EXIT_CODE }),
            ),
          ),
          Effect.zipRight(
            ledger
              .events(AgentProcessExited)
              .pipe(Stream.take(1), Stream.runDrain),
          ),
          Effect.as("customer-observed-termination"),
        ),
    });
    const result = yield* Run.execute(spec);
    assert.instanceOf(result, ProgramFinished);
    if (result instanceof ProgramFinished) {
      assert.deepStrictEqual(
        result.exit,
        Exit.succeed("customer-observed-termination"),
      );
    }
    assert.strictEqual(yield* Ref.get(executions), 1);
    assert.isTrue(yield* Ref.get(platformReleased));
    const exits = yield* readTerminationEvidence(storage);
    assert.strictEqual(exits.length, 1);
    assert.strictEqual(exits[0]?.code, OBSERVED_EXIT_CODE);
  }));

/* eslint-enable max-lines-per-function, max-statements, sonarjs/max-lines-per-function -- restore the project limits after the ordered lifecycle regressions */
