/** @file Composed run-kernel lifecycle, failure, and durability behavior. */

import type * as NodeHttp from "node:http"; // eslint-disable-line agent-code-guard/prefer-effect-platform -- The test captures the run-owned raw proxy listener.
import { assert, effect as test } from "@effect/vitest";
import { AgentId } from "@moltzap/identity";
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Ref,
  Schema,
  type Scope,
  Stream,
} from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Tests capture the run-owned raw proxy listener and host one ephemeral upstream peer.
import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, vi } from "vitest";
import type { AcquireControlledEndpoint } from "./endpoints.js";
import {
  defineFakeRuntime,
  makeFakeCluster,
} from "../__tests__/fake-cluster.js";
import { RuntimeAcquisitionError } from "../agents/agent.js";
import { AgentRoster } from "../agents/roster.js";
import {
  Cluster,
  ClusterError,
  type ClusterService,
} from "../cluster/cluster.js";
import { EventCatalog } from "../events/catalog.js";
import {
  AgentRuntimeStartFailed,
  LinkDown,
  ProgramFailed,
  ProgramSucceeded,
  RouterStarted,
  RouterStartFailed,
  RouterStopFailed,
  RunStarted,
} from "../events/core.js";
import {
  LedgerCompletion,
  ledgerDigest,
  LedgerManifest,
  ledgerRef,
} from "../ledger/schema.js";
import {
  type LedgerArtifact,
  LedgerStorage,
  LedgerStorageError,
  type LedgerStorageService,
} from "../ledger/storage.js";
import { Network } from "../network/endpoint.js";
import { NetworkError } from "../network/failure.js";
import { LinkController, LinkDriver } from "../network/link.js";
import { makeParticipantHandle } from "../network/participant.js";
import {
  makeRouterStopReport,
  RouterProvider,
  type RouterProviderService,
} from "../network/router.js";
import { makeDefinitionEventServices } from "./events.js";
import {
  ClusterLost,
  CompletedLedgerReceipt,
  IncompleteLedgerReceipt,
  ProgramFinished,
  runSociety,
  type SimulatorRunOutcome,
} from "./execute.js";

const DEFINITION_ID = "acme.run-lifecycle-test/v1";
const ROUTER_URL = new URL("http://router.example.test:43100");
const ADVERTISED_PROXY_URL = new URL("http://controller.run.test:43120");
const ENDPOINT_ID = Schema.decodeSync(AgentId)("agt_AAAAAAAAAAAAAAAAAAAAAA");
const SENDER_ID = Schema.decodeSync(AgentId)("agt_AQAAAAAAAAAAAAAAAAAAAA");
const DIGEST = Schema.decodeSync(ledgerDigest)("a".repeat(64));
const REF = Schema.decodeSync(ledgerRef)("run-lifecycle-test-ledger");

const httpBoundary = vi.hoisted(
  (): { onServer?: (server: NodeHttp.Server) => void } => ({}),
);

vi.mock("node:http", async (importOriginal) => {
  const original = await importOriginal<typeof NodeHttp>();
  return {
    ...original,
    createServer: (listener?: RequestListener) => {
      if (listener === undefined) {
        const server = original.createServer();
        httpBoundary.onServer?.(server);
        return server;
      }
      const server = original.createServer(listener);
      httpBoundary.onServer?.(server);
      return server;
    },
  };
});

afterEach(() => {
  httpBoundary.onServer = undefined;
});

class LifecycleObservation extends Schema.TaggedClass<LifecycleObservation>()(
  "acme.run-lifecycle-observation/v1",
  { value: Schema.String },
) {}

const eventServices = makeDefinitionEventServices(
  DEFINITION_ID,
  EventCatalog.make(LifecycleObservation),
);
const roster = AgentRoster.make(DEFINITION_ID, {});
type EmptyRosterDefinitions = Readonly<Record<never, never>>;

function completion(manifest: LedgerManifest, count: number): LedgerCompletion {
  return LedgerCompletion.make({
    ledgerFormatVersion: 1,
    runId: manifest.runId,
    recordCount: count,
    artifacts: { manifest: DIGEST, records: DIGEST },
  });
}

interface MemoryStorageOptions {
  readonly allocationFailure?: LedgerStorageError;
  readonly appendFailure?: {
    readonly eventTag: string;
    readonly error: LedgerStorageError;
  };
  readonly beforeComplete?: Effect.Effect<void>;
  readonly completionFailure?: LedgerStorageError;
}

// eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- One fake storage allocation keeps its failpoints beside the physical artifact state they govern.
function memoryStorage(
  records: string[],
  options: MemoryStorageOptions = {},
): LedgerStorageService {
  const files = new Map<LedgerArtifact, string>();
  return {
    // eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- This is the complete in-memory implementation of one allocation.
    allocate: (input) => {
      if (options.allocationFailure !== undefined) {
        return Effect.fail(options.allocationFailure);
      }
      const manifest = LedgerManifest.make({
        ledgerFormatVersion: 1,
        definitionId: input.definitionId,
        runId: "run-lifecycle-test",
        catalogTags: [...input.catalogTags].sort((left, right) =>
          left.localeCompare(right),
        ),
        createdAt: DateTime.unsafeMake(0),
        provenance: input.provenance,
        metadata: input.metadata,
      });
      files.set(
        "manifest",
        JSON.stringify(Schema.encodeSync(LedgerManifest)(manifest)),
      );
      files.set("records", "");
      return Effect.succeed({
        ref: REF,
        runId: manifest.runId,
        manifest,
        append: (record: string) => {
          const failure = options.appendFailure;
          return failure !== undefined && record.includes(failure.eventTag)
            ? Effect.fail(failure.error)
            : Effect.sync(() => {
                records.push(record);
                files.set("records", `${records.join("\n")}\n`);
              });
        },
        complete: (count: number) =>
          (options.beforeComplete ?? Effect.void).pipe(
            Effect.zipRight(
              options.completionFailure === undefined
                ? Effect.sync(() => {
                    const completed = completion(manifest, count);
                    files.set(
                      "completion",
                      JSON.stringify(
                        Schema.encodeSync(LedgerCompletion)(completed),
                      ),
                    );
                    return completed;
                  })
                : Effect.fail(options.completionFailure),
            ),
          ),
      });
    },
    read: (...[, artifact]) => Effect.succeed(files.get(artifact) ?? ""),
    digest: () => Effect.succeed(DIGEST),
  };
}

function eventTags(records: readonly string[]): readonly string[] {
  return records.map((record) => {
    const decoded: unknown = JSON.parse(record);
    if (typeof decoded !== "object" || decoded === null) {
      throw new TypeError("test ledger record has no event tag");
    }
    if (!("event" in decoded)) {
      throw new TypeError("test ledger record has no event tag");
    }
    const { event } = decoded;
    if (typeof event !== "object" || event === null || !("_tag" in event)) {
      throw new TypeError("test ledger record has no event tag");
    }
    if (typeof event._tag !== "string") {
      throw new TypeError("test ledger record has no event tag");
    }
    return event._tag;
  });
}

function hasFailure(
  cause: Cause.Cause<unknown>,
  predicate: (failure: unknown) => boolean,
): boolean {
  return Array.from(Cause.failures(cause)).some(predicate);
}

function isLedgerFailure(
  expected: LedgerStorageError,
): (failure: unknown) => failure is LedgerStorageError {
  return (failure): failure is LedgerStorageError =>
    failure instanceof LedgerStorageError &&
    failure.operation === expected.operation &&
    failure.detail === expected.detail;
}

function isClusterFailure(
  expected: ClusterError,
): (failure: unknown) => failure is ClusterError {
  return (failure): failure is ClusterError =>
    failure instanceof ClusterError && failure.detail === expected.detail;
}

function isRuntimeFailure(
  expected: RuntimeAcquisitionError,
): (failure: unknown) => failure is RuntimeAcquisitionError {
  return (failure): failure is RuntimeAcquisitionError =>
    failure instanceof RuntimeAcquisitionError &&
    failure.runtime === expected.runtime &&
    failure.agent === expected.agent &&
    failure.detail === expected.detail;
}

function successfulRouterProvider(
  timeline?: Ref.Ref<readonly string[]>,
  address: URL = ROUTER_URL,
): RouterProviderService {
  return {
    acquire: Effect.gen(function* () {
      const stopped =
        yield* Deferred.make<ReturnType<typeof makeRouterStopReport>>();
      if (timeline !== undefined) {
        yield* Ref.update(timeline, (entries) => [
          ...entries,
          "router-acquire",
        ]);
      }
      yield* Effect.addFinalizer(() => {
        const observeRelease =
          timeline === undefined
            ? Effect.void
            : Ref.update(timeline, (entries) => [...entries, "router-release"]);
        return Deferred.succeed(stopped, makeRouterStopReport()).pipe(
          Effect.tap(() => observeRelease),
          Effect.asVoid,
        );
      });
      return Object.freeze({
        address,
        stopped: Deferred.await(stopped),
      });
    }),
  };
}

function runKernel<A, E>(
  program: Effect.Effect<A, E, LinkController | LinkDriver | Network>,
  storage: LedgerStorageService,
  router: RouterProviderService,
  cluster?: ClusterService,
): Effect.Effect<
  SimulatorRunOutcome<A, E, EmptyRosterDefinitions>,
  LedgerStorageError
> {
  return runSociety({
    definitionId: DEFINITION_ID,
    eventServices,
    roster,
    program,
  }).pipe(
    Effect.provideService(Cluster, cluster ?? makeFakeCluster()),
    Effect.provideService(RouterProvider, router),
    Effect.provideService(LedgerStorage, storage),
  );
}

interface TestHttpServer {
  readonly server: Server;
  readonly origin: URL;
}

function acquireHttpServer(
  listener: RequestListener,
): Effect.Effect<TestHttpServer, Error, Scope.Scope> {
  const server = createServer(listener);
  const acquire = Effect.tryPromise({
    try: () =>
      new Promise<TestHttpServer>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("test HTTP server has no TCP address"));
            return;
          }
          resolve({
            server,
            origin: new URL(`http://127.0.0.1:${String(address.port)}`),
          });
        });
      }),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  });
  return Effect.acquireRelease(acquire, (acquiredServer) =>
    Effect.async<undefined>((resume) => {
      acquiredServer.server.close(() => {
        resume(Effect.succeed(undefined));
      });
    }),
  );
}

test("acquires the Router before the cluster and releases it afterward", () =>
  Effect.gen(function* () {
    const records: string[] = [];
    const timeline = yield* Ref.make<readonly string[]>([]);
    const cluster = makeFakeCluster({
      onPrepare: () =>
        Ref.update(timeline, (entries) => [...entries, "cluster-prepare"]),
      onRelease: Ref.update(timeline, (entries) => [
        ...entries,
        "cluster-release",
      ]),
    });
    const result = yield* runSociety({
      definitionId: DEFINITION_ID,
      eventServices,
      roster,
      program: Ref.update(timeline, (entries) => [...entries, "program"]),
    }).pipe(
      Effect.provideService(Cluster, cluster),
      Effect.provideService(RouterProvider, successfulRouterProvider(timeline)),
      Effect.provideService(LedgerStorage, memoryStorage(records)),
    );

    assert.instanceOf(result, ProgramFinished);
    if (result instanceof ProgramFinished) {
      assert.deepStrictEqual(result.exit, Exit.void);
      assert.instanceOf(result.receipt, CompletedLedgerReceipt);
      assert.strictEqual(result.receipt.completion.recordCount, records.length);
    }
    assert.deepStrictEqual(yield* Ref.get(timeline), [
      "router-acquire",
      "cluster-prepare",
      "program",
      "cluster-release",
      "router-release",
    ]);
    assert.include(eventTags(records), RouterStarted._tag);
    assert.include(eventTags(records), ProgramSucceeded._tag);
  }));

test("returns a completed receipt around a failed customer program Exit", () =>
  Effect.gen(function* () {
    const records: string[] = [];
    const result = yield* runKernel(
      Effect.fail("customer rejected the run"),
      memoryStorage(records),
      successfulRouterProvider(),
    );

    assert.instanceOf(result, ProgramFinished);
    if (result instanceof ProgramFinished) {
      assert.isTrue(Exit.isFailure(result.exit));
      if (Exit.isFailure(result.exit)) {
        assert.deepStrictEqual(Array.from(Cause.failures(result.exit.cause)), [
          "customer rejected the run",
        ]);
      }
      assert.instanceOf(result.receipt, CompletedLedgerReceipt);
      assert.strictEqual(result.receipt.completion.recordCount, records.length);
    }
    assert.include(eventTags(records), ProgramFailed._tag);
    assert.notInclude(eventTags(records), ProgramSucceeded._tag);
  }));

// eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- This regression pins the composed proxy path with a raw ephemeral peer.
test("routes controller-local endpoints through the acquired proxy to the actual Router origin", () =>
  Effect.scoped(
    // eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- The generator owns the complete scoped HTTP lifecycle of this single composition probe.
    Effect.gen(function* () {
      const records: string[] = [];
      const upstreamPaths: string[] = [];
      let endpointRouterOrigin: URL | undefined;
      const upstream = yield* acquireHttpServer((request, response) => {
        upstreamPaths.push(request.url ?? "");
        response.writeHead(204);
        response.end();
      });
      const acquireEndpoint: AcquireControlledEndpoint = ({
        name,
        routerOrigin,
      }) =>
        Effect.gen(function* () {
          endpointRouterOrigin = routerOrigin;
          const response = yield* Effect.tryPromise({
            // eslint-disable-next-line agent-code-guard/prefer-effect-platform -- A fetch probe verifies the actual loopback proxy origin supplied to the endpoint seam.
            try: () => fetch(new URL("/composition-probe", routerOrigin)),
            catch: (cause) =>
              NetworkError.make({
                operation: "attach-endpoint",
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
          });
          if (!response.ok) {
            return yield* Effect.fail(
              NetworkError.make({
                operation: "attach-endpoint",
                detail: `proxy probe returned ${String(response.status)}`,
              }),
            );
          }
          return {
            participant: makeParticipantHandle(name, ENDPOINT_ID),
            transport: {
              received: Stream.never,
              send: () => Effect.void,
            },
          };
        });
      const program = Effect.gen(function* () {
        const network = yield* Network;
        const endpoint = yield* network.endpoint("observer");
        return endpoint.participant.name;
      });
      const result = yield* runSociety({
        definitionId: DEFINITION_ID,
        eventServices,
        roster,
        program,
      }).pipe(
        Effect.provideService(
          Cluster,
          makeFakeCluster({
            acquireEndpoint,
            routerFaultProxy: {
              listener: {
                bindHost: "0.0.0.0",
                port: 0,
                advertisedOrigin: ADVERTISED_PROXY_URL,
              },
            },
          }),
        ),
        Effect.provideService(
          RouterProvider,
          successfulRouterProvider(undefined, upstream.origin),
        ),
        Effect.provideService(LedgerStorage, memoryStorage(records)),
      );

      assert.instanceOf(result, ProgramFinished);
      if (result instanceof ProgramFinished) {
        assert.deepStrictEqual(result.exit, Exit.succeed("observer"));
      }
      assert.deepStrictEqual(upstreamPaths, ["/composition-probe"]);
      assert.strictEqual(
        endpointRouterOrigin?.hostname,
        upstream.origin.hostname,
      );
      assert.notStrictEqual(endpointRouterOrigin?.port, "0");
      assert.notStrictEqual(
        endpointRouterOrigin?.origin,
        upstream.origin.origin,
      );
      assert.notStrictEqual(
        endpointRouterOrigin?.origin,
        ADVERTISED_PROXY_URL.origin,
      );
      assert.notStrictEqual(
        upstream.origin.origin,
        ADVERTISED_PROXY_URL.origin,
      );
    }),
  ));

test("binds the proxy listener before acquiring any roster runtime", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const records: string[] = [];
      const occupied = yield* acquireHttpServer((...[, response]) => {
        response.writeHead(204);
        response.end();
      });
      let runtimeAcquisitions = 0;
      const blockedRoster = AgentRoster.make(DEFINITION_ID, {
        alice: defineFakeRuntime({
          name: "proxy-order-runtime",
          configuration: { schema: Schema.Struct({}), value: {} },
          acquire: () =>
            Effect.sync(() => {
              runtimeAcquisitions += 1;
              return { gateway: undefined, termination: Effect.never };
            }),
        }),
      });
      const result = yield* runSociety({
        definitionId: DEFINITION_ID,
        eventServices,
        roster: blockedRoster,
        program: Effect.void,
      }).pipe(
        Effect.provideService(
          Cluster,
          makeFakeCluster({
            agentIdFor: () => ENDPOINT_ID,
            routerFaultProxy: {
              listener: {
                bindHost: "127.0.0.1",
                port: Number(occupied.origin.port),
              },
            },
          }),
        ),
        Effect.provideService(
          RouterProvider,
          successfulRouterProvider(undefined, ROUTER_URL),
        ),
        Effect.provideService(LedgerStorage, memoryStorage(records)),
      );

      assert.instanceOf(result, ClusterLost);
      assert.strictEqual(runtimeAcquisitions, 0);
    }),
  ));

test("propagates unexpected post-bind proxy failure through the run outcome", () =>
  Effect.gen(function* () {
    const records: string[] = [];
    const programStarted = yield* Deferred.make<undefined>();
    const proxyCreated = yield* Deferred.make<Server>();
    httpBoundary.onServer = (server) => {
      Effect.runSync(Deferred.succeed(proxyCreated, server));
    };
    const program = Deferred.succeed(programStarted, undefined).pipe(
      Effect.zipRight(Effect.never),
    );
    const running = yield* runKernel(
      program,
      memoryStorage(records),
      successfulRouterProvider(),
    ).pipe(Effect.fork);

    const proxyServer = yield* Deferred.await(proxyCreated);
    yield* Deferred.await(programStarted);
    proxyServer.emit("error", new Error("proxy listener lost"));

    const result = yield* Fiber.join(running);
    assert.instanceOf(result, ClusterLost);
    if (result instanceof ClusterLost) {
      assert.instanceOf(result.receipt, CompletedLedgerReceipt);
      assert.isFalse(Cause.isInterrupted(result.cause));
      assert.isTrue(
        hasFailure(
          result.cause,
          (failure) =>
            failure instanceof NetworkError &&
            failure.operation === "receive" &&
            failure.detail.includes("proxy listener lost"),
        ),
      );
    }
    assert.notInclude(eventTags(records), ProgramSucceeded._tag);
  }));

test("records Router acquisition failure without claiming readiness", () => {
  const records: string[] = [];
  const failure = NetworkError.make({
    operation: "acquire-router",
    detail: "router unavailable",
  });
  return Effect.gen(function* () {
    const result = yield* runKernel(Effect.void, memoryStorage(records), {
      acquire: Effect.fail(failure),
    });
    assert.instanceOf(result, ClusterLost);
    if (result instanceof ClusterLost) {
      assert.isTrue(
        Array.from(Cause.failures(result.cause)).some(
          (current) =>
            current instanceof NetworkError &&
            current.operation === failure.operation &&
            current.detail === failure.detail,
        ),
      );
    }
    assert.include(eventTags(records), RouterStartFailed._tag);
    assert.notInclude(eventTags(records), RouterStarted._tag);
  });
});

test("records Router stop failure and retains it in the run outcome", () => {
  const records: string[] = [];
  const failure = NetworkError.make({
    operation: "stop-router",
    detail: "router shutdown failed",
  });
  return Effect.gen(function* () {
    const result = yield* runKernel(Effect.void, memoryStorage(records), {
      acquire: Effect.succeed({
        address: ROUTER_URL,
        stopped: Effect.fail(failure),
      }),
    });
    assert.instanceOf(result, ClusterLost);
    if (result instanceof ClusterLost) {
      assert.isTrue(
        Array.from(Cause.failures(result.cause)).some(
          (current) =>
            current instanceof NetworkError &&
            current.operation === failure.operation &&
            current.detail === failure.detail,
        ),
      );
    }
    assert.include(eventTags(records), RouterStopFailed._tag);
  });
});

test("installs the link controller and its run-owned driver", () => {
  const records: string[] = [];
  const program = Effect.gen(function* () {
    const links = yield* LinkController;
    const driver = yield* LinkDriver;
    return [typeof links.disable, typeof driver.apply] as const;
  });
  return Effect.gen(function* () {
    const result = yield* runKernel(
      program,
      memoryStorage(records),
      successfulRouterProvider(),
    );
    assert.instanceOf(result, ProgramFinished);
    if (result instanceof ProgramFinished) {
      assert.deepStrictEqual(
        result.exit,
        Exit.succeed(["function", "function"]),
      );
    }
  });
});

test("keeps ledger allocation failure in the Effect error channel", () => {
  const records: string[] = [];
  const failure = new LedgerStorageError({
    operation: "allocate",
    detail: "allocation unavailable",
  });
  return Effect.gen(function* () {
    const observed = yield* runKernel(
      Effect.void,
      memoryStorage(records, { allocationFailure: failure }),
      successfulRouterProvider(),
    ).pipe(Effect.flip);

    assert.instanceOf(observed, LedgerStorageError);
    assert.strictEqual(observed.operation, failure.operation);
    assert.strictEqual(observed.detail, failure.detail);
    assert.deepStrictEqual(records, []);
  });
});

test("returns incomplete evidence when the first ledger append fails", () => {
  const records: string[] = [];
  const failure = new LedgerStorageError({
    operation: "append",
    detail: `cannot append ${RunStarted._tag}`,
    ref: REF,
    artifact: "records",
  });
  return Effect.gen(function* () {
    const result = yield* runKernel(
      Effect.void,
      memoryStorage(records, {
        appendFailure: { eventTag: RunStarted._tag, error: failure },
      }),
      successfulRouterProvider(),
    );

    assert.instanceOf(result, ClusterLost);
    if (result instanceof ClusterLost) {
      assert.instanceOf(result.receipt, IncompleteLedgerReceipt);
      assert.strictEqual(result.receipt.ledger, REF);
      assert.isTrue(hasFailure(result.cause, isLedgerFailure(failure)));
    }
    assert.deepStrictEqual(records, []);
  });
});

test("retains completed program evidence when ledger completion fails", () => {
  const records: string[] = [];
  const failure = new LedgerStorageError({
    operation: "complete",
    detail: "completion unavailable",
    ref: REF,
    artifact: "completion",
  });
  return Effect.gen(function* () {
    const result = yield* runKernel(
      Effect.succeed("program-complete"),
      memoryStorage(records, { completionFailure: failure }),
      successfulRouterProvider(),
    );

    assert.instanceOf(result, ClusterLost);
    if (result instanceof ClusterLost) {
      assert.instanceOf(result.receipt, IncompleteLedgerReceipt);
      assert.isTrue(hasFailure(result.cause, isLedgerFailure(failure)));
    }
    assert.include(eventTags(records), ProgramSucceeded._tag);
  });
});

test("finalizes durably before restoring repeated caller interruption", () =>
  Effect.gen(function* () {
    const records: string[] = [];
    const programStarted = yield* Deferred.make<undefined>();
    const completionStarted = yield* Deferred.make<undefined>();
    const releaseCompletion = yield* Deferred.make<undefined>();
    const storage = memoryStorage(records, {
      beforeComplete: Deferred.succeed(completionStarted, undefined).pipe(
        Effect.zipRight(Deferred.await(releaseCompletion)),
      ),
    });
    const program = Deferred.succeed(programStarted, undefined).pipe(
      Effect.zipRight(Effect.never),
    );
    const running = yield* runKernel(
      program,
      storage,
      successfulRouterProvider(),
    ).pipe(Effect.fork);

    yield* Deferred.await(programStarted);
    yield* Fiber.interruptFork(running);
    yield* Deferred.await(completionStarted);
    yield* Fiber.interruptFork(running);
    yield* Effect.yieldNow();
    assert.isTrue(Option.isNone(yield* Fiber.poll(running)));

    yield* Deferred.succeed(releaseCompletion, undefined);
    const exit = yield* Fiber.await(running);
    assert.isTrue(Exit.isInterrupted(exit));
    assert.notStrictEqual(yield* storage.read(REF, "completion"), "");
  }));

test("returns completed cluster-loss evidence when cluster preparation fails", () => {
  const records: string[] = [];
  const failure = new ClusterError({ detail: "cluster prepare failed" });
  const cluster: ClusterService = {
    prepare: () => Effect.fail(failure),
  };
  return Effect.gen(function* () {
    const result = yield* runKernel(
      Effect.void,
      memoryStorage(records),
      successfulRouterProvider(),
      cluster,
    );

    assert.instanceOf(result, ClusterLost);
    if (result instanceof ClusterLost) {
      assert.instanceOf(result.receipt, CompletedLedgerReceipt);
      assert.isTrue(hasFailure(result.cause, isClusterFailure(failure)));
    }
    assert.notInclude(eventTags(records), ProgramSucceeded._tag);
    assert.notInclude(eventTags(records), ProgramFailed._tag);
  });
});

test("returns completed cluster-loss evidence when an active session fails", () =>
  Effect.gen(function* () {
    const records: string[] = [];
    const programStarted = yield* Deferred.make<undefined>();
    const sessionLost = yield* Deferred.make<never, ClusterError>();
    const failure = new ClusterError({ detail: "cluster session lost" });
    const program = Deferred.succeed(programStarted, undefined).pipe(
      Effect.zipRight(Effect.never),
    );
    const running = yield* runKernel(
      program,
      memoryStorage(records),
      successfulRouterProvider(),
      makeFakeCluster({ failure: Deferred.await(sessionLost) }),
    ).pipe(Effect.fork);

    yield* Deferred.await(programStarted);
    yield* Deferred.fail(sessionLost, failure);
    const result = yield* Fiber.join(running);
    assert.instanceOf(result, ClusterLost);
    if (result instanceof ClusterLost) {
      assert.instanceOf(result.receipt, CompletedLedgerReceipt);
      assert.isTrue(hasFailure(result.cause, isClusterFailure(failure)));
    }
  }));

test("records roster acquisition failure without running customer code", () => {
  const records: string[] = [];
  const failure = RuntimeAcquisitionError.make({
    runtime: "unavailable-runtime",
    agent: "alice",
    detail: "readiness failed",
  });
  const failingRoster = AgentRoster.make(DEFINITION_ID, {
    alice: defineFakeRuntime({
      name: "unavailable-runtime",
      configuration: { schema: Schema.Struct({}), value: {} },
      acquire: () => Effect.fail(failure),
    }),
  });
  let programRan = false;
  return Effect.gen(function* () {
    const result = yield* runSociety({
      definitionId: DEFINITION_ID,
      eventServices,
      roster: failingRoster,
      program: Effect.sync(() => {
        programRan = true;
      }),
    }).pipe(
      Effect.provideService(
        Cluster,
        makeFakeCluster({ agentIdFor: () => ENDPOINT_ID }),
      ),
      Effect.provideService(RouterProvider, successfulRouterProvider()),
      Effect.provideService(LedgerStorage, memoryStorage(records)),
    );

    assert.instanceOf(result, ClusterLost);
    if (result instanceof ClusterLost) {
      assert.instanceOf(result.receipt, CompletedLedgerReceipt);
      assert.isTrue(hasFailure(result.cause, isRuntimeFailure(failure)));
    }
    assert.isFalse(programRan);
    assert.include(eventTags(records), AgentRuntimeStartFailed._tag);
    assert.notInclude(eventTags(records), ProgramSucceeded._tag);
  });
});

test("reports compensated link-evidence failure as ledger-backed cluster loss", () => {
  const records: string[] = [];
  const failure = new LedgerStorageError({
    operation: "append",
    detail: `cannot append ${LinkDown._tag}`,
    ref: REF,
    artifact: "records",
  });
  const acquireEndpoint: AcquireControlledEndpoint = ({ name }) =>
    Effect.succeed({
      participant: makeParticipantHandle(name, ENDPOINT_ID),
      transport: {
        received: Stream.never,
        send: () => Effect.void,
      },
    });
  const program = Effect.gen(function* () {
    const network = yield* Network;
    const links = yield* LinkController;
    const receiver = yield* network.endpoint("receiver");
    const sender = makeParticipantHandle("sender", SENDER_ID);
    yield* Effect.scoped(links.disable(sender, receiver.participant));
  });
  return Effect.gen(function* () {
    const result = yield* runKernel(
      program,
      memoryStorage(records, {
        appendFailure: { eventTag: LinkDown._tag, error: failure },
      }),
      successfulRouterProvider(),
      makeFakeCluster({ acquireEndpoint }),
    );

    assert.instanceOf(result, ClusterLost);
    if (result instanceof ClusterLost) {
      assert.instanceOf(result.receipt, IncompleteLedgerReceipt);
      assert.isFalse(Cause.isInterrupted(result.cause));
      assert.isTrue(hasFailure(result.cause, isLedgerFailure(failure)));
    }
    assert.include(eventTags(records), RunStarted._tag);
    assert.include(eventTags(records), RouterStarted._tag);
    assert.notInclude(eventTags(records), LinkDown._tag);
  });
});
